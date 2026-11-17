// Brief 1015 (legend-o2b4m): data layer of the payout recon clearance screen
// and the return-claim withdrawal (legend-xbagc, legend-snwnn).
//
// Pinned here, from the brief's "Antarmuka bersama" and the shared validators
// (not from the UI or the API implementation):
//   1. api.ts: one caller per endpoint, the right method, path and body; ids
//      are path parameters and never part of a body; `password` and `reason`
//      travel in the JSON body.
//   2. hooks.ts: every mutation refreshes the query it changes, on success and
//      on a 409 (the data moved under the user); the refusal still reaches the
//      caller as the API's ApiError.
//   3. errors.ts: the recon and withdraw codes read as catalog text, never the
//      generic message; `isReconConflict` / `isWithdrawConflict` tell the
//      screen when to reload and offer a new proposal.
//
// Assumptions (the brief gives names but not the mutation argument shapes):
//   - The hooks take one object that mirrors the api caller's arguments:
//     useProposeReconClearance  -> { flagId, reason, password }
//     useApproveReconClearance  -> { clearanceId, password }
//     useProposeReturnWithdrawal(batchId) -> { claimId, reason, password }
//     useApproveReturnWithdrawal(batchId) -> { withdrawalId, password }
//   - api.ts functions return the unwrapped `data` of the route response
//     (`{ clearanceId }` / `{ withdrawalId }`) and the list as a plain array.
//     The mocked transport answers contract-shaped bodies (the approve of a
//     withdrawal also names `restoredItems`), because the caller validates.
//   - A refused withdrawal (PAYOUT-93 / PAYOUT-95) comes back as HTTP 409 with
//     the codes PAYOUT_RETURN_WITHDRAW_REFUSED / PAYOUT_RETURN_WITHDRAW_STATE
//     (the two codes `isWithdrawConflict` in errors.ts accepts).
//   - Invalidation is read from the query cache: a query seeded under
//     `payoutReconFlagsQuery().queryKey` / `batchReturnClaimsQuery(id).queryKey`
//     must be marked invalid after the mutation.
//
// Harness: server rendering (`renderToString`) runs the hook, the returned
// mutation is driven from the test; `apiFetch` is replaced. No browser.

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

