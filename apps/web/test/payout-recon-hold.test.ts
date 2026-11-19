// Brief 1192 (legend-6o7pc): the "Hold slip" section of the payout recon screen
// and its link from the finance exceptions list, as a finance user sees them.
//
// Pinned here (from the sub-brief and the shared DTO `PayoutReconHoldDto`):
//   1. Status labels: Ditahan (no release), Diusulkan lepas (release proposed),
//      Dilepas (release approved), Sudah diambil alih flag (a later flag took
//      the hold over; this wins over any release).
//   2. A release can be proposed only when the evidence is clean (`releasable`)
//      and no release exists; otherwise the button is absent and the slip stays
//      held with an explanation.
//   3. The person who proposed a release cannot approve it: the approve button
//      is disabled and explained (compared by user id); another user can.
//   4. A hold a flag took over, and a released hold, offer no action.
//   5. Loading, empty and error states read as such. Nothing on the screen pays
//      or promises payment, and no password field starts filled.
//   6. The finance exceptions list knows the kind `payout_recon_hold` and links
//      it (and the flag kind) to the recon screen; other kinds have no link.
//
// Not covered here (needs a browser, see e2e/payout-recon-hold.mock.spec.ts):
// password required before submit and cleared after, the 409 reload flow.
//
// Harness: `renderToString` inside a QueryClientProvider, like
// payout-recon-screen.test.ts. The holds come from the query cache; server
// rendering never fetches.

import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/api/client", async () => ({
  ...(await import("@/lib/api/errors")),
  apiFetch: async () => ({}),
}));

import type { PayoutReconHoldDto } from "@starter/shared/types";
import { ReconPage } from "@/features/ws10-payroll-payout/components/recon-page.tsx";
import {
  canProposeRelease,
  holdStatus,
  isOwnRelease,
  sortHolds,
} from "@/features/ws10-payroll-payout/components/recon-hold-model.ts";
import {
  payoutReconFlagsQuery,
  payoutReconHoldsQuery,
} from "@/features/ws10-payroll-payout/queries.ts";
import {
  reconScreenPath,
  refTypeKey,
} from "@/features/ws07-finance-exceptions/lib.ts";
import {
  createTranslator,
  messagesId,
  type MessageKey,
} from "@starter/shared/i18n";

const t = createTranslator(messagesId);
const text = (key: string) =>
  t(`payrollPayoutReview.reconHold.${key}` as MessageKey);

const ME = randomUUID();
const OTHER = randomUUID();
const NOW = "2026-11-17T07:10:00.000Z";

const ACCESS = {
  canView: true,
  canConfigure: false,
  canRequest: false,
  canApprove: true,
};

function hold(overrides: Partial<PayoutReconHoldDto> = {}): PayoutReconHoldDto {
  return {
    id: randomUUID(),
    kind: "return",
    itemId: randomUUID(),
    payslipId: randomUUID(),
    batchId: randomUUID(),
    reason: "evidence_read_locked",
    heldAt: NOW,
    takenOver: false,
    releasable: true,
    release: null,
    ...overrides,
  };
}

function release(
  by: string,
  status: "proposed" | "approved" = "proposed",
): NonNullable<PayoutReconHoldDto["release"]> {
  return {
    id: randomUUID(),
    status,
    reason: "Bukti bank terbaca bersih pada pemeriksaan berikutnya.",
    proposedBy: by,
    proposedAt: NOW,
    approvedBy: status === "approved" ? OTHER : null,
    approvedAt: status === "approved" ? NOW : null,
  };
}

/** `holds: undefined` leaves the cache empty, so the section is loading. */
function renderRecon(
  holds: PayoutReconHoldDto[] | undefined,
  currentUserId = ME,
): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // No flags: the flag part reads as empty, the hold section stands on its own.
  client.setQueryData(payoutReconFlagsQuery().queryKey, []);
  if (holds) client.setQueryData(payoutReconHoldsQuery().queryKey, holds);
  return renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ReconPage, { access: ACCESS, currentUserId }),
    ),
  );
}

type Button = { text: string; disabled: boolean };

function buttons(html: string): Button[] {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(
    (match) => ({
      text: (match[2] ?? "").replace(/<[^>]*>/g, "").trim(),
      disabled: /\sdisabled(=|\s|$)/.test(` ${match[1] ?? ""}`),
    }),
  );
}

const named = (html: string, name: string) =>
  buttons(html).filter((button) => button.text === name);

const visibleText = (html: string) =>
  html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("payout-recon-hold: status", () => {
  it("reads Ditahan, Diusulkan lepas, Dilepas and Sudah diambil alih flag", () => {
    expect(holdStatus(hold())).toBe("held");
    expect(holdStatus(hold({ release: release(ME) }))).toBe("proposed");
    expect(holdStatus(hold({ release: release(ME, "approved") }))).toBe(
      "released",
    );
    expect(holdStatus(hold({ takenOver: true }))).toBe("takenOver");
  });

  it("lets a taken-over hold win over a release", () => {
    expect(
      holdStatus(hold({ takenOver: true, release: release(ME, "approved") })),
    ).toBe("takenOver");
  });

  it("shows each status in words on the screen", () => {
    const text_ = visibleText(
      renderRecon([
        hold(),
        hold({ release: release(OTHER) }),
        hold({ release: release(OTHER, "approved") }),
        hold({ takenOver: true }),
      ]),
    );
    for (const key of [
      "status.held",
      "status.proposed",
      "status.released",
      "status.takenOver",
    ])
      expect(text_).toContain(text(key));
  });

  it("lists holds that still hold a slip before the others", () => {
    const released = hold({ release: release(OTHER, "approved") });
    const held = hold();
    const takenOver = hold({ takenOver: true });
    expect(sortHolds([released, takenOver, held]).map((row) => row.id)).toEqual(
      [held.id, released.id, takenOver.id],
    );
  });
});

