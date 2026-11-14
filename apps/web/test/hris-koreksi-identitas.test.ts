// Bead 852, finding 4 (second opinion 15 Nov): an old tab keeps the profile of
// the account it loaded with, while the session cookie is shared by every tab.
// After another tab signs in as someone else, the old tab must not file or
// edit a correction under the new account.
//
// Expected behaviour (CTO decision, brief 852):
//   1. The POST is bound to the employee the tab expects: when the session now
//      names someone else, no correction is filed under that someone else.
//   2. An edit ("Ubah") of a queue entry closes when the identity changed.
//   3. The queued original is removed only when the response names the same
//      owner as the entry; otherwise it stays queued.
//
// Assumptions: the contract's body is strict and carries no employee id, so the
// binding may be a pre-check of `/api/hris/me` right before the POST or an
// extra argument to `submitAttendanceCorrection`. The fake server below accepts
// either: it refuses a POST whose extra arguments name the expected employee
// while the session is someone else, and counts every other POST as filed under
// the session's employee. A race between the check and the POST needs the API
// to honour the binding and cannot be shown with this fake.
//
// Server-side rendering is the harness: hooks run during `renderToString`
// inside a real QueryClientProvider, and the returned mutation is then driven
// from the test. No browser, no jsdom.

import { randomUUID } from "node:crypto";
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTranslator, messagesId } from "@starter/shared/i18n";
import { createUlid } from "@starter/shared/core";
import { requestAttendanceCorrection } from "@starter/shared/hris";
import { ApiError } from "@/lib/api/errors";

const EMPLOYEE_A = "emp-a";
const EMPLOYEE_B = "emp-b";

const server = vi.hoisted(() => ({
  /** Who the shared session cookie names right now. */
  sessionEmployee: "emp-a",
  /** Whom a successful POST's response names; defaults to the session. */
  responseOwner: undefined as string | undefined,
  /** True when `/api/hris/me` gives no answer (offline, 5xx). */
  profileFails: false,
  /** Effects React would run after mount; server rendering never does. */
  effects: [] as (() => unknown)[],
  /** Every POST that reached the server, refused or not. */
  posts: [] as { sessionEmployee: string }[],
  /** POSTs the server accepted: filed under `employeeId`. */
  filed: [] as { employeeId: string }[],
}));

vi.mock("@/features/ws10-hris-employee/api.ts", () => ({
  fetchMyHrisProfile: async () => {
    if (server.profileFails) throw new Error("no answer");
    return { employee: { id: server.sessionEmployee } };
  },
  submitClockAttendance: async () => {
    throw new Error("not used");
  },
  submitAttendanceCorrection: async (_body: unknown, ...extra: unknown[]) => {
    server.posts.push({ sessionEmployee: server.sessionEmployee });
    const boundTo = JSON.stringify(extra).includes(EMPLOYEE_A);
    if (boundTo && server.sessionEmployee !== EMPLOYEE_A)
      throw new ApiError(409, "IDENTITY_CHANGED", "Session changed.");
    server.filed.push({ employeeId: server.sessionEmployee });
    return {
      id: createUlid(),
      employeeId: server.responseOwner ?? server.sessionEmployee,
    };
  },
}));

// Server rendering skips effects, but the queue flush lives in one. Only the
// code under test (hooks.ts) sees this stand-in; the test runs what it saved.
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => unknown) => {
    server.effects.push(effect);
  },
}));

// The toast context throws without its provider and nothing here reads it.
vi.mock("@/components/ui/toast", () => ({ useToast: () => () => {} }));

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useRouteContext: () => ({ session: { user: { id: "user-a" } } }),
}));

// Radix renders its dialog through a portal that only exists after mount, so
// the server render would never show it. A plain stand-in keeps the rule under
// test (is the edit form shown at all) observable.
vi.mock("@/components/ui/dialog", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => children;
  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? children : null,
    DialogContent: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
    DialogDescription: passthrough,
    DialogFooter: passthrough,
    DialogClose: passthrough,
  };
});

