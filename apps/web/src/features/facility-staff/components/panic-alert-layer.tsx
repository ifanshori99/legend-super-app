// Full-screen panic alert layer for facility staff (bead legend-alovk, Arah A
// from design/mockups/panic). White surface, a red rule on top and the room
// name as the biggest thing on screen; "Darurat" always comes with an icon
// and a word, never colour alone. "Saya tangani" means "I am on my way", so a
// response never reads as "resolved". `PanicAlertScreen` is presentational
// (state in, callbacks out) so it renders with `renderToStaticMarkup`;
// `PanicAlertLayer` wires it to the realtime hook and the unit board.
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  LoaderCircle,
  CircleAlert,
  CircleX,
  MapPin,
  TriangleAlert,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useOutletClock } from "@/lib/tenant-context";
import { useStaffFacility, useUnitBoard } from "../hooks.ts";
import {
  panicView,
  pendingAlerts,
  settledAlerts,
  type PanicAckState,
  type PanicConnection,
  type PanicQueueItem,
  type PanicQueueState,
  type PanicView,
} from "../panic-queue.ts";
import { usePanicAlerts } from "../use-panic-alerts.ts";
import { areaName, clock } from "../view.ts";

/** Where an alert came from; `code: null` when the unit is not known. */
export type PanicLocation = { code: string | null; area: string };

export type PanicAlertScreenProps = {
  state: PanicQueueState;
  resolveLocation: (item: PanicQueueItem) => PanicLocation;
  onAck: (alertId: string) => void;
  onDismiss: (alertId: string) => void;
  /** Link target of the staff PIN screen. */
  pinHref: string;
  formatTime: (instant: string) => string;
};

type Tone = "danger" | "warning" | "success" | "neutral";

const TONE_RULE: Record<Tone, string> = {
  danger: "border-danger",
  warning: "border-warning",
  success: "border-success",
  neutral: "border-foreground",
};
const TONE_ICON: Record<Tone, string> = {
  danger: "text-danger",
  warning: "text-warning",
  success: "text-success",
  neutral: "text-foreground",
};
const TONE_PANEL: Record<Tone, string> = {
  danger: "border-danger bg-danger-subtle",
  warning: "border-warning bg-warning-subtle",
  success: "border-success bg-success-subtle",
  neutral: "border-foreground bg-surface-2",
};

const CONNECTION_KEYS: Record<PanicConnection, MessageKey> = {
  connecting: "facilityStaff.panic.connection.connecting",
  open: "facilityStaff.panic.connection.open",
  reconnecting: "facilityStaff.panic.connection.reconnecting",
  unreachable: "facilityStaff.panic.connection.unreachable",
  revoked: "facilityStaff.panic.connection.revoked",
  stopped: "facilityStaff.panic.connection.stopped",
};

const STATUS_KEYS: Record<PanicAckState, MessageKey> = {
  idle: "facilityStaff.panic.status.idle",
  sending: "facilityStaff.panic.status.sending",
  failed: "facilityStaff.panic.status.failed",
  session: "facilityStaff.panic.status.session",
  mine: "facilityStaff.panic.status.mine",
  taken: "facilityStaff.panic.status.taken",
};

const HEADING_ID = "panic-alert-heading";
const LOCATION_ID = "panic-alert-location";
const nameId = (alertId: string) => `panic-alert-name-${alertId}`;

// Panic buttons: 12px corners (not the pill), 56px tall, and a firm 2px
// outline for the secondary kind so it stays readable in high contrast.
const BUTTON = "min-h-14 w-full rounded-xl! text-lg";
const OUTLINE_BUTTON = `${BUTTON} border-2! border-foreground`;
const LINK = "inline-flex min-h-11 items-center";

/** Status text; a colleague's name replaces "rekan lain" once it is known. */
function useStatusText() {
  const t = useT();
  return (item: PanicQueueItem) =>
    item.ack === "taken" && item.takenBy
      ? t("facilityStaff.panic.status.takenBy", { name: item.takenBy })
      : t(STATUS_KEYS[item.ack]);
}

