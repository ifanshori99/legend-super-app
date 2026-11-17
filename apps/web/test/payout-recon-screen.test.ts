// Brief 1015 (legend-o2b4m): the payout recon screen ("Flag rekonsiliasi
// payout") and the return-claim withdrawal UI, as a finance user sees them.
//
// Pinned here (from the brief, the approved mockup notes and the shared DTOs,
// not from the implementation):
//   1. A flag the current user proposed cannot be approved by that user: the
//      approve button is disabled and an explanation says someone else must do
//      it. The check compares user ids. Another user gets an enabled button.
//   2. Status labels: Terbuka (no clearance), Diusulkan (proposed), Disetujui
//      (approved), Terbuka ulang (reopened, with "Clearance lama tidak
//      berlaku"). An open flag shows no proposed/approved label.
//   3. Loading and empty states read as such; neither shows an approve button.
//   4. Nothing on the screen pays or transfers money: no pay button, and no
//      "gaji sudah dibayar" / "slip pasti dapat dibayar" promise.
//   5. A password field, if it is on screen, starts empty (never pre-filled).
//   6. Return claims: an open claim offers a withdraw proposal; a claim with an
//      open withdrawal proposed by me cannot be approved by me (disabled +
//      explanation), another user can approve; consumed and withdrawn claims
//      offer no withdraw action.
//
// Not covered here (needs a browser, see e2e/payout-recon-clearance.mock.spec.ts):
// password required before submit, password cleared after submit or close,
// and the 409 "changed" flow offering a new proposal.
//
// ASSUMPTIONS:
//   - `components/recon-page.tsx` exports `ReconPage({ currentUserId })`
//     (the route passes only that; `access` is passed too and ignored if the
//     page does not take it).
//   - With one flag on the screen, it is the selected one, so its detail panel
//     (approve button, self-proposer note) renders on the first server render.
//   - `components/return-withdraw.tsx` exports
//     `ReturnWithdrawSection({ batchId, currentUserId, isCreator })`.
//   - All visible text is read from the Indonesian catalog
//     (`payrollPayoutReview.recon.*`, `payrollPayoutReview.returnWithdraw.*`),
//     so a wording change in the catalog does not break these tests.
//   - Flags and claims come from the query cache seeded under
//     `payoutReconFlagsQuery()` / `batchReturnClaimsQuery(batchId)` as plain
//     arrays; server rendering never fetches.
//
// Harness: `renderToString` inside a QueryClientProvider, like
// payout-password-stepup.test.ts. No browser, no jsdom.

import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  PayoutReconFlagDto,
  PayoutReturnClaimDto,
} from "@starter/shared/types";

vi.mock("@/lib/api/client", async () => ({
  ...(await import("@/lib/api/errors")),
  apiFetch: async () => ({}),
}));

import { isNotFound } from "@tanstack/react-router";
import type { AreaAccess } from "@/lib/areas/access.ts";
import { reconGuard } from "@/features/ws10-payroll-payout/recon-guard.ts";
import { ReconPage } from "@/features/ws10-payroll-payout/components/recon-page.tsx";
import { ReturnWithdrawSection } from "@/features/ws10-payroll-payout/components/return-withdraw.tsx";
import {
  createTranslator,
  messagesId,
  type MessageKey,
} from "@starter/shared/i18n";
import {
  batchQuery,
  batchReturnClaimsQuery,
  payoutReconFlagsQuery,
} from "@/features/ws10-payroll-payout/queries.ts";

const t = createTranslator(messagesId);
const text = (key: string) => t(`payrollPayoutReview.${key}` as MessageKey);

const ME = randomUUID();
const OTHER = randomUUID();
const BATCH_ID = randomUUID();

const ACCESS = {
  canView: true,
  canConfigure: false,
  canRequest: false,
  canApprove: true,
};

const NOW = "2026-11-17T07:10:00.000Z";

