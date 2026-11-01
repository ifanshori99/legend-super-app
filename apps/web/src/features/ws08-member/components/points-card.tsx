import { Link } from "@tanstack/react-router";
import { Coins, TriangleAlert } from "lucide-react";
import { formatNumber, formatRupiah } from "@starter/shared/i18n";
import type { MemberOverview } from "@starter/shared/crm";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NumberDisplay } from "@/components/ui/money";
import { formatMemberDate } from "../format";

// The member's balance, one card (PRD §3.20 "Halaman Member": saldo poin).
// The earn ratio, expiry and point value are tenant policy, so they come from
// the loyalty program in the contract, never from copy in the component.
export function PointsCard({
  balance,
  program,
  expiring,
  showCta = true,
}: {
  balance: number;
  program: MemberOverview["program"];
  /** Earliest unredeemed grant that expires, if any. */
  expiring?: { points: number; date: string } | null;
  showCta?: boolean;
}) {
  const t = useT();
  return (
    <Card className="gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="grid gap-1">
          <p className="text-sm leading-5 font-medium text-muted-foreground">
            {t("member.points.balance")}
          </p>
          <p className="flex items-baseline gap-2">
            <NumberDisplay value={balance} size="xl" className="font-brand" />
            <span className="text-base leading-6 font-semibold text-muted-foreground">
              {t("member.common.pointsUnit")}
            </span>
          </p>
        </div>
        <span className="grid size-12 shrink-0 place-items-center rounded-full bg-brand-subtle text-foreground">
          <Coins className="size-6" aria-hidden="true" />
        </span>
      </div>

      <p className="text-sm leading-5 text-muted-foreground">
        {t("member.points.earnHint", {
          points: formatNumber(program.earnRate.points),
          spend: formatRupiah(program.earnRate.spendIdr),
        })}
      </p>

      {expiring && (
        <p className="flex items-start gap-2 rounded-lg bg-warning-subtle px-3 py-2 text-sm leading-5 font-medium text-warning">
          <TriangleAlert
            className="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          {t("member.overview.expiringBody", {
            points: formatNumber(expiring.points),
            date: formatMemberDate(expiring.date),
          })}
        </p>
      )}

      {showCta && (
        <Button asChild variant="outline" size="sm" className="w-fit">
          <Link to="/member/poin">{t("member.overview.pointsCta")}</Link>
        </Button>
      )}
    </Card>
  );
}
