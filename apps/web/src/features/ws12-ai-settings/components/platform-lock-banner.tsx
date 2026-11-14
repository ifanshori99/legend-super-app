// Platform kill switch banner (founder W16 Q7): AI is off for the whole tenant,
// so every setting below is locked. Cards keep their saved values visible.
import { Ban } from "lucide-react";
import { useT } from "@/components/i18n";

export function PlatformLockBanner() {
  const t = useT();
  return (
    <div
      role="alert"
      className="flex min-w-0 gap-3 rounded-container border-(length:--border-w) border-danger/40 bg-danger/10 p-card text-danger"
    >
      <Ban className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
      <div className="grid min-w-0 max-w-2xl gap-1 text-base leading-6">
        <p className="font-semibold">{t("aiSettings.platformLock.title")}</p>
        <p>{t("aiSettings.platformLock.body")}</p>
        <p>{t("aiSettings.platformLock.hint")}</p>
      </div>
    </div>
  );
}