const wire = vi.hoisted(() => ({
  calls: [] as { path: string; method?: string; body?: unknown }[],
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

import * as api from "@/features/ws10-payroll-payout/api.ts";
import * as errors from "@/features/ws10-payroll-payout/errors.ts";
import {
  useApproveReconClearance,
  useApproveReturnWithdrawal,
  usePayoutReconFlags,
  useProposeReconClearance,
  useProposeReturnWithdrawal,
} from "@/features/ws10-payroll-payout/hooks.ts";
import {
  batchReturnClaimsQuery,
  payoutReconFlagsQuery,
} from "@/features/ws10-payroll-payout/queries.ts";

const t = createTranslator(messagesId);
const GENERIC_TEXT = t("payrollPayout.error.generic" as MessageKey);

const FLAG_ID = randomUUID();
const CLEARANCE_ID = randomUUID();
const BATCH_ID = randomUUID();
const CLAIM_ID = randomUUID();
const WITHDRAWAL_ID = randomUUID();
const REASON = "Selisih nominal sudah dicek terhadap mutasi bank.";

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

async function settle(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

function only(suffix: string) {
  const found = wire.calls.filter((call) => call.path.endsWith(suffix));
  expect(found).toHaveLength(1);
  return found[0]!;
}

beforeEach(() => {
  wire.calls.length = 0;
  wire.next = undefined;
});

describe("payout-recon-data: api paths and bodies", () => {
  it("lists recon flags with a GET and returns the plain array", async () => {
    const flag = {
      id: FLAG_ID,
      kind: "return",
      itemId: randomUUID(),
      payslipId: randomUUID(),
      batchId: BATCH_ID,
      reason: "Selisih nominal",
      flaggedAt: "2026-11-17T07:10:00.000Z",
      reopened: false,
      clearance: null,
    };
    wire.next = async () => ({ data: [flag] });
    const result = await api.listPayoutReconFlags();
    const call = only("/api/hris/payroll/payout-recon-flags");
    expect(call.method ?? "GET").toBe("GET");
    expect(result).toEqual([flag]);
  });

  it("proposes a clearance: POST to the flag, reason and password in the body", async () => {
    wire.next = async () => ({ data: { clearanceId: CLEARANCE_ID } });
    const result = await api.proposeReconClearance(FLAG_ID, {
      reason: REASON,
      password: "benar-123",
    });
    const call = only(
      `/api/hris/payroll/payout-recon-flags/${FLAG_ID}/clearance`,
    );
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ reason: REASON, password: "benar-123" });
    expect(call.body).not.toHaveProperty("flagId");
    expect(result).toEqual({ clearanceId: CLEARANCE_ID });
  });

  it("approves a clearance: POST to the clearance, only the password in the body", async () => {
    wire.next = async () => ({ data: { clearanceId: CLEARANCE_ID } });
    await api.approveReconClearance(CLEARANCE_ID, { password: "benar-123" });
    const call = only(
      `/api/hris/payroll/payout-recon-clearances/${CLEARANCE_ID}/approve`,
    );
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ password: "benar-123" });
  });

  it("lists the return claims of one batch with a GET", async () => {
    wire.next = async () => ({ data: [] });
    const result = await api.listBatchReturnClaims(BATCH_ID);
    const call = only(
      `/api/hris/payroll/disbursement-batches/${BATCH_ID}/return-claims`,
    );
    expect(call.method ?? "GET").toBe("GET");
    expect(result).toEqual([]);
  });

  it("proposes a withdrawal of a claim: POST to the claim, reason and password in the body", async () => {
    wire.next = async () => ({ data: { withdrawalId: WITHDRAWAL_ID } });
    const result = await api.proposeReturnWithdrawal(CLAIM_ID, {
      reason: REASON,
      password: "benar-123",
    });
    const call = only(
      `/api/hris/payroll/payout-return-claims/${CLAIM_ID}/withdrawal`,
    );
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ reason: REASON, password: "benar-123" });
    expect(call.body).not.toHaveProperty("claimId");
    expect(result).toEqual({ withdrawalId: WITHDRAWAL_ID });
  });

  it("approves a withdrawal: POST to the withdrawal, only the password in the body", async () => {
    wire.next = async () => ({
      data: { withdrawalId: WITHDRAWAL_ID, restoredItems: 1 },
    });
    await api.approveReturnWithdrawal(WITHDRAWAL_ID, { password: "benar-123" });
    const call = only(
      `/api/hris/payroll/payout-return-withdrawals/${WITHDRAWAL_ID}/approve`,
    );
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ password: "benar-123" });
  });
});

describe("payout-recon-data: queries sit under the payout key", () => {
  it("keys the recon flags and the batch claims under 'payroll-payout'", () => {
    expect(payoutReconFlagsQuery().queryKey).toEqual(
      expect.arrayContaining(["payroll-payout"]),
    );
    expect(batchReturnClaimsQuery(BATCH_ID).queryKey).toEqual(
      expect.arrayContaining(["payroll-payout"]),
    );
  });

  it("keeps the claims of two batches apart", () => {
    expect(batchReturnClaimsQuery(BATCH_ID).queryKey).not.toEqual(
      batchReturnClaimsQuery(randomUUID()).queryKey,
    );
  });
});