function flag(overrides: Partial<PayoutReconFlagDto> = {}): PayoutReconFlagDto {
  return {
    id: randomUUID(),
    kind: "amount_mismatch",
    itemId: randomUUID(),
    payslipId: randomUUID(),
    batchId: BATCH_ID,
    reason: "Nominal transfer berbeda dari gaji bersih",
    flaggedAt: NOW,
    reopened: false,
    clearance: null,
    ...overrides,
  };
}

function proposed(by: string): PayoutReconFlagDto["clearance"] {
  return {
    id: randomUUID(),
    status: "proposed",
    reason: "Selisih sudah dicocokkan dengan mutasi bank",
    proposedBy: by,
    proposedAt: NOW,
    approvedBy: null,
    approvedAt: null,
  };
}

function approved(): PayoutReconFlagDto["clearance"] {
  return {
    ...proposed(OTHER)!,
    status: "approved",
    approvedBy: ME,
    approvedAt: NOW,
  };
}

/**
 * A minimal batch for the flags of one batch: one item per flag, matching by
 * item id, payslip id and batch id. The page joins names and amounts from it
 * and shows a skeleton instead of the panel while it loads.
 */
function batchFor(batchId: string, flags: PayoutReconFlagDto[]) {
  return {
    data: {
      id: batchId,
      legalEntityId: randomUUID(),
      payrollRunId: randomUUID(),
      channel: "manual_bank",
      status: "approved",
      haltReason: null,
      requestedBy: OTHER,
      requestedAt: NOW,
      approvedBy: null,
      approvedAt: null,
      approvalExpiresAt: null,
      contentHash: null,
      sourceBankAccountId: null,
      itemCount: flags.length,
      totalIdr: flags.length * 5_000_000,
      bankFormat: null,
      exportChecksumSha256: null,
      exportedBy: null,
      exportedAt: null,
      cancelledBy: null,
      cancelledAt: null,
      cancelReason: null,
      createdAt: NOW,
      updatedAt: NOW,
      freeze: { frozen: false },
      items: flags.map((row) => ({
        id: row.itemId,
        batchId,
        payslipId: row.payslipId,
        employeeId: randomUUID(),
        channel: "manual_bank",
        attemptNo: 1,
        status: "succeeded",
        excludedReason: null,
        amountIdr: 5_000_000,
        feeIdr: 5_000,
        bankCode: "BCA",
        accountHolderName: "Pemilik Rekening",
        maskedAccountNumber: "****1234",
        nameMatch: true,
        providerRef: null,
        confirmedBy: null,
        confirmationRef: null,
        settledAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    },
  };
}

/**
 * `batch: "loading"` leaves the batches out of the cache, so the page waits
 * for them (server rendering never fetches).
 */
function renderRecon(
  flags: PayoutReconFlagDto[] | undefined,
  currentUserId = ME,
  { batch = "ready" }: { batch?: "ready" | "loading" } = {},
): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (flags) {
    client.setQueryData(payoutReconFlagsQuery().queryKey, flags);
    if (batch === "ready")
      for (const batchId of new Set(flags.map((row) => row.batchId)))
        client.setQueryData(
          batchQuery(batchId).queryKey,
          batchFor(
            batchId,
            flags.filter((row) => row.batchId === batchId),
          ),
        );
  }
  return renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ReconPage, { access: ACCESS, currentUserId }),
    ),
  );
}

function claim(
  overrides: Partial<PayoutReturnClaimDto> = {},
): PayoutReturnClaimDto {
  return {
    id: randomUUID(),
    status: "open",
    bankRef: "TRX-0001",
    itemCount: 2,
    createdBy: randomUUID(),
    createdAt: NOW,
    withdrawal: null,
    ...overrides,
  };
}

function renderClaims(
  claims: PayoutReturnClaimDto[] | undefined,
  currentUserId = ME,
  isCreator = false,
): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (claims)
    client.setQueryData(batchReturnClaimsQuery(BATCH_ID).queryKey, claims);
  return renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ReturnWithdrawSection, {
        batchId: BATCH_ID,
        currentUserId,
        isCreator,
      }),
    ),
  );
}

type Button = { attrs: string; text: string; disabled: boolean };

