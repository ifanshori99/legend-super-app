import { Link } from "@tanstack/react-router";
import { Coins } from "lucide-react";
import { formatNumber, formatRupiah } from "@starter/shared/i18n";
import type { MemberOverview } from "@starter/shared/crm";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NumberDisplay } from "@/components/ui/money";

// The member's balance, one card (PRD §3.20 "Halaman Member": saldo poin).
// The earn ratio, expiry and point value are tenant policy, so they come from
// the loyalty program in the contract, never from copy in the component.
export function PointsCard({
  balance,
  program,
  showCta = true,
}: {
  balance: number;
  program: MemberOverview["program"];
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

      {showCta && (
        <Button asChild variant="outline" size="sm" className="w-fit">
          <Link to="/member/poin">{t("member.overview.pointsCta")}</Link>
        </Button>
      )}
    </Card>
  );
}
