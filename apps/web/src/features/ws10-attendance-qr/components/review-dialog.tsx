// Evidence dialog of the supervisor selfie sampling review (PRD v1.7 §3 F25;
// bead legend-0z5k). The evidence is a private-bucket selfie (PII
// `attendancePhotoUrl`, readable with hr.attendance.manage — the page guard).
// A data URL (mock/offline capture) or the signed, short-lived `https:` link
// renders as an image; any other scheme is never loaded. The image is fetched
// without a referrer, the URL is never logged or shown as text, and an expired
// link falls back to the private-storage note.
import * as React from "react";
import { CircleCheck, Flag, ImageOff, Paperclip } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatNumber } from "@starter/shared/i18n";
import type { AttendanceLog } from "@starter/shared/hris";
import { formatOutletTime } from "../format.ts";
import {
  ATTENDANCE_METHOD_KEY,
  ATTENDANCE_TYPE_KEY,
  ATTENDANCE_VALIDITY,
} from "../labels.ts";
import { ATTENDANCE_TIME_ZONE } from "../outlet.ts";
import type {
  AttendanceReviewDecision,
  AttendanceReviewKind,
} from "../review-store.ts";

export function ReviewDialog({
  log,
  employeeName,
  decision,
  canDecide,
  onDecide,
  onOpenChange,
}: {
  log: AttendanceLog | null;
  employeeName: string;
  decision: AttendanceReviewDecision | undefined;
  /** hr.attendance.manage; without it the actions are not offered. */
  canDecide: boolean;
  onDecide: (kind: AttendanceReviewKind) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const open = log !== null;
  // "Validitas sistem" is the server's value; the session decision is shown
  // separately and never replaces it.
  const validity = log?.validity ?? "valid";
  const validityLabel = ATTENDANCE_VALIDITY[validity];
  const terminal = log?.validity === "rejected";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        {log && (
          <>
            <DialogHeader>
              <DialogTitle>
                {t("attendanceQr.review.dialogTitle", { name: employeeName })}
              </DialogTitle>
              <DialogDescription>
                {t("attendanceQr.review.dialogDescription")}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4">
              <section className="grid gap-2">
                <h3 className="type-heading">
                  {t("attendanceQr.review.evidenceTitle")}
                </h3>
                <SelfieEvidence
                  key={log.id}
                  log={log}
                  employeeName={employeeName}
                />
              </section>

              <section className="grid gap-2">
                <h3 className="type-heading">
                  {t("attendanceQr.review.factsTitle")}
                </h3>
                <dl className="grid grid-cols-2 gap-3 rounded-container border-(length:--border-w) bg-surface-2 p-3 text-sm">
                  <Fact
                    label={t("attendanceQr.review.factType")}
                    value={t(ATTENDANCE_TYPE_KEY[log.type])}
                  />
                  <Fact
                    label={t("attendanceQr.review.factTime")}
                    value={formatOutletTime(
                      log.occurredAt,
                      ATTENDANCE_TIME_ZONE,
                    )}
                  />
                  <Fact
                    label={t("attendanceQr.review.factMethod")}
                    value={t(ATTENDANCE_METHOD_KEY[log.method])}
                  />
                  <Fact
                    label={t("attendanceQr.review.factGeo")}
                    value={
                      log.geoDistanceM === null
                        ? t("attendanceQr.review.factGeoNone")
                        : t("attendanceQr.review.factGeoValue", {
                            metres: formatNumber(log.geoDistanceM),
                          })
                    }
                  />
                  <Fact
                    label={t("attendanceQr.review.factDevice")}
                    value={
                      log.deviceIdHash === null
                        ? t("attendanceQr.review.factDeviceUnbound")
                        : t("attendanceQr.review.factDeviceBound")
                    }
                  />
                  <div className="min-w-0">
                    <dt className="text-muted-foreground">
                      {t("attendanceQr.review.factValidity")}
                    </dt>
                    <dd className="mt-1">
                      <StatusPill status={validityLabel.status}>
                        {t(validityLabel.labelKey)}
                      </StatusPill>
                    </dd>
                  </div>
                </dl>
              </section>

              <section className="grid gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="type-heading">
                    {t("attendanceQr.review.decisionTitle")}
                  </h3>
                  {decision && (
                    <Badge
                      tone={
                        decision.kind === "accepted" ? "success" : "warning"
                      }
                    >
                      {decision.kind === "accepted"
                        ? t("attendanceQr.review.localAccepted")
                        : t("attendanceQr.review.localFlagged")}
                    </Badge>
                  )}
                </div>

                {decision && (
                  <p className="text-sm leading-5 text-muted-foreground">
                    {t("attendanceQr.review.decidedAt", {
                      time: formatOutletTime(
                        decision.decidedAt,
                        ATTENDANCE_TIME_ZONE,
                      ),
                    })}
                  </p>
                )}

                {terminal ? (
                  <p className="rounded-container bg-danger-subtle p-3 text-sm leading-5 text-danger">
                    {t("attendanceQr.review.rejectedNote")}
                  </p>
                ) : !canDecide ? (
                  <p className="rounded-container bg-surface-2 p-3 text-sm leading-5 text-muted-foreground">
                    {t("attendanceQr.review.noPermission")}
                  </p>
                ) : (
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button onClick={() => onDecide("accepted")}>
                      <CircleCheck aria-hidden="true" />
                      {t("attendanceQr.review.acceptAction")}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => onDecide("flagged")}
                    >
                      <Flag aria-hidden="true" />
                      {t("attendanceQr.review.flagAction")}
                    </Button>
                  </div>
                )}

                <p className="text-xs leading-5 text-muted-foreground">
                  {t("attendanceQr.review.localNote")}
                </p>
              </section>
            </div>

            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">
                  {t("attendanceQr.review.close")}
                </Button>
              </DialogClose>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}

function SelfieEvidence({
  log,
  employeeName,
}: {
  log: AttendanceLog;
  employeeName: string;
}) {
  const t = useT();
  const [failed, setFailed] = React.useState(false);
  if (log.photoUrl === null)
    return (
      <div className="grid gap-1.5 rounded-container border-(length:--border-w) bg-surface-2 p-card">
        <Badge tone="neutral">
          <ImageOff aria-hidden="true" />
          {t("attendanceQr.review.selfieMissing")}
        </Badge>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("attendanceQr.review.selfieNoneHint")}
        </p>
      </div>
    );

  if (!failed && isRenderablePhoto(log.photoUrl))
    return (
      <img
        src={log.photoUrl}
        referrerPolicy="no-referrer"
        decoding="async"
        onError={() => setFailed(true)}
        alt={t("attendanceQr.review.selfieAlt", { name: employeeName })}
        className="max-h-80 w-full rounded-media border-(length:--border-w) bg-surface-3 object-contain"
      />
    );

  return (
    <div className="grid gap-1.5 rounded-container border-(length:--border-w) bg-surface-2 p-card">
      <Badge tone="neutral">
        <Paperclip aria-hidden="true" />
        {t("attendanceQr.review.selfiePrivate")}
      </Badge>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("attendanceQr.review.selfiePrivateHint")}
      </p>
    </div>
  );
}

/** Only an inline image or a TLS signed link is ever handed to `<img>`. */
function isRenderablePhoto(url: string): boolean {
  if (url.startsWith("data:image/")) return true;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
