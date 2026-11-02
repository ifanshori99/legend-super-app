// Selfie capture for the attendance clock (PRD F25 "Absensi selfie", HR-02:
// a missing selfie is always rejected). Two honest paths:
//
// - Live camera through getUserMedia, with a visible shutter.
// - The native camera app through `<input type="file" capture="user">`, which
//   is the fallback when the browser refuses the stream (older iOS PWA, denied
//   permission) and the only path in a desktop browser without a camera.
//
// The preview is a local object URL; nothing is uploaded until the employee
// presses "Kirim absen".
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, Images, RotateCw, VideoOff } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import type { MessageKey } from "@starter/shared/i18n";
import {
  captureSelfieFrame,
  normalizeSelfieFile,
  selfieFileProblem,
  type SelfieFileProblem,
} from "../selfie.ts";

type CameraMode = "idle" | "starting" | "streaming";

type SelfieError = "cameraDenied" | "cameraUnavailable" | SelfieFileProblem;

const ERROR_KEYS: Record<SelfieError, MessageKey> = {
  cameraDenied: "hris.attendance.cameraDenied",
  cameraUnavailable: "hris.attendance.cameraUnavailable",
  fileTooLarge: "hris.attendance.fileTooLarge",
  fileWrongType: "hris.attendance.fileWrongType",
};

export function SelfieCapture({
  value,
  onChange,
}: {
  value: Blob | null;
  onChange: (blob: Blob | null) => void;
}) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [mode, setMode] = useState<CameraMode>("idle");
  const [error, setError] = useState<SelfieError | null>(null);
  const [capturing, setCapturing] = useState(false);

  const previewUrl = useMemo(
    () => (value ? URL.createObjectURL(value) : null),
    [value],
  );

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => stopStream, [stopStream]);

  useEffect(() => {
    if (mode !== "streaming") return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    void video.play().catch(() => {
      setError("cameraUnavailable");
      setMode("idle");
      stopStream();
    });
  }, [mode, stopStream]);

  const startCamera = useCallback(async () => {
    setError(null);
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      setError("cameraUnavailable");
      return;
    }
    setMode("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      setMode("streaming");
    } catch (caught) {
      stopStream();
      setMode("idle");
      setError(
        caught instanceof DOMException && caught.name === "NotAllowedError"
          ? "cameraDenied"
          : "cameraUnavailable",
      );
    }
  }, [stopStream]);

  // Auto-start once: the three-tap clock is Beranda → shutter → kirim (PRD
  // §3 Kelompok D 33 scope "≤3 taps"), so opening this screen turns the front
  // camera on. A denied permission keeps the native-camera fallback below.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || value !== null) return;
    autoStarted.current = true;
    void startCamera();
  }, [startCamera, value]);

  async function takePhoto() {
    const video = videoRef.current;
    if (!video) return;
    setCapturing(true);
    try {
      const blob = await captureSelfieFrame(video);
      stopStream();
      setMode("idle");
      setError(null);
      onChange(blob);
    } catch {
      setError("cameraUnavailable");
    } finally {
      setCapturing(false);
    }
  }

  async function pickFile(file: File) {
    const problem = selfieFileProblem(file);
    if (problem) {
      setError(problem);
      return;
    }
    try {
      const blob = await normalizeSelfieFile(file);
      setError(null);
      onChange(blob);
    } catch {
      setError("fileWrongType");
    }
  }

  return (
    <div className="grid gap-3">
      {value && previewUrl ? (
        <img
          src={previewUrl}
          alt={t("hris.attendance.photoAlt")}
          className="h-64 w-full rounded-lg border-(length:--border-w) object-cover sm:h-80"
        />
      ) : mode === "streaming" ? (
        <video
          ref={videoRef}
          muted
          playsInline
          autoPlay
          aria-label={t("hris.attendance.cameraTitle")}
          className="h-64 w-full rounded-lg border-(length:--border-w) bg-muted object-cover sm:h-80"
        />
      ) : (
        <div className="grid h-64 place-items-center gap-2 rounded-lg border-(length:--border-w) border-dashed bg-muted/40 p-4 text-center sm:h-80">
          {mode === "starting" ? (
            <p className="text-sm text-muted-foreground">
              {t("hris.attendance.cameraStarting")}
            </p>
          ) : (
            <>
              <Camera
                className="size-8 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="text-sm text-muted-foreground">
                {t("hris.attendance.photoMissing")}
              </p>
            </>
          )}
        </div>
      )}

      <div className="grid gap-2">
        {mode === "streaming" ? (
          <Button
            type="button"
            size="lg"
            loading={capturing}
            onClick={() => void takePhoto()}
          >
            <Camera aria-hidden="true" />
            {t("hris.attendance.cameraShutter")}
          </Button>
        ) : value ? (
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={() => {
              onChange(null);
              setError(null);
            }}
          >
            <RotateCw aria-hidden="true" />
            {t("hris.attendance.cameraRetake")}
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="lg"
            loading={mode === "starting"}
            onClick={() => void startCamera()}
          >
            <Camera aria-hidden="true" />
            {t("hris.attendance.cameraStart")}
          </Button>
        )}

        {mode === "streaming" ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              stopStream();
              setMode("idle");
            }}
          >
            <VideoOff aria-hidden="true" />
            {t("common.cancel")}
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            onClick={() => fileRef.current?.click()}
          >
            <Images aria-hidden="true" />
            {t("hris.attendance.fileFallback")}
          </Button>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="user"
        className="sr-only"
        aria-label={t("hris.attendance.fileFallback")}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void pickFile(file);
        }}
      />

      <div aria-live="polite" className="grid gap-1">
        {error && (
          <p role="alert" className="text-sm leading-5 font-medium text-danger">
            {t(ERROR_KEYS[error])}
          </p>
        )}
        {value && !error && (
          <p className="text-sm leading-5 font-medium text-success">
            {t("hris.attendance.photoReady")}
          </p>
        )}
        <p className="text-sm leading-5 text-muted-foreground">
          {t("hris.attendance.cameraHint")}
        </p>
      </div>
    </div>
  );
}
