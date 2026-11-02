// Attendance clock (PRD v1.7 §3 Kelompok D 33 "Absen", F25, §4 Alur L,
// HR-02). Three steps on one screen: selfie, method (selfie+GPS or the
// rotating outlet QR), then send. The camera starts on open, so the walk from
// the Beranda is button → shutter → kirim.
//
// Nothing is decided here: the server evaluates geofence, device binding,
// selfie presence and the QR window with the tenant policy and answers the
// stored log with its validity. This screen only refuses to send an incomplete
// submission.
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, MapPin, QrCode, ShieldCheck } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import type { MessageKey } from "@starter/shared/i18n";
import type { AttendanceLog, AttendanceType } from "@starter/shared/hris";
import type { ClockAttendanceInput } from "../api.ts";
import { useOnline } from "@/lib/use-online";
import { hrisMockControl } from "../browser-mock.ts";
import { deviceIdHash } from "../device.ts";
import { useGeolocation } from "../geo.ts";
import { useClockAttendance, useMyHrisProfile } from "../hooks.ts";
import { uploadAttendanceSelfie } from "../selfie.ts";
import {
  looksLikeQrToken,
  methodLabelKey,
  normalizeQrToken,
  sameClockCapture,
  typeTitleKey,
  type ClockCapture,
} from "../state.ts";
import { AttendanceResult } from "./attendance-result.tsx";
import { LocationStatus } from "./location-status.tsx";
import { QrScanField } from "./qr-scan-field.tsx";
import { SelfieCapture } from "./selfie-capture.tsx";
import { newIdempotencyKey } from "../../../lib/idempotency.ts";

type ClockMethod = "selfie_geo" | "rotating_qr";

