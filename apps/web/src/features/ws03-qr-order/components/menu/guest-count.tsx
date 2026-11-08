// Founder Q5 (legend-2re1): the guest count is asked inline in the menu, not in
// a dialog. Before joining the guest sees a "Jumlah tamu · Pilih" row (mobile)
// or chip (desktop); tapping it, or tapping an add, opens this paper panel.
// "Simpan" opens the table session (useJoinTable); the item the guest tapped
// then opens from the menu page.
import { useEffect, useRef, useState } from "react";
import { ChevronRight, Users, X } from "lucide-react";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useTableJourney } from "../../context";
import { useJoinTable } from "../../hooks";
import { QrStepper } from "../glass/qr-primitives";
import { Notice } from "../notice";

/** The inline paper panel: stepper plus the rust "Simpan". */
export function GuestPanel() {
  const t = useT();
  const { qrToken, closeJoin, clearPendingItem, clearSelection } =
    useTableJourney();
  const join = useJoinTable(qrToken);
  const [pax, setPax] = useState(2);
  const panel = useRef<HTMLDivElement>(null);
  // Opened by a tap: bring the keyboard and screen reader user into it.
  useEffect(() => {
    panel.current?.focus();
  }, []);
  // Dismissed without joining: the item and its stashed choices are dropped,
  // so they do not come back the next time that item is opened.
  const close = () => {
    clearPendingItem();
    clearSelection();
    closeJoin();
  };
  return (
    <section
      ref={panel}
      tabIndex={-1}
      aria-labelledby="qr-guest-title"
      className="qr-paper grid gap-3 rounded-qr-media p-4 shadow-raised focus-visible:outline-none"
    >
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          join.mutate(pax, { onSuccess: () => closeJoin() });
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="grid gap-1">
            <h2 id="qr-guest-title" className="text-base font-bold">
              {t("qrGlass.menu.guest.label")}
            </h2>
            <p className="text-base leading-snug text-muted-foreground">
              {t("qrGlass.menu.guest.hint")}
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            className="-m-2 inline-grid size-11 shrink-0 place-items-center rounded-full hover:bg-qr-selection focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <X className="size-5" aria-hidden="true" />
            <span className="sr-only">{t("qrGlass.menu.guest.close")}</span>
          </button>
        </div>
        <div className="flex items-center gap-3">
          <QrStepper
            tone="outline"
            value={pax}
            min={1}
            max={30}
            onChange={setPax}
            decreaseLabel={t("qrMenu.join.paxDecrease")}
            increaseLabel={t("qrMenu.join.paxIncrease")}
            valueLabel={t("qrMenu.join.paxValue", { count: pax })}
          />
          <Button
            type="submit"
            loading={join.isPending}
            className="min-w-0 flex-1"
          >
            {t("qrGlass.menu.guest.save")}
          </Button>
        </div>
        {join.isError && (
          <Notice tone="danger" title={t("qrMenu.join.error")} />
        )}
      </form>
    </section>
  );
}

/** Mobile row shown while the guest has not joined and the panel is closed. */
export function GuestRow({ className }: { className?: string }) {
  const t = useT();
  const { openJoin } = useTableJourney();
  return (
    <button
      type="button"
      onClick={() => openJoin()}
      aria-label={`${t("qrGlass.menu.guest.label")}, ${t("qrGlass.menu.guest.chooseAria")}`}
      className={cn(
        "qr-paper flex min-h-14 w-full items-center gap-3 rounded-qr-media px-4 text-left shadow-raised pressable focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
    >
      <Users className="size-5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-base">
        {t("qrGlass.menu.guest.label")}
        {" · "}
        <span className="font-bold">{t("qrGlass.menu.guest.choose")}</span>
      </span>
      <ChevronRight className="size-5 shrink-0" aria-hidden="true" />
    </button>
  );
}

/** Desktop chip in the left index: the count once joined, else opens the panel. */
export function GuestChip({
  pax,
  className,
}: {
  pax: number | null;
  className?: string;
}) {
  const t = useT();
  const { openJoin } = useTableJourney();
  const body = (
    <>
      <Users className="size-5 shrink-0" aria-hidden="true" />
      <span className="font-semibold">
        {pax !== null
          ? t("qrGlass.menu.guest.chip", { count: pax })
          : `${t("qrGlass.menu.guest.label")} · ${t("qrGlass.menu.guest.choose")}`}
      </span>
    </>
  );
  const base =
    "inline-flex min-h-11 w-fit items-center gap-2 rounded-qr-media bg-qr-selection px-3";
  return pax !== null ? (
    <span className={cn(base, className)}>{body}</span>
  ) : (
    <button
      type="button"
      onClick={() => openJoin()}
      aria-label={t("qrGlass.menu.guest.chooseAria")}
      className={cn(
        base,
        "pressable focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
    >
      {body}
    </button>
  );
}
