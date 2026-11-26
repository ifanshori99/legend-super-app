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
  onDone: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<TabletPrinter>(current);
  return (
    <form
      className="grid gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        writeTabletPrinter(draft);
        onDone();
      }}
    >
      <DialogHeader>
        <DialogTitle>{t("posKasirCommon.printer.title")}</DialogTitle>
        <DialogDescription>
          {t("posKasirCommon.printer.description")}
        </DialogDescription>
      </DialogHeader>
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-semibold">
          {t("posKasirCommon.printer.methodLabel")}
        </legend>
        <SegmentedControl
          label={t("posKasirCommon.printer.methodLabel")}
          value={draft.method}
          onValueChange={(method) => setDraft({ ...draft, method })}
          options={PRINTER_METHODS.map((method) => ({
            value: method,
            label: methodLabel(t, method),
          }))}
        />
        <p className="max-w-prose text-base text-muted-foreground">
          {t(`posKasirCommon.printer.methodHint.${draft.method}`)}
        </p>
      </fieldset>
      {draft.method !== "none" && (
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-semibold">
            {t("posKasirCommon.printer.paperLabel")}
          </legend>
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
        </fieldset>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
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
  const trigger = (
    <Button
      type="button"
      variant="outline"
      className={variant === "block" ? "w-full" : undefined}
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
        </div>
      ) : (
        trigger
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          {open && (
            <SettingsBody current={printer} onDone={() => setOpen(false)} />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
