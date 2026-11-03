// Outlet wall display for the rotating attendance QR (PRD v1.7 §3 F27, F25;
// bead legend-0z5k). The screen is read from a distance: one large code, one
// large countdown, calm surfaces. It polls itself; the manual button only
// exists for a supervisor who wants the next code now.
import { RefreshCw, TimerOff, WifiOff } from "lucide-react";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CardShell,
  CardShellBody,
  CardShellFooter,
} from "@/components/ui/card";
import { ErrorState } from "@/components/ui/feedback-state";
import { QrCode } from "@/components/ui/qr-code";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@starter/shared/i18n";
import {
  ATTENDANCE_QR_ROTATION_SECONDS,
  isAttendanceQrValid,
  type AttendanceQrToken,
} from "@starter/shared/hris";
import { useOnline } from "@/lib/use-online";
import { formatOutletTime } from "../format.ts";
import { useAttendanceQr, useNow } from "../hooks.ts";
import { ATTENDANCE_OUTLET_NAME, ATTENDANCE_TIME_ZONE } from "../outlet.ts";
import { qrRemainingMs } from "../queries.ts";

const ROTATION_MS = ATTENDANCE_QR_ROTATION_SECONDS * 1_000;

export function QrDisplayPage() {
  const t = useT();
  const online = useOnline();
  const query = useAttendanceQr();
  const now = useNow(1_000);
  const reading = query.data;
  const qr = reading?.qr;
  // Every comparison with the token window uses the server clock (device
  // clock + estimated offset), so a drifting outlet tablet stays honest.
  const remainingMs =
    reading && now !== null ? Math.max(0, qrRemainingMs(reading, now)) : null;
  const secondsLeft =
    remainingMs === null ? null : Math.ceil(remainingMs / 1_000);
  const active =
    reading && now !== null
      ? isAttendanceQrValid(reading.qr, new Date(now + reading.offsetMs)) &&
        remainingMs !== null &&
        remainingMs > 0
      : false;
  const progress =
    remainingMs === null ? 0 : Math.min(100, (remainingMs / ROTATION_MS) * 100);

  if (query.isPending) return <QrSkeleton />;
  // A failed background poll keeps the last reading on screen; the expiry
  // logic above hides it once its window closes.
  if (!qr)
    return (
      <ErrorState
        title={
          online
            ? t("attendanceQr.display.errorTitle")
            : t("attendanceQr.display.offlineTitle")
        }
        description={
          online
            ? t("attendanceQr.display.errorHint")
            : t("attendanceQr.display.offlineHint")
        }
        onRetry={() => void query.refetch()}
      />
    );

  return (
    <div className="grid min-w-0 gap-5">
      <div className="grid gap-1">
        <h2 className="type-title">
          {t("attendanceQr.display.outletHeading", {
            outlet: ATTENDANCE_OUTLET_NAME,
          })}
        </h2>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("attendanceQr.display.description")}
        </p>
      </div>

      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)]">
        <CardShell>
          <CardShellBody className="items-center gap-4 p-card text-center">
            <StatusPill
              status={active ? "success" : "warning"}
              className="text-xs"
            >
              {active
                ? t("attendanceQr.display.statusActive")
                : t("attendanceQr.display.statusExpired")}
            </StatusPill>

            {active ? (
              <>
                <QrCard qr={qr} />
                <div className="grid max-w-full gap-1">
                  <p className="type-eyebrow text-muted-foreground">
                    {t("attendanceQr.display.tokenLabel")}
                  </p>
                  <p className="font-mono text-base leading-7 font-bold tracking-[0.08em] break-all tabular sm:text-xl sm:tracking-[0.18em]">
                    {qr.token}
                  </p>
                </div>
              </>
            ) : (
              // An expired code is never left on screen: a scan would only be
              // rejected by the server (no token reuse).
              <ExpiredPlate />
            )}
          </CardShellBody>
          <CardShellFooter className="flex-wrap justify-between gap-2">
            <span className="min-w-0">
              {t("attendanceQr.display.screenHint")}
            </span>
            {!online ? (
              <StatusPill status="warning" icon={WifiOff} className="text-xs">
                {t("attendanceQr.display.offlineTitle")}
              </StatusPill>
            ) : (
              query.isError && (
                <StatusPill status="warning" className="text-xs">
                  {t("attendanceQr.display.refreshFailed")}
                </StatusPill>
              )
            )}
          </CardShellFooter>
        </CardShell>

        <div className="grid min-w-0 content-start gap-5">
          <CardShell>
            <CardShellBody className="gap-4 p-card">
              <h3 className="type-heading">
                {t("attendanceQr.display.progressLabel")}
              </h3>

              <div className="flex items-end gap-2">
                <span className="text-7xl leading-none font-bold tabular">
                  {formatNumber(secondsLeft ?? 0)}
                </span>
                <span className="pb-2 text-base font-semibold text-muted-foreground">
                  {active
                    ? t("attendanceQr.display.secondsUnit")
                    : t("attendanceQr.display.countdownExpired")}
                </span>
              </div>

              <div
                role="progressbar"
                aria-label={t("attendanceQr.display.progressLabel")}
                aria-valuemin={0}
                aria-valuemax={ATTENDANCE_QR_ROTATION_SECONDS}
                aria-valuenow={secondsLeft ?? 0}
                aria-valuetext={t("attendanceQr.display.secondsLeft", {
                  seconds: formatNumber(secondsLeft ?? 0),
                })}
                className="h-2 w-full overflow-hidden rounded-full bg-surface-3"
              >
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${progress}%` }}
                />
              </div>

              <dl className="grid grid-cols-2 gap-3 border-t pt-3 text-sm">
                <div className="min-w-0">
                  <dt className="text-muted-foreground">
                    {t("attendanceQr.display.issuedLabel")}
                  </dt>
                  <dd className="font-semibold tabular">
                    {formatOutletTime(qr.issuedAt, ATTENDANCE_TIME_ZONE)}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-muted-foreground">
                    {t("attendanceQr.display.expiresLabel")}
                  </dt>
                  <dd className="font-semibold tabular">
                    {formatOutletTime(qr.expiresAt, ATTENDANCE_TIME_ZONE)}
                  </dd>
                </div>
                <div className="col-span-2 min-w-0">
                  <dt className="text-muted-foreground">
                    {t("attendanceQr.display.updatedLabel")}
                  </dt>
                  <dd className="font-semibold tabular">
                    {formatOutletTime(
                      new Date(query.dataUpdatedAt).toISOString(),
                      ATTENDANCE_TIME_ZONE,
                    )}
                  </dd>
                </div>
              </dl>

              <p className="text-sm leading-5 text-muted-foreground">
                {t("attendanceQr.display.rotationNote", {
                  seconds: ATTENDANCE_QR_ROTATION_SECONDS,
                })}
              </p>

              <Button
                variant="outline"
                onClick={() => void query.refetch()}
                loading={query.isFetching}
              >
                {!query.isFetching && <RefreshCw aria-hidden="true" />}
                {query.isFetching
                  ? t("attendanceQr.display.refreshing")
                  : t("attendanceQr.display.refresh")}
              </Button>
            </CardShellBody>
          </CardShell>
        </div>
      </div>
    </div>
  );
}

function QrCard({ qr }: { qr: AttendanceQrToken }) {
  const t = useT();
  return (
    <QrCode
      value={qr.token}
      label={t("attendanceQr.display.qrLabel", {
        outlet: ATTENDANCE_OUTLET_NAME,
      })}
      size={320}
      margin={2}
      className="max-w-full rounded-container border-(length:--border-w) border-border bg-card p-4 shadow-hairline"
      svgClassName="h-auto w-[min(72vw,20rem)] max-w-full sm:w-[21rem] lg:w-[24rem]"
    />
  );
}

function ExpiredPlate() {
  const t = useT();
  return (
    <div className="grid aspect-square w-[min(72vw,20rem)] max-w-full place-content-center justify-items-center gap-2 rounded-container border-(length:--border-w) border-dashed border-border bg-surface-2 p-4 text-center sm:w-[21rem] lg:w-[24rem]">
      <TimerOff aria-hidden="true" className="size-8 text-muted-foreground" />
      <p className="type-heading">{t("attendanceQr.display.expiredPlate")}</p>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("attendanceQr.display.expiredPlateHint")}
      </p>
    </div>
  );
}

function QrSkeleton() {
  const t = useT();
  return (
    <div className="grid min-w-0 gap-5">
      <span className="sr-only">{t("attendanceQr.display.loading")}</span>
      <Skeleton className="h-7 w-72 max-w-full" />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)]">
        <CardShell>
          <CardShellBody className="items-center gap-4 p-card">
            <Skeleton className="size-[min(72vw,20rem)] rounded-container" />
            <Skeleton className="h-6 w-64 max-w-full" />
          </CardShellBody>
        </CardShell>
        <CardShell>
          <CardShellBody className="gap-4 p-card">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-16 w-28" />
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-control w-full" />
          </CardShellBody>
        </CardShell>
      </div>
    </div>
  );
}