describe("payout-recon-data: recon mutations refresh the flag list", () => {
  function seededClient() {
    const client = newClient();
    client.setQueryData(payoutReconFlagsQuery().queryKey, []);
    expect(
      client.getQueryState(payoutReconFlagsQuery().queryKey)?.isInvalidated,
    ).toBe(false);
    return client;
  }
  const stale = (client: QueryClient) =>
    client.getQueryState(payoutReconFlagsQuery().queryKey)?.isInvalidated;

  it("propose: sends the request and refreshes the list on success", async () => {
    wire.next = async () => ({ data: { clearanceId: CLEARANCE_ID } });
    const client = seededClient();
    const propose = render(client, useProposeReconClearance);
    const error = await settle(
      propose.mutateAsync({
        flagId: FLAG_ID,
        reason: REASON,
        password: "benar-123",
      }),
    );
    expect(error).toBeNull();
    expect(only(`/payout-recon-flags/${FLAG_ID}/clearance`).body).toEqual({
      reason: REASON,
      password: "benar-123",
    });
    expect(stale(client)).toBe(true);
  });

  it("approve: refreshes the list on success", async () => {
    wire.next = async () => ({ data: { clearanceId: CLEARANCE_ID } });
    const client = seededClient();
    const approve = render(client, useApproveReconClearance);
    const error = await settle(
      approve.mutateAsync({ clearanceId: CLEARANCE_ID, password: "benar-123" }),
    );
    expect(error).toBeNull();
    expect(stale(client)).toBe(true);
  });

  it("approve on PAYOUT_RECON_FLAG_CHANGED (409): error reaches the caller and the list is refreshed", async () => {
    wire.next = async () => {
      throw new ApiError(409, "PAYOUT_RECON_FLAG_CHANGED", "Data berubah.");
    };
    const client = seededClient();
    const approve = render(client, useApproveReconClearance);
    const error = await settle(
      approve.mutateAsync({ clearanceId: CLEARANCE_ID, password: "benar-123" }),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("PAYOUT_RECON_FLAG_CHANGED");
    expect(stale(client)).toBe(true);
  });

  it("approve on PAYOUT_RECON_CLEAR_STATE (409): list is refreshed too", async () => {
    wire.next = async () => {
      throw new ApiError(409, "PAYOUT_RECON_CLEAR_STATE", "Sudah disetujui.");
    };
    const client = seededClient();
    const approve = render(client, useApproveReconClearance);
    await settle(
      approve.mutateAsync({ clearanceId: CLEARANCE_ID, password: "benar-123" }),
    );
    expect(stale(client)).toBe(true);
  });

  it("propose on a 409: list is refreshed", async () => {
    wire.next = async () => {
      throw new ApiError(409, "PAYOUT_RECON_CLEAR_STATE", "Sudah disetujui.");
    };
    const client = seededClient();
    const propose = render(client, useProposeReconClearance);
    await settle(
      propose.mutateAsync({
        flagId: FLAG_ID,
        reason: REASON,
        password: "benar-123",
      }),
    );
    expect(stale(client)).toBe(true);
  });

  it("a self-approval refusal (403) is not a conflict: error passes through", async () => {
    wire.next = async () => {
      throw new ApiError(403, "PAYOUT_RECON_CLEAR_SELF_APPROVAL", "Ditolak.");
    };
    const client = seededClient();
    const approve = render(client, useApproveReconClearance);
    const error = await settle(
      approve.mutateAsync({ clearanceId: CLEARANCE_ID, password: "benar-123" }),
    );
    expect((error as ApiError).code).toBe("PAYOUT_RECON_CLEAR_SELF_APPROVAL");
  });

  it("usePayoutReconFlags is a query hook that renders without data first", () => {
    const flags = render(newClient(), usePayoutReconFlags);
    expect(flags.data).toBeUndefined();
    expect(flags.isPending).toBe(true);
  });
});

describe("payout-recon-data: withdraw mutations refresh the batch claims", () => {
  function seededClient() {
    const client = newClient();
    client.setQueryData(batchReturnClaimsQuery(BATCH_ID).queryKey, []);
    return client;
  }
  const stale = (client: QueryClient) =>
    client.getQueryState(batchReturnClaimsQuery(BATCH_ID).queryKey)
      ?.isInvalidated;

  it("propose: sends the request and refreshes this batch's claims", async () => {
    wire.next = async () => ({ data: { withdrawalId: WITHDRAWAL_ID } });
    const client = seededClient();
    const propose = render(client, () => useProposeReturnWithdrawal(BATCH_ID));
    const error = await settle(
      propose.mutateAsync({
        claimId: CLAIM_ID,
        reason: REASON,
        password: "benar-123",
      }),
    );
    expect(error).toBeNull();
    expect(only(`/payout-return-claims/${CLAIM_ID}/withdrawal`).body).toEqual({
      reason: REASON,
      password: "benar-123",
    });
    expect(stale(client)).toBe(true);
  });

  it("approve: refreshes this batch's claims on success", async () => {
    wire.next = async () => ({
      data: { withdrawalId: WITHDRAWAL_ID, restoredItems: 1 },
    });
    const client = seededClient();
    const approve = render(client, () => useApproveReturnWithdrawal(BATCH_ID));
    const error = await settle(
      approve.mutateAsync({
        withdrawalId: WITHDRAWAL_ID,
        password: "benar-123",
      }),
    );
    expect(error).toBeNull();
    expect(stale(client)).toBe(true);
  });

  it.each(["PAYOUT_RETURN_WITHDRAW_REFUSED", "PAYOUT_RETURN_WITHDRAW_STATE"])(
    "approve on %s (409): error reaches the caller and the claims are refreshed",
    async (code) => {
      wire.next = async () => {
        throw new ApiError(409, code, "Ditolak.");
      };
      const client = seededClient();
      const approve = render(client, () =>
        useApproveReturnWithdrawal(BATCH_ID),
      );
      const error = await settle(
        approve.mutateAsync({
          withdrawalId: WITHDRAWAL_ID,
          password: "benar-123",
        }),
      );
      expect((error as ApiError).code).toBe(code);
      expect(stale(client)).toBe(true);
    },
  );

  it("propose on a 409: claims are refreshed", async () => {
    wire.next = async () => {
      throw new ApiError(
        409,
        "PAYOUT_RETURN_WITHDRAW_REFUSED",
        "Tidak bisa ditarik.",
      );
    };
    const client = seededClient();
    const propose = render(client, () => useProposeReturnWithdrawal(BATCH_ID));
    await settle(
      propose.mutateAsync({
        claimId: CLAIM_ID,
        reason: REASON,
        password: "benar-123",
      }),
    );
    expect(stale(client)).toBe(true);
  });
});

describe("payout-recon-data: error catalog", () => {
  const cases: [string, number, string][] = [
    [
      "PAYOUT_RECON_FLAG_CHANGED",
      409,
      "payrollPayoutReview.error.reconFlagChanged",
    ],
    [
      "PAYOUT_RECON_CLEAR_STATE",
      409,
      "payrollPayoutReview.error.reconClearState",
    ],
    [
      "PAYOUT_RECON_CLEAR_SELF_APPROVAL",
      403,
      "payrollPayoutReview.error.reconClearSelfApproval",
    ],
    [
      "PAYOUT_RECON_CLEAR_REASON_INVALID",
      422,
      "payrollPayoutReview.error.reconClearReasonInvalid",
    ],
    [
      "PAYOUT_RETURN_WITHDRAW_STATE",
      409,
      "payrollPayoutReview.error.returnWithdrawState",
    ],
    [
      "PAYOUT_RETURN_WITHDRAW_REFUSED",
      409,
      "payrollPayoutReview.error.returnWithdrawRefused",
    ],
  ];

  it.each(cases)("%s reads as its catalog text", (code, status, key) => {
    const error = new ApiError(status, code, "Teks mentah dari API.");
    const text = payoutErrorMessageOf(error);
    expect(text).toBe(t(key as MessageKey));
    expect(text).not.toBe(GENERIC_TEXT);
    expect(text).not.toBe("Teks mentah dari API.");
  });

  it("the 'changed' refusal tells the user to file a new proposal", () => {
    const text = payoutErrorMessageOf(
      new ApiError(409, "PAYOUT_RECON_FLAG_CHANGED", "x"),
    );
    expect(text).toMatch(/usulan/i);
    expect(text).toMatch(/baru/i);
  });

  it("isReconConflict is true for the 409 recon codes only", () => {
    expect(typeof errors.isReconConflict).toBe("function");
    expect(
      errors.isReconConflict(
        new ApiError(409, "PAYOUT_RECON_FLAG_CHANGED", "x"),
      ),
    ).toBe(true);
    expect(
      errors.isReconConflict(
        new ApiError(409, "PAYOUT_RECON_CLEAR_STATE", "x"),
      ),
    ).toBe(true);
    expect(
      errors.isReconConflict(
        new ApiError(403, "PAYOUT_RECON_CLEAR_SELF_APPROVAL", "x"),
      ),
    ).toBe(false);
    expect(
      errors.isReconConflict(new ApiError(403, "REAUTH_PASSWORD_INVALID", "x")),
    ).toBe(false);
    expect(errors.isReconConflict(new Error("offline"))).toBe(false);
  });

  it("isWithdrawConflict is true for the 409 withdraw codes only", () => {
    expect(typeof errors.isWithdrawConflict).toBe("function");
    expect(
      errors.isWithdrawConflict(
        new ApiError(409, "PAYOUT_RETURN_WITHDRAW_REFUSED", "x"),
      ),
    ).toBe(true);
    expect(
      errors.isWithdrawConflict(
        new ApiError(409, "PAYOUT_RETURN_WITHDRAW_STATE", "x"),
      ),
    ).toBe(true);
    expect(
      errors.isWithdrawConflict(
        new ApiError(403, "PAYOUT_RETURN_WITHDRAW_SELF_APPROVAL", "x"),
      ),
    ).toBe(false);
    expect(errors.isWithdrawConflict(new Error("offline"))).toBe(false);
  });
});

function payoutErrorMessageOf(error: unknown) {
  return errors.payoutErrorMessage(error, t);
}
