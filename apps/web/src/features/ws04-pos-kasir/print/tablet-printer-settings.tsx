import { useState } from "react";
import { Printer } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { PrintPaperWidth } from "@starter/shared/pos";
import {
  PAPER_WIDTHS,
  PRINTER_METHODS,
  writeTabletPrinter,
  type PrinterMethod,
  type TabletPrinter,
} from "./printer-settings";
import { deliverToTabletPrinter } from "./send-to-printer";
import { testPrintPayload } from "./test-page";
import { useTabletPrinter } from "./use-tablet-printer";

type T = ReturnType<typeof useT>;

const methodLabel = (t: T, method: PrinterMethod) =>
  t(`posKasirCommon.printer.method.${method}`);
const paperLabel = (t: T, width: PrintPaperWidth) =>
  t(`posKasirCommon.printer.paper.w${width}`);

/** "RawBT · 58 mm", or just "Tanpa printer". */
export function tabletPrinterSummary(t: T, printer: TabletPrinter): string {
  if (printer.method === "none") return methodLabel(t, "none");
  return t("posKasirCommon.printer.summary", {
    method: methodLabel(t, printer.method),
    paper: paperLabel(t, printer.paperWidth),
  });
}

function SettingsBody({
  current,
  onDone,
}: {
  current: TabletPrinter;
  onDone: (saved?: TabletPrinter) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<TabletPrinter>(current);
  const [test, setTest] = useState<"sent" | "failed" | null>(null);
  return (
    <form
      className="grid gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        writeTabletPrinter(draft);
        onDone(draft);
      }}
    >
      <DialogHeader>
        <DialogTitle>{t("posKasirCommon.printer.title")}</DialogTitle>
        <DialogDescription>
          {t("posKasirCommon.printer.description")}
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <span aria-hidden="true" className="text-sm font-semibold">
          {t("posKasirCommon.printer.methodLabel")}
        </span>
        <SegmentedControl
          label={t("posKasirCommon.printer.methodLabel")}
          value={draft.method}
          onValueChange={(method) => {
            setDraft({ ...draft, method });
            setTest(null);
          }}
          options={PRINTER_METHODS.map((method) => ({
            value: method,
            label: methodLabel(t, method),
          }))}
        />
        <p className="max-w-prose text-base text-muted-foreground">
          {t(`posKasirCommon.printer.methodHint.${draft.method}`)}
        </p>
      </div>
      {draft.method !== "none" && (
        <div className="grid gap-2">
          <span aria-hidden="true" className="text-sm font-semibold">
            {t("posKasirCommon.printer.paperLabel")}
          </span>
          <SegmentedControl
            label={t("posKasirCommon.printer.paperLabel")}
            value={String(draft.paperWidth)}
            onValueChange={(value) =>
              setDraft({
                ...draft,
                paperWidth: Number(value) as PrintPaperWidth,
              })
            }
            options={PAPER_WIDTHS.map((width) => ({
              value: String(width),
              label: paperLabel(t, width),
            }))}
          />
        </div>
      )}
      {draft.method !== "none" && (
        <div className="grid justify-items-start gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              const { outcome } = deliverToTabletPrinter(
                testPrintPayload(draft.paperWidth),
                draft,
              );
              setTest(outcome === "failed" ? "failed" : "sent");
            }}
          >
            <Printer aria-hidden="true" />
            {t("posKasirCommon.printer.testPrint")}
          </Button>
          <p role="status" className="text-base">
            {test === "sent" && t("posKasirCommon.printer.testSent")}
            {test === "failed" && t("posKasirCommon.printer.testFailed")}
          </p>
        </div>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onDone()}>
          {t("posKasirCommon.printer.cancel")}
        </Button>
        <Button type="submit">{t("posKasirCommon.printer.save")}</Button>
      </DialogFooter>
    </form>
  );
}

/** The printer of this tablet: what it is now and the way to change it. */
export function TabletPrinterSettings({
  variant = "block",
}: {
  /** `block` shows the current printer; `button` is only the change button. */
  variant?: "block" | "button";
}) {
  const t = useT();
  const printer = useTabletPrinter();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<TabletPrinter | null>(null);
  // Review P2 no. 5: "Printer disimpan: RawBT · 80 mm", announced politely.
  const savedText = saved
    ? t("posKasirCommon.printer.saved", {
        summary: tabletPrinterSummary(t, saved),
      })
    : null;
  const trigger = (
    <Button
      type="button"
      variant="outline"
      // The side panel's footer sticks to the bottom: keep the button above it.
      className={variant === "block" ? "w-full scroll-mb-48" : undefined}
      onClick={() => setOpen(true)}
    >
      <Printer aria-hidden="true" />
      {t("posKasirCommon.printer.open")}
    </Button>
  );
  return (
    <>
      {variant === "block" ? (
        <div className="grid gap-3 border-b-(length:--border-w) border-border pb-4">
          <div className="grid gap-1">
            <span className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
              {t("posKasirCommon.printer.label")}
            </span>
            <span className="text-(length:--density-text) font-semibold">
              {tabletPrinterSummary(t, printer)}
            </span>
          </div>
          {trigger}
          {savedText && (
            <p aria-hidden="true" className="text-base">
              {savedText}
            </p>
          )}
        </div>
      ) : (
        trigger
      )}
      <p role="status" className="sr-only">
        {savedText}
      </p>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          {open && (
            <SettingsBody
              current={printer}
              onDone={(next) => {
                setOpen(false);
                if (next) setSaved(next);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
