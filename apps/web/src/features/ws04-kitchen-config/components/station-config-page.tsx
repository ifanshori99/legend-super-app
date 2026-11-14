// Station config editor (bead legend-sonf, PRD §3 F12 "KDS per Stasiun"):
// reorder the KDS tabs, switch a station on or off and turn the print fallback
// on per station. The draft lives on screen until "Simpan pengaturan"; a failed
// save keeps it.
import * as React from "react";
import { useBlocker } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  CircleCheck,
  TriangleAlert,
} from "lucide-react";
import { cn } from "cn";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useTenantContext } from "@/lib/tenant-context";
import {
  useKitchenStations,
  useMenuStations,
  useUpdateKitchenStations,
} from "../hooks.ts";
import {
  buildStationRows,
  moveStation,
  rankLabel,
  setStationFlag,
  stationsDirty,
  toStationUpdates,
  type MoveDirection,
  type StationRow,
  type StationRowFlag,
} from "../station-order.ts";

const TYPE_KEYS: Record<string, MessageKey> = {
  coffee_bar: "kitchenConfig.stations.types.coffee_bar",
  beverage_bar: "kitchenConfig.stations.types.beverage_bar",
  hot_kitchen: "kitchenConfig.stations.types.hot_kitchen",
  cold_kitchen: "kitchenConfig.stations.types.cold_kitchen",
  pastry: "kitchenConfig.stations.types.pastry",
};

// Rows: rank, name, order, status, print. Two columns up to 760px, one column
// (stacked, full-width toggles) up to 600px.
const ROW_COLS =
  "grid-cols-1 items-center gap-3 min-[601px]:grid-cols-[2rem_minmax(0,1fr)] min-[761px]:grid-cols-[2rem_minmax(7.5rem,1fr)_7.25rem_8.5rem_8.5rem]";

type FocusRequest = { stationId: string; direction: MoveDirection };

