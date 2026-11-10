// legend-ts50: Customer 360 acceptance tests over HTTP (brief 290d "Tes gagal-dulu",
// bagian Customer 360; 304a). Contract: packages/shared/src/crm/endpoints.ts
// (listCustomers, getCustomer360), crm.ts (customer360Schema).
//
// Test ids: CRM-C360-NN (no features.json exists, so the id is ours).
//
// Assumptions (the contract is silent on these; each is one line to change):
// - customerProfileDtoSchema has no WhatsApp field, so the tests never name one.
//   They read every string of the JSON body and compare digits only: "masked"
//   means the full number's digits appear nowhere but the last 4 digits do;
//   "full" means the number's digits (ignoring + - spaces) appear somewhere.
// - The detail route reveals the full number automatically to a caller holding
//   crm.customer.pii.read, and every such read writes at least one audit_logs row
//   that mentions the profile id and never contains the number itself. There is
//   no separate "reveal" endpoint in the contract.
// - The full number is sealed in user_identities.value_encrypted (see
//   identityAad in crm-customer360-helpers.ts).
// - The list `q` search by a full phone number does not work for staff without
//   crm.customer.pii.read (it would tell them whether a number is registered);
//   it answers an empty page, identical for a registered and an unknown number.
// - An unknown id and an id of another tenant answer the same 404 (same code).
// - recentVisits are newest first; favoriteItems count paid orders only (a draft
//   order is ignored) and equal memberFavorites(tx, profileId) after JSON round trip.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../app";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import request from "supertest";
import { sealSecret } from "../lib/secrets.ts";
import {
  newMemberUser,
  owner,
  seedConsent,
  seedOrder,
  seedProfile,
} from "./member-loyalty-helpers.ts";
import {
  auditRowsMentioning,
  bodyHasDigits,
  createCrmWorld,
  identityAad,
  newNumber,
  realUserId,
  seedItem,
  seedOrderLine,
  seedVisit,
  seedWhatsappIdentity,
  staffWith,
  type CrmStaff,
  type CrmWorld,
  type SeededNumber,
} from "./crm-customer360-helpers.ts";

let app: Express;
let world: CrmWorld;
let other: CrmWorld;
let viewOnly: CrmStaff;
let withPii: CrmStaff;
let noCustomerAccess: CrmStaff;
let otherStaff: CrmStaff;

let a: { id: string; name: string; number: SeededNumber };
let b: { id: string; name: string };
let foreign: { id: string; number: SeededNumber };
let latteId: string;
let croissantId: string;

const get = (staff: CrmStaff, w: CrmWorld, path: string) =>
  staff.client.get(path).set(w.host);

async function profileWithNumber(w: CrmWorld, name: string) {
  const userId = await realUserId(app);
  const number = newNumber();
  await seedWhatsappIdentity(userId, number);
  const profile = await seedProfile(w.tenantId, {
    userId,
    name,
    whatsappHash: number.hash,
  });
  await seedConsent(w.tenantId, profile.id);
  return { id: profile.id, name, number };
}

