// AI & MCP usage page (WS-12, bead legend-hi82): the tenant's month of AI
// spend, MCP tokens with revoke, and the tool-call audit. The month lives in
// the URL (?month=YYYY-MM) so a view can be shared and reloaded.
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { FormField } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { API_MOCK } from "@/lib/api/mock-flag";
import { monthLabel, monthOf, monthOptions } from "./usage-format";
import { UsageSummary } from "./usage-summary";
import { UsageToolCalls } from "./usage-toolcalls";
import { UsageTokens } from "./usage-tokens";

export function UsagePage({ month }: { month?: string }) {
  const t = useT();
  const navigate = useNavigate();
  const now = new Date();
  const selected = month ?? monthOf(now);
  // An older month named in the URL stays selectable.
  const options = monthOptions(now);
  if (!options.includes(selected)) options.push(selected);

  return (
    <section
      aria-labelledby="ai-usage-title"
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <Link
            to="/kelola/pengaturan/mcp-ai"
            className="inline-flex min-h-11 w-fit items-center gap-1.5 text-sm font-semibold text-primary underline-offset-4 hover:underline sm:min-h-0"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            {t("aiAdminUsage.back")}
          </Link>
          <h2 id="ai-usage-title" className="type-title">
            {t("aiAdminUsage.title")}
          </h2>
          <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
            {t("aiAdminUsage.subtitle")}
          </p>
        </div>
        <div className="flex w-full items-end gap-3 sm:w-auto">
          {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
          <FormField
            label={t("aiAdminUsage.month.label")}
            required
            className="w-full sm:w-48"
          >
            <Select
              value={selected}
              onValueChange={(value) =>
                void navigate({
                  to: "/kelola/pengaturan/mcp-ai/pemakaian",
                  search: { month: value },
                })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    {monthLabel(entry)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </div>
      </div>

      <UsageSummary month={selected} />
      <UsageTokens />
      <UsageToolCalls />
    </section>
  );
}
