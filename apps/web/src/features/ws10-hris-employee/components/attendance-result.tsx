// The outcome of a clock submission (HR-02). The contract answers the stored
// log with its validity; the reasons that can produce that validity are listed
// as *possible* causes with the fix for each — the screen never claims a cause
// the API did not send.
import { Link } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AttendanceLog, AttendanceMethod } from "@starter/shared/hris";
import {
  formatTime,
  methodLabelKey,
  possibleCauses,
  reasonFixKey,
  reasonLabelKey,
  submissionHeadlineKey,
  submissionHintKey,
  typeLabelKey,
  validityLabelKey,
  validityStatus,
} from "../state.ts";

export function AttendanceResult({
  log,
  timeZone,
  submitted,
  onRetry,
}: {
  log: AttendanceLog;
  timeZone: string;
  submitted: { method: AttendanceMethod; selfie: boolean };
  onRetry: () => void;
}) {
  const t = useT();
  const causes = possibleCauses(log.validity, submitted);
  const rejected = log.validity === "rejected";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(submissionHeadlineKey(log.validity))}</CardTitle>
        <CardDescription>{t(submissionHintKey(log.validity))}</CardDescription>
        <CardAction>
          <StatusPill status={validityStatus(log.validity)}>
            {t(validityLabelKey(log.validity))}
          </StatusPill>
        </CardAction>
      </CardHeader>

      <dl className="grid gap-2 text-sm leading-5">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">
            {t("hris.result.detailType")}
          </dt>
          <dd className="font-medium">{t(typeLabelKey(log.type))}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">
            {t("hris.result.detailTime")}
          </dt>
          <dd className="font-medium tabular">
            {formatTime(log.occurredAt, timeZone)}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">
            {t("hris.result.detailMethod")}
          </dt>
          <dd className="font-medium">{t(methodLabelKey(log.method))}</dd>
        </div>
        {log.geoDistanceM !== null && (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">
              {t("hris.result.detailDistance")}
            </dt>
            <dd className="font-medium tabular">{log.geoDistanceM} m</dd>
          </div>
        )}
      </dl>

      {causes.length > 0 && (
        <div
          className={
            rejected
              ? "grid gap-2 rounded-lg bg-danger-subtle p-3"
              : "grid gap-2 rounded-lg bg-warning-subtle p-3"
          }
        >
          <p className="text-sm leading-5 font-semibold">
            {t("hris.reason.possibleTitle")}
          </p>
          <ul className="grid gap-2">
            {causes.map((reason) => (
              <li key={reason} className="text-sm leading-5">
                <p className="font-medium">{t(reasonLabelKey(reason))}</p>
                <p>{t(reasonFixKey(reason))}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <CardFooter className="flex-col items-stretch gap-2">
        {rejected ? (
          <>
            <Button type="button" size="lg" onClick={onRetry}>
              {t("hris.result.retry")}
            </Button>
            <Button asChild variant="outline">
              <Link to="/karyawan/absensi/riwayat">
                {t("hris.result.viewHistory")}
              </Link>
            </Button>
          </>
        ) : (
          <>
            <Button asChild size="lg">
              <Link to="/karyawan/absensi/riwayat">
                {t("hris.result.viewHistory")}
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/karyawan">{t("hris.result.backHome")}</Link>
            </Button>
          </>
        )}
      </CardFooter>
    </Card>
  );
}