/** Every <button> in the markup with its visible text. */
function buttons(html: string): Button[] {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(
    (match) => {
      const attrs = match[1] ?? "";
      return {
        attrs,
        text: (match[2] ?? "").replace(/<[^>]*>/g, "").trim(),
        disabled: /\sdisabled(=|\s|$)/.test(` ${attrs}`),
      };
    },
  );
}

const APPROVE = new RegExp(text("recon.approve.submit"));

const named = (html: string, name: RegExp) =>
  buttons(html).filter((button) => name.test(button.text));

const visibleText = (html: string) =>
  html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("payout-recon-screen: self-proposer cannot approve", () => {
  // The h1 "Flag rekonsiliasi payout" belongs to the area shell (route
  // comment), so the page itself is checked by its subtitle.
  it("shows the screen intro", () => {
    expect(visibleText(renderRecon([flag()]))).toContain(
      text("recon.subtitle"),
    );
  });

  it("disables 'Setujui clearance' for the proposer and explains why", () => {
    const html = renderRecon([flag({ clearance: proposed(ME) })], ME);
    const approve = named(html, APPROVE);
    expect(approve).toHaveLength(1);
    expect(approve[0]!.disabled).toBe(true);
    // Explanation: you proposed it, someone else must approve.
    expect(visibleText(html)).toContain(text("recon.self.body"));
  });

  it("enables 'Setujui clearance' for a different user", () => {
    const html = renderRecon([flag({ clearance: proposed(ME) })], OTHER);
    const approve = named(html, APPROVE);
    expect(approve).toHaveLength(1);
    expect(approve[0]!.disabled).toBe(false);
    expect(visibleText(html)).not.toContain(text("recon.self.body"));
  });

  it("compares user ids: a proposer with a different id is not 'self'", () => {
    // Same display text everywhere, only the ids differ.
    const html = renderRecon([flag({ clearance: proposed(OTHER) })], ME);
    expect(named(html, APPROVE)[0]?.disabled).toBe(false);
  });

  it("renders no approve button while the batch is still loading", () => {
    const html = renderRecon([flag({ clearance: proposed(OTHER) })], OTHER, {
      batch: "loading",
    });
    expect(named(html, APPROVE)).toHaveLength(0);
    expect(named(html, new RegExp(text("recon.propose.submit")))).toHaveLength(
      0,
    );
  });

  it("offers no approve action on an open flag with no proposal", () => {
    const html = renderRecon([flag()], ME);
    expect(named(html, APPROVE)).toHaveLength(0);
  });
});

describe("payout-recon-screen: status labels", () => {
  it("open flag reads Terbuka and nothing about a proposal", () => {
    const page = visibleText(renderRecon([flag()]));
    expect(page).toContain("Terbuka");
    expect(page).not.toContain("Diusulkan");
    expect(page).not.toContain("Disetujui");
    expect(page).not.toContain("Terbuka ulang");
  });

  it("proposed flag reads Diusulkan", () => {
    const page = visibleText(
      renderRecon([flag({ clearance: proposed(OTHER) })]),
    );
    expect(page).toContain("Diusulkan");
    expect(page).not.toContain("Terbuka ulang");
  });

  it("approved flag reads Disetujui", () => {
    const page = visibleText(renderRecon([flag({ clearance: approved() })]));
    expect(page).toContain("Disetujui");
    expect(page).not.toContain("Terbuka ulang");
  });

  it("reopened flag reads Terbuka ulang and says the old clearance no longer applies", () => {
    const page = visibleText(renderRecon([flag({ reopened: true })]));
    expect(page).toContain("Terbuka ulang");
    expect(page).toContain("Clearance lama tidak berlaku");
  });

  it("reopened flag with a new proposal keeps the reopened mark", () => {
    const page = visibleText(
      renderRecon([flag({ reopened: true, clearance: proposed(OTHER) })]),
    );
    expect(page).toContain("Diusulkan");
    expect(page).toContain("Terbuka ulang");
  });

  it("a list with all four kinds shows every label", () => {
    const page = visibleText(
      renderRecon([
        flag(),
        flag({ clearance: proposed(OTHER) }),
        flag({ clearance: approved() }),
        flag({ reopened: true }),
      ]),
    );
    for (const label of ["Diusulkan", "Disetujui", "Terbuka ulang"])
      expect(page).toContain(label);
    expect(page).toMatch(/Terbuka(?! ulang)/);
  });
});