beforeAll(async () => {
  app = createApp();
  world = await createCrmWorld();
  other = await createCrmWorld();

  viewOnly = await staffWith(app, world, ["crm.customer.view"], "Staf Lihat");
  withPii = await staffWith(
    app,
    world,
    ["crm.customer.view", "crm.customer.pii.read"],
    "Staf PII",
  );
  noCustomerAccess = await staffWith(
    app,
    world,
    ["crm.segment.manage"],
    "Staf Tanpa Akses Pelanggan",
  );
  otherStaff = await staffWith(
    app,
    other,
    ["crm.customer.view", "crm.customer.pii.read"],
    "Staf Tenant Lain",
  );

  a = await profileWithNumber(world, `Andini ${randomUUID().slice(0, 6)}`);
  const bName = `Budi ${randomUUID().slice(0, 6)}`;
  const bProfile = await seedProfile(world.tenantId, { name: bName });
  b = { id: bProfile.id, name: bName };
  foreign = await profileWithNumber(other, "Foreign Member");

  // A: two paid orders, latte x3 (+1) and croissant x1, so latte is the favorite.
  latteId = await seedItem(world, "Latte Uji");
  croissantId = await seedItem(world, "Croissant Uji");
  const first = await seedVisit(world, a.id, { daysAgo: 6, spendIdr: 80_000 });
  await seedOrderLine(world, first, latteId, "Latte Uji", 3);
  await seedOrderLine(world, first, croissantId, "Croissant Uji", 1);
  const second = await seedVisit(world, a.id, {
    daysAgo: 2,
    spendIdr: 20_000,
  });
  await seedOrderLine(world, second, latteId, "Latte Uji", 1);
  // A draft (unpaid) order of A must not count toward favorites.
  const draft = await seedOrder(world.tenantId, {
    outletId: world.outletA,
    profileId: a.id,
    status: "draft",
  });
  await seedOrderLine(world, draft, latteId, "Latte Uji", 5);
  await seedVisit(world, b.id, { daysAgo: 1, spendIdr: 10_000 });
});

afterAll(async () => {
  await owner.end();
});

