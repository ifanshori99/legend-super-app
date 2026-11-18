// POS 936 second-opinion round 3, finding R3-02 (brief 1065).
// Written from docs/qa/second-opinion-pos-936-ronde3-1064.md (Temuan + Usul
// test) and the observable HTTP contract of pos-1059-door.test.ts, not from
// the service code.
//
// Barrier interleaving: the test holds the row lock of an `issued` ticket,
// starts a door check (QR, then PIN) from a normal device and waits until the
// request is parked behind that lock. Then the device is switched to training
// mode through the real toggle (setDeviceTrainingMode). Finally the ticket
// lock is released.
//
// Accepted outcomes (both are named by the report):
//   (a) the toggle finished first: the open is refused (uniform 403
//       DOOR_CREDENTIAL_INVALID), the ticket stays `issued` with no
//       first_opened_at, and (PIN) no PIN slot was consumed;
//   (b) the toggle had to wait for the open (it did not finish before the
//       release): the open succeeds and the toggle completes afterwards.
// Forbidden: the toggle finished first AND the ticket was opened afterwards.
//
// ASSUMPTIONS (also in the report):
//   - The toggle is "finished first" when its promise settled before the
//     ticket lock was released. The test waits up to 3 s for that, so a slow
//     toggle can only make the test pass wrongly, never fail wrongly.
//   - "No PIN slot consumed": after the refused PIN open, 4 wrong PINs from a
//     normal device are all 403 and the right PIN then still opens the door
//     (a consumed slot would make the 4th wrong guess the 5th and lock the
//     ticket: 429 DOOR_PIN_LOCKED). The wrong PIN is checked on the other
//     race device, whose training mode is off.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import { randomUUID } from "node:crypto";
import { setDeviceTrainingMode } from "../services/device.service.ts";
import { doorCheckTicket } from "../services/facility-door-check.ts";
import { registerTestDevice } from "./device-seed.ts";
import {
  buildWorld,
  asOwnerTenant,
  doorCheck,
  errorCode,
  mintCredential,
  owner,
  paidTicket,
  teardownWorld,
  ticketState,
  type Bought,
  type World,
} from "./pos-1065-world.ts";
import { ulidToUuid } from "@starter/shared/core";

let world: World;

beforeAll(async () => {
  world = await buildWorld("r302");
}, 180_000);

afterAll(async () => {
  await teardownWorld(world);
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function toggleToTraining(deviceId: string) {
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(world.tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(world.outletA)] },
  );
  return setDeviceTrainingMode(context, world.doorStaff.userId, {
    deviceId,
    trainingMode: true,
  });
}

type Reply = { status: number; body: { error?: { code?: string } } };

/**
 * Holds the ticket row lock, fires the check, waits (bounded) until a backend
 * is parked behind the lock, switches the device to training, releases.
 */
async function raceOpenAgainstToggle(
  bought: Bought,
  forDevice: string,
  body: Record<string, unknown>,
): Promise<{ reply: Reply; toggledFirst: boolean }> {
  const client = await owner.connect();
  let reply: Reply;
  let toggledFirst = false;
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [world.tenant.tenantId],
    );
    await client.query(
      "SELECT id FROM access_tickets WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [world.tenant.tenantId, ulidToUuid(bought.ticketId)],
    );
    const { rows } = await client.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    const holderPid = rows[0]!.pid;

    const pending = Promise.resolve(doorCheck(world, forDevice, body)).then(
      (response) => response as unknown as Reply,
    );
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const { rows: waiters } = await owner.query(
        "SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid)) LIMIT 1",
        [holderPid],
      );
      if (waiters[0]) break;
      await wait(25);
    }

    // The toggle may legitimately wait for the open (outcome b), so it is
    // not awaited before the release.
    const toggle = toggleToTraining(forDevice).then(() => {
      toggledFirst = true;
    });
    for (let attempt = 0; attempt < 120 && !toggledFirst; attempt += 1)
      await wait(25);
    const toggledBeforeRelease = toggledFirst;

    await client.query("ROLLBACK");
    reply = await pending;
    await toggle;
    toggledFirst = toggledBeforeRelease;
  } finally {
    client.release();
  }
  return { reply, toggledFirst };
}

function expectRefusedByTraining(reply: Reply) {
  expect(reply.status, JSON.stringify(reply.body)).toBe(403);
  expect(errorCode(reply.body)).toBe("DOOR_CREDENTIAL_INVALID");
}

async function expectUntouched(bought: Bought) {
  const state = await ticketState(world, bought.ticketId);
  expect(state.status).toBe("issued");
  expect(state.first_opened_at).toBeNull();
}

