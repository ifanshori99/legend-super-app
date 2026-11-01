// One printable table sticker: brand line, table number, zone, the signed QR
// and the URL printed underneath. The QR keeps the library's black-on-white
// output on purpose — a scannable code must not follow the dark theme (DESIGN
// §8 forbids raw colors in UI, and this is a machine-readable image, not a
// surface). `marginSize` keeps the quiet zone scanners need.
import { QRCodeSVG } from "qrcode.react";
import type { FloorZone, Table, TableQr } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";

type Props = {
  qr: TableQr;
  table: Table;
  zone?: FloorZone;
  /** Brand line until tenant config supplies the real name (D43). */
  brand: string;
};

function QrLabel({ qr, table, zone, brand }: Props) {
  const t = useT();
  return (
    <article className="grid break-inside-avoid gap-2 overflow-hidden rounded-lg border-(length:--border-w) bg-card p-3">
      <p className="text-xs leading-4 font-semibold tracking-wide text-muted-foreground uppercase">
        {brand}
      </p>
      <div className="flex flex-wrap items-start gap-3">
        <QRCodeSVG
          value={qr.url}
          size={104}
          level="M"
          marginSize={2}
          title={t("floor.tableTitle", { code: table.code })}
          className="shrink-0"
        />
        {/* min width keeps the text readable: it wraps under the QR instead
            of squeezing one character per line on a narrow label */}
        <div className="grid min-w-[8rem] flex-1 gap-0.5">
          <p className="text-lg leading-6 font-semibold tabular">
            {t("floor.tableTitle", { code: table.code })}
          </p>
          {zone && (
            <p className="text-sm leading-5 text-muted-foreground">
              {zone.name}
            </p>
          )}
          <p className="text-xs leading-4">{t("floor.qrLabelScan")}</p>
          <p className="text-xs leading-4 break-all text-muted-foreground">
            {qr.url}
          </p>
        </div>
      </div>
    </article>
  );
}

export { QrLabel };