describe("CRM-C360 list", () => {
  it("CRM-C360-01 staff with crm.customer.view lists only their own tenant's customers", async () => {
    const response = await get(viewOnly, world, "/api/customers");
    expect(response.status).toBe(200);
    const ids = (response.body.data as { id: string }[]).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(ids).not.toContain(foreign.id);
  });

  it("CRM-C360-02 the list shows names and can be searched by name", async () => {
    const response = await get(
      viewOnly,
      world,
      `/api/customers?q=${encodeURIComponent(a.name.slice(0, 6))}`,
    );
    expect(response.status).toBe(200);
    const ids = (response.body.data as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });

  it("CRM-C360-03 the list never carries a full WhatsApp number or the stored hash", async () => {
    for (const staff of [viewOnly, withPii]) {
      const response = await get(staff, world, "/api/customers");
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain(a.number.hash);
    }
    const masked = await get(viewOnly, world, "/api/customers");
    expect(bodyHasDigits(masked.body, a.number.tail)).toBe(false);
  });

  it("CRM-C360-04 empty state: a tenant with no customers lists an empty page", async () => {
    const empty = await createCrmWorld();
    const staff = await staffWith(app, empty, ["crm.customer.view"]);
    const response = await get(staff, empty, "/api/customers");
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
  });
});

describe("CRM-C360 detail and personal data", () => {
  it("CRM-C360-05 the detail shows the WhatsApp number masked by default", async () => {
    const response = await get(viewOnly, world, `/api/customers/${a.id}`);
    expect(response.status).toBe(200);
    expect(response.body.data.profile.id).toBe(a.id);
    expect(response.body.data.profile.name).toBe(a.name);
    // Full number nowhere; the shared mask (maskWhatsAppNumber) keeps the
    // first four digits and the last three.
    expect(bodyHasDigits(response.body, a.number.tail)).toBe(false);
    expect(response.body.data.whatsapp.number).toBe(
      `${a.number.digits.slice(0, 4)}${"•".repeat(a.number.digits.length - 7)}${a.number.digits.slice(-3)}`,
    );
    expect(response.body.data.whatsapp.masked).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain(a.number.hash);
  });

  it("CRM-C360-06 staff with crm.customer.pii.read gets the full number, and every reveal is audited", async () => {
    const before = (await auditRowsMentioning(world.tenantId, a.id)).length;
    const first = await get(withPii, world, `/api/customers/${a.id}`);
    expect(first.status).toBe(200);
    expect(bodyHasDigits(first.body, a.number.tail)).toBe(true);
    const afterFirst = await auditRowsMentioning(world.tenantId, a.id);
    expect(afterFirst.length).toBeGreaterThan(before);
    await get(withPii, world, `/api/customers/${a.id}`);
    const afterSecond = await auditRowsMentioning(world.tenantId, a.id);
    // Each opening writes its own row.
    expect(afterSecond.length).toBeGreaterThanOrEqual(afterFirst.length + 1);
    // The audit trail names who and what, never the number itself.
    expect(afterSecond.some((row) => row.includes(withPii.userId))).toBe(true);
    expect(afterSecond.some((row) => row.includes(a.number.tail))).toBe(false);
  });

  it("CRM-C360-07 a customer without a stored number still opens (nothing to reveal)", async () => {
    const response = await get(withPii, world, `/api/customers/${b.id}`);
    expect(response.status).toBe(200);
    expect(response.body.data.profile.id).toBe(b.id);
  });

  it("CRM-C360-16 the number shown is the verified identity that matches the profile's hash, not another WhatsApp identity of the account", async () => {
    const userId = await realUserId(app);
    const mine = newNumber();
    const other = newNumber();
    const sibling = newNumber();
    const unverified = newNumber();
    // The profile's own number is a secondary identity; a primary verified
    // identity with another number and an unverified one sit beside it.
    await seedWhatsappIdentity(userId, mine);
    for (const [number, primary, verified] of [
      [other, true, true],
      [sibling, false, false],
    ] as const) {
      await owner.query(
        `INSERT INTO user_identities (id, user_id, type, value_hash, value_encrypted, verified_at, is_primary)
         VALUES ($1, $2, 'whatsapp', $3, $4, $5, $6)`,
        [
          randomUUID(),
          userId,
          number.hash,
          sealSecret(`+${number.digits}`, identityAad(number.hash)),
          verified ? new Date() : null,
          primary,
        ],
      );
    }
    const matching = await seedProfile(world.tenantId, {
      userId,
      name: `Ganda ${randomUUID().slice(0, 6)}`,
      whatsappHash: mine.hash,
    });
    await seedConsent(world.tenantId, matching.id);
    const response = await get(withPii, world, `/api/customers/${matching.id}`);
    expect(response.status).toBe(200);
    expect(bodyHasDigits(response.body, mine.digits)).toBe(true);
    expect(bodyHasDigits(response.body, other.tail)).toBe(false);
    expect(bodyHasDigits(response.body, sibling.tail)).toBe(false);

    // A profile whose hash points at the unverified identity shows no number.
    // (One profile per user and tenant, so this one gets its own account.)
    const otherUserId = await realUserId(app);
    await seedWhatsappIdentity(otherUserId, newNumber());
    await owner.query(
      `INSERT INTO user_identities (id, user_id, type, value_hash, value_encrypted, verified_at, is_primary)
       VALUES ($1, $2, 'whatsapp', $3, $4, NULL, false)`,
      [
        randomUUID(),
        otherUserId,
        unverified.hash,
        sealSecret(`+${unverified.digits}`, identityAad(unverified.hash)),
      ],
    );
    const pointsAtUnverified = await seedProfile(world.tenantId, {
      userId: otherUserId,
      name: `Belum ${randomUUID().slice(0, 6)}`,
      whatsappHash: unverified.hash,
    });
    await seedConsent(world.tenantId, pointsAtUnverified.id);
    const none = await get(
      withPii,
      world,
      `/api/customers/${pointsAtUnverified.id}`,
    );
    expect(none.status).toBe(200);
    expect(none.body.data.whatsapp.number).toBeNull();
  });

  it("CRM-C360-08 staff without crm.customer.pii.read never receive the number, even by searching for it", async () => {
    const registered = await get(
      viewOnly,
      world,
      `/api/customers?q=${a.number.digits}`,
    );
    const unknown = await get(
      viewOnly,
      world,
      `/api/customers?q=${newNumber().digits}`,
    );
    expect(registered.status).toBe(200);
    expect(unknown.status).toBe(200);
    // Same answer for a registered and an unregistered number: no oracle.
    expect(registered.body.data).toEqual([]);
    expect(unknown.body.data).toEqual([]);
    expect(bodyHasDigits(registered.body, a.number.tail)).toBe(false);
  });
});

describe("CRM-C360 favorites, visits, vouchers", () => {
  it("CRM-C360-09 the detail shows favorites that equal memberFavorites", async () => {
    const response = await get(viewOnly, world, `/api/customers/${a.id}`);
    expect(response.status).toBe(200);
    const favorites = response.body.data.favoriteItems as {
      menuItemId: string;
      name: string;
      quantity: number;
    }[];
    // From the seeded paid orders: latte 3 + 1, croissant 1.
    expect(favorites[0]).toMatchObject({
      menuItemId: latteId,
      name: "Latte Uji",
      quantity: 4,
    });
    expect(favorites.find((f) => f.menuItemId === croissantId)?.quantity).toBe(
      1,
    );

    // ASSUMPTION: memberFavorites(tx, profileId) returns CustomerFavoriteItem[].
    const { memberFavorites } =
      await import("../services/member-favorites.service.ts");
    const expected = await withTenant(db, world.context, (tx) =>
      memberFavorites(tx, a.id),
    );
    expect(favorites).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  it("CRM-C360-10 the detail lists recent visits and an empty voucher list when none exist", async () => {
    const response = await get(viewOnly, world, `/api/customers/${a.id}`);
    const data = response.body.data;
    expect(data.recentVisits).toHaveLength(2);
    expect(
      data.recentVisits.map((v: { spendIdr: number }) => v.spendIdr),
    ).toEqual([20_000, 80_000]);
    expect(data.activeVouchers).toEqual([]);
    expect(data.recentFeedback).toEqual([]);
  });
});

describe("CRM-C360 access and tenant isolation", () => {
  it("CRM-C360-11 staff without crm.customer.view get 403 on list and detail", async () => {
    for (const path of ["/api/customers", `/api/customers/${a.id}`]) {
      const response = await get(noCustomerAccess, world, path);
      expect(response.status, path).toBe(403);
      expect(response.body.error.code, path).toBe("PERMISSION_DENIED");
    }
  });

  it("CRM-C360-12 a member session gets 403 on the staff routes", async () => {
    const member = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    for (const path of ["/api/customers", `/api/customers/${a.id}`]) {
      const response = await member.client
        .get(path)
        .set({ Host: world.hostname });
      expect(response.status, path).toBe(403);
    }
  });

  it("CRM-C360-13 anonymous callers get 401", async () => {
    const response = await request(app).get("/api/customers").set(world.host);
    expect(response.status).toBe(401);
  });

  it("CRM-C360-14 another tenant's customer is a plain 404, the same as an unknown id", async () => {
    // The route works for a customer of this tenant ...
    expect((await get(viewOnly, world, `/api/customers/${a.id}`)).status).toBe(
      200,
    );
    // ... and says the same for another tenant's customer and an unknown id.
    const foreignRead = await get(
      viewOnly,
      world,
      `/api/customers/${foreign.id}`,
    );
    const unknownRead = await get(
      viewOnly,
      world,
      `/api/customers/${randomUUID()}`,
    );
    expect(foreignRead.status).toBe(404);
    expect(unknownRead.status).toBe(404);
    expect(foreignRead.body.error.code).toBe(unknownRead.body.error.code);
    expect(JSON.stringify(foreignRead.body)).not.toContain(foreign.number.tail);
    // Even with pii.read, no cross-tenant reveal and no audit row appears.
    const revealed = await get(withPii, world, `/api/customers/${foreign.id}`);
    expect(revealed.status).toBe(404);
    expect(bodyHasDigits(revealed.body, foreign.number.tail)).toBe(false);
    expect(await auditRowsMentioning(world.tenantId, foreign.id)).toEqual([]);
  });

  it("CRM-C360-15 the other tenant's staff see only their own customer", async () => {
    const response = await get(otherStaff, other, "/api/customers");
    expect(response.status).toBe(200);
    const ids = (response.body.data as { id: string }[]).map((p) => p.id);
    expect(ids).toEqual([foreign.id]);
    const cross = await get(otherStaff, other, `/api/customers/${a.id}`);
    expect(cross.status).toBe(404);
  });
});