describe("R3-02 training mode switched while a door check waits for the ticket lock", () => {
  it("R3-02-qr the QR open never succeeds after the device finished switching to training", async () => {
    const bought = await paidTicket(world);
    const credential = await mintCredential(world, bought);

    const { reply, toggledFirst } = await raceOpenAgainstToggle(
      bought,
      world.raceQr,
      { qrToken: credential.qrToken },
    );

    if (toggledFirst) {
      expectRefusedByTraining(reply);
      await expectUntouched(bought);
    } else {
      // Valid alternative: the toggle waited for the open to finish.
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    }
  });

  it("R3-02-pin the PIN open never succeeds after the switch, and a refused open consumes no PIN slot", async () => {
    const bought = await paidTicket(world);
    const credential = await mintCredential(world, bought);

    const { reply, toggledFirst } = await raceOpenAgainstToggle(
      bought,
      world.racePin,
      { ticketId: bought.ticketId, pin: credential.pin },
    );

    if (toggledFirst) {
      expectRefusedByTraining(reply);
      await expectUntouched(bought);

      // No slot was consumed: 4 wrong guesses are still plain refusals and
      // the right PIN still opens the door from a normal device.
      const wrong = String(credential.pin === "111111" ? 222222 : 111111);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const guess = await doorCheck(world, world.normalA, {
          ticketId: bought.ticketId,
          pin: wrong,
        });
        expect(guess.status, JSON.stringify(guess.body)).toBe(403);
        expect(errorCode(guess.body)).toBe("DOOR_CREDENTIAL_INVALID");
      }
      const opened = await doorCheck(world, world.normalA, {
        ticketId: bought.ticketId,
        pin: credential.pin,
      });
      expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    } else {
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    }
  });
});

// ---- Service level: doorCheckTicket(context, actor, input, deviceId) -----------------
//
// ASSUMPTIONS (also in the report): the new 4th parameter is the verified
// device id (default null). A training or unknown device is refused with the
// uniform 403 DOOR_CREDENTIAL_INVALID. The refusal burns no PIN slot: the
// failures counter of access_ticket_pin_guesses (absent row = 0) is unchanged,
// while a wrong PIN on a normal device raises it by one.

describe("R3-02 doorCheckTicket service-level device check", () => {
  const context = () =>
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(world.tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );

  const check = (bought: Bought, pin: string, deviceId: string | null) =>
    doorCheckTicket(
      context(),
      world.doorStaff.userId,
      {
        facilityId: world.facilityId,
        ticketId: bought.ticketId,
        pin,
      } as Parameters<typeof doorCheckTicket>[2],
      deviceId,
    );

  async function failures(bought: Bought): Promise<number> {
    const { rows } = await asOwnerTenant(world.tenant.tenantId, (db) =>
      db.query<{ failures: number }>(
        `SELECT failures FROM access_ticket_pin_guesses
          WHERE tenant_id = $1 AND access_ticket_id = $2`,
        [world.tenant.tenantId, ulidToUuid(bought.ticketId)],
      ),
    );
    return rows[0]?.failures ?? 0;
  }

  const refused = { status: 403, code: "DOOR_CREDENTIAL_INVALID" };

  it("R3-02-svc-training a training-mode device with the correct PIN is refused 403 and burns no PIN slot; a wrong PIN on a normal device counts", async () => {
    const trainingA = randomUUID();
    await registerTestDevice(owner, {
      tenantId: world.tenant.tenantId,
      outletId: world.outletA,
      deviceId: trainingA,
      label: "Latihan A servis",
    });
    await owner.query(
      "UPDATE devices SET training_mode = true WHERE tenant_id = $1 AND id = $2",
      [world.tenant.tenantId, trainingA],
    );
    const bought = await paidTicket(world);
    const credential = await mintCredential(world, bought);
    expect(await failures(bought)).toBe(0);

    for (const device of [trainingA, world.trainingB]) {
      await expect(check(bought, credential.pin, device)).rejects.toMatchObject(
        refused,
      );
      expect(await failures(bought)).toBe(0);
      await expectUntouched(bought);
    }

    // Control: a wrong PIN on a normal device is refused and counts once.
    const wrong = credential.pin === "111111" ? "222222" : "111111";
    await expect(check(bought, wrong, world.normalA)).rejects.toMatchObject(
      refused,
    );
    expect(await failures(bought)).toBe(1);

    // The training refusal after that still leaves the counter at 1.
    await expect(
      check(bought, credential.pin, trainingA),
    ).rejects.toMatchObject(refused);
    expect(await failures(bought)).toBe(1);
    await expectUntouched(bought);

    // The right PIN on a normal device still opens the door.
    const opened = await check(bought, credential.pin, world.normalA);
    expect(opened.ticket.status).toBe("in_use");
  });

  it("R3-02-svc-unknown an unknown deviceId with the correct PIN is refused 403 and the ticket stays unopened", async () => {
    const bought = await paidTicket(world);
    const credential = await mintCredential(world, bought);
    await expect(
      check(bought, credential.pin, randomUUID()),
    ).rejects.toMatchObject(refused);
    await expectUntouched(bought);
  });
});
