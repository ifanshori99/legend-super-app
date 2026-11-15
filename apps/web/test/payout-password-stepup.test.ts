// Brief 890: payout money actions (approve a batch, download the bank file,
// save the payout settings) ask for the account password as a step-up proof.
// The API (branch 888) takes an optional `password` on those three calls and
// answers:
//   403 MFA_REQUIRED, 401 REAUTH_REQUIRED, 403 REAUTH_PASSWORD_INVALID,
//   429 REAUTH_PASSWORD_LOCKED.
//
// What is pinned here (from the brief and the shared validators, not from the
// UI implementation):
//   1. useApproveBatch / useUpsertPayoutConfig put `password` in the request
//      body, and leave the key out when none is given.
//   2. useExportBatch does the same on its own fetch (JSON body).
//   3. A wrong password and a locked account read as catalog text, never as the
//      generic message or the raw API message.
//   4. useStepUp.capture tells the caller whether the panel shows (true) or the
//      caller must show the error (false), and keeps the password field open
//      after a wrong password.
//   5. VerifyPanel shows the refusal text in place with an empty password field.
//   6. Double submit: a mutation that is in flight is observable as pending,
//      which is what the components' `isPending` guard relies on.
//
// Assumptions:
//   - The hooks themselves do not dedupe two quick `mutate` calls (TanStack
//     Query never does); the component guard is the protection, so the test
//     only proves the pending flag is visible between the two calls.
//   - Wrong-password refusals reach the hook as ApiError with the API's code;
//     the catalog key is `payrollPayout.error.reauthPasswordLocked` for the
//     locked case (brief P3) and the existing `reauthPasswordInvalid` for the
//     wrong one. Exact locked wording is the brief's text.
//   - Responses of the mocked transport are not contract-shaped, so a success
//     path may end in a response-shape error in development; only the request
//     on the wire is asserted there.
//
// Harness: server rendering (`renderToString`), no browser, no jsdom, like
// hris-koreksi-identitas.test.ts. The transport (`apiFetch`) and `fetch` are
// replaced; the real endpoint caller still validates the request body against
// the shared strict schema.

import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createTranslator,
  messagesId,
  type MessageKey,
} from "@starter/shared/i18n";
import { ApiError } from "@/lib/api/errors";

type WireCall = { path: string; method?: string; body?: unknown };

const wire = vi.hoisted(() => ({
  /** Every request that reached the (mocked) transport. */
  calls: [] as { path: string; method?: string; body?: unknown }[],
  /** What the transport does next: undefined answers `{}`. */
  next: undefined as undefined | (() => Promise<unknown>),
}));

vi.mock("@/lib/api/client", async () => ({
  ...(await import("@/lib/api/errors")),
  apiFetch: async (
    path: string,
    init: { method?: string; body?: unknown } = {},
  ) => {
    wire.calls.push({ path, method: init.method, body: init.body });
    return wire.next ? wire.next() : {};
  },
}));

// `useState` is swapped for a recorder only while `harness.stub` is set, so
// the state calls of `useStepUp` can be read without a DOM. Server rendering
// drops updates that arrive after the render.
const harness = vi.hoisted(() => ({
  stub: false,
  slot: 0,
  sets: [] as { slot: number; value: unknown }[],
}));

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (init: unknown) => {
      if (!harness.stub) return actual.useState(init);
      const slot = harness.slot++;
      const initial =
        typeof init === "function" ? (init as () => unknown)() : init;
      return [
        initial,
        (update: unknown) => {
          const value =
            typeof update === "function"
              ? (update as (previous: unknown) => unknown)(initial)
              : update;
          harness.sets.push({ slot, value });
        },
      ];
    },
  };
});

import {
  useApproveBatch,
  useExportBatch,
  useUpsertPayoutConfig,
} from "@/features/ws10-payroll-payout/hooks.ts";
import { payoutErrorMessage } from "@/features/ws10-payroll-payout/errors.ts";
import {
  useStepUp,
  VerifyPanel,
} from "@/features/ws10-payroll-payout/components/approval-verify.tsx";

