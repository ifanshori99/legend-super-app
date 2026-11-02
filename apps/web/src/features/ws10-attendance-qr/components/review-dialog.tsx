// Evidence dialog of the supervisor selfie sampling review (PRD v1.7 §3 F25;
// bead legend-0z5k). The evidence is a private-bucket selfie: a data URL (the
// mock/offline capture) renders as an image, a signed `photoUrl` for anything
// else is shown as an attachment badge. A stored external URL is never loaded
// here, both because the signed link may already be expired and because the
// mock fixtures carry example hosts that must not be requested.
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
  onDecide,
  onOpenChange,
}: {
  log: AttendanceLog | null;
  employeeName: string;
  decision: AttendanceReviewDecision | undefined;
  onDecide: (kind: AttendanceReviewKind) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const open = log !== null;
  const validity = decision?.validity ?? log?.validity ?? "valid";
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
                <SelfieEvidence log={log} employeeName={employeeName} />
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

  if (log.photoUrl.startsWith("data:image/"))
    return (
      <img
        src={log.photoUrl}
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