function useLocationName(
  resolveLocation: PanicAlertScreenProps["resolveLocation"],
) {
  const t = useT();
  return (item: PanicQueueItem) => {
    const location = resolveLocation(item);
    return {
      name: location.code ?? t("facilityStaff.panic.locationUnknown"),
      known: location.code !== null,
      // Arrival number: names an alert whose room is unknown ("alert 02").
      number: String(item.order).padStart(2, "0"),
      area: location.area,
    };
  };
}

function TestBadge() {
  const t = useT();
  return (
    <span
      data-slot="panic-test-badge"
      className="inline-flex items-center rounded-control border-2 border-foreground px-2 py-0.5 text-sm font-bold tracking-wide"
    >
      {t("facilityStaff.panic.test")}
    </span>
  );
}

function Header({
  tone,
  title,
  connection,
  icon,
}: {
  tone: Tone;
  title: string;
  connection: PanicConnection;
  icon: ReactNode;
}) {
  const t = useT();
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b-2 border-foreground px-4 py-3 md:px-10">
      <p className={`flex items-center gap-2 font-bold ${TONE_ICON[tone]}`}>
        {icon}
        <span className="text-foreground">{title}</span>
      </p>
      <p
        data-slot="panic-connection"
        data-connection={connection}
        aria-live="polite"
        className="text-base font-semibold"
      >
        {t(CONNECTION_KEYS[connection])}
      </p>
    </header>
  );
}

function Banner({
  connection,
  pinHref,
}: {
  connection: PanicConnection;
  pinHref: string;
}) {
  const t = useT();
  return (
    <div
      role="status"
      data-slot="panic-banner"
      data-connection={connection}
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b-2 border-foreground bg-warning-subtle px-4 py-3 md:px-10"
    >
      <div className="grid gap-1">
        <p className="flex items-center gap-2 font-semibold">
          <WifiOff
            className="size-5 shrink-0 text-warning"
            aria-hidden="true"
          />
          {t("facilityStaff.panic.banner")}
        </p>
        <p className="ps-7">{t("facilityStaff.panic.bannerAdvice")}</p>
      </div>
      {connection === "unreachable" && (
        <a
          href={pinHref}
          className={`${LINK} font-bold underline underline-offset-4`}
        >
          {t("facilityStaff.panic.pinLink")}
        </a>
      )}
    </div>
  );
}

function LocationBlock({
  tone,
  label,
  name,
  detail,
  id,
  nameId: nameElementId,
}: {
  tone: Tone;
  label: string;
  name: string;
  detail: string;
  id?: string;
  nameId?: string;
}) {
  return (
    <div
      id={id}
      data-slot="panic-location"
      className={`border-s-8 px-5 py-4 contrast-more:border-foreground md:px-8 md:py-6 ${TONE_PANEL[tone]}`}
    >
      <p className="text-base font-semibold text-muted-foreground">{label}</p>
      <p
        id={nameElementId}
        className="tabular text-[2.5rem] leading-tight font-bold break-words md:text-[3.5rem]"
      >
        {name}
      </p>
      {detail && <p className="text-lg">{detail}</p>}
    </div>
  );
}

