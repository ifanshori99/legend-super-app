// Pengaturan AI (bead legend-nnufz): ChatGPT login (main), custom model
// (automatic fallback), monthly budget and the service order. The page gate
// comes first: loading, no connection, or an ended session replace the cards.
// When the platform turns AI off, one banner explains it and EVERY card is
// locked (founder W16 Q7). The API authorizes every request; the route guard
// and `locked` here are presentation.
import type { ReactNode } from "react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { BudgetCard } from "./budget-card";
import { ChatgptPanel } from "./chatgpt-panel";
import { CustomModelPanel } from "./custom-model-panel";
import {
  AiSettingsLoadError,
  AiSettingsLoading,
  AiSettingsOffline,
  AiSettingsSessionExpired,
} from "./page-states";
import { PlatformLockBanner } from "./platform-lock-banner";
import { useAiPlatformLock, useChatgptLogin, useProvider } from "../hooks";
import { OrderCard } from "./order-card";

const hasStatus = (error: unknown, status: number) =>
  error instanceof ApiError && error.status === status;

export function AiSettingsPage() {
  const t = useT();
  const chatgpt = useChatgptLogin();
  const provider = useProvider();
  const { locked } = useAiPlatformLock();

  // Only a failed first load gates the page; a failed refresh keeps the data.
  const failures = [
    ...(chatgpt.data ? [] : [chatgpt.error]),
    ...(provider.data ? [] : [provider.error]),
  ];
  const retry = () => {
    void chatgpt.refetch();
    void provider.refetch();
  };
  const retrying = chatgpt.isFetching || provider.isFetching;
  let body: ReactNode;
  let showCards = false;
  if (failures.some((error) => hasStatus(error, 401))) {
    body = <AiSettingsSessionExpired />;
  } else if (failures.some((error) => hasStatus(error, 0))) {
    body = <AiSettingsOffline onRetry={retry} retrying={retrying} />;
  } else if (!provider.data && provider.error) {
    body = <AiSettingsLoadError onRetry={retry} retrying={retrying} />;
  } else if (chatgpt.isPending || provider.isPending) {
    body = <AiSettingsLoading />;
  } else {
    showCards = true;
    body = (
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_17.5rem] lg:items-start">
        <div className="grid min-w-0 gap-4">
          <ChatgptPanel disabled={locked} />
          <CustomModelPanel locked={locked} />
        </div>
        <div className="grid min-w-0 gap-4">
          <BudgetCard locked={locked} />
          <OrderCard locked={locked} />
        </div>
      </div>
    );
  }
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-base leading-6 text-muted-foreground">
          {t("aiSettings.intro")}
        </p>
        {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
      </div>
      {showCards && provider.data?.data.platformLocked === true && (
        <PlatformLockBanner />
      )}
      {body}
    </div>
  );
}
