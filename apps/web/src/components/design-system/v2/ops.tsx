// Operations surface (Kontras): POS table board + KDS tickets — v1 vs v2.
// Both stages use the shipped OperationsShell. AFTER adds the v2 board
// hierarchy: occupied tables lift to surface-3, urgent states get a solid
// pill and a heavy start rule, calm states stay tinted, zones become a
// segmented control with counts, and KDS tickets carry their timer state in
// a full-width header band instead of a small pill.
import {
  Ban,
  BellRing,
  CalendarClock,
  CircleAlert,
  CircleCheck,
  Clock,
  ReceiptText,
  Sparkles,
  TriangleAlert,
  UserRound,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import type { MessageKey } from "@starter/shared/i18n";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { OperationsShell } from "@/components/shells/operations-shell";
import { ThemeScope } from "@/components/theme-scope";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { Compare, Screen, Stage, type CompareView } from "./frame";
import { v2Tables, v2Tickets, v2Zones, type TableState } from "./sample";

const OUTLET = "Cafe Legend Bandung · BDG-01";
const TZ = "Asia/Jakarta";

export function OpsCompare({
  view,
  tenant,
}: {
  view: CompareView;
  tenant?: string;
}) {
  const t = useT();
  return (
    <Compare
      view={view}
      before={
        <Stage
          tag="before"
          title={t("designV2.ops.copy1")}
          note={t("designV2.ops.copy2")}
        >
          <div className="grid gap-6">
            <Screen label={t("designV2.ops.copy3")}>
              <OperationsShell
                embedded
                title={t("designV2.ops.copy4")}
                outlet={OUTLET}
                online
                timeZone={TZ}
              >
                <BeforeBoard />
              </OperationsShell>
            </Screen>
            <Screen label={t("designV2.ops.copy5")} className="h-[600px]">
              <OperationsShell
                embedded
                mode="dark"
                title={t("designV2.ops.copy6")}
                outlet={OUTLET}
                online
                timeZone={TZ}
              >
                <BeforeKds />
              </OperationsShell>
            </Screen>
          </div>
        </Stage>
      }
      after={
        <Stage
          tag="after"
          title={t("designV2.ops.copy1")}
          note={t("designV2.ops.copy7")}
        >
          <ThemeScope tenant={tenant} className="grid gap-6">
            <Screen label={t("designV2.ops.copy3")}>
              <OperationsShell
                embedded
                title={t("designV2.ops.copy8")}
                outlet={OUTLET}
                online
                timeZone={TZ}
              >
                <AfterBoard />
              </OperationsShell>
            </Screen>
            <Screen label={t("designV2.ops.copy5")} className="h-[600px]">
              <OperationsShell
                embedded
                mode="dark"
                title={t("designV2.ops.copy6")}
                outlet={OUTLET}
                online
                timeZone={TZ}
              >
                <AfterKds />
              </OperationsShell>
            </Screen>
          </ThemeScope>
        </Stage>
      }
    />
  );
}

/* ------------------------------------------------------------ BEFORE */

const BEFORE_STATUS: Record<
  TableState,
  {
    label: MessageKey;
    tone: "success" | "info" | "warning" | "danger" | "neutral";
  }
> = {
  empty: { label: "designV2.ops.copy23", tone: "success" },
  occupied: { label: "designV2.ops.copy24", tone: "info" },
  waiter: { label: "designV2.ops.copy31", tone: "warning" },
  bill: { label: "designV2.ops.copy32", tone: "danger" },
  cleaning: { label: "designV2.ops.copy27", tone: "neutral" },
  reserved: { label: "designV2.ops.copy33", tone: "neutral" },
  inactive: { label: "designV2.ops.copy29", tone: "neutral" },
};

function BeforeBoard() {
  const t = useT();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-4 p-4">
      <div>
        <p className="text-2xl font-bold">{t("designV2.ops.copy9")}</p>
        <p className="text-sm text-muted-foreground">
          {" "}
          {t("designV2.ops.copy10")}{" "}
        </p>
      </div>
      <div className="flex gap-6 overflow-hidden border-b-2 text-lg whitespace-nowrap">
        {v2Zones.map((zone, index) => (
          <span
            key={zone.label}
            className={cn(
              "pb-3",
              index === 0 && "-mb-0.5 border-b-2 border-foreground font-bold",
            )}
          >
            {zone.label} ({zone.count})
          </span>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        {v2Tables.map((table) => {
          const status = BEFORE_STATUS[table.state];
          return (
            <div
              key={table.code}
              className="flex min-h-32 flex-col gap-2 rounded-lg border-2 bg-card p-4"
            >
              <div className="flex justify-between">
                <p className="text-2xl font-bold">{table.code}</p>
                <span className="inline-flex items-center gap-1 text-sm">
                  <Users className="size-4" aria-hidden="true" />
                  {table.seats}
                </span>
              </div>
              <Badge tone={status.tone}>{t(status.label)}</Badge>
              {table.minutes !== undefined && (
                <p className="text-sm">
                  {" "}
                  {t("designV2.ops.copy11")} {table.minutes}{" "}
                  {t("designV2.ops.copy12")} {table.guests}{" "}
                  {t("designV2.ops.copy13")}{" "}
                </p>
              )}
              {table.due !== undefined && (
                <p className="flex justify-between text-sm">
                  {" "}
                  {t("designV2.ops.copy14")}{" "}
                  <Money amount={table.due} className="font-semibold" />
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BeforeKds() {
  const t = useT();
  return (
    <div className="grid h-full auto-rows-min gap-3 overflow-hidden p-4 sm:grid-cols-3">
      {v2Tickets.map((ticket) => (
        <article
          key={ticket.code}
          className="flex flex-col gap-3 rounded-lg border-(length:--border-w) bg-card p-4"
        >
          <header className="flex flex-wrap items-start justify-between gap-2">
            <p className="text-2xl leading-8 font-bold whitespace-nowrap">
              {" "}
              {t("designV2.ops.copy15")} {ticket.table}
            </p>
            <StatusPill status={ticket.timer} className="text-sm">
              {ticket.elapsed}
            </StatusPill>
          </header>
          <ul className="grid gap-1 font-medium">
            {ticket.items.map((item) => (
              <li key={item.name}>
                {item.qty}× {item.name}
                {item.flag ? ` — ${item.flag.toLowerCase()}` : ""}
              </li>
            ))}
          </ul>
          <Button className="mt-auto w-full">{t("designV2.ops.copy16")}</Button>
        </article>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- AFTER */

function AfterBoard() {
  const t = useT();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-5 p-4 lg:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <div
          role="radiogroup"
          aria-label={t("designV2.ops.copy17")}
          className="inline-flex max-w-full gap-1 overflow-hidden rounded-control bg-surface-2 p-1"
        >
          {v2Zones.map((zone, index) => (
            <span
              key={zone.label}
              role="radio"
              aria-checked={index === 0}
              className={cn(
                "inline-flex h-12 shrink-0 items-center gap-2 rounded-[calc(var(--control-radius)-2px)] px-4 font-semibold",
                index === 0
                  ? "bg-card text-foreground shadow-raised"
                  : "text-muted-foreground",
              )}
            >
              {zone.label}
              <span className="text-sm tabular">{zone.count}</span>
            </span>
          ))}
        </div>
        <p className="ms-auto text-sm text-muted-foreground">
          {" "}
          {t("designV2.ops.copy18")}{" "}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="me-1 type-eyebrow text-muted-foreground">
          {" "}
          {t("designV2.ops.copy19")}{" "}
        </span>
        <span className="inline-flex h-9 items-center gap-1.5 rounded-full bg-danger px-3 text-sm font-semibold text-danger-foreground">
          <BellRing className="size-4" aria-hidden="true" />{" "}
          {t("designV2.ops.copy20")}{" "}
        </span>
        <span className="inline-flex h-9 items-center gap-1.5 rounded-full bg-warning-subtle px-3 text-sm font-semibold text-warning">
          <ReceiptText className="size-4" aria-hidden="true" />{" "}
          {t("designV2.ops.copy21")}{" "}
        </span>
        <span className="inline-flex h-9 items-center gap-1.5 rounded-full bg-surface-3 px-3 text-sm font-semibold">
          <Sparkles className="size-4" aria-hidden="true" />{" "}
          {t("designV2.ops.copy22")}{" "}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        {v2Tables.map((table) => (
          <TableTile key={table.code} {...table} />
        ))}
      </div>
    </div>
  );
}

const TILE: Record<TableState, string> = {
  empty: "border-(length:--border-w) bg-card",
  occupied: "bg-surface-3",
  waiter: "border-2 border-s-[6px] border-danger bg-card",
  bill: "bg-surface-3",
  cleaning: "border-2 border-dashed bg-background",
  reserved: "border-(length:--border-w) bg-card",
  inactive: "bg-surface-2 text-muted-foreground",
};

function TileStatus({ state, note }: { state: TableState; note?: string }) {
  const t = useT();
  const base = "inline-flex w-fit items-center gap-1.5 font-semibold";
  switch (state) {
    case "empty":
      return (
        <span className={cn(base, "text-success")}>
          <CircleCheck className="size-5" aria-hidden="true" />{" "}
          {t("designV2.ops.copy23")}{" "}
        </span>
      );
    case "occupied":
      return (
        <span className={base}>
          <UserRound className="size-5" aria-hidden="true" />{" "}
          {t("designV2.ops.copy24")}{" "}
        </span>
      );
    case "waiter":
      return (
        <span
          className={cn(
            base,
            "rounded-full bg-danger px-3 py-1 text-sm text-danger-foreground",
          )}
        >
          <BellRing className="size-4" aria-hidden="true" />{" "}
          {t("designV2.ops.copy25")} {note}
        </span>
      );
    case "bill":
      return (
        <span
          className={cn(
            base,
            "rounded-full bg-warning-subtle px-3 py-1 text-sm text-warning",
          )}
        >
          <ReceiptText className="size-4" aria-hidden="true" />{" "}
          {t("designV2.ops.copy26")}{" "}
        </span>
      );
    case "cleaning":
      return (
        <span className={cn(base, "text-muted-foreground")}>
          <Sparkles className="size-5" aria-hidden="true" />{" "}
          {t("designV2.ops.copy27")}{" "}
        </span>
      );
    case "reserved":
      return (
        <span className={cn(base, "text-info")}>
          <CalendarClock className="size-5" aria-hidden="true" />{" "}
          {t("designV2.ops.copy28")} {note}
        </span>
      );
    case "inactive":
      return (
        <span className={base}>
          <Ban className="size-5" aria-hidden="true" />{" "}
          {t("designV2.ops.copy29")}{" "}
        </span>
      );
  }
}

function TableTile({
  code,
  seats,
  state,
  minutes,
  guests,
  due,
  note,
}: (typeof v2Tables)[number]) {
  const t = useT();
  return (
    <article
      className={cn(
        "flex min-h-40 flex-col gap-3 rounded-container p-4",
        TILE[state],
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-3xl leading-9 font-semibold tracking-tight">
          {code}
        </h3>
        <span className="inline-flex items-center gap-1 text-sm text-muted-foreground tabular">
          <Users className="size-4" aria-hidden="true" />
          {seats}
        </span>
      </div>
      <TileStatus state={state} note={note} />
      {minutes !== undefined && (
        <div className="mt-auto grid gap-1">
          <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground tabular">
            <Clock className="size-4" aria-hidden="true" />
            {minutes >= 60
              ? t("designV2.ops.copy37", {
                  hours: Math.floor(minutes / 60),
                  minutes: minutes % 60,
                })
              : t("designV2.ops.copy38", { minutes })}{" "}
            · {guests} {t("designV2.ops.copy13")}{" "}
          </p>
          {due !== undefined && (
            <p className="flex items-baseline justify-between gap-2">
              <span className="text-sm text-muted-foreground">
                {t("designV2.ops.copy30")}
              </span>
              <Money amount={due} className="font-semibold" />
            </p>
          )}
        </div>
      )}
    </article>
  );
}

const TICKET_HEAD = {
  late: "bg-danger text-danger-foreground",
  near: "bg-warning-subtle text-foreground",
  onTrack: "bg-surface-3 text-foreground",
} as const;

const TICKET_STATE = {
  late: { label: "designV2.ops.copy34", icon: CircleAlert },
  near: { label: "designV2.ops.copy35", icon: TriangleAlert },
  onTrack: { label: "designV2.ops.copy36", icon: Clock },
} as const;

function AfterKds() {
  const t = useT();
  return (
    <div className="grid h-full auto-rows-min gap-4 overflow-hidden p-4 sm:grid-cols-3">
      {v2Tickets.map((ticket) => {
        const state = TICKET_STATE[ticket.timer];
        return (
          <article
            key={ticket.code}
            data-timer={ticket.timer}
            className="flex flex-col overflow-hidden rounded-container border-(length:--border-w) bg-card"
          >
            <header
              className={cn(
                "flex items-start justify-between gap-3 px-4 py-3",
                TICKET_HEAD[ticket.timer],
              )}
            >
              <div className="min-w-0">
                <h3 className="text-3xl leading-9 font-bold tracking-tight">
                  {" "}
                  {t("designV2.ops.copy15")} {ticket.table}
                </h3>
                <p className="text-sm font-medium">
                  <span className="font-mono">{ticket.code}</span> ·{" "}
                  {ticket.channel}
                </p>
              </div>
              <div className="grid justify-items-end">
                <span className="text-3xl leading-9 font-bold tabular">
                  {ticket.elapsed}
                </span>
                <span className="inline-flex items-center gap-1 text-sm font-semibold">
                  <state.icon className="size-4" aria-hidden="true" />
                  {t(state.label)}
                </span>
              </div>
            </header>
            <ul className="grid gap-4 px-4 py-4">
              {ticket.items.map((item) => (
                <li key={item.name} className="flex gap-3">
                  <span className="grid size-11 shrink-0 place-items-center rounded-md bg-surface-3 text-xl font-bold tabular">
                    {item.qty}
                  </span>
                  <div className="grid min-w-0 gap-1">
                    <p className="leading-snug font-semibold">{item.name}</p>
                    {item.mods && (
                      <p className="text-muted-foreground">{item.mods}</p>
                    )}
                    {item.flag && (
                      <Flag>
                        <TriangleAlert className="size-4" aria-hidden="true" />
                        {item.flag}
                      </Flag>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {ticket.note && (
              <p className="mx-4 rounded-md bg-surface-2 px-3 py-2 text-muted-foreground">
                {ticket.note}
              </p>
            )}
            <div className="mt-auto p-4">
              <Button className="w-full">{t("designV2.ops.copy16")}</Button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function Flag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex w-fit items-center gap-1.5 rounded-md bg-warning-subtle px-2 py-0.5 font-semibold text-warning">
      {children}
    </span>
  );
}