describe("payout-recon-screen: loading and empty", () => {
  it("loading (no data yet) offers no approve action and no empty message", () => {
    const html = renderRecon(undefined);
    expect(named(html, APPROVE)).toHaveLength(0);
    expect(html).toContain(text("recon.loading"));
    expect(visibleText(html)).not.toContain(text("recon.empty.title"));
  });

  it("no flags reads as empty and offers no approve action", () => {
    const html = renderRecon([]);
    expect(visibleText(html)).toContain(text("recon.empty.title"));
    expect(named(html, APPROVE)).toHaveLength(0);
  });
});

describe("payout-recon-screen: no pay action", () => {
  const states = {
    open: [flag()],
    proposed: [flag({ clearance: proposed(OTHER) })],
    approved: [flag({ clearance: approved() })],
    reopened: [flag({ reopened: true })],
  };

  it.each(Object.entries(states))(
    "%s: no pay, transfer or download button",
    (_name, flags) => {
      const html = renderRecon(flags, OTHER);
      expect(
        named(html, /\b(bayar|bayarkan|transfer|cairkan|unduh|kirim dana)\b/i),
      ).toHaveLength(0);
    },
  );

  it.each(Object.entries(states))(
    "%s: copy never promises the salary is paid",
    (_name, flags) => {
      const page = visibleText(renderRecon(flags, OTHER));
      expect(page).not.toMatch(/gaji (sudah|telah) dibayar/i);
      expect(page).not.toMatch(/pasti dapat dibayar/i);
    },
  );
});

describe("payout-recon-screen: password field", () => {
  it("any password input starts empty and masked", () => {
    const html = renderRecon([flag({ clearance: proposed(OTHER) })], ME);
    const html2 = renderRecon([flag()], ME);
    for (const markup of [html, html2]) {
      const inputs = [
        ...markup.matchAll(/<input\b[^>]*type="password"[^>]*>/g),
      ];
      for (const input of inputs)
        expect(input[0]).not.toMatch(/\svalue="[^"]+"/);
    }
  });
});

const PROPOSE = new RegExp(text("returnWithdraw.action.propose"));
const APPROVE_WITHDRAW = new RegExp(text("returnWithdraw.action.approve"));

function withdrawal(proposedBy: string): PayoutReturnClaimDto["withdrawal"] {
  return {
    id: randomUUID(),
    reason: "Klaim dicatat salah, bank belum mengembalikan dana",
    proposedBy,
    proposedAt: NOW,
  };
}

