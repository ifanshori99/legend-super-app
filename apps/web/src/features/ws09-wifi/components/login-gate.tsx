// Signed-out state of the captive portal: the WhatsApp account behind the
// membership is what ties the session to a person (PRD §3 "Wi-Fi Tamu":
// maksimal 2 perangkat per akun). The WhatsApp login screen itself is WS-01
// (bead legend-baa); this card only sends the guest there, and keeps the
// table menu open meanwhile (FAC-11).
import { Link } from "@tanstack/react-router";
import { MessageCircle } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { WifiPolicy } from "@starter/shared/facility";
import { tableMenuToken } from "../state.ts";
import { WifiFacts } from "./wifi-facts";

export function WifiLoginGate({
  policy,
  tableToken,
}: {
  policy: WifiPolicy;
  tableToken: string | undefined;
}) {
  const t = useT();
  const menuToken = tableMenuToken(tableToken);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("wifi.loginTitle")}</CardTitle>
        <CardDescription>
          {t("wifi.loginHint", { devices: policy.maxDevices })}
        </CardDescription>
        <CardAction>
          <span className="grid size-10 shrink-0 place-items-center rounded-container bg-surface-3 text-muted-foreground">
            <MessageCircle className="size-5" aria-hidden="true" />
          </span>
        </CardAction>
      </CardHeader>
      <WifiFacts policy={policy} />
      <Button asChild>
        <Link to="/sign-in">{t("wifi.loginAction")}</Link>
      </Button>
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
    </Card>
  );
}
