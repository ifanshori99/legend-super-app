// O3 offline shell (bead legend-wasr7.7, re-review O3 P1): what the service
// worker shows when a /pos page cannot load. Rendered without a session or
// any account data, so the worker may keep it; the count of unsent sales is
// read from this tablet's own storage after hydration.
import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback-state";
import { countPendingOfflineSales } from "./queue";
import { defaultOfflineBackend } from "./store";

export function PosOfflineShell() {
  const t = useT();
  const [pending, setPending] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    countPendingOfflineSales(defaultOfflineBackend(), null).then(
      (count) => alive && setPending(count),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
  return (
    <main className="mx-auto flex min-h-dvh max-w-md items-center p-6">
      <EmptyState
        icon={WifiOff}
        title={t("posOffline.shell.title")}
        description={
          pending === null
            ? t("posOffline.shell.description")
            : `${t("posOffline.shell.description")} ${
                pending > 0
                  ? t("posOffline.shell.pending", { count: pending })
                  : t("posOffline.shell.none")
              }`
        }
        action={
          <Button asChild>
            {/* A full load: the cashier screen needs the session again. */}
            <a href="/pos/kasir">{t("posOffline.shell.retry")}</a>
          </Button>
        }
      />
    </main>
  );
}