import { hrisKeys } from "@/features/ws10-hris-employee/keys.ts";
import {
  useDiscardCorrection,
  useFlushCorrectionQueue,
  useRetryCorrection,
  useSubmitCorrection,
} from "@/features/ws10-hris-employee/hooks.ts";
import { CorrectionDialog } from "@/features/ws10-hris-employee/components/correction-dialog.tsx";
import {
  enqueueCorrection,
  hasQueuedCorrection,
  markCorrectionRefused,
  type QueuedCorrection,
} from "@/features/ws10-hris-employee/queue.ts";

const t = createTranslator(messagesId);

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

/** This tab loaded as employee A: its cached profile says so. */
function tabLoadedAs(employeeId: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(hrisKeys.profile("user-a"), {
    employee: { id: employeeId },
  });
  return client;
}

function render<T>(client: QueryClient, useIt: () => T): T {
  let result: T | undefined;
  function Probe() {
    result = useIt();
    return null;
  }
  renderToString(
    createElement(QueryClientProvider, { client }, createElement(Probe)),
  );
  if (result === undefined) throw new Error("hook did not render");
  return result;
}

function correctionBody() {
  return requestAttendanceCorrection.body.parse({
    outletId: randomUUID(),
    attendanceLogId: null,
    requestedType: "in",
    requestedOccurredAt: "2026-11-15T01:00:00.000Z",
    reason: "Lupa absen masuk",
    idempotencyKey: `key-${createUlid()}`,
  });
}

/** A refused entry employee A queued earlier, waiting to be edited. */
function refusedEntryOf(employeeId: string): QueuedCorrection {
  const body = correctionBody();
  enqueueCorrection(body, employeeId);
  markCorrectionRefused(body.idempotencyKey, {
    status: 422,
    code: "VALIDATION_FAILED",
    reason: "Jam tidak valid",
    at: "2026-11-15T02:00:00.000Z",
  });
  const row: QueuedCorrection = {
    key: body.idempotencyKey,
    employeeId,
    body,
    queuedAt: "2026-11-15T02:00:00.000Z",
  };
  return row;
}

