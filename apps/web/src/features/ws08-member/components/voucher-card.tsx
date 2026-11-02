import type { VoucherDto } from "@starter/shared/crm";
import { useT } from "@/components/i18n";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { formatMemberDate } from "../format";
import { VoucherStatusBadge } from "./status-badge";

// One voucher (PRD §3.20 "Halaman Member": voucher). The plain code is shown
// only once at issue and never in the list, so the card shows value, source,
// validity and status.
export function VoucherCard({ voucher }: { voucher: VoucherDto }) {
  const t = useT();
  return (
    <Card className="gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 gap-0.5">
          <p className="type-eyebrow text-muted-foreground">
            {t(`member.vouchers.source.${voucher.source}`)}
          </p>
          {voucher.valueIdr !== null && (
            <p>
              <Money amount={voucher.valueIdr} size="stat" />
            </p>
          )}
        </div>
        <VoucherStatusBadge status={voucher.status} />
      </div>
      <p className="text-sm leading-5 text-muted-foreground">
        {voucher.validUntil === null
          ? t("member.vouchers.noExpiry")
          : t("member.vouchers.validUntil", {
              date: formatMemberDate(voucher.validUntil),
            })}
      </p>
    </Card>
  );
}
