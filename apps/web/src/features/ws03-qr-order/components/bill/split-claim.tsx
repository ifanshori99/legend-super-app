// Claim button of one split part (legend-wwyyk, phone only): the guest who paid
// a part connects it to their account within 24 hours. The claim token comes
// with the payer secret kept at pay time and is handed out once, so it is kept
// in sessionStorage: coming back from /masuk shows "Lanjut ke akun" again from
// the kept token and never asks the server a second time.
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { BillSplit } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { effectiveClaimStatus, type ClaimView } from "../../domain.ts";
import { useSplitClaim } from "../../hooks";
import {
  dropSplitClaim,
  keepSplitClaim,
  storedSplitClaim,
} from "../../session-store.ts";
import { QrFooter } from "../glass/qr-primitives";
import { Notice } from "../notice";

export function SplitClaim({
  sessionId,
  qrToken,
  split,
  total,
}: {
  sessionId: string;
  qrToken: string;
  split: BillSplit;
  /** Live parts of the bill, for "X dari N bagian". */
  total: number;
}) {
  const t = useT();
  const claim = useSplitClaim(sessionId);
  // Read once per mount: the 24 h deadline does not need a ticking clock.
  const [now] = useState(() => Date.now());
  const paid = split.status === "paid";
  // The token kept from an earlier ask (a return from /masuk lands here).
  const [kept, setKept] = useState(() =>
    paid ? storedSplitClaim(sessionId, split.id) : null,
  );
  const keptLive =
    kept !== null && new Date(kept.claimableUntil).getTime() > now;
  const keptStale = kept !== null && !keptLive;
  useEffect(() => {
    if (keptStale) dropSplitClaim(sessionId, split.id);
  }, [keptStale, sessionId, split.id]);

  const data = claim.data?.data;
  const status: ClaimView | null = keptLive
    ? "available"
    : keptStale
      ? "expired"
      : data
        ? effectiveClaimStatus(data, now)
        : null;
  const busy = claim.isPending;
  const failed = claim.isError && !keptLive;

  // The button gives way to the "Lanjut ke akun" link after a click: move focus
  // there so a keyboard or screen-reader guest is not dropped on the page body.
  // Only for a click, never for a kept token read on load.
  const continueRef = useRef<HTMLAnchorElement>(null);
  const focusContinue = useRef(false);
  useEffect(() => {
    if (kept !== null && focusContinue.current) {
      focusContinue.current = false;
      continueRef.current?.focus();
    }
  }, [kept]);

  const ask = () =>
    claim.mutate(split.id, {
      onSuccess: ({ data: result }) => {
        if (
          result.status === "available" &&
          result.claimToken !== null &&
          result.claimableUntil !== null
        ) {
          const next = {
            claimToken: result.claimToken,
            claimableUntil: result.claimableUntil,
          };
          keepSplitClaim(sessionId, split.id, next);
          focusContinue.current = true;
          setKept(next);
        }
      },
    });

  // Intro, footer note, notice and button of each state in the mockup.
  let intro = t("qrOrders.bill.splitClaimIntroPaid");
  let note = t("qrOrders.bill.splitClaimReadyNote");
  let label = t("qrOrders.bill.splitClaimAction");
  let disabled = false;
  let notice: {
    tone: "success" | "danger";
    title: string;
    detail: string;
  } | null = null;
  let state: string = "siap";
  if (!paid || status === "unavailable") {
    state = "belum-bayar";
    intro = t("qrOrders.bill.splitClaimIntroPending");
    note = t("qrOrders.bill.splitClaimPendingNote");
    disabled = true;
  } else if (busy) {
    state = "sedang-klaim";
    intro = t("qrOrders.bill.splitClaimIntroReady");
    note = t("qrOrders.bill.splitClaimBusyNote");
    label = t("qrOrders.bill.splitClaimBusy");
  } else if (failed) {
    state = "error";
    note = t("qrOrders.bill.splitClaimKeptNote");
    label = t("qrOrders.bill.splitClaimRetry");
    notice = {
      tone: "danger",
      title: t("qrOrders.bill.splitClaimErrorTitle"),
      detail: t("qrOrders.bill.splitClaimErrorDetail"),
    };
  } else if (status === "available") {
    state = "berhasil";
    note = t("qrOrders.bill.splitClaimOkNote");
    label = t("qrOrders.bill.splitClaimContinue");
    notice = {
      tone: "success",
      title: t("qrOrders.bill.splitClaimOkTitle"),
      detail: t("qrOrders.bill.splitClaimOkDetail"),
    };
  } else if (status === "claimed") {
    state = "sudah-diklaim";
    note = t("qrOrders.bill.splitClaimDoneNote");
    disabled = true;
    notice = {
      tone: "success",
      title: t("qrOrders.bill.splitClaimDoneTitle"),
      detail: t("qrOrders.bill.splitClaimDoneDetail"),
    };
  } else if (status === "expired") {
    state = "kedaluwarsa";
    note = t("qrOrders.bill.splitClaimKeptNote");
    disabled = true;
    notice = {
      tone: "danger",
      title: t("qrOrders.bill.splitClaimExpiredTitle"),
      detail: t("qrOrders.bill.splitClaimExpiredDetail"),
    };
  } else {
    intro = t("qrOrders.bill.splitClaimIntroReady");
  }

  return (
    <>
      <section aria-labelledby="bill-split-claim" className="grid gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="bill-split-claim" className="type-title">
            {t("qrOrders.bill.splitClaimTitle")}
          </h2>
          <span className="text-sm text-muted-foreground">
            {t("qrOrders.bill.splitClaimOf", {
              n: split.shareIndex + 1,
              total,
            })}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">{intro}</p>
        <div aria-live="polite" className="grid gap-3">
          {notice && (
            <Notice tone={notice.tone} title={notice.title}>
              {notice.detail}
            </Notice>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {t("qrOrders.bill.splitClaimCaption")}
        </p>
      </section>
      {/* The one action of the page: a sticky bar, safe-area aware (QrFooter). */}
      <QrFooter
        data-testid={`split-claim-${split.id}`}
        data-claim-state={state}
      >
        <p className="text-center text-sm text-muted-foreground">{note}</p>
        {state === "berhasil" ? (
          <Button asChild size="lg">
            {/* Same as the point claim: come back to this bill after /masuk. */}
            <Link
              ref={continueRef}
              to="/masuk"
              search={{ redirect: `/t/${qrToken}/bill` }}
            >
              {label}
            </Link>
          </Button>
        ) : (
          <Button
            type="button"
            size="lg"
            disabled={disabled}
            loading={busy}
            onClick={ask}
          >
            {label}
          </Button>
        )}
      </QrFooter>
    </>
  );
}
