// "Urutan layanan": ChatGPT first, custom model as the automatic fallback.
// Read-only summary of the two panels; there is no order toggle by design.
import { useT } from "@/components/i18n";
import { Skeleton } from "@/components/ui/skeleton";
import { AdminCard } from "@/features/ws12-ai-admin/components/shared";
import { useChatgptLogin, useProvider } from "../hooks";

// `locked` is accepted for symmetry with the other cards but changes nothing:
// the mockup keeps the saved status visible while the platform lock is on, and
// the page banner explains the lock.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for the lock contract test
export function OrderCard(_props: { locked?: boolean }) {
  const t = useT();
  const login = useChatgptLogin();
  const provider = useProvider();
  const loading = login.isPending || provider.isPending;
  const connected = login.data?.data.state === "connected";
  // A failed first load is "unknown", never "not connected / not ready".
  const loginUnknown = !login.data && login.isError;
  const providerUnknown = !provider.data && provider.isError;
  // Ready = a model is saved with a key and its last test passed.
  const config = provider.data?.data.config ?? null;
  const ready =
    config !== null && config.hasKey && config.lastTest?.status === "ok";

  return (
    <AdminCard aria-labelledby="ai-order-title">
      <h2 id="ai-order-title" className="type-title">
        {t("aiSettings.order.title")}
      </h2>
      {loading ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <>
          <ol className="grid gap-3">
            <OrderItem
              n={1}
              name={t("aiSettings.order.primary")}
              status={
                loginUnknown
                  ? t("aiSettings.order.primaryUnavailable")
                  : connected
                    ? t("aiSettings.order.primaryConnected")
                    : t("aiSettings.order.primaryNotConnected")
              }
            />
            <OrderItem
              n={2}
              name={t("aiSettings.order.fallback")}
              status={
                providerUnknown
                  ? t("aiSettings.order.fallbackUnavailable")
                  : ready
                    ? t("aiSettings.order.fallbackReady")
                    : t("aiSettings.order.fallbackNotReady")
              }
            />
          </ol>
          {!providerUnknown && (
            <p className="text-sm leading-5 text-muted-foreground">
              {ready
                ? t("aiSettings.order.noteReady")
                : t("aiSettings.order.noteNotReady")}
            </p>
          )}
        </>
      )}
    </AdminCard>
  );
}

function OrderItem({
  n,
  name,
  status,
}: {
  n: number;
  name: string;
  status: string;
}) {
  return (
    <li className="flex items-center gap-3">
      <span
        aria-hidden="true"
        className="grid size-7 shrink-0 place-items-center rounded-full bg-primary-tint text-sm font-semibold text-primary"
      >
        {n}
      </span>
      <span className="grid min-w-0">
        <span className="font-semibold">{name}</span>
        <span className="text-sm text-muted-foreground">{status}</span>
      </span>
    </li>
  );
}
