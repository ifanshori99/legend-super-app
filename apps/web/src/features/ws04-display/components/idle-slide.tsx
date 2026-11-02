// The idle slide of the customer display (PRD §3 F11 "Customer Display"): the
// screen is paired and waiting for the terminal to open a bill. The display
// contract carries no promotion payload, so this slide shows no invented offer.
import { Monitor } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";

export function IdleSlide() {
  const t = useT();
  return (
    <section
      aria-labelledby="display-idle"
      className="flex min-h-[24rem] flex-1 flex-col items-center justify-center gap-4 rounded-container border-(length:--border-w) bg-card p-card text-center shadow-hairline"
    >
      <p className="type-eyebrow text-muted-foreground">
        {t("app.defaultBrand")}
      </p>
      <h2 id="display-idle" className="type-display-xl">
        {t("posDisplay.idle.welcome")}
      </h2>
      <p className="max-w-md text-(length:--density-text) leading-7 text-muted-foreground">
        {t("posDisplay.idle.hint")}
      </p>
      <Badge tone="neutral" className="px-3 py-1 text-sm [&_svg]:size-4">
        <Monitor aria-hidden="true" />
        {t("posDisplay.idle.waiting")}
      </Badge>
    </section>
  );
}