export function StationConfigPage() {
  const t = useT();
  const { outlet } = useTenantContext();
  const outletId = outlet?.id ?? null;
  const stations = useKitchenStations(outletId);
  const menuStations = useMenuStations(outletId);
  const update = useUpdateKitchenStations(outletId);

  const saved = React.useMemo(
    () => buildStationRows(stations.data ?? [], menuStations.data ?? []),
    [stations.data, menuStations.data],
  );
  const [draft, setDraft] = React.useState<StationRow[] | null>(null);
  const [saveFailed, setSaveFailed] = React.useState(false);
  const [justSaved, setJustSaved] = React.useState(false);
  const [announcement, setAnnouncement] = React.useState("");
  const rows = draft ?? saved;
  const dirty = draft !== null && stationsDirty(saved, draft);
  const noneActive = rows.length > 0 && rows.every((row) => !row.isActive);

  // Unsaved changes survive neither a route change nor a reload silently.
  useBlocker({
    shouldBlockFn: () =>
      !window.confirm(t("kitchenConfig.stations.leaveConfirm")),
    enableBeforeUnload: () => dirty,
    disabled: !dirty,
  });

  const orderButtons = React.useRef(new Map<string, HTMLButtonElement>());
  const focusRequest = React.useRef<FocusRequest | null>(null);
  const firstSwitch = React.useRef<HTMLButtonElement | null>(null);
  const viewButton = React.useRef<HTMLButtonElement | null>(null);

  // After a save the editor is replaced by the success notice: focus moves to
  // its button so keyboard users are not left on a removed control.
  React.useEffect(() => {
    if (justSaved) viewButton.current?.focus();
  }, [justSaved]);

  // After a move the moved row keeps focus on the same-direction button, or on
  // the other one when that end of the list disabled it.
  React.useLayoutEffect(() => {
    const request = focusRequest.current;
    if (!request) return;
    focusRequest.current = null;
    const same = orderButtons.current.get(
      `${request.stationId}:${request.direction}`,
    );
    const other = orderButtons.current.get(
      `${request.stationId}:${request.direction === "up" ? "down" : "up"}`,
    );
    (same && !same.disabled ? same : other)?.focus();
  }, [draft]);

  function change(next: StationRow[]) {
    setDraft(next);
    setJustSaved(false);
    setSaveFailed(false);
  }

  function move(index: number, direction: MoveDirection) {
    const row = rows[index];
    focusRequest.current = { stationId: row.stationId, direction };
    change(moveStation(rows, index, direction));
    setAnnouncement(
      t("kitchenConfig.stations.moved", {
        name: row.name ?? t("kitchenConfig.stations.unknownStation"),
        n: direction === "up" ? index : index + 2,
      }),
    );
  }

  function toggle(stationId: string, flag: StationRowFlag, value: boolean) {
    change(setStationFlag(rows, stationId, flag, value));
  }

  function submit() {
    if (!dirty || !draft || noneActive || update.isPending) return;
    setSaveFailed(false);
    update.mutate(toStationUpdates(draft), {
      onSuccess: () => {
        setDraft(null);
        setAnnouncement("");
        setJustSaved(true);
      },
      onError: () => setSaveFailed(true),
    });
  }

  function reload() {
    void stations.refetch();
    void menuStations.refetch();
  }

  const pending = stations.isPending || menuStations.isPending;
  const failed =
    (stations.isError && !stations.data) ||
    (menuStations.isError && !menuStations.data);

  function stationName(row: StationRow) {
    return row.name ?? t("kitchenConfig.stations.unknownStation");
  }

  function renderNameCell(row: StationRow) {
    const typeKey = row.type ? TYPE_KEYS[row.type] : undefined;
    return (
      <div className="min-w-0 min-[601px]:max-[760px]:col-start-2">
        <strong className="block text-lg leading-6">{stationName(row)}</strong>
        {typeKey && (
          <small className="block text-sm text-muted-foreground">
            {t(typeKey)}
          </small>
        )}
      </div>
    );
  }

  const rankClass =
    "text-center font-bold text-muted-foreground tabular-nums max-[760px]:self-start max-[760px]:pt-1 max-[600px]:text-left";

  const editorRows = (
    <div className="mt-6">
      <div
        aria-hidden="true"
        className={cn(
          ROW_COLS,
          "hidden border-t-(length:--border-w) py-3 text-sm text-muted-foreground min-[761px]:grid",
        )}
      >
        <span />
        <span>{t("kitchenConfig.stations.columnStation")}</span>
        <span>{t("kitchenConfig.stations.columnOrder")}</span>
        <span>{t("kitchenConfig.stations.columnStatus")}</span>
        <span>{t("kitchenConfig.stations.columnPrint")}</span>
      </div>
      <ul>
        {rows.map((row, index) => {
          const name = stationName(row);
          return (
            <li
              key={row.stationId}
              className={cn(
                "grid",
                ROW_COLS,
                "border-t-(length:--border-w) py-4 max-[600px]:items-stretch max-[600px]:gap-4 max-[600px]:py-6",
              )}
            >
              <span className={rankClass}>{rankLabel(index)}</span>
              {renderNameCell(row)}
              <Control label={t("kitchenConfig.stations.orderLabel")}>
                <div className="flex gap-1">
                  {(["up", "down"] as const).map((direction) => (
                    <Button
                      key={direction}
                      type="button"
                      variant="outline"
                      className="size-14! min-w-14 p-2"
                      aria-label={t(
                        direction === "up"
                          ? "kitchenConfig.stations.moveUp"
                          : "kitchenConfig.stations.moveDown",
                        { name },
                      )}
                      disabled={
                        update.isPending ||
                        (direction === "up"
                          ? index === 0
                          : index === rows.length - 1)
                      }
                      ref={(node: HTMLButtonElement | null) => {
                        const key = `${row.stationId}:${direction}`;
                        if (node) orderButtons.current.set(key, node);
                        else orderButtons.current.delete(key);
                      }}
                      onClick={() => move(index, direction)}
                    >
                      {direction === "up" ? (
                        <ArrowUp aria-hidden="true" />
                      ) : (
                        <ArrowDown aria-hidden="true" />
                      )}
                    </Button>
                  ))}
                </div>
              </Control>
              <Control label={t("kitchenConfig.stations.columnStatus")}>
                <FlagSwitch
                  checked={row.isActive}
                  disabled={update.isPending}
                  ariaLabel={t("kitchenConfig.stations.statusAria", { name })}
                  onText={t("kitchenConfig.stations.on")}
                  offText={t("kitchenConfig.stations.off")}
                  onChange={(value) => toggle(row.stationId, "isActive", value)}
                  ref={index === 0 ? firstSwitch : undefined}
                />
              </Control>
              <Control label={t("kitchenConfig.stations.columnPrint")}>
                <FlagSwitch
                  checked={row.autoPrintFallback}
                  disabled={update.isPending}
                  ariaLabel={t("kitchenConfig.stations.printAria", { name })}
                  onText={t("kitchenConfig.stations.on")}
                  offText={t("kitchenConfig.stations.off")}
                  onChange={(value) =>
                    toggle(row.stationId, "autoPrintFallback", value)
                  }
                />
              </Control>
            </li>
          );
        })}
      </ul>
    </div>
  );

  let body: React.ReactNode;
  if (pending) {
    body = (
      <div
        role="status"
        aria-busy="true"
        className="grid gap-3 py-6"
        data-testid="station-config-loading"
      >
        <strong>{t("kitchenConfig.stations.loading")}</strong>
        <div aria-hidden="true" className="grid gap-3">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-14 w-full rounded-container" />
          ))}
        </div>
      </div>
    );
  } else if (failed) {
    body = (
      <div className="grid gap-4 py-6">
        <Notice tone="danger" title={t("kitchenConfig.stations.errorTitle")}>
          {t("kitchenConfig.stations.errorHint")}
        </Notice>
        <div>
          <Button
            type="button"
            variant="outline"
            className="h-14! max-[600px]:w-full"
            onClick={reload}
          >
            {t("kitchenConfig.stations.retry")}
          </Button>
        </div>
      </div>
    );
  } else if (saved.length === 0) {
    body = (
      <EmptyState
        title={t("kitchenConfig.stations.emptyTitle")}
        description={t("kitchenConfig.stations.emptyHint")}
        action={
          <Button
            type="button"
            variant="outline"
            className="h-14!"
            onClick={reload}
          >
            {t("kitchenConfig.stations.reload")}
          </Button>
        }
      />
    );
  } else {
    body = (
      <>
        {justSaved && (
          // The notice text sits in the live region above, which stays in the DOM.
          <div className="py-6">
            <Button
              type="button"
              variant="outline"
              className="h-14! max-[600px]:w-full"
              ref={viewButton}
              onClick={() => {
                setJustSaved(false);
                requestAnimationFrame(() => firstSwitch.current?.focus());
              }}
            >
              {t("kitchenConfig.stations.viewSettings")}
            </Button>
          </div>
        )}
        {/* Hidden, not unmounted, after a save: the footer status keeps its
            live region and only swaps text. */}
        <div hidden={justSaved}>
          {saveFailed && (
            <Notice
              tone="danger"
              title={t("kitchenConfig.stations.saveFailedTitle")}
              className="mt-4"
            >
              {t("kitchenConfig.stations.saveFailedHint")}
            </Notice>
          )}
          {editorRows}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t-(length:--border-w) pt-6 max-[600px]:flex-col max-[600px]:items-stretch">
            <span role="status" className="text-sm text-muted-foreground">
              {justSaved
                ? t("kitchenConfig.stations.saved")
                : dirty
                  ? t("kitchenConfig.stations.unsaved")
                  : t("kitchenConfig.stations.noChanges")}
            </span>
            <Button
              type="button"
              className="h-14! max-[600px]:w-full"
              disabled={!dirty || noneActive}
              loading={update.isPending}
              aria-describedby={noneActive ? "station-none-active" : undefined}
              onClick={submit}
            >
              {saveFailed
                ? t("kitchenConfig.stations.retrySave")
                : t("kitchenConfig.stations.save")}
            </Button>
          </div>
          <div role="status">
            {noneActive && (
              <p
                id="station-none-active"
                className="mt-3 inline-flex items-start gap-2 text-sm leading-5 font-semibold text-warning"
              >
                <TriangleAlert
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                {t("kitchenConfig.stations.minOneActive")}
              </p>
            )}
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="grid min-w-0 gap-5">
      <div className="grid gap-1">
        <h1 className="type-title">{t("kitchenConfig.stations.title")}</h1>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("kitchenConfig.stations.intro")}
        </p>
      </div>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-6 min-[1151px]:grid-cols-[minmax(0,1fr)_17.5rem]">
        <section
          aria-labelledby="station-config-title"
          className="min-w-0 rounded-container border-(length:--border-w) bg-card p-6 shadow-hairline max-[600px]:p-4"
        >
          <h2 id="station-config-title" className="type-title">
            {t("kitchenConfig.stations.panelTitle")}
          </h2>
          <p className="mt-2 text-sm leading-5 text-muted-foreground">
            {t("kitchenConfig.stations.panelHint")}
          </p>
          {/* Reorder announcement, always in the DOM so the text is announced. */}
          <div role="status" className="sr-only">
            {announcement}
          </div>
          {/* Always in the DOM, so the text is announced when it appears. */}
          <div role="status" className={justSaved ? "mt-4" : undefined}>
            {justSaved && (
              <Notice
                tone="success"
                role={null}
                title={t("kitchenConfig.stations.successTitle")}
              >
                {t("kitchenConfig.stations.successHint")}
              </Notice>
            )}
          </div>
          {body}
        </section>
        <aside className="grid min-w-0 gap-3 rounded-container border-(length:--border-w) bg-card p-6 text-sm leading-5 text-muted-foreground shadow-hairline max-[600px]:p-4">
          <h2 className="type-title text-foreground">
            {t("kitchenConfig.stations.fallbackTitle")}
          </h2>
          <p>{t("kitchenConfig.stations.fallbackIntro")}</p>
          <div className="grid gap-1 rounded-control bg-surface-2 p-4">
            <strong className="text-foreground">
              {t("kitchenConfig.stations.fallbackCardTitle")}
            </strong>
            <p>{t("kitchenConfig.stations.fallbackCardText")}</p>
          </div>
          <p>{t("kitchenConfig.stations.fallbackNote")}</p>
        </aside>
      </div>
    </div>
  );
}

