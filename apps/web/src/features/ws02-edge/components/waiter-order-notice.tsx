// Guest notice for a broken cloud↔edge link (PRD v1.7 §4 Alur F step 2, §3 F5
// "Pesanan Pelanggan dari Cloud"): the QR page says "Silakan pesan melalui
// waiter" and the waiter takes the order with captain order. The QR screen
// (WS-03) renders this; the supervisor screen previews it.
import { cn } from "cn";
import { HandPlatter } from "lucide-react";
import { useT } from "@/components/i18n";

export function WaiterOrderNotice({ className }: { className?: string }) {
  const t = useT();
  return (
    <div
      data-edge-waiter-notice=""
      className={cn(
        "flex flex-col gap-3 rounded-container border-(length:--border-w) border-warning bg-warning-subtle p-card",
        className,
      )}
    >
      <p className="inline-flex items-center gap-2 self-start rounded-full bg-warning px-4 py-2 font-bold text-warning-foreground">
        <HandPlatter className="size-5 shrink-0" aria-hidden="true" />
        {t("edge.waiter.notice")}
      </p>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("edge.waiter.hint")}
      </p>
    </div>
  );
}
