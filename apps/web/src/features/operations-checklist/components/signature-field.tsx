// Signature evidence as a canvas signature pad (PRD v1.7 §3 F41: "tanda tangan
// digital"). Pointer events draw; a clear button resets. The pad exports its
// ink as a PNG Blob through `handleRef`; the card uploads it and records the
// id the API returns. Keyboard users who cannot draw type their name instead:
// with no ink, the name is rendered onto the canvas in a script face and that
// image is the signature. Ink and paper are fixed tokens (not theme-driven) so
// the stored PNG is legible whatever theme the screen used.
import * as React from "react";
import { cn } from "cn";
import { Eraser } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type SignatureHandle = {
  /** Ink (or the typed name) on paper as a PNG, or null while both are empty. */
  exportPng: () => Promise<Blob | null>;
  /** Changes whenever the drawing changes, so a stale upload is detectable. */
  revision: () => string;
};

// Script-like system faces; the generic `cursive` family is the last resort.
const SIGNATURE_FONT =
  '"Snell Roundhand", "Segoe Script", "Brush Script MT", "Apple Chancery", cursive';

function padColors(canvas: HTMLCanvasElement) {
  const style = getComputedStyle(canvas);
  return {
    ink: style.getPropertyValue("--signature-ink").trim() || style.color,
    paper:
      style.getPropertyValue("--signature-paper").trim() ||
      style.backgroundColor,
  };
}

export function SignatureField({
  handleRef,
  hasInk,
  onInkChange,
  signerName,
  onSignerNameChange,
  signerNameError,
  disabled = false,
}: {
  handleRef?: React.Ref<SignatureHandle>;
  hasInk: boolean;
  onInkChange: (hasInk: boolean) => void;
  signerName: string;
  onSignerNameChange: (name: string) => void;
  signerNameError?: string;
  /** Locks the pad, Clear and the name while an upload or save is running. */
  disabled?: boolean;
}) {
  const t = useT();
  const labelId = React.useId();
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const drawing = React.useRef(false);
  const lastPoint = React.useRef<{ x: number; y: number } | null>(null);
  const inkRef = React.useRef(hasInk);
  const revisionRef = React.useRef(0);
  const onInkChangeRef = React.useRef(onInkChange);
  const signerNameRef = React.useRef(signerName);

  // Keep the latest callback without touching the ref during render (React
  // purity rule); the drawing handlers read it from event time.
  React.useEffect(() => {
    onInkChangeRef.current = onInkChange;
  }, [onInkChange]);

  React.useEffect(() => {
    signerNameRef.current = signerName;
  }, [signerName]);

  const clear = React.useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (canvas && context) {
      context.clearRect(0, 0, canvas.width, canvas.height);
    }
    inkRef.current = false;
    revisionRef.current += 1;
    onInkChangeRef.current(false);
  }, []);

  React.useImperativeHandle(
    handleRef,
    () => ({
      // Drawing and typed name both change the image, so both are in the key.
      revision: () => `${revisionRef.current}:${signerNameRef.current.trim()}`,
      exportPng: () => {
        const canvas = canvasRef.current;
        const name = signerNameRef.current.trim();
        if (!canvas || (!inkRef.current && name === ""))
          return Promise.resolve(null);
        const out = document.createElement("canvas");
        out.width = canvas.width;
        out.height = canvas.height;
        const outContext = out.getContext("2d");
        if (!outContext) return Promise.resolve(null);
        const { ink, paper } = padColors(canvas);
        outContext.fillStyle = paper;
        outContext.fillRect(0, 0, out.width, out.height);
        if (inkRef.current) {
          outContext.drawImage(canvas, 0, 0);
        } else {
          // No ink: the typed name stands in as the signature image.
          let size = Math.round(out.height * 0.4);
          outContext.fillStyle = ink;
          outContext.textBaseline = "middle";
          outContext.textAlign = "center";
          outContext.font = `italic ${size}px ${SIGNATURE_FONT}`;
          const maxWidth = out.width * 0.9;
          const measured = outContext.measureText(name).width;
          if (measured > maxWidth) {
            size = Math.max(8, Math.floor((size * maxWidth) / measured));
            outContext.font = `italic ${size}px ${SIGNATURE_FONT}`;
          }
          outContext.fillText(name, out.width / 2, out.height / 2);
        }
        return new Promise<Blob | null>((resolve) =>
          out.toBlob(resolve, "image/png"),
        );
      },
    }),
    [],
  );

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.lineWidth = 2;
      context.lineCap = "round";
      context.lineJoin = "round";
      // The stroke follows the fixed signature ink token (no raw colour).
      context.strokeStyle = padColors(canvas).ink;
      context.fillStyle = context.strokeStyle;
      clear();
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [clear]);

  function pointOf(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function markInk() {
    revisionRef.current += 1;
    if (inkRef.current) return;
    inkRef.current = true;
    onInkChangeRef.current(true);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    const point = pointOf(event);
    lastPoint.current = point;
    // A tap leaves a dot, so a deliberate mark is never ambiguous.
    const context = event.currentTarget.getContext("2d");
    if (context) {
      context.beginPath();
      context.arc(point.x, point.y, 1.25, 0, Math.PI * 2);
      context.fill();
    }
    markInk();
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const point = pointOf(event);
    const previous = lastPoint.current;
    const context = event.currentTarget.getContext("2d");
    if (context && previous) {
      context.beginPath();
      context.moveTo(previous.x, previous.y);
      context.lineTo(point.x, point.y);
      context.stroke();
    }
    lastPoint.current = point;
    markInk();
  }

  function endStroke() {
    drawing.current = false;
    lastPoint.current = null;
  }

  return (
    <div data-slot="checklist-signature" className="grid gap-3">
      <div className="grid gap-1.5">
        <Label id={labelId}>{t("opsChecklist.run.item.signatureLabel")}</Label>
        <canvas
          ref={canvasRef}
          role="img"
          aria-labelledby={labelId}
          data-slot="signature-canvas"
          data-inked={hasInk || undefined}
          aria-disabled={disabled || undefined}
          className={cn(
            "h-40 w-full touch-none rounded-field border-(length:--border-w) border-input bg-(--signature-paper) text-(--signature-ink) shadow-hairline",
            disabled && "pointer-events-none opacity-60",
          )}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
          onPointerLeave={endStroke}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm leading-5 text-muted-foreground">
            {t("opsChecklist.run.item.signatureHint")}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            aria-disabled={disabled || undefined}
            onClick={clear}
          >
            <Eraser aria-hidden="true" />
            {t("opsChecklist.run.item.signatureClear")}
          </Button>
        </div>
      </div>

      <FormField
        label={t("opsChecklist.run.item.signatureName")}
        hint={t("opsChecklist.run.item.signatureNameHint")}
        error={signerNameError}
      >
        <Input
          value={signerName}
          autoComplete="name"
          disabled={disabled}
          onChange={(event) => onSignerNameChange(event.target.value)}
        />
      </FormField>
    </div>
  );
}
