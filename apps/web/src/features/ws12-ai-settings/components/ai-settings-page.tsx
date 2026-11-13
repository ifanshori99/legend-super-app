// Pengaturan AI (bead legend-nnufz): ChatGPT login (main), custom model
// (automatic fallback), monthly budget and the service order. When the platform
// kill switch is on (ChatGPT status `platformDisabled`) only the ChatGPT
// connection is disabled and its own card says why; the custom model and budget
// stay usable. The API authorizes every request; the route guard and `disabled` here
// are presentation.
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { API_MOCK } from "@/lib/api/mock-flag";
import { BudgetCard } from "./budget-card";
import { ChatgptPanel } from "./chatgpt-panel";
import { CustomModelPanel } from "./custom-model-panel";
import { useChatgptLogin } from "../hooks";
import { OrderCard } from "./order-card";

export function AiSettingsPage() {
  const t = useT();
  // The platform kill switch rides on the ChatGPT status and is ChatGPT-only.
  // The ChatGPT card stays locked until it is known (fail closed); the API
  // enforces it regardless.
  const status = useChatgptLogin();
  const platformOff = status.data?.data.platformDisabled === true;
  const chatgptLocked = platformOff || status.isPending;

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm leading-5 text-muted-foreground">
          {t("aiSettings.intro")}
        </p>
        {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_17.5rem] lg:items-start">
        <div className="grid min-w-0 gap-4">
          <ChatgptPanel disabled={chatgptLocked} />
          <CustomModelPanel />
        </div>
        <div className="grid min-w-0 gap-4">
          <BudgetCard />
          <OrderCard />
        </div>
      </div>
    </div>
  );
}
