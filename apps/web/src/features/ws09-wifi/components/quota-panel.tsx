// The connected state of the portal: today's quota, the speed tier and the
// reminder with the "+1 jam" action (PRD §3 "Wi-Fi Berbasis Belanja", §4 Alur
// X). The quota is read from the server and re-read every 30 seconds, so a
// paid order shows up without the guest doing anything (FAC-12).
import { Link } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { WifiQuotaView } from "@starter/shared/facility";
import {
  formatMinutes,
  isThrottled,
  shouldRemind,
  tableMenuToken,
} from "../state.ts";
import { AddHourDialog } from "./add-hour-dialog";
import { QuotaMeter } from "./quota-meter";

export function QuotaPanel({
  view,
  tableToken,
}: {
  view: WifiQuotaView;
  tableToken: string | undefined;
}) {
  const t = useT();
  const [addHourOpen, setAddHourOpen] = useState(false);
  const { session, policy, remainingMinutes } = view;
  const throttled = isThrottled(session.speedTier);
  const nearLimit = shouldRemind(remainingMinutes);
  const menuToken = tableMenuToken(tableToken);
  return (
    <Card className="gap-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <h3 className="type-eyebrow text-muted-foreground">
          {t("wifi.quotaLabel")}
        </h3>
        <StatusPill status={throttled ? "warning" : "success"}>
          {t(throttled ? "wifi.speedBase" : "wifi.speedFull")}
        </StatusPill>
      </div>
      <QuotaMeter
        usedMinutes={session.usedMinutes}
        quotaMinutes={session.quotaMinutes}
        remainingMinutes={remainingMinutes}
        speedTier={session.speedTier}
      />
      <div className="grid gap-1">
        <p className="text-sm leading-5 text-muted-foreground">
          {t(throttled ? "wifi.speedBaseHint" : "wifi.speedFullHint")}
        </p>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("wifi.quotaNote")}
        </p>
      </div>
      {(nearLimit || throttled) && (
        <div className="grid gap-3 rounded-container bg-warning-subtle p-4">
          <div className="grid gap-1">
            <p className="flex items-center gap-2 type-heading text-warning">
              <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
              {t(throttled ? "wifi.spentTitle" : "wifi.reminderTitle")}
            </p>
            <p className="text-sm leading-5">
              {throttled
                ? t("wifi.spentHint")
                : t("wifi.reminderHint", {
                    minutes: formatMinutes(remainingMinutes, t),
                  })}
            </p>
          </div>
          <Button size="sm" onClick={() => setAddHourOpen(true)}>
            {t("wifi.addHour")}
          </Button>
        </div>
      )}
      {!nearLimit && !throttled && (
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => setAddHourOpen(true)}
        >
          {t("wifi.addHour")}
        </Button>
      )}
      {menuToken && (
        <div className="grid gap-2 border-t-(length:--border-w) pt-4">
          <p className="text-sm leading-5 text-muted-foreground">
            {t("wifi.orderHint")}
          </p>
          <Button variant="outline" asChild>
            <Link to="/t/$token" params={{ token: menuToken }}>
              {t("wifi.orderAction")}
            </Link>
          </Button>
        </div>
      )}
      <AddHourDialog
        policy={policy}
        tableToken={menuToken}
        open={addHourOpen}
        onOpenChange={setAddHourOpen}
      />
    </Card>
  );
}