/** "Saya tangani" plus the states around it: sending, failed, session. */
function AckControls({
  item,
  label,
  primary,
  describedBy,
  pinHref,
  onAck,
}: {
  item: PanicQueueItem;
  label: string;
  primary: boolean;
  /** Id of the element that names the room this button answers for. */
  describedBy: string;
  pinHref: string;
  onAck: (alertId: string) => void;
}) {
  const t = useT();
  const sending = item.ack === "sending";
  if (item.ack === "session") {
    return (
      <div className="grid gap-3">
        <p role="alert" className="font-semibold">
          {t("facilityStaff.panic.session")}
        </p>
        <Button
          asChild
          variant={primary ? "destructive" : "outline"}
          className={primary ? BUTTON : OUTLINE_BUTTON}
        >
          <a
            href={pinHref}
            aria-describedby={describedBy}
            data-panic-primary={primary ? "" : undefined}
          >
            {t("facilityStaff.panic.pinLink")}
            <ArrowRight aria-hidden="true" />
          </a>
        </Button>
      </div>
    );
  }
  return (
    <div className="grid gap-3">
      {item.ack === "failed" && (
        <p role="alert" className="font-semibold">
          {t("facilityStaff.panic.failed")}
        </p>
      )}
      <Button
        type="button"
        variant={primary ? "destructive" : "outline"}
        className={`${primary ? BUTTON : OUTLINE_BUTTON} aria-disabled:opacity-100! motion-safe:transition-colors`}
        // aria-disabled, not disabled: focus stays on the button while the
        // answer is in flight and the label keeps full contrast.
        aria-disabled={sending || undefined}
        aria-busy={sending || undefined}
        aria-describedby={describedBy}
        data-panic-primary={primary ? "" : undefined}
        data-ack={item.ack}
        onClick={() => {
          if (!sending) onAck(item.alertId);
        }}
      >
        {sending && (
          <LoaderCircle
            className="motion-safe:animate-spin"
            aria-hidden="true"
          />
        )}
        {sending
          ? t("facilityStaff.panic.sending")
          : item.ack === "failed"
            ? t("facilityStaff.panic.retry")
            : label}
        {!sending && primary && <ArrowRight aria-hidden="true" />}
      </Button>
    </div>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return (
    <footer className="border-t-2 border-foreground bg-surface-2 px-4 py-4 text-base text-muted-foreground md:px-10">
      {children}
    </footer>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-base font-semibold text-muted-foreground">
      {children}
    </p>
  );
}

function SingleAlert({
  item,
  props,
}: {
  item: PanicQueueItem;
  props: PanicAlertScreenProps;
}) {
  const t = useT();
  const locate = useLocationName(props.resolveLocation);
  const statusText = useStatusText();
  const { name, area } = locate(item);
  const test = item.kind === "test";
  return (
    <div
      data-slot="panic-alert"
      data-alert-id={item.alertId}
      className="grid gap-6"
    >
      <div aria-live="assertive" aria-atomic="true" className="grid gap-3">
        <Eyebrow>
          {test && <TestBadge />}
          {test
            ? t("facilityStaff.panic.alert.eyebrowTest")
            : t("facilityStaff.panic.alert.eyebrow")}
        </Eyebrow>
        <h1
          id={HEADING_ID}
          className="text-3xl font-bold tracking-tight break-words md:text-4xl"
        >
          {test
            ? t("facilityStaff.panic.alert.headingTest")
            : t("facilityStaff.panic.alert.heading")}
        </h1>
        <div className="pt-3">
          <LocationBlock
            id={LOCATION_ID}
            nameId={nameId(item.alertId)}
            tone="danger"
            label={t("facilityStaff.panic.locationLabel")}
            name={name}
            detail={area}
          />
        </div>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <dl className="grid grid-cols-2 content-start gap-3 border-t-2 border-foreground pt-4 md:grid-cols-1">
          <div>
            <dt className="text-base text-muted-foreground">
              {t("facilityStaff.panic.receivedLabel")}
            </dt>
            <dd className="tabular text-lg font-bold">
              {props.formatTime(item.receivedAt)}
            </dd>
          </div>
          <div>
            <dt className="text-base text-muted-foreground">
              {t("facilityStaff.panic.statusLabel")}
            </dt>
            <dd className="text-lg font-bold break-words">
              {statusText(item)}
            </dd>
          </div>
        </dl>
        <div className="grid content-start gap-3">
          <p className="text-lg">{t("facilityStaff.panic.alert.ackHint")}</p>
          <AckControls
            item={item}
            label={t("facilityStaff.panic.ack")}
            primary
            describedBy={nameId(item.alertId)}
            pinHref={props.pinHref}
            onAck={props.onAck}
          />
        </div>
      </div>
    </div>
  );
}

function AlertQueue({
  items,
  props,
}: {
  items: PanicQueueItem[];
  props: PanicAlertScreenProps;
}) {
  const t = useT();
  const locate = useLocationName(props.resolveLocation);
  const statusText = useStatusText();
  return (
    <div data-slot="panic-queue" className="grid gap-6">
      <div aria-live="assertive" aria-atomic="true" className="grid gap-3">
        <CircleAlert className="size-14 text-danger" aria-hidden="true" />
        <Eyebrow>{t("facilityStaff.panic.queue.eyebrow")}</Eyebrow>
        <h1
          id={HEADING_ID}
          className="text-3xl font-bold tracking-tight md:text-4xl"
        >
          {t("facilityStaff.panic.queue.heading", { count: items.length })}
        </h1>
        <p className="text-lg">{t("facilityStaff.panic.queue.hint")}</p>
      </div>
      <ol className="grid list-none gap-4 p-0">
        {items.map((item, index) => {
          const { name, known, number, area } = locate(item);
          const details = [area, props.formatTime(item.receivedAt)].filter(
            Boolean,
          );
          return (
            <li
              key={item.alertId}
              data-slot="panic-queue-card"
              data-alert-id={item.alertId}
              className="grid gap-3 border-2 border-s-8 border-foreground border-s-danger bg-card p-4 md:grid-cols-[minmax(0,1fr)_18rem] md:items-center md:gap-x-6 md:p-6"
            >
              <div className="grid min-w-0 gap-2">
                <p className="flex flex-wrap items-center gap-2 text-base font-semibold text-muted-foreground">
                  <span className="tabular">{number}</span>
                  <span aria-hidden="true">·</span>
                  {item.kind === "test" && <TestBadge />}
                  <span className="min-w-0 break-words">
                    {statusText(item)}
                  </span>
                </p>
                <p
                  id={nameId(item.alertId)}
                  className="tabular text-[2.5rem] leading-tight font-bold break-words md:text-5xl"
                >
                  {name}
                </p>
                <p className="tabular text-base">{details.join(" · ")}</p>
              </div>
              <AckControls
                item={item}
                label={
                  index === 0
                    ? t("facilityStaff.panic.ack")
                    : known
                      ? t("facilityStaff.panic.ackFor", { location: name })
                      : t("facilityStaff.panic.ackForAlert", { number })
                }
                primary={index === 0}
                describedBy={nameId(item.alertId)}
                pinHref={props.pinHref}
                onAck={props.onAck}
              />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Heading({
  level,
  id,
  children,
}: {
  level: 1 | 2;
  id: string;
  children: ReactNode;
}) {
  const Tag = level === 1 ? "h1" : "h2";
  return (
    <Tag id={id} className="text-3xl font-bold tracking-tight md:text-4xl">
      {children}
    </Tag>
  );
}

function SettledList({
  items,
  props,
}: {
  items: PanicQueueItem[];
  props: PanicAlertScreenProps;
}) {
  const t = useT();
  const locate = useLocationName(props.resolveLocation);
  return (
    <div data-slot="panic-settled" className="grid gap-8">
      {items.map((item, index) => {
        const { name, known, number, area } = locate(item);
        const mine = item.ack === "mine";
        return (
          <section
            key={item.alertId}
            data-alert-id={item.alertId}
            data-ack={item.ack}
            aria-labelledby={`${HEADING_ID}-${item.alertId}`}
            className="grid gap-4"
          >
            <div aria-live="polite" className="grid gap-3">
              {mine ? (
                <MapPin className="size-12" aria-hidden="true" />
              ) : (
                <Users className="size-12" aria-hidden="true" />
              )}
              <Eyebrow>
                {item.kind === "test" && <TestBadge />}
                {mine
                  ? t("facilityStaff.panic.settled.mineEyebrow")
                  : t("facilityStaff.panic.settled.takenEyebrow")}
              </Eyebrow>
              <Heading
                level={index === 0 ? 1 : 2}
                id={`${HEADING_ID}-${item.alertId}`}
              >
                {mine
                  ? known
                    ? t("facilityStaff.panic.settled.mineHeading", {
                        location: name,
                      })
                    : t("facilityStaff.panic.settled.mineHeadingAlert", {
                        number,
                      })
                  : item.takenBy
                    ? t("facilityStaff.panic.settled.takenHeadingBy", {
                        name: item.takenBy,
                      })
                    : t("facilityStaff.panic.settled.takenHeading")}
              </Heading>
              {!mine && (
                <p className="text-lg">
                  {t("facilityStaff.panic.settled.takenHint")}
                </p>
              )}
            </div>
            <LocationBlock
              tone="neutral"
              label={t("facilityStaff.panic.locationLabel")}
              name={name}
              detail={area}
            />
            <dl className="grid grid-cols-2 gap-3 border-y-2 border-foreground py-4">
              <div>
                <dt className="text-base text-muted-foreground">
                  {t("facilityStaff.panic.receivedLabel")}
                </dt>
                <dd className="tabular text-lg font-bold">
                  {props.formatTime(item.receivedAt)}
                </dd>
              </div>
              <div>
                <dt className="text-base text-muted-foreground">
                  {t("facilityStaff.panic.settled.conditionLabel")}
                </dt>
                <dd className="text-lg font-bold">
                  {t("facilityStaff.panic.settled.condition")}
                </dd>
              </div>
            </dl>
            <p>{t("facilityStaff.panic.settled.note")}</p>
            <Button
              type="button"
              variant="outline"
              className={OUTLINE_BUTTON}
              data-panic-primary=""
              onClick={() => props.onDismiss(item.alertId)}
            >
              {t("facilityStaff.panic.close")}
            </Button>
          </section>
        );
      })}
    </div>
  );
}

function UnreachableNotice({
  pinHref,
  onClose,
}: {
  pinHref: string;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <div data-slot="panic-unreachable" className="grid gap-6">
      <div aria-live="assertive" aria-atomic="true" className="grid gap-3">
        <WifiOff className="size-12 text-warning" aria-hidden="true" />
        <Eyebrow>{t("facilityStaff.panic.unreachable.eyebrow")}</Eyebrow>
        <h1
          id={HEADING_ID}
          className="text-3xl font-bold tracking-tight md:text-4xl"
        >
          {t("facilityStaff.panic.unreachable.heading")}
        </h1>
        <p className="text-lg">{t("facilityStaff.panic.unreachable.body")}</p>
      </div>
      <section className="grid gap-2 border-y-2 border-foreground py-4">
        <h2 className="text-xl font-bold">
          {t("facilityStaff.panic.unreachable.pinHeading")}
        </h2>
        <p className="text-lg">
          {t("facilityStaff.panic.unreachable.pinBody")}
        </p>
      </section>
      <Button asChild className={`${BUTTON} justify-between`}>
        <a href={pinHref} data-panic-primary="">
          {t("facilityStaff.panic.pinLink")}
          <ArrowRight aria-hidden="true" />
        </a>
      </Button>
      <Button
        type="button"
        variant="outline"
        className={OUTLINE_BUTTON}
        onClick={onClose}
      >
        {t("facilityStaff.panic.close")}
      </Button>
      <p className="text-base text-muted-foreground">
        {t("facilityStaff.panic.unreachable.footnote")}
      </p>
    </div>
  );
}

function RevokedNotice({
  pinHref,
  onClose,
}: {
  pinHref: string;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <div data-slot="panic-revoked" className="grid gap-6">
      <div aria-live="assertive" aria-atomic="true" className="grid gap-3">
        <CircleX className="size-12" aria-hidden="true" />
        <Eyebrow>{t("facilityStaff.panic.revoked.eyebrow")}</Eyebrow>
        <h1
          id={HEADING_ID}
          className="text-3xl font-bold tracking-tight md:text-4xl"
        >
          {t("facilityStaff.panic.revoked.heading")}
        </h1>
        <p className="text-lg">{t("facilityStaff.panic.revoked.body")}</p>
      </div>
      <section className="grid gap-2 border-y-2 border-foreground py-4 text-lg">
        <p className="font-bold">{t("facilityStaff.panic.revoked.warning")}</p>
        <p>{t("facilityStaff.panic.revoked.next")}</p>
      </section>
      <div className="grid gap-3 sm:grid-cols-2">
        <Button asChild variant="outline" className={OUTLINE_BUTTON}>
          <a href={pinHref} data-slot="panic-revoked-pin">
            {t("facilityStaff.panic.revoked.pinLink")}
            <ArrowRight aria-hidden="true" />
          </a>
        </Button>
        <Button
          type="button"
          variant="outline"
          className={OUTLINE_BUTTON}
          data-panic-primary=""
          onClick={onClose}
        >
          {t("facilityStaff.panic.close")}
        </Button>
      </div>
      <p className="text-base text-muted-foreground">
        {t("facilityStaff.panic.revoked.footnote")}
      </p>
    </div>
  );
}

const VIEW_TONE: Record<Exclude<PanicView, "idle">, Tone> = {
  alert: "danger",
  queue: "danger",
  settled: "neutral",
  unreachable: "warning",
  revoked: "neutral",
};

function PanicDialog({
  view,
  props,
  onExit,
}: {
  view: Exclude<PanicView, "idle">;
  props: PanicAlertScreenProps;
  /** The staff member left a layer that may be left (not an open alert). */
  onExit: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { state } = props;
  const pending = pendingAlerts(state);
  const settled = settledAlerts(state);
  const connection = state.connection;
  const tone = VIEW_TONE[view];
  const waiting = view === "alert" || view === "queue";
  const firstPendingId = pending[0]?.alertId ?? "";
  // Changes when any pending card changes state or goes away, so a focused
  // button that unmounts (ack ok, 401) hands focus on.
  const pendingSignature = pending
    .map((item) => `${item.alertId}:${item.ack}`)
    .join(",");
  const lastFocusKey = useRef("");

  // Modal from the first render and again whenever it is found closed: the
  // layer only mounts while there is something the staff member must see.
  // A new view or a new first alert puts focus on the main button so one
  // keypress is enough. The pending signature is a dependency so focus comes
  // back to the main button when the focused one disappears.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const focusKey = `${view}:${firstPendingId}`;
    const active = document.activeElement;
    const focusInside =
      active instanceof HTMLElement &&
      active !== dialog &&
      dialog.contains(active);
    // Refocus only when the main alert changed or focus fell out of the
    // dialog; a queue that merely grows must not steal focus from a button
    // the staff member is already on.
    if (focusKey !== lastFocusKey.current || !focusInside) {
      lastFocusKey.current = focusKey;
      dialog.querySelector<HTMLElement>("[data-panic-primary]")?.focus();
    }
  }, [view, firstPendingId, pending.length, pendingSignature]);

  let title = t("facilityStaff.panic.title");
  let icon = <TriangleAlert className="size-6" aria-hidden="true" />;
  if (view === "queue") {
    title = t("facilityStaff.panic.titleQueue", { count: pending.length });
  } else if (view === "settled") {
    title = t("facilityStaff.panic.settled.title");
    icon = <MapPin className="size-6" aria-hidden="true" />;
  } else if (view === "unreachable") {
    title = t("facilityStaff.panic.deviceTitle");
    icon = <WifiOff className="size-6" aria-hidden="true" />;
  } else if (view === "revoked") {
    title = t("facilityStaff.panic.revoked.title");
    icon = <CircleX className="size-6" aria-hidden="true" />;
  }

  return (
    <dialog
      ref={dialogRef}
      data-slot="panic-alert-layer"
      data-view={view}
      aria-labelledby={view === "settled" ? undefined : HEADING_ID}
      aria-label={view === "settled" ? title : undefined}
      aria-describedby={view === "alert" ? LOCATION_ID : undefined}
      // Esc must never hide an alert nobody has answered. A browser may still
      // close the dialog (a second Esc is not cancelable): reopen while an
      // alert waits. Revoked, unreachable and settled layers can be left.
      onCancel={(event) => {
        if (waiting) event.preventDefault();
      }}
      onClose={() => {
        if (!waiting) {
          onExit();
          return;
        }
        const dialog = dialogRef.current;
        if (dialog && !dialog.open) {
          dialog.showModal();
          dialog.querySelector<HTMLElement>("[data-panic-primary]")?.focus();
        }
      }}
      className={`fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overflow-y-auto overscroll-contain border-t-8 bg-background pt-[env(safe-area-inset-top)] pe-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] ps-[env(safe-area-inset-left)] text-foreground ${TONE_RULE[tone]} contrast-more:border-foreground`}
    >
      <div className="mx-auto flex min-h-full w-full flex-col">
        <Header tone={tone} title={title} connection={connection} icon={icon} />
        {waiting &&
          (connection === "reconnecting" || connection === "unreachable") && (
            <Banner connection={connection} pinHref={props.pinHref} />
          )}
        <section className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-10 md:py-12">
          {view === "alert" && pending[0] && (
            <SingleAlert item={pending[0]} props={props} />
          )}
          {view === "queue" && <AlertQueue items={pending} props={props} />}
          {view === "settled" && <SettledList items={settled} props={props} />}
          {view === "unreachable" && (
            <UnreachableNotice pinHref={props.pinHref} onClose={onExit} />
          )}
          {view === "revoked" && (
            <RevokedNotice pinHref={props.pinHref} onClose={onExit} />
          )}
        </section>
        {view === "alert" && (
          <Footer>{t("facilityStaff.panic.alert.footer")}</Footer>
        )}
        {view === "queue" && (
          <Footer>{t("facilityStaff.panic.queue.footer")}</Footer>
        )}
        {view === "settled" && (
          <Footer>{t("facilityStaff.panic.settled.footer")}</Footer>
        )}
      </div>
    </dialog>
  );
}

export function PanicAlertScreen(props: PanicAlertScreenProps) {
  const t = useT();
  const view = panicView(props.state);
  // The layer that may be left (revoked, unreachable, settled) is hidden once
  // closed, until the situation changes.
  const viewKey =
    view === "settled"
      ? `settled:${settledAlerts(props.state)
          .map((item) => item.alertId)
          .join(",")}`
      : view;
  const [closedKey, setClosedKey] = useState<string | null>(null);
  if (closedKey !== null && closedKey !== viewKey) setClosedKey(null);
  const closed = view !== "idle" && closedKey === viewKey;
  if (view === "idle" || closed) {
    // No overlay: just a small connection status on the page.
    const connection = props.state.connection;
    return (
      <p
        role="status"
        data-slot="panic-connection"
        data-view={view === "idle" ? "idle" : "closed"}
        data-connection={connection}
        className="flex items-center gap-2 text-base text-muted-foreground"
      >
        {connection === "open" ? (
          <Wifi className="size-4 text-success" aria-hidden="true" />
        ) : (
          <WifiOff className="size-4" aria-hidden="true" />
        )}
        {t(CONNECTION_KEYS[connection])}
        {closed && (view === "revoked" || view === "unreachable") && (
          <a href={props.pinHref} className={`${LINK} font-semibold underline`}>
            {view === "revoked"
              ? t("facilityStaff.panic.revoked.pinLink")
              : t("facilityStaff.panic.pinLink")}
          </a>
        )}
      </p>
    );
  }
  return (
    <PanicDialog
      view={view}
      props={props}
      onExit={() => setClosedKey(viewKey)}
    />
  );
}

// PIN recovery returns to the same facility screen (architect 791 item 7).
function pinHrefFor(facilityId: string | undefined): string {
  const base = "/pos/ganti-pengguna?emergency=true";
  return facilityId
    ? `${base}&facilityId=${encodeURIComponent(facilityId)}`
    : base;
}

export function PanicAlertLayer({ facilityId }: { facilityId?: string }) {
  const { timeZone } = useOutletClock();
  const { facility, config } = useStaffFacility(facilityId);
  const board = useUnitBoard(facility?.id ?? null);
  const { state, ack, dismiss } = usePanicAlerts();
  const rows = board.data?.rows ?? [];
  const areas = config.data?.areas ?? [];

  const resolveLocation = (item: PanicQueueItem): PanicLocation => {
    const row = item.unitId
      ? rows.find((candidate) => candidate.unit.id === item.unitId)
      : undefined;
    return {
      code: item.unitCode ?? row?.unit.code ?? null,
      area: item.areaName ?? (row ? areaName(areas, row.unit.areaId) : ""),
    };
  };

  return (
    <PanicAlertScreen
      state={state}
      resolveLocation={resolveLocation}
      onAck={(alertId) => void ack(alertId)}
      onDismiss={dismiss}
      pinHref={pinHrefFor(facilityId ?? facility?.id)}
      formatTime={(instant) => clock(instant, timeZone)}
    />
  );
}
