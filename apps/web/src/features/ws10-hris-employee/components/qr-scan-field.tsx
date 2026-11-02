// Rotating outlet QR input (PRD F25 "QR Outlet Berotasi", Alur L step 2). The
// outlet screen shows a code that changes every 30 seconds; the employee scans
// it when the GPS fix is unusable. Scanning uses the browser's native
// BarcodeDetector where it exists; everywhere else the code can be typed from
// the outlet screen — a phone with an old WebView still clocks in.
import { useCallback, useEffect, useRef, useState } from "react";
import { ScanLine, Square } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import type { MessageKey } from "@starter/shared/i18n";
import { hrisMockControl } from "../browser-mock.ts";

type DetectedCode = { rawValue: string };
type Detector = { detect(source: CanvasImageSource): Promise<DetectedCode[]> };
type DetectorConstructor = new (options?: {
  formats?: string[];
}) => Detector;

function detectorConstructor(): DetectorConstructor | null {
  const candidate = (globalThis as { BarcodeDetector?: unknown })
    .BarcodeDetector;
  return typeof candidate === "function"
    ? (candidate as DetectorConstructor)
    : null;
}

export function QrScanField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [mockToken, setMockToken] = useState<string | null>(null);

  useEffect(() => {
    setMockToken(hrisMockControl()?.currentQrToken() ?? null);
  }, []);

  const stopScanning = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setScanning(false);
  }, []);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    if (!scanning) return;
    const video = videoRef.current;
    const stream = streamRef.current;
    const Ctor = detectorConstructor();
    if (!video || !stream || !Ctor) return;
    video.srcObject = stream;
    void video.play().catch(() => {
      setError("hris.attendance.qrScanFailed");
      stopScanning();
    });
    const detector = new Ctor({ formats: ["qr_code"] });
    const timer = window.setInterval(() => {
      if (video.readyState < 2) return;
      void detector
        .detect(video)
        .then((codes) => {
          const raw = codes[0]?.rawValue?.trim();
          if (!raw) return;
          onChange(raw);
          setError(null);
          stopScanning();
        })
        .catch(() => {
          // A frame that cannot be decoded is normal; the next tick retries.
        });
    }, 300);
    return () => window.clearInterval(timer);
  }, [scanning, onChange, stopScanning]);

  async function startScanning() {
    setError(null);
    if (!detectorConstructor()) {
      setError("hris.attendance.qrUnsupported");
      return;
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices) {
      setError("hris.attendance.qrUnsupported");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      streamRef.current = stream;
      setScanning(true);
    } catch {
      setError("hris.attendance.qrScanFailed");
    }
  }

  return (
    <div className="grid gap-3">
      {scanning && (
        <video
          ref={videoRef}
          muted
          playsInline
          autoPlay
          aria-label={t("hris.attendance.qrTitle")}
          className="aspect-square w-full rounded-lg border-(length:--border-w) bg-muted object-cover"
        />
      )}

      <FormField
        label={t("hris.attendance.qrCodeLabel")}
        hint={error ? undefined : t("hris.attendance.qrHint")}
        error={error ? t(error) : undefined}
        required
      >
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={t("hris.attendance.qrCodePlaceholder")}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="font-mono"
        />
      </FormField>

      {scanning ? (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={stopScanning}
        >
          <Square aria-hidden="true" />
          {t("hris.attendance.qrScanStop")}
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => void startScanning()}
        >
          <ScanLine aria-hidden="true" />
          {t("hris.attendance.qrScan")}
        </Button>
      )}

      {mockToken && (
        <div className="grid gap-1 rounded-lg bg-muted p-3">
          <p className="text-xs leading-4 text-muted-foreground">
            {t("hris.attendance.mockQrHint", { token: mockToken })}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-fit"
            onClick={() => {
              onChange(mockToken);
              setError(null);
            }}
          >
            {t("hris.attendance.mockQrFill")}
          </Button>
        </div>
      )}
    </div>
  );
}