const t = createTranslator(messagesId);
const LOCKED_KEY = "payrollPayout.error.reauthPasswordLocked" as MessageKey;
const LOCKED_TEXT =
  "Terlalu banyak percobaan kata sandi. Coba lagi beberapa menit lagi.";
const INVALID_TEXT = "Kata sandi salah. Periksa lalu coba lagi.";
const API_LOCKED_MESSAGE =
  "Terlalu banyak percobaan password. Coba lagi nanti.";

const BATCH_ID = randomUUID();
const ENTITY_ID = randomUUID();
const CONTENT_HASH = "a".repeat(64);

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

/** A failed or half-shaped answer is fine: only the request is under test. */
async function settle(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

function callTo(suffix: string): WireCall {
  const found = wire.calls.filter((call) => call.path.endsWith(suffix));
  expect(found).toHaveLength(1);
  return found[0]!;
}

function configInput(password?: string) {
  return {
    ...(password === undefined ? {} : { password }),
    method: "manual_bank" as const,
    integrationId: null,
    manualSourceBankAccountId: randomUUID(),
    manualBankFormat: "generic_csv" as const,
    maxPerTransferIdr: 50_000_000,
    dailyCapIdr: null,
    feePerTransferIdr: 5_000,
    enabled: true,
  };
}

const wrongPassword = () =>
  new ApiError(403, "REAUTH_PASSWORD_INVALID", "Password salah.");
const lockedAccount = () =>
  new ApiError(429, "REAUTH_PASSWORD_LOCKED", API_LOCKED_MESSAGE);

type FetchCall = { url: string; method?: string; body?: string };
const fetched: FetchCall[] = [];
let fetchAnswer: () => Response = () => new Response("a,b\n1,2\n");

beforeEach(() => {
  wire.calls.length = 0;
  wire.next = undefined;
  fetched.length = 0;
  fetchAnswer = () =>
    new Response("a,b\n1,2\n", {
      status: 200,
      headers: { "content-disposition": 'attachment; filename="bank.csv"' },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | string, init?: RequestInit) => {
      fetched.push({
        url: String(url),
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return fetchAnswer();
    }),
  );
  // Saving the file needs a document; nothing here looks at it.
  vi.stubGlobal("document", {
    createElement: () => ({ click() {}, remove() {} }),
    body: { append() {} },
  });
  harness.stub = false;
  harness.slot = 0;
  harness.sets.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("payout-password-stepup: approve sends the password", () => {
  it("puts password in the approve body next to the batch fields", async () => {
    const approve = render(newClient(), useApproveBatch);
    await settle(
      approve.mutateAsync({
        batchId: BATCH_ID,
        contentHash: CONTENT_HASH,
        sourceBankAccountId: null,
        password: "benar-123",
      }),
    );
    const call = callTo(`/disbursement-batches/${BATCH_ID}/approve`);
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({
      contentHash: CONTENT_HASH,
      sourceBankAccountId: null,
      password: "benar-123",
    });
  });

  it("leaves the password key out when none was typed", async () => {
    const approve = render(newClient(), useApproveBatch);
    await settle(
      approve.mutateAsync({
        batchId: BATCH_ID,
        contentHash: CONTENT_HASH,
        sourceBankAccountId: null,
      }),
    );
    const call = callTo(`/disbursement-batches/${BATCH_ID}/approve`);
    expect(call.body).toEqual({
      contentHash: CONTENT_HASH,
      sourceBankAccountId: null,
    });
    expect(call.body).not.toHaveProperty("password");
  });

  it("never puts the batch id in the body", async () => {
    const approve = render(newClient(), useApproveBatch);
    await settle(
      approve.mutateAsync({
        batchId: BATCH_ID,
        contentHash: CONTENT_HASH,
        sourceBankAccountId: null,
        password: "benar-123",
      }),
    );
    expect(callTo("/approve").body).not.toHaveProperty("batchId");
  });

  it("surfaces a wrong password as the API error, ready for the catalog", async () => {
    wire.next = async () => {
      throw wrongPassword();
    };
    const approve = render(newClient(), useApproveBatch);
    const error = await settle(
      approve.mutateAsync({
        batchId: BATCH_ID,
        contentHash: CONTENT_HASH,
        sourceBankAccountId: null,
        password: "salah",
      }),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("REAUTH_PASSWORD_INVALID");
    expect(payoutErrorMessage(error, t)).toBe(INVALID_TEXT);
  });
});

describe("payout-password-stepup: config sends the password", () => {
  it("puts password in the PUT body", async () => {
    const save = render(newClient(), () => useUpsertPayoutConfig(ENTITY_ID));
    await settle(save.mutateAsync(configInput("benar-123")));
    const call = callTo(`/payout-configs/${ENTITY_ID}`);
    expect(call.method).toBe("PUT");
    expect(call.body).toEqual(
      expect.objectContaining({ password: "benar-123", method: "manual_bank" }),
    );
  });

  it("leaves the password key out when none was typed", async () => {
    const save = render(newClient(), () => useUpsertPayoutConfig(ENTITY_ID));
    await settle(save.mutateAsync(configInput()));
    const call = callTo(`/payout-configs/${ENTITY_ID}`);
    expect(call.body).toEqual(
      expect.objectContaining({ method: "manual_bank" }),
    );
    expect(call.body).not.toHaveProperty("password");
  });

  it("surfaces a locked account as catalog text", async () => {
    wire.next = async () => {
      throw lockedAccount();
    };
    const save = render(newClient(), () => useUpsertPayoutConfig(ENTITY_ID));
    const error = await settle(save.mutateAsync(configInput("salah")));
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(429);
    expect(payoutErrorMessage(error, t)).toBe(LOCKED_TEXT);
  });
});

describe("payout-password-stepup: export sends the password", () => {
  it("posts the password as a JSON body", async () => {
    const download = render(newClient(), useExportBatch);
    const error = await settle(
      download.mutateAsync({ batchId: BATCH_ID, password: "benar-123" }),
    );
    expect(error).toBeNull();
    expect(fetched).toHaveLength(1);
    expect(fetched[0]!.method).toBe("POST");
    expect(fetched[0]!.url).toContain(
      `/disbursement-batches/${BATCH_ID}/export`,
    );
    expect(JSON.parse(fetched[0]!.body ?? "null")).toEqual({
      password: "benar-123",
    });
  });

  it("posts an empty JSON object when no password was typed", async () => {
    const download = render(newClient(), useExportBatch);
    await settle(download.mutateAsync({ batchId: BATCH_ID }));
    expect(fetched).toHaveLength(1);
    const body = JSON.parse(fetched[0]!.body ?? "null") as object;
    expect(body).toEqual({});
    expect(body).not.toHaveProperty("password");
  });

  it("does not send an empty password string", async () => {
    const download = render(newClient(), useExportBatch);
    await settle(download.mutateAsync({ batchId: BATCH_ID, password: "" }));
    expect(JSON.parse(fetched[0]!.body ?? "null")).toEqual({});
  });

  it("turns a wrong password into the catalog text", async () => {
    fetchAnswer = () =>
      new Response(
        JSON.stringify({
          error: {
            code: "REAUTH_PASSWORD_INVALID",
            message: "Password salah.",
          },
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    const download = render(newClient(), useExportBatch);
    const error = await settle(
      download.mutateAsync({ batchId: BATCH_ID, password: "salah" }),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("REAUTH_PASSWORD_INVALID");
    expect(payoutErrorMessage(error, t)).toBe(INVALID_TEXT);
  });

  it("turns a locked account into the catalog text, not the API's message", async () => {
    fetchAnswer = () =>
      new Response(
        JSON.stringify({
          error: {
            code: "REAUTH_PASSWORD_LOCKED",
            message: API_LOCKED_MESSAGE,
          },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    const download = render(newClient(), useExportBatch);
    const error = await settle(
      download.mutateAsync({ batchId: BATCH_ID, password: "salah" }),
    );
    expect((error as ApiError).status).toBe(429);
    const text = payoutErrorMessage(error, t);
    expect(text).toBe(LOCKED_TEXT);
    expect(text).not.toBe(API_LOCKED_MESSAGE);
  });
});

describe("payout-password-stepup: error catalog", () => {
  it("has a locked-account text that is not the generic message", () => {
    expect(t(LOCKED_KEY)).toBe(LOCKED_TEXT);
    expect(t(LOCKED_KEY)).not.toBe(t("payrollPayout.error.generic"));
  });

  it("maps REAUTH_PASSWORD_LOCKED to it, whatever message the API sent", () => {
    expect(payoutErrorMessage(lockedAccount(), t)).toBe(LOCKED_TEXT);
    expect(
      payoutErrorMessage(
        new ApiError(429, "REAUTH_PASSWORD_LOCKED", "something else"),
        t,
      ),
    ).toBe(LOCKED_TEXT);
  });

  it("maps REAUTH_PASSWORD_INVALID to the wrong-password text", () => {
    expect(payoutErrorMessage(wrongPassword(), t)).toBe(INVALID_TEXT);
  });

  it("keeps REAUTH_REQUIRED and MFA_REQUIRED as catalog text", () => {
    const reauth = payoutErrorMessage(
      new ApiError(401, "REAUTH_REQUIRED", "x"),
      t,
    );
    const mfa = payoutErrorMessage(new ApiError(403, "MFA_REQUIRED", "x"), t);
    expect(reauth).toBe(t("payrollPayout.error.reauthRequired"));
    expect(mfa).toBe(t("payrollPayout.error.mfaRequired"));
    expect(reauth).not.toBe("x");
    expect(mfa).not.toBe("x");
  });
});

describe("payout-password-stepup: useStepUp.capture", () => {
  function stepUp(acceptsPassword: boolean) {
    harness.stub = true;
    harness.slot = 0;
    harness.sets.length = 0;
    let result: ReturnType<typeof useStepUp> | undefined;
    function Probe() {
      result = useStepUp({ acceptsPassword });
      return null;
    }
    renderToString(createElement(Probe));
    harness.stub = false;
    if (!result) throw new Error("hook did not render");
    return result;
  }

  /** The last value given to the `needs` state (slot 0), if any. */
  const lastNeeds = () =>
    harness.sets.filter((set) => set.slot === 0).at(-1)?.value;

  it("REAUTH_REQUIRED shows the panel and asks for the password too", () => {
    const step = stepUp(true);
    const shown = step.capture(
      new ApiError(401, "REAUTH_REQUIRED", "Verifikasi ulang."),
    );
    expect(shown).toBe(true);
    expect(lastNeeds()).toEqual({ mfa: true, password: true });
  });

  it("MFA_REQUIRED shows the panel", () => {
    const step = stepUp(true);
    expect(step.capture(new ApiError(403, "MFA_REQUIRED", "MFA."))).toBe(true);
    expect(lastNeeds()).toEqual(expect.objectContaining({ mfa: true }));
  });

  it("an endpoint that takes no password never asks for one", () => {
    const step = stepUp(false);
    expect(step.capture(new ApiError(401, "REAUTH_REQUIRED", "x"))).toBe(true);
    expect(lastNeeds()).toEqual({ mfa: true, password: false });
  });

  it("a wrong password is the caller's to show, and the password field reopens", () => {
    const step = stepUp(true);
    const shown = step.capture(wrongPassword());
    expect(shown).toBe(false);
    expect(lastNeeds()).toEqual({ mfa: true, password: true });
    // Another round so the panel starts a fresh attempt.
    expect(harness.sets.some((set) => set.slot === 1)).toBe(true);
  });

  it("a locked account is the caller's to show and closes the panel", () => {
    const step = stepUp(true);
    const shown = step.capture(lockedAccount());
    expect(shown).toBe(false);
    expect(lastNeeds()).toEqual({ mfa: false, password: false });
  });

  it("any other error is shown by the caller and leaves the panel alone", () => {
    const step = stepUp(true);
    expect(step.capture(new ApiError(409, "PAYOUT_BATCH_STATE", "x"))).toBe(
      false,
    );
    expect(step.capture(new Error("boom"))).toBe(false);
    expect(harness.sets).toHaveLength(0);
  });

  it("reset closes the panel", () => {
    const step = stepUp(true);
    step.reset();
    expect(lastNeeds()).toEqual({ mfa: false, password: false });
  });
});

describe("payout-password-stepup: panel", () => {
  function panel(error: string | null, onVerified = () => {}) {
    return renderToString(
      createElement(
        QueryClientProvider,
        { client: newClient() },
        createElement(VerifyPanel, {
          needs: { mfa: false, password: true },
          busy: false,
          error,
          onVerified,
          onCancel: () => {},
        }),
      ),
    );
  }

  it("shows a password field, empty, with the refusal text in place", () => {
    const html = panel(INVALID_TEXT);
    expect(html).toContain('type="password"');
    expect(html).toContain(INVALID_TEXT);
    expect(html).not.toMatch(/type="password"[^>]*value="[^"]+"/);
    expect(html).not.toMatch(/value="[^"]+"[^>]*type="password"/);
  });

  it("shows no refusal when there is none", () => {
    const html = panel(null);
    expect(html).toContain('type="password"');
    expect(html).not.toContain(INVALID_TEXT);
    expect(html).not.toContain('role="alert"');
  });

  it("offers a way out without sending anything", () => {
    expect(panel(null)).toContain(t("payrollPayoutReview.verify.cancel"));
  });
});

describe("payout-password-stepup: double submit", () => {
  function deferred() {
    let release!: (value: unknown) => void;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  it("approve is observably pending while the first call is in flight", async () => {
    const gate = deferred();
    wire.next = () => gate.promise;
    const client = newClient();
    const approve = render(client, useApproveBatch);
    const first = settle(
      approve.mutateAsync({
        batchId: BATCH_ID,
        contentHash: CONTENT_HASH,
        sourceBankAccountId: null,
        password: "benar-123",
      }),
    );
    await vi.waitFor(() => expect(client.isMutating()).toBe(1));
    expect(wire.calls).toHaveLength(1);
    gate.release({});
    await first;
    await vi.waitFor(() => expect(client.isMutating()).toBe(0));
  });

  it("export is observably pending while the first call is in flight", async () => {
    const gate = deferred();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string, init?: RequestInit) => {
        fetched.push({
          url: String(url),
          method: init?.method,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        await gate.promise;
        return new Response("a,b\n", {
          status: 200,
          headers: { "content-disposition": 'attachment; filename="b.csv"' },
        });
      }),
    );
    const client = newClient();
    const download = render(client, useExportBatch);
    const first = settle(
      download.mutateAsync({ batchId: BATCH_ID, password: "benar-123" }),
    );
    await vi.waitFor(() => expect(client.isMutating()).toBe(1));
    expect(fetched).toHaveLength(1);
    gate.release(undefined);
    expect(await first).toBeNull();
    await vi.waitFor(() => expect(client.isMutating()).toBe(0));
  });

  it("config is observably pending while the first call is in flight", async () => {
    const gate = deferred();
    wire.next = () => gate.promise;
    const client = newClient();
    const save = render(client, () => useUpsertPayoutConfig(ENTITY_ID));
    const first = settle(save.mutateAsync(configInput("benar-123")));
    await vi.waitFor(() => expect(client.isMutating()).toBe(1));
    expect(wire.calls).toHaveLength(1);
    gate.release({});
    await first;
    await vi.waitFor(() => expect(client.isMutating()).toBe(0));
  });
});
