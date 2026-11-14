import { useEffect, useRef, useState, type FormEvent } from "react";
import type { KitchenTicketDetail } from "@starter/shared/kitchen";
import {
  CircleAlert,
  CircleCheck,
  Keyboard,
  ScanLine,
  TriangleAlert,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/errors.ts";
import type { KdsScannerStatus } from "../contract-gap.ts";
import type { useKdsActions } from "../hooks.ts";
import {
  exampleScanTicket,
  hasScannableTicket,
  resolveScan,
  ticketScanCode,
  type ScanAction,
} from "../scan-code.ts";

type Feedback =
  | { kind: "ready" }
  | { kind: "done" | "error" | "info"; title: string; body: string };

const TONE = {
  done: {
    box: "bg-success-subtle text-success",
    icon: CircleCheck,
  },
  error: { box: "bg-danger-subtle text-danger", icon: CircleAlert },
  warning: { box: "bg-warning-subtle text-warning", icon: TriangleAlert },
  info: { box: "bg-surface-3 text-foreground", icon: null },
} as const;

/**
 * Keyboard-wedge scanner aside (bead legend-uqfu). The scanner types
 * `<AKSI> <TIKET>` plus Enter into the labelled input. Actions reuse the
 * board's `useKdsActions` mutation; the ticket buttons never depend on this
 * panel or on the scanner connection.
 */
export function ScannerPanel({
  tickets,
  action,
  status,
  onRecall,
}: {
  tickets: readonly KitchenTicketDetail[];
  action: ReturnType<typeof useKdsActions>;
  /** `unknown` when nothing reports the connection (no claim either way). */
  status: KdsScannerStatus | "unknown";
  /**
   * Opens the board's recall dialog; the reason is still required there.
   * `done` reports how the dialog ended: recalled, or cancelled.
   */
  onRecall: (
    ticket: KitchenTicketDetail,
    done: (recalled: boolean) => void,
  ) => void;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const refocus = useRef(false);
  const [value, setValue] = useState("");
  // Counts scans so an identical result is announced again by the live region.
  const [scans, setScans] = useState(0);
  const [feedback, setFeedback] = useState<Feedback>({ kind: "ready" });
  const busy = action.isPending;
  const disconnected = status === "disconnected";
  // Nothing to scan when no action can apply to any ticket on the board.
  const noTickets = !hasScannableTicket(tickets);
  const example = exampleScanTicket(tickets);
  const disabled = busy || disconnected || noTickets;

  // The input is disabled while an action runs; hand focus back after it.
  useEffect(() => {
    if (!disabled && refocus.current) {
      refocus.current = false;
      inputRef.current?.focus();
    }
  }, [disabled]);

  const subject = (ticket: KitchenTicketDetail) =>
    ticket.tableLabel !== null
      ? t("kds.table", { label: ticket.tableLabel })
      : t(`kds.channel.${ticket.channel}`);

  const succeed = (act: ScanAction, ticket: KitchenTicketDetail) => {
    const params = {
      subject: subject(ticket),
      code: ticketScanCode(ticket.ticketNo),
    };
    if (act === "bump")
      setFeedback({
        kind: "done",
        title: t("kds.scanner.doneBumpTitle"),
        body: t("kds.scanner.doneBumpBody", params),
      });
    else if (act === "start")
      setFeedback({
        kind: "done",
        title: t("kds.scanner.doneStartTitle"),
        body: t("kds.scanner.doneStartBody", params),
      });
    else {
      const removed = ticket.priority > 0;
      setFeedback({
        kind: "done",
        title: t(
          removed
            ? "kds.scanner.donePriorityRemovedTitle"
            : "kds.scanner.donePriorityTitle",
        ),
        body: t(
          removed
            ? "kds.scanner.donePriorityRemovedBody"
            : "kds.scanner.donePriorityBody",
          params,
        ),
      });
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    const result = resolveScan(value, tickets);
    // A new scan clears the last action error, so the page banner never
    // contradicts what the scanner reports.
    action.reset();
    setScans((count) => count + 1);
    setValue("");
    refocus.current = true;
    if (!result.ok) {
      setFeedback(
        result.reason === "invalid-status"
          ? {
              kind: "error",
              title: t("kds.scanner.invalidTitle"),
              body: t("kds.scanner.invalidBody", {
                code: ticketScanCode(result.ticket.ticketNo),
                status: t(`kds.status.${result.ticket.status}`),
              }),
            }
          : {
              kind: "error",
              title: t("kds.scanner.unknownTitle"),
              body: t("kds.scanner.unknownBody"),
            },
      );
      // Nothing is pending, so the effect would not run; refocus now.
      refocus.current = false;
      inputRef.current?.focus();
      return;
    }
    const { ticket } = result;
    if (result.action === "recall") {
      setFeedback({
        kind: "info",
        title: t("kds.scanner.recallTitle"),
        body: t("kds.scanner.recallBody", {
          subject: subject(ticket),
          code: ticketScanCode(ticket.ticketNo),
        }),
      });
      onRecall(ticket, (recalled) =>
        setFeedback(
          recalled
            ? {
                kind: "done",
                title: t("kds.scanner.doneRecallTitle"),
                body: t("kds.scanner.doneRecallBody", {
                  subject: subject(ticket),
                  code: ticketScanCode(ticket.ticketNo),
                }),
              }
            : { kind: "ready" },
        ),
      );
      refocus.current = false;
      return;
    }
    const onSuccess = () => succeed(result.action, ticket);
    const onError = (error: unknown) => {
      setFeedback({
        kind: "error",
        title: t("kds.scanner.failedTitle"),
        body: t("kds.scanner.failedBody", {
          message:
            error instanceof ApiError && error.message
              ? error.message
              : t("kds.scanner.failedFallback"),
        }),
      });
      // The scanner reports this failure; the page banner stays out of it.
      action.reset();
    };
    if (result.action === "priority")
      action.mutate(
        {
          kind: "priority",
          id: ticket.id,
          priority: ticket.priority > 0 ? 0 : 1,
        },
        { onSuccess, onError },
      );
    else
      action.mutate(
        { kind: "ticket", id: ticket.id, action: result.action },
        { onSuccess, onError },
      );
  };

  // What the feedback region says: a blocking state beats the last result.
  const view = disconnected
    ? {
        tone: "warning" as const,
        title: t("kds.scanner.disconnectedTitle"),
        body: t("kds.scanner.disconnectedBody"),
      }
    : busy
      ? {
          tone: "info" as const,
          title: t("kds.scanner.busyTitle"),
          body: t("kds.scanner.busyBody"),
        }
      : noTickets
        ? {
            tone: "info" as const,
            title: t("kds.scanner.noTicketsTitle"),
            body: t("kds.scanner.noTicketsBody"),
          }
        : feedback.kind === "ready"
          ? {
              tone: "info" as const,
              title: t("kds.scanner.readyTitle"),
              body: t("kds.scanner.readyBody"),
            }
          : {
              tone: feedback.kind,
              title: feedback.title,
              body: feedback.body,
            };
  const tone = TONE[view.tone];
  const ToneIcon = tone.icon;

  return (
    <aside
      aria-labelledby="kds-scanner-title"
      className="flex flex-col gap-4 self-start rounded-container border-(length:--border-w) bg-card p-4 min-[1001px]:sticky min-[1001px]:top-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id="kds-scanner-title" className="type-title">
          {t("kds.scanner.title")}
        </h2>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("kds.scanner.intro")}
        </p>
      </div>
      {status !== "unknown" && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={disconnected ? "warning" : "success"}>
            {disconnected ? (
              <TriangleAlert aria-hidden="true" />
            ) : (
              <CircleCheck aria-hidden="true" />
            )}
            {t(
              disconnected
                ? "kds.scanner.disconnected"
                : "kds.scanner.connected",
            )}
          </Badge>
          <Badge
            tone={disconnected ? "warning" : "neutral"}
            className="rounded-control border-(length:--border-w) border-current font-semibold"
          >
            {disconnected ? (
              <Keyboard aria-hidden="true" />
            ) : (
              <ScanLine aria-hidden="true" />
            )}
            {t(
              disconnected ? "kds.scanner.tagManual" : "kds.scanner.tagActive",
            )}
          </Badge>
        </div>
      )}
      <form onSubmit={submit} className="flex flex-col gap-2">
        <Label htmlFor="kds-scanner-input">{t("kds.scanner.label")}</Label>
        <Input
          ref={inputRef}
          id="kds-scanner-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          className="h-14 border-2 border-primary focus-visible:ring-4 focus-visible:ring-primary/30"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          disabled={disabled}
          placeholder={
            disconnected
              ? t("kds.scanner.disconnectedPlaceholder")
              : busy
                ? t("kds.scanner.busyPlaceholder")
                : example
                  ? t("kds.scanner.placeholder", {
                      code: ticketScanCode(example.ticketNo),
                    })
                  : t("kds.scanner.placeholderNoExample")
          }
          aria-describedby="kds-scanner-hint"
        />
        <p
          id="kds-scanner-hint"
          className="text-sm leading-5 text-muted-foreground"
        >
          {t("kds.scanner.hint")}
        </p>
      </form>
      <div
        role="status"
        aria-live="polite"
        aria-busy={busy}
        className={`flex items-start gap-2 rounded-control p-3 ${tone.box}`}
      >
        {ToneIcon && (
          <ToneIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        )}
        <div key={scans} className="flex min-w-0 flex-1 flex-col gap-1">
          <strong className="text-sm leading-5">{view.title}</strong>
          <p className="text-sm leading-5">{view.body}</p>
          {busy && <Skeleton className="mt-1 h-3 w-24" />}
        </div>
      </div>
      <div className="flex flex-col gap-1 border-t-(length:--border-w) pt-3 text-sm leading-5">
        <p className="font-semibold">{t("kds.scanner.stepsTitle")}</p>
        <ol className="list-decimal pl-5 text-muted-foreground">
          <li>{t("kds.scanner.stepStartBump")}</li>
          <li>{t("kds.scanner.stepRecallPriority")}</li>
        </ol>
      </div>
    </aside>
  );
}
