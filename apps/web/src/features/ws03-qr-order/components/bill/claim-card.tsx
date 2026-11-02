// Claim points for the share this guest paid (PRD §3 F10 "Klaim Poin per
// Orang": each guest claims their own part, within 24 hours). Points need a
// member account; ordering never does (ORD-01).
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { CircleCheck, Clock, Gift } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useClaimPoints, usePointClaim } from "../../hooks";
import { effectiveClaimStatus } from "../../domain.ts";
import { formatDateTime } from "./format.ts";

export function ClaimCard({
  sessionId,
  timeZone,
}: {
  sessionId: string;
  timeZone: string;
}) {
  const t = useT();
  const claimQuery = usePointClaim(sessionId);
  const claim = useClaimPoints(sessionId);
  // Read once per mount: the 24 h deadline does not need a ticking clock.
  const [now] = useState(() => Date.now());
  const data = claimQuery.data?.data;
  // A failed or loading claim never blocks the bill: the card just stays out.
  if (!data) return null;
  const status = effectiveClaimStatus(data, now);
  const Icon =
    status === "claimed" ? CircleCheck : status === "expired" ? Clock : Gift;

  return (
    <section
      aria-labelledby="bill-claim"
      className="grid gap-3 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline"
    >
      <div className="flex items-center gap-2">
        <Icon className="size-5 shrink-0" aria-hidden="true" />
        <h2 id="bill-claim" className="type-title">
          {t("qrOrders.bill.claimTitle")}
        </h2>
      </div>
      <div aria-live="polite" className="grid gap-3">
        {status === "unavailable" && (
          <p className="text-sm text-muted-foreground">
            {t("qrOrders.bill.claimUnavailable")}
          </p>
        )}
        {status === "expired" && (
          <p className="text-sm text-muted-foreground">
            {t("qrOrders.bill.claimExpired")}
          </p>
        )}
        {status === "claimed" && (
          <p className="text-sm">
            {t("qrOrders.bill.claimDone", { points: data.points })}
          </p>
        )}
        {status === "available" && (
          <>
            <p className="text-sm text-muted-foreground">
              {t("qrOrders.bill.claimPaid", {
                amount: formatRupiah(data.paidIdr),
              })}
              {data.claimableUntil &&
                ` ${t("qrOrders.bill.claimUntil", {
                  date: formatDateTime(data.claimableUntil, timeZone),
                })}`}
            </p>
            {data.requiresLogin ? (
              <>
                <p className="text-sm">{t("qrOrders.bill.claimLogin")}</p>
                <Button asChild variant="outline">
                  <Link to="/sign-in">
                    {t("qrOrders.bill.claimLoginAction")}
                  </Link>
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="secondary"
                loading={claim.isPending}
                onClick={() => claim.mutate()}
              >
                {t("qrOrders.bill.claimAvailable", { points: data.points })}
              </Button>
            )}
            {claim.isError && (
              <p role="alert" className="text-sm font-medium text-danger">
                {t("qrOrders.bill.claimFailed")}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
