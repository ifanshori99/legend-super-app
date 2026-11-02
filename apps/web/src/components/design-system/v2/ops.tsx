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
import { cn } from "cn";
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
  return (
    <Compare
      view={view}
      before={
        <Stage
          tag="before"
          title="Papan status meja (POS) dan tiket KDS"
          note="Semua meja berbingkai sama, status hanya chip kecil, tab garis bawah, tiket KDS dengan pill timer kecil."
        >
          <div className="grid gap-6">
            <Screen label="POS · papan meja">
              <OperationsShell
                embedded
                title="Kasir & operasional"
                outlet={OUTLET}
                online
                timeZone={TZ}
              >
                <BeforeBoard />
              </OperationsShell>
            </Screen>
            <Screen label="KDS · bar kopi (dapur gelap)" className="h-[600px]">
              <OperationsShell
                embedded
                mode="dark"
                title="KDS · Bar kopi"
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
          title="Papan status meja (POS) dan tiket KDS"
          note="Yang mendesak tampil duluan dan paling keras; meja terisi naik satu tingkat permukaan; zona jadi kontrol bersegmen dengan jumlah; tiket KDS membawa status timer di header penuh."
        >
          <ThemeScope tenant={tenant} className="grid gap-6">
            <Screen label="POS · papan meja">
              <OperationsShell
                embedded
                title="Papan meja"
                outlet={OUTLET}
                online
                timeZone={TZ}
              >
                <AfterBoard />
              </OperationsShell>
            </Screen>
            <Screen label="KDS · bar kopi (dapur gelap)" className="h-[600px]">
              <OperationsShell
                embedded
                mode="dark"
                title="KDS · Bar kopi"
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
  { label: string; tone: "success" | "info" | "warning" | "danger" | "neutral" }
> = {
  empty: { label: "Kosong", tone: "success" },
  occupied: { label: "Terisi", tone: "info" },
  waiter: { label: "Menunggu pesanan", tone: "warning" },
  bill: { label: "Menunggu tagihan", tone: "danger" },
  cleaning: { label: "Perlu dibersihkan", tone: "neutral" },
  reserved: { label: "Direservasi", tone: "neutral" },
  inactive: { label: "Nonaktif", tone: "neutral" },
};

function BeforeBoard() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-4 p-4">
      <div>
        <p className="text-2xl font-bold">Papan Status Meja</p>
        <p className="text-sm text-muted-foreground">
          Denah real-time: status, durasi duduk, dan tagihan
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
              <Badge tone={status.tone}>{status.label}</Badge>
              {table.minutes !== undefined && (
                <p className="text-sm">
                  Duduk {table.minutes} mnt · {table.guests} tamu
                </p>
              )}
              {table.due !== undefined && (
                <p className="flex justify-between text-sm">
                  Sisa tagihan
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
  return (
    <div className="grid h-full auto-rows-min gap-3 overflow-hidden p-4 sm:grid-cols-3">
      {v2Tickets.map((ticket) => (
        <article
          key={ticket.code}
          className="flex flex-col gap-3 rounded-lg border-(length:--border-w) bg-card p-4"
        >
          <header className="flex flex-wrap items-start justify-between gap-2">
            <p className="text-2xl leading-8 font-bold whitespace-nowrap">
              Meja {ticket.table}
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
          <Button className="mt-auto w-full">Selesai</Button>
        </article>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- AFTER */

function AfterBoard() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-5 p-4 lg:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <div
          role="radiogroup"
          aria-label="Zona"
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
          Diperbarui otomatis tiap 15 detik
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="me-1 type-eyebrow text-muted-foreground">
          Perlu tindakan
        </span>
        <span className="inline-flex h-9 items-center gap-1.5 rounded-full bg-danger px-3 text-sm font-semibold text-danger-foreground">
          <BellRing className="size-4" aria-hidden="true" /> 1 panggilan waiter
        </span>
        <span className="inline-flex h-9 items-center gap-1.5 rounded-full bg-warning-subtle px-3 text-sm font-semibold text-warning">
          <ReceiptText className="size-4" aria-hidden="true" /> 2 minta tagihan
        </span>
        <span className="inline-flex h-9 items-center gap-1.5 rounded-full bg-surface-3 px-3 text-sm font-semibold">
          <Sparkles className="size-4" aria-hidden="true" /> 2 perlu dibersihkan
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
  const base = "inline-flex w-fit items-center gap-1.5 font-semibold";
  switch (state) {
    case "empty":
      return (
        <span className={cn(base, "text-success")}>
          <CircleCheck className="size-5" aria-hidden="true" /> Kosong
        </span>
      );
    case "occupied":
      return (
        <span className={base}>
          <UserRound className="size-5" aria-hidden="true" /> Terisi
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
          <BellRing className="size-4" aria-hidden="true" /> Panggil waiter ·{" "}
          {note}
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
          <ReceiptText className="size-4" aria-hidden="true" /> Minta tagihan
        </span>
      );
    case "cleaning":
      return (
        <span className={cn(base, "text-muted-foreground")}>
          <Sparkles className="size-5" aria-hidden="true" /> Perlu dibersihkan
        </span>
      );
    case "reserved":
      return (
        <span className={cn(base, "text-info")}>
          <CalendarClock className="size-5" aria-hidden="true" /> Reservasi{" "}
          {note}
        </span>
      );
    case "inactive":
      return (
        <span className={base}>
          <Ban className="size-5" aria-hidden="true" /> Nonaktif
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
              ? `${Math.floor(minutes / 60)} j ${minutes % 60} mnt`
              : `${minutes} mnt`}{" "}
            · {guests} tamu
          </p>
          {due !== undefined && (
            <p className="flex items-baseline justify-between gap-2">
              <span className="text-sm text-muted-foreground">Sisa</span>
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
  late: { label: "Lewat target", icon: CircleAlert },
  near: { label: "Mendekati target", icon: TriangleAlert },
  onTrack: { label: "Sesuai target", icon: Clock },
} as const;

function AfterKds() {
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
                  Meja {ticket.table}
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
                  {state.label}
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
              <Button className="w-full">Selesai</Button>
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
