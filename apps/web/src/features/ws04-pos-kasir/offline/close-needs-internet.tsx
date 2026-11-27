// O5 follow-up (Keputusan CTO 27 Nov, point 6 c): the blind count is written
// to the cloud, so a tablet without internet cannot start it. The screen says
// so and offers only the way back to the till; the sales keep going offline.
import { Link } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Notice } from "@/features/ws04-pos-kasir/components/shared";

export function CloseNeedsInternet({ pending }: { pending: number }) {
  const t = useT();
  return (
    <div className="grid gap-4" data-slot="pos-offline-close-needs-internet">
      <Notice
        tone="warning"
        title={t("posKasirOffline.closeNeedsInternet.title")}
      >
        <div className="grid gap-2">
          <p>{t("posKasirOffline.closeNeedsInternet.body")}</p>
          {pending > 0 && (
            <p>
              {t("posKasirOffline.closeNeedsInternet.pending", {
                count: pending,
              })}
            </p>
          )}
        </div>
      </Notice>
      <Button asChild className="justify-self-start">
        <Link to="/pos/kasir">
          {t("posKasirOffline.closeNeedsInternet.back")}
        </Link>
      </Button>
    </div>
  );
}