export function AttendanceClock({ type }: { type: AttendanceType }) {
  const t = useT();
  const online = useOnline();
  const profile = useMyHrisProfile();
  const clock = useClockAttendance();
  const mock = hrisMockControl();

  const [method, setMethod] = useState<ClockMethod>("selfie_geo");
  const [selfie, setSelfie] = useState<Blob | null>(null);
  const [qrToken, setQrToken] = useState("");
  const [deviceHash, setDeviceHash] = useState<string | null | undefined>(
    undefined,
  );
  const [deviceBound, setDeviceBound] = useState(false);
  const [formError, setFormError] = useState<MessageKey | null>(null);
  const [submitError, setSubmitError] = useState<Error | null>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<AttendanceLog | null>(null);
  // The last unanswered attempt: its captured inputs and the exact request
  // sent. A retry with the same inputs resends that request byte for byte.
  const attempt = useRef<{
    capture: ClockCapture;
    body: ClockAttendanceInput;
  } | null>(null);
  const submitting = useRef(false);

  const geo = useGeolocation(method === "selfie_geo");

  useEffect(() => {
    let active = true;
    void deviceIdHash().then((hash) => {
      if (active) setDeviceHash(hash);
    });
    return () => {
      active = false;
    };
  }, []);

  // The result replaces the form below the page header; bring it into view.
  useEffect(() => {
    if (result) document.getElementById("main-content")?.scrollTo({ top: 0 });
  }, [result]);

  if (profile.isPending)
    return (
      <div aria-busy="true" className="grid gap-4">
        <span className="sr-only" role="status">
          {t("common.loading")}
        </span>
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-64 w-full rounded-container" />
        <Skeleton className="h-48 w-full rounded-container" />
      </div>
    );

  if (profile.isError || !profile.data)
    return (
      <ErrorState
        title={t("hris.state.profileError")}
        description={t("hris.state.retryHint")}
        onRetry={() => void profile.refetch()}
      />
    );

  const timeZone = profile.data.outlet.timeZone;

  async function handleSubmit() {
    setFormError(null);
    setSubmitError(null);
    if (!selfie) {
      setFormError("hris.attendance.photoRequired");
      return;
    }
    if (method === "selfie_geo" && geo.state.status !== "ready") {
      setFormError(
        geo.state.status === "denied"
          ? "hris.attendance.locationDenied"
          : "hris.attendance.locationNeeded",
      );
      return;
    }
    if (method === "rotating_qr" && !looksLikeQrToken(qrToken)) {
      setFormError("hris.attendance.qrNeeded");
      return;
    }
    if (!online) {
      setFormError("hris.attendance.submitOffline");
      return;
    }
    if (submitting.current) return;
    submitting.current = true;
    setUploading(true);
    try {
      const capture: ClockCapture = {
        type,
        method,
        selfie,
        qrToken: method === "rotating_qr" ? normalizeQrToken(qrToken) : null,
        location:
          method === "selfie_geo" && geo.state.status === "ready"
            ? geo.state.location
            : null,
        deviceIdHash: deviceHash ?? null,
      };
      // One attempt, one key: a retry after a network error replays the same
      // request (same upload ref and capture time) so the API answers the
      // original log instead of creating a second one or refusing the key.
      if (
        !attempt.current ||
        !sameClockCapture(attempt.current.capture, capture)
      ) {
        const photoUploadRef = await uploadAttendanceSelfie(selfie);
        attempt.current = {
          capture,
          body: {
            type,
            method,
            occurredAt: new Date().toISOString(),
            location: capture.location,
            deviceIdHash: capture.deviceIdHash,
            photoUploadRef,
            qrToken: capture.qrToken,
            idempotencyKey: newIdempotencyKey(),
          },
        };
      }
      const log = await clock.mutateAsync(attempt.current.body);
      attempt.current = null;
      setResult(log);
    } catch (error) {
      setSubmitError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      submitting.current = false;
      setUploading(false);
    }
  }

  const busy = uploading || clock.isPending;

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
          <Link to="/karyawan">
            <ChevronLeft aria-hidden="true" />
            {t("hris.attendance.back")}
          </Link>
        </Button>
        <header className="grid gap-1">
          <h1 className="font-brand type-display-xl">
            {t(typeTitleKey(type))}
          </h1>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("hris.attendance.subtitle")}
          </p>
        </header>
      </div>

      {result ? (
        <AttendanceResult
          log={result}
          timeZone={timeZone}
          submitted={{ method, selfie: selfie !== null }}
          onRetry={() => {
            setResult(null);
            setSubmitError(null);
            setFormError(null);
          }}
        />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="font-brand type-title">
                {t("hris.attendance.stepSelfie")}
              </CardTitle>
              <CardDescription>
                {t("hris.attendance.stepSelfieHint")}
              </CardDescription>
            </CardHeader>
            <SelfieCapture value={selfie} onChange={setSelfie} />
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="font-brand type-title">
                {t("hris.attendance.stepDetails")}
              </CardTitle>
              <CardDescription>
                {t(
                  method === "selfie_geo"
                    ? "hris.attendance.methodSelfieHint"
                    : "hris.attendance.methodQrHint",
                )}
              </CardDescription>
            </CardHeader>

            <SegmentedControl
              value={method}
              onValueChange={setMethod}
              label={t("hris.attendance.methodTitle")}
              options={[
                {
                  value: "selfie_geo",
                  label: t("hris.attendance.methodSelfie"),
                  icon: MapPin,
                },
                {
                  value: "rotating_qr",
                  label: t("hris.attendance.methodQr"),
                  icon: QrCode,
                },
              ]}
            />

            {method === "selfie_geo" ? (
              <LocationStatus state={geo.state} onRetry={geo.request} />
            ) : (
              <QrScanField value={qrToken} onChange={setQrToken} />
            )}

            <div className="grid gap-1 border-t pt-3">
              <p className="flex items-center gap-1.5 text-sm leading-5 font-medium">
                <ShieldCheck
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                {t("hris.attendance.deviceTitle")}
              </p>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("hris.attendance.deviceHint")}
              </p>
              {mock && deviceHash && (
                <div className="pt-1">
                  {deviceBound ? (
                    <p className="text-sm leading-5 font-medium text-success">
                      {t("hris.attendance.mockBound")}
                    </p>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-fit"
                      onClick={() => {
                        mock.bindDevice(deviceHash);
                        setDeviceBound(true);
                      }}
                    >
                      {t("hris.attendance.mockBind")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="font-brand type-title">
                {t("hris.attendance.stepSubmit")}
              </CardTitle>
            </CardHeader>

            <dl className="grid gap-2 rounded-container bg-surface-2 p-3 text-sm leading-5">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">
                  {t("hris.attendance.summaryMethod")}
                </dt>
                <dd className="text-right font-medium">
                  {t(methodLabelKey(method))}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">
                  {t("hris.attendance.summarySelfie")}
                </dt>
                <dd className="text-right font-medium">
                  {selfie
                    ? t("hris.attendance.photoReady")
                    : t("hris.attendance.photoMissing")}
                </dd>
              </div>
              {method === "selfie_geo" ? (
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground">
                    {t("hris.attendance.summaryLocation")}
                  </dt>
                  <dd className="text-right font-medium">
                    {geo.state.status === "ready"
                      ? t("hris.attendance.locationFound", {
                          accuracy: geo.state.location.accuracyM,
                        })
                      : geo.state.status === "locating"
                        ? t("hris.attendance.locationChecking")
                        : geo.state.status === "denied"
                          ? t("hris.attendance.locationDenied")
                          : geo.state.status === "unavailable"
                            ? t("hris.attendance.locationUnavailable")
                            : t("hris.attendance.locationIdle")}
                  </dd>
                </div>
              ) : (
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground">
                    {t("hris.attendance.summaryQr")}
                  </dt>
                  <dd className="text-right font-medium">
                    {looksLikeQrToken(qrToken)
                      ? t("hris.attendance.qrReady")
                      : t("hris.attendance.qrMissing")}
                  </dd>
                </div>
              )}
            </dl>

            {!online && (
              <div className="grid gap-1 rounded-container bg-warning-subtle p-3">
                <p className="text-sm leading-5 font-semibold">
                  {t("hris.attendance.offlineTitle")}
                </p>
                <p className="text-sm leading-5">
                  {t("hris.attendance.offlineHint")}
                </p>
              </div>
            )}

            <div aria-live="polite">
              {formError && (
                <p
                  role="alert"
                  className="text-sm leading-5 font-medium text-danger"
                >
                  {t(formError)}
                </p>
              )}
            </div>

            {submitError && (
              <div role="alert" className="grid gap-0.5">
                <p className="text-sm leading-5 font-semibold text-danger">
                  {t("hris.attendance.errorTitle")}
                </p>
                <p className="text-sm leading-5">{submitError.message}</p>
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("hris.attendance.errorHint")}
                </p>
              </div>
            )}

            <Button
              type="button"
              size="lg"
              className="w-full"
              loading={busy}
              disabled={!online}
              onClick={() => void handleSubmit()}
            >
              {busy
                ? t("hris.attendance.submitting")
                : t("hris.attendance.submit")}
            </Button>
          </Card>
        </>
      )}
    </div>
  );
}
