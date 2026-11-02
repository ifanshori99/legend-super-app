// "/wifi" — the guest Wi-Fi captive portal (PRD v1.7 §3 Kelompok C "Wi-Fi Tamu
// & WFC", §4 Alur X, §5 Peta situs "/wifi"). It works in four stages: no zone
// known (scan a QR), signed out (WhatsApp login), signed in but not connected,
// and connected (quota meter with the "+1 jam" reminder). The WFC products are
// offered underneath in every stage.
import { Wifi } from "lucide-react";
import { useT } from "@/components/i18n";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentWifiSession, useWifiPolicy } from "../hooks";
import { ConnectCard } from "./connect-card";
import { WifiLoginGate } from "./login-gate";
import { QuotaPanel } from "./quota-panel";
import { WfcProducts } from "./wfc-products";

export function WifiPortal({
  zoneId,
  facilityId,
  tableToken,
  signedIn,
}: {
  zoneId: string | undefined;
  facilityId: string | undefined;
  tableToken: string | undefined;
  /** Presentation only: the API still authorizes every request. */
  signedIn: boolean;
}) {
  const t = useT();
  return (
    <div className="grid gap-5">
      <header className="grid gap-2">
        <h1 className="font-brand type-display-xl">{t("wifi.title")}</h1>
        <p className="max-w-prose text-sm leading-5 text-muted-foreground">
          {t("wifi.intro")}
        </p>
      </header>
      {zoneId ? (
        <PortalStage
          zoneId={zoneId}
          tableToken={tableToken}
          signedIn={signedIn}
        />
      ) : (
        <EmptyState
          icon={Wifi}
          title={t("wifi.zoneUnknownTitle")}
          description={t("wifi.zoneUnknownHint")}
        />
      )}
      <WfcProducts facilityId={facilityId} />
    </div>
  );
}

function PortalStage({
  zoneId,
  tableToken,
  signedIn,
}: {
  zoneId: string;
  tableToken: string | undefined;
  signedIn: boolean;
}) {
  const policy = useWifiPolicy(zoneId);
  const session = useCurrentWifiSession(signedIn);

  if (policy.isPending) return <PortalSkeleton />;
  if (policy.isError) return <ErrorState onRetry={() => policy.refetch()} />;

  if (!signedIn)
    return <WifiLoginGate policy={policy.data} tableToken={tableToken} />;

  if (session.isPending) return <PortalSkeleton />;
  if (session.isError) return <ErrorState onRetry={() => session.refetch()} />;

  if (!session.data)
    return (
      <ConnectCard
        policy={policy.data}
        zoneId={zoneId}
        tableToken={tableToken}
      />
    );

  return <QuotaPanel view={session.data} tableToken={tableToken} />;
}

/** Shaped like the quota card, with the region marked busy for readers. */
function PortalSkeleton() {
  const t = useT();
  return (
    <div
      aria-busy="true"
      className="grid gap-4 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline"
    >
      <span className="sr-only">{t("wifi.loading")}</span>
      <div className="flex items-start justify-between gap-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-6 w-28 rounded-full" />
      </div>
      <Skeleton className="h-8 w-32" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-control w-full rounded-control" />
    </div>
  );
}