beforeEach(() => {
  server.sessionEmployee = EMPLOYEE_A;
  server.responseOwner = undefined;
  server.profileFails = false;
  server.effects.length = 0;
  server.posts.length = 0;
  server.filed.length = 0;
  vi.stubGlobal("window", {
    localStorage: memoryStorage(),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal("navigator", { onLine: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hris koreksi: tab lama setelah ganti akun", () => {
  test("a new correction is not filed under the account that took over the session", async () => {
    const submit = render(tabLoadedAs(EMPLOYEE_A), useSubmitCorrection);
    server.sessionEmployee = EMPLOYEE_B; // another tab signed in as B

    await submit.mutateAsync({ body: correctionBody() }).catch(() => {});

    expect(server.filed).toEqual([]);
  });

  test("an edit does not file under the new account and keeps the queued original", async () => {
    const row = refusedEntryOf(EMPLOYEE_A);
    const submit = render(tabLoadedAs(EMPLOYEE_A), useSubmitCorrection);
    server.sessionEmployee = EMPLOYEE_B;

    await submit
      .mutateAsync({ body: correctionBody(), replaces: row.key })
      .catch(() => {});

    expect(server.filed).toEqual([]);
    expect(hasQueuedCorrection(row.key, EMPLOYEE_A)).toBe(true);
  });

  test("an edit still goes through while the session is the same employee (control)", async () => {
    const row = refusedEntryOf(EMPLOYEE_A);
    const submit = render(tabLoadedAs(EMPLOYEE_A), useSubmitCorrection);

    const result = await submit.mutateAsync({
      body: correctionBody(),
      replaces: row.key,
    });

    expect(result.status).toBe("sent");
    expect(server.filed).toEqual([{ employeeId: EMPLOYEE_A }]);
    expect(hasQueuedCorrection(row.key, EMPLOYEE_A)).toBe(false);
  });

  test("the queued original stays when the response names another owner", async () => {
    const row = refusedEntryOf(EMPLOYEE_A);
    const submit = render(tabLoadedAs(EMPLOYEE_A), useSubmitCorrection);
    // The session still reads as A at check time, but the server filed the
    // correction under B: the original must not be thrown away for it.
    server.responseOwner = EMPLOYEE_B;

    await submit
      .mutateAsync({ body: correctionBody(), replaces: row.key })
      .catch(() => {});

    expect(hasQueuedCorrection(row.key, EMPLOYEE_A)).toBe(true);
  });

  test("the edit form is closed for an entry of another account", () => {
    const row = refusedEntryOf(EMPLOYEE_A);
    const editTitle = t("hris.correction.editTitle");
    const dialog = (employeeId: string) =>
      renderToString(
        createElement(
          QueryClientProvider,
          { client: tabLoadedAs(employeeId) },
          createElement(CorrectionDialog, {
            open: true,
            onOpenChange: () => {},
            log: null,
            outletId: row.body.outletId,
            timeZone: "Asia/Jakarta",
            editing: row,
          }),
        ),
      );

    // Control: the owner sees the edit form.
    expect(dialog(EMPLOYEE_A)).toContain(editTitle);
    // The tab now shows account B (identity changed): the form must be gone.
    expect(dialog(EMPLOYEE_B)).not.toContain(editTitle);
  });
});

// ---- Review architect, 15 Nov: gaps left by the first fix -----------------
//
// Expected behaviour (CTO decision, brief 852, T4):
//   4. A correction is sent only when the server proved the session is still
//      this tab's employee ("yes"). When it gave no answer ("unknown") the
//      request goes to the on-device queue; nothing is POSTed.
//   5. A replay (automatic flush, or "Coba lagi") removes a queued entry only
//      when the response names the entry's owner.
//   6. "Buang" works only when the server proved the identity ("yes").
//
// Assumption: "queued" means the mutation resolves with status "queued" and
// the entry is in the local queue under the idempotency key.

/** Lets every pending promise chain finish (they hold no timers or I/O). */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Runs the effects React would run after mount, then waits for them. */
async function runEffects() {
  for (const effect of server.effects.splice(0)) effect();
  await settle();
}

/** The flush hook returns nothing; render it and keep its effect for later. */
function mountFlush(client: QueryClient) {
  render(client, () => {
    useFlushCorrectionQueue();
    return true;
  });
}

describe("hris koreksi: kirim hanya bila identitas terbukti", () => {
  test("no answer from the identity check queues the correction and sends nothing", async () => {
    const submit = render(tabLoadedAs(EMPLOYEE_A), useSubmitCorrection);
    const body = correctionBody();
    server.profileFails = true;

    const result = await submit.mutateAsync({ body });

    expect(server.posts).toEqual([]);
    expect(result).toEqual({ status: "queued", key: body.idempotencyKey });
    expect(hasQueuedCorrection(body.idempotencyKey, EMPLOYEE_A)).toBe(true);
  });

  test("an edit with no identity answer keeps the original and sends nothing", async () => {
    const row = refusedEntryOf(EMPLOYEE_A);
    const submit = render(tabLoadedAs(EMPLOYEE_A), useSubmitCorrection);
    server.profileFails = true;

    await submit
      .mutateAsync({ body: correctionBody(), replaces: row.key })
      .catch(() => {});

    expect(server.posts).toEqual([]);
    expect(server.filed).toEqual([]);
  });

  test("a proven identity sends the correction (control)", async () => {
    const submit = render(tabLoadedAs(EMPLOYEE_A), useSubmitCorrection);

    const result = await submit.mutateAsync({ body: correctionBody() });

    expect(result.status).toBe("sent");
    expect(server.filed).toEqual([{ employeeId: EMPLOYEE_A }]);
  });
});

describe("hris koreksi: replay antrean", () => {
  test("the automatic flush keeps the entry when the response names another owner", async () => {
    const body = correctionBody();
    enqueueCorrection(body, EMPLOYEE_A);
    mountFlush(tabLoadedAs(EMPLOYEE_A));
    server.responseOwner = EMPLOYEE_B;

    await runEffects();

    expect(server.posts).toHaveLength(1); // the replay did run
    expect(hasQueuedCorrection(body.idempotencyKey, EMPLOYEE_A)).toBe(true);
  });

  test("the automatic flush sends nothing when the identity check has no answer", async () => {
    const body = correctionBody();
    enqueueCorrection(body, EMPLOYEE_A);
    mountFlush(tabLoadedAs(EMPLOYEE_A));
    server.profileFails = true;

    await runEffects();

    expect(server.posts).toEqual([]);
    expect(hasQueuedCorrection(body.idempotencyKey, EMPLOYEE_A)).toBe(true);
  });

  test("the automatic flush sends and clears the entry for the owner (control)", async () => {
    const body = correctionBody();
    enqueueCorrection(body, EMPLOYEE_A);
    mountFlush(tabLoadedAs(EMPLOYEE_A));

    await runEffects();

    expect(server.filed).toEqual([{ employeeId: EMPLOYEE_A }]);
    expect(hasQueuedCorrection(body.idempotencyKey, EMPLOYEE_A)).toBe(false);
  });

  test("Coba lagi keeps the entry when the response names another owner", async () => {
    const row = refusedEntryOf(EMPLOYEE_A);
    const retry = render(tabLoadedAs(EMPLOYEE_A), useRetryCorrection);
    server.responseOwner = EMPLOYEE_B;

    await retry.mutateAsync(row).catch(() => {});

    expect(server.posts).toHaveLength(1); // the retry did run
    expect(hasQueuedCorrection(row.key, EMPLOYEE_A)).toBe(true);
  });

  test("Coba lagi sends nothing when the identity check has no answer", async () => {
    const row = refusedEntryOf(EMPLOYEE_A);
    const retry = render(tabLoadedAs(EMPLOYEE_A), useRetryCorrection);
    server.profileFails = true;

    await retry.mutateAsync(row).catch(() => {});

    expect(server.posts).toEqual([]);
    expect(hasQueuedCorrection(row.key, EMPLOYEE_A)).toBe(true);
  });

  test("Coba lagi sends and clears the entry for the owner (control)", async () => {
    const row = refusedEntryOf(EMPLOYEE_A);
    const retry = render(tabLoadedAs(EMPLOYEE_A), useRetryCorrection);

    await retry.mutateAsync(row);

    expect(server.filed).toEqual([{ employeeId: EMPLOYEE_A }]);
    expect(hasQueuedCorrection(row.key, EMPLOYEE_A)).toBe(false);
  });
});

describe("hris koreksi: Buang", () => {
  test("keeps the entry when the session now names another employee", async () => {
    const row = refusedEntryOf(EMPLOYEE_A);
    const discard = render(tabLoadedAs(EMPLOYEE_A), useDiscardCorrection);
    server.sessionEmployee = EMPLOYEE_B;

    await discard.mutateAsync(row).catch(() => {});

    expect(hasQueuedCorrection(row.key, EMPLOYEE_A)).toBe(true);
  });

  test("keeps the entry when the identity check has no answer", async () => {
    const row = refusedEntryOf(EMPLOYEE_A);
    const discard = render(tabLoadedAs(EMPLOYEE_A), useDiscardCorrection);
    server.profileFails = true;

    await discard.mutateAsync(row).catch(() => {});

    expect(hasQueuedCorrection(row.key, EMPLOYEE_A)).toBe(true);
  });

  test("removes the entry when the identity is proven (control)", async () => {
    const row = refusedEntryOf(EMPLOYEE_A);
    const discard = render(tabLoadedAs(EMPLOYEE_A), useDiscardCorrection);

    await discard.mutateAsync(row);

    expect(hasQueuedCorrection(row.key, EMPLOYEE_A)).toBe(false);
  });
});
