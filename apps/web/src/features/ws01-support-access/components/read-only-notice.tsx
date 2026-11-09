// Persistent notice for the Super Admin whose impersonated session is read
// only (TEN-04). Mounted by AreaFrame inside the tenant areas; "Akhiri sesi"
// stops the impersonation (the API allows it under any grant) and reloads to
// the start page as the Super Admin again.
import * as React from "react";
import { LifeBuoy, Power } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { authClient } from "@/lib/auth-client";
import { cn } from "cn";

export function SupportReadOnlyNotice({ className }: { className?: string }) {
  const t = useT();
  const toast = useToast();
  const [pending, setPending] = React.useState(false);
  const labelId = React.useId();

  async function end() {
    setPending(true);
    try {
      const result = await authClient.admin.stopImpersonating();
      if (result.error) throw new Error("stop impersonating failed");
      // Full reload: every cached tenant read belongs to the ended session.
      window.location.assign("/");
    } catch {
      setPending(false);
      toast({
        title: t("supportAccess.readOnlyMode.endFailed"),
        tone: "danger",
      });
    }
  }

  return (
    <section
      aria-labelledby={labelId}
      data-slot="support-readonly-notice"
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1 border-b-(length:--border-w) bg-warning-subtle px-4 py-2 text-sm text-warning",
        className,
      )}
    >
      <p
        id={labelId}
        className="inline-flex items-center gap-2 font-semibold sm:flex-1"
      >
        <LifeBuoy className="size-4 shrink-0" aria-hidden="true" />
        {t("supportAccess.readOnlyMode.label")}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        loading={pending}
        onClick={() => void end()}
      >
        <Power aria-hidden="true" />
        {pending
          ? t("supportAccess.readOnlyMode.ending")
          : t("supportAccess.readOnlyMode.end")}
      </Button>
    </section>
  );
}
