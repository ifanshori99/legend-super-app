// Signature evidence as a canvas signature pad plus an accessible text
// alternative (PRD v1.7 §3 F41: "tanda tangan digital"). Pointer events draw;
// a clear button resets. The name field lets a user sign without drawing, so
// the evidence never depends on a motor skill alone (WCAG 2.5.1 alternative).
// The pad stores a mock media id: real media upload wiring follows a later bead.
import * as React from "react";
import { Eraser } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SignatureField({
  hasInk,
  onInkChange,
  signerName,
  onSignerNameChange,
  signerNameError,
}: {
  hasInk: boolean;
  onInkChange: (hasInk: boolean) => void;
  signerName: string;
  onSignerNameChange: (name: string) => void;
  signerNameError?: string;
}) {
  const t = useT();
  const labelId = React.useId();
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const drawing = React.useRef(false);
  const lastPoint = React.useRef<{ x: number; y: number } | null>(null);
  const inkRef = React.useRef(hasInk);
  const onInkChangeRef = React.useRef(onInkChange);

  // Keep the latest callback without touching the ref during render (React
  // purity rule); the drawing handlers read it from event time.
  React.useEffect(() => {
    onInkChangeRef.current = onInkChange;
  }, [onInkChange]);

  const clear = React.useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (canvas && context) {
      context.clearRect(0, 0, canvas.width, canvas.height);
    }
    inkRef.current = false;
    onInkChangeRef.current(false);
  }, []);

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
      // The stroke follows the theme's ink token (no raw colour).
      context.strokeStyle = getComputedStyle(canvas).color;
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
          className="h-40 w-full touch-none rounded-field border-(length:--border-w) border-input bg-background text-foreground shadow-hairline"
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
          <Button type="button" variant="outline" size="sm" onClick={clear}>
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
          onChange={(event) => onSignerNameChange(event.target.value)}
        />
      </FormField>
    </div>
  );
}