describe("payout-recon-screen: return claim withdrawal", () => {
  it("an open claim offers an enabled withdraw proposal", () => {
    const html = renderClaims([claim()]);
    const propose = named(html, PROPOSE);
    expect(propose).toHaveLength(1);
    expect(propose[0]!.disabled).toBe(false);
    expect(visibleText(html)).toContain(text("returnWithdraw.status.open"));
  });

  it("the batch requester cannot propose, and is told why", () => {
    const html = renderClaims([claim()], ME, true);
    expect(named(html, PROPOSE)[0]?.disabled).toBe(true);
    expect(visibleText(html)).toContain(text("returnWithdraw.blocked.creator"));
  });

  it.each(["consumed", "withdrawn"] as const)(
    "a %s claim offers no withdraw or approve action",
    (status) => {
      const html = renderClaims([claim({ status })]);
      expect(named(html, PROPOSE)).toHaveLength(0);
      expect(named(html, APPROVE_WITHDRAW)).toHaveLength(0);
      expect(visibleText(html)).toContain(
        text(`returnWithdraw.status.${status}`),
      );
    },
  );

  it("a consumed claim says it can no longer be withdrawn", () => {
    expect(
      visibleText(renderClaims([claim({ status: "consumed" })])),
    ).toContain(text("returnWithdraw.blocked.consumed"));
  });

  it("a claim with my own pending withdrawal cannot be approved by me", () => {
    const html = renderClaims([claim({ withdrawal: withdrawal(ME) })], ME);
    const approve = named(html, APPROVE_WITHDRAW);
    expect(approve).toHaveLength(1);
    expect(approve[0]!.disabled).toBe(true);
    expect(visibleText(html)).toContain(text("returnWithdraw.blocked.self"));
    expect(visibleText(html)).toContain(text("returnWithdraw.status.proposed"));
  });

  it("another user can approve that withdrawal", () => {
    const html = renderClaims([claim({ withdrawal: withdrawal(ME) })], OTHER);
    const approve = named(html, APPROVE_WITHDRAW);
    expect(approve).toHaveLength(1);
    expect(approve[0]!.disabled).toBe(false);
    expect(visibleText(html)).not.toContain(
      text("returnWithdraw.blocked.self"),
    );
  });

  it("no claims reads as empty", () => {
    expect(visibleText(renderClaims([]))).toContain(
      text("returnWithdraw.empty.title"),
    );
  });

  it("claims still loading read as loading, with no actions", () => {
    const html = renderClaims(undefined);
    expect(html).toContain(text("returnWithdraw.loading"));
    expect(named(html, PROPOSE)).toHaveLength(0);
  });

  it("copy does not promise money moves", () => {
    const html = renderClaims([claim(), claim({ withdrawal: withdrawal(ME) })]);
    expect(visibleText(html)).not.toMatch(/gaji (sudah|telah) dibayar/i);
    expect(named(html, /\b(bayar|transfer|cairkan)\b/i)).toHaveLength(0);
  });
});

describe("payout-recon-screen: 200-flag limit note", () => {
  const batchA = randomUUID();
  const batchB = randomUUID();
  const many = (count: number, batchId: string) =>
    Array.from({ length: count }, () => flag({ batchId }));

  it("shows the limit note when the full list hit 200, even if each batch has fewer", () => {
    const html = renderRecon([...many(120, batchA), ...many(80, batchB)]);
    expect(visibleText(html)).toContain(text("recon.list.limit"));
  });

  it("shows the limit note when all 200 flags are in one batch", () => {
    const html = renderRecon(many(200, batchA));
    expect(visibleText(html)).toContain(text("recon.list.limit"));
  });

  it("does not show the note below 200", () => {
    const html = renderRecon([...many(120, batchA), ...many(79, batchB)]);
    expect(visibleText(html)).not.toContain(text("recon.list.limit"));
  });
});

describe("payout-recon-screen: page guard", () => {
  // Assumption: access shape of lib/areas/access.ts; MFA is not required, so
  // only the permission decides (the guard needs payroll.disburse.approve,
  // the same permission as the API routes).
  const access = (permissions: AreaAccess["permissions"]): AreaAccess => ({
    authenticated: true,
    permissions,
    mfaRequired: false,
    mfaVerified: false,
    stations: [],
    outlets: [],
  });
  const run = (value: AreaAccess) => reconGuard({ context: { access: value } });

  it("passes with payroll.disburse.approve", () => {
    expect(() => run(access(["payroll.disburse.approve"]))).not.toThrow();
  });

  it.each([
    ["no permission", [] as AreaAccess["permissions"]],
    ["payroll.view only", ["payroll.view"] as AreaAccess["permissions"]],
    [
      "payroll.disburse.request only",
      ["payroll.disburse.request"] as AreaAccess["permissions"],
    ],
  ])("throws notFound with %s", (_name, permissions) => {
    let thrown: unknown;
    try {
      run(access(permissions));
    } catch (error) {
      thrown = error;
    }
    expect(isNotFound(thrown)).toBe(true);
  });

  it("throws notFound for a signed-out visitor", () => {
    let thrown: unknown;
    try {
      run({ ...access(["payroll.disburse.approve"]), authenticated: false });
    } catch (error) {
      thrown = error;
    }
    expect(isNotFound(thrown)).toBe(true);
  });
});
