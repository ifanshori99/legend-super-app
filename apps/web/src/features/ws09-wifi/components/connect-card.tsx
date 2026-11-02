// Signed in but not connected yet: the guest connects this device with one
// tap. The zone's numbers are shown first so the guest knows what they get;
// a refused device (FAC-12) is reported next to the button.
import { Link } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { WifiPolicy } from "@starter/shared/facility";
import { useStartWifiSession } from "../hooks";
import {
  deviceFingerprint,
  startErrorMessage,
  tableMenuToken,
} from "../state.ts";
import { WifiFacts } from "./wifi-facts";

export function ConnectCard({
  policy,
  zoneId,
  tableToken,
}: {
  policy: WifiPolicy;
  zoneId: string;
  tableToken: string | undefined;
}) {
  const t = useT();
  const connect = useStartWifiSession();
  const menuToken = tableMenuToken(tableToken);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("wifi.connectTitle")}</CardTitle>
        <CardDescription>{t("wifi.connectHint")}</CardDescription>
      </CardHeader>
      <WifiFacts policy={policy} />
      <div className="grid gap-2">
        <Button
          loading={connect.isPending}
          onClick={() =>
            connect.mutate({
              zoneId,
              deviceFingerprint: deviceFingerprint(),
            })
          }
        >
          {connect.isPending
            ? t("wifi.connectPending")
            : t("wifi.connectAction")}
        </Button>
        {connect.isError && (
          <p role="alert" className="text-sm leading-5 text-danger">
            {startErrorMessage(connect.error, policy.maxDevices, t)}
          </p>
        )}
      </div>
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
