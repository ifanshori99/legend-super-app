// One printable table sticker: brand line, table number, zone, the signed QR
// and the URL printed underneath. The code comes from the shared `QrCode`
// renderer, which keeps a light plate in both color modes on purpose — a
// scannable code must not follow the dark theme (DESIGN §4: a machine-readable
// image, not a surface). The renderer's quiet zone keeps the scan reliable.
import type { FloorZone, Table, TableQr } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import { QrCode } from "@/components/ui/qr-code";

type Props = {
  qr: TableQr;
  table: Table;
  zone?: FloorZone;
  /** Outlet name printed above the QR (founder Q33); empty hides the line. */
  brand: string;
};

function QrLabel({ qr, table, zone, brand }: Props) {
  const t = useT();
  return (
    <article className="grid break-inside-avoid gap-2 overflow-hidden rounded-container border-(length:--border-w) bg-card p-3 shadow-hairline">
      {brand && <p className="type-eyebrow text-muted-foreground">{brand}</p>}
      <div className="flex flex-wrap items-start gap-3">
        <QrCode
          value={qr.url}
          label={t("floorEditor.tableTitle", { code: table.code })}
          size={104}
          className="shrink-0"
        />
        {/* min width keeps the text readable: it wraps under the QR instead
            of squeezing one character per line on a narrow label */}
        <div className="grid min-w-[8rem] flex-1 gap-0.5">
          <p className="text-lg leading-6 font-semibold tabular">
            {t("floorEditor.tableTitle", { code: table.code })}
          </p>
          {zone && (
            <p className="text-sm leading-5 text-muted-foreground">
              {zone.name}
            </p>
          )}
          <p className="text-xs leading-4">{t("floorEditor.qrLabelScan")}</p>
          <p className="text-xs leading-4 break-all text-muted-foreground">
            {qr.url}
          </p>
        </div>
      </div>
    </article>
  );
}

export { QrLabel };