/** Per-control label: hidden next to the header row, shown when rows stack. */
function Control({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 min-[601px]:max-[760px]:col-start-2">
      <span className="mb-2 block text-sm text-muted-foreground min-[761px]:hidden">
        {label}
      </span>
      {children}
    </div>
  );
}

const FlagSwitch = React.forwardRef<
  HTMLButtonElement,
  {
    checked: boolean;
    disabled: boolean;
    ariaLabel: string;
    onText: string;
    offText: string;
    onChange: (value: boolean) => void;
  }
>(function FlagSwitch(
  { checked, disabled, ariaLabel, onText, offText, onChange },
  ref,
) {
  return (
    <label
      className={cn(
        "flex min-h-14 items-center gap-2 rounded-control border-(length:--border-w) bg-card px-2 font-bold whitespace-nowrap shadow-hairline min-[601px]:max-[760px]:min-w-36 max-[600px]:w-full",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
      )}
    >
      <Switch
        ref={ref}
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onCheckedChange={onChange}
      />
      {checked ? onText : offText}
    </label>
  );
});

function Notice({
  tone,
  title,
  role = "alert",
  className,
  children,
}: {
  tone: "danger" | "success" | "info";
  title: string;
  role?: "alert" | "status" | null;
  className?: string;
  children: React.ReactNode;
}) {
  const Icon = tone === "success" ? CircleCheck : CircleAlert;
  return (
    <div
      role={role ?? undefined}
      className={cn(
        "grid gap-1 rounded-container border-(length:--border-w) p-4 text-sm leading-5 text-foreground",
        tone === "danger" && "border-danger bg-danger-subtle",
        tone === "success" && "border-success bg-success-subtle",
        tone === "info" && "border-info bg-info-subtle",
        className,
      )}
    >
      <strong className="inline-flex items-center gap-2">
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        {title}
      </strong>
      <p>{children}</p>
    </div>
  );
}