describe("payout-recon-hold: proposing a release", () => {
  it("offers 'Usulkan pelepasan' only when the evidence is clean", () => {
    const html = renderRecon([hold({ releasable: true })]);
    expect(named(html, text("propose.open"))).toHaveLength(1);
    expect(named(html, text("propose.open"))[0]!.disabled).toBe(false);
  });

  it("offers no proposal when the evidence is not clean and says the slip stays held", () => {
    const html = renderRecon([hold({ releasable: false })]);
    expect(named(html, text("propose.open"))).toHaveLength(0);
    expect(visibleText(html)).toContain(text("card.notClean"));
    expect(visibleText(html)).toContain(text("card.held"));
  });

  it("does not offer a second proposal while one waits", () => {
    const row = hold({ release: release(OTHER) });
    expect(canProposeRelease(row)).toBe(false);
    expect(named(renderRecon([row]), text("propose.open"))).toHaveLength(0);
  });

  it("opens no form by itself: no reason field and no password on first paint", () => {
    const html = renderRecon([hold()]);
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain('type="password"');
  });
});

describe("payout-recon-hold: self approval", () => {
  it("disables 'Setujui pelepasan' for the proposer and explains why", () => {
    const row = hold({ release: release(ME) });
    expect(isOwnRelease(row, ME)).toBe(true);
    const html = renderRecon([row], ME);
    const approve = named(html, text("approve.submit"));
    expect(approve).toHaveLength(1);
    expect(approve[0]!.disabled).toBe(true);
    expect(visibleText(html)).toContain(text("self.body"));
  });

  it("enables the button for a different user, with an empty password field", () => {
    const row = hold({ release: release(ME) });
    expect(isOwnRelease(row, OTHER)).toBe(false);
    const html = renderRecon([row], OTHER);
    const approve = named(html, text("approve.submit"));
    expect(approve).toHaveLength(1);
    expect(approve[0]!.disabled).toBe(false);
    expect(visibleText(html)).not.toContain(text("self.body"));
    const password = html.match(/<input\b[^>]*type="password"[^>]*>/g) ?? [];
    expect(password).toHaveLength(1);
    expect(password[0]).not.toMatch(/\svalue="[^"]+"/);
  });

  it("never treats an unknown user as the proposer", () => {
    expect(isOwnRelease(hold({ release: release(ME) }), "")).toBe(false);
  });
});

describe("payout-recon-hold: no action where none applies", () => {
  it("offers no button for a taken-over or a released hold", () => {
    const html = renderRecon([
      hold({ takenOver: true, releasable: false }),
      hold({ release: release(OTHER, "approved"), releasable: false }),
    ]);
    expect(named(html, text("propose.open"))).toHaveLength(0);
    expect(named(html, text("approve.submit"))).toHaveLength(0);
    expect(visibleText(html)).toContain(text("card.takenOver"));
    expect(visibleText(html)).toContain(text("card.releasedScope"));
  });
});

describe("payout-recon-hold: screen states", () => {
  it("reads as loading while the holds are not there, with no action", () => {
    const html = renderRecon(undefined);
    expect(html).toContain(text("loading"));
    expect(visibleText(html)).not.toContain(text("empty.title"));
    expect(named(html, text("propose.open"))).toHaveLength(0);
  });

  it("explains an empty list", () => {
    const html = renderRecon([]);
    expect(visibleText(html)).toContain(text("empty.title"));
    expect(visibleText(html)).toContain(text("title"));
  });

  it("shows the hold section even when there is no flag at all", () => {
    expect(visibleText(renderRecon([hold()]))).toContain(text("card.held"));
  });

  it("promises no payment", () => {
    const page = visibleText(
      renderRecon([
        hold(),
        hold({ release: release(OTHER) }),
        hold({ release: release(OTHER, "approved") }),
      ]),
    );
    expect(page).not.toMatch(/gaji (sudah|telah) dibayar/i);
    expect(page).not.toMatch(/pasti dapat dibayar/i);
  });
});

describe("finance exceptions: recon hold", () => {
  it("links the flag and hold kinds to the recon screen and nothing else", () => {
    expect(reconScreenPath("payout_recon_hold")).toBe(
      "/kelola/payroll/rekonsiliasi",
    );
    expect(reconScreenPath("payout_recon_flag")).toBe(
      "/kelola/payroll/rekonsiliasi",
    );
    expect(reconScreenPath("payout_proof_stuck")).toBeNull();
    expect(reconScreenPath("edge_receipt_skipped")).toBeNull();
  });

  it("names the hold reference type", () => {
    expect(refTypeKey("payout_recon_hold")).toBe(
      "financeExceptions.refTypes.payout_recon_hold",
    );
  });
});
