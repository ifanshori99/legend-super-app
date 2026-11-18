import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Ticket } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { formatClock, formatDateLabel } from "../../../facility/flow";
import { useIssueTicketCredential, useOrderTickets } from "../../ticket/hooks";
import type { TicketCredential } from "../../ticket/types";
import { PosPageHeading, PosPanel, Notice, StatusPill } from "../shared";
import { IssueError } from "./issue-error";
import { IssuedTicket } from "./issued-ticket";
import { TicketError } from "./ticket-error";

// /pos/tiket?order&tiket — one paid ticket, issued on an explicit tap (never on
// mount). The QR and PIN live only in this component's state: a reload or a
// return to the screen starts again at "Terbitkan tiket", and issuing again
// rotates the code on the server. Any failed issue drops the code from state:
// the server may already have rotated it, so the one on screen can be dead.
export function TicketIssueStep({
  orderId,
  ticketId,
}: {
  orderId: string;
  ticketId: string;
}) {
  const t = useT();
  const tickets = useOrderTickets(orderId);
  const issue = useIssueTicketCredential();
  const [credential, setCredential] = useState<TicketCredential | null>(null);
  const [rotations, setRotations] = useState(0);

  const line = tickets.data?.find((item) => item.ticketId === ticketId);

  const runIssue = () => {
    if (issue.isPending) return;
    issue.mutate(
      { orderId, ticketId },
      {
        onSuccess: (next) => {
          if (credential) setRotations((count) => count + 1);
          setCredential(next);
        },
        onError: () => {
          setCredential(null);
          setRotations(0);
        },
      },
    );
  };

  const heading = (
    <PosPageHeading
      title={t("posKasirTicket.title")}
      subtitle={t("posKasirTicket.subtitle")}
      action={
        <Button asChild variant="outline">
          <Link to="/pos/kasir">
            <ArrowLeft aria-hidden="true" />
            {t("posKasirTicket.back")}
          </Link>
        </Button>
      }
    />
  );

  if (credential && line && !issue.isError)
    return (
      <div data-slot="ticket-sale-screen" className="grid gap-4">
        {heading}
        <IssuedTicket
          line={line}
          credential={credential}
          rotated={rotations > 0}
          reissuing={issue.isPending}
          onReissue={runIssue}
        />
      </div>
    );

  return (
    <div data-slot="ticket-sale-screen" className="grid gap-4">
      {heading}
      <PosPanel
        title={t("posKasirTicket.step.title")}
        aside={
          line?.lineStatus === "issued" ? (
            <StatusPill tone="success">
              {t("posKasirTicket.issued.pill")}
            </StatusPill>
          ) : undefined
        }
      >
        <div data-slot="ticket-issue-step" className="grid gap-4">
          {tickets.isLoading ? (
            <div role="status" aria-busy="true" className="grid gap-3">
              <span className="sr-only">
                {t("posKasirTicket.step.loading")}
              </span>
              <Skeleton className="h-24 w-full" />
            </div>
          ) : tickets.isError ? (
            <TicketError
              error={tickets.error}
              title={t("posKasirTicket.step.errorTitle")}
              onRetry={() => void tickets.refetch()}
            />
          ) : !line ? (
            <Notice
              tone="danger"
              title={t("posKasirTicket.step.notFoundTitle")}
            >
              {t("posKasirTicket.step.notFoundHint")}
            </Notice>
          ) : (
            <>
              <div className="grid gap-1 rounded-container bg-surface-3 p-4">
                <p className="font-semibold">
                  {line.productName || t("posKasirTicket.issued.fallbackName")}
                </p>
                {line.customerName ? (
                  <p className="text-sm text-muted-foreground">
                    {t("posKasirTicket.issued.customer", {
                      name: line.customerName,
                    })}
                  </p>
                ) : null}
                {line.startsAt && line.endsAt ? (
                  <p className="text-sm text-muted-foreground">
                    {t("posKasirTicket.issued.schedule", {
                      date: formatDateLabel(line.startsAt),
                      from: formatClock(line.startsAt),
                      until: formatClock(line.endsAt),
                    })}
                  </p>
                ) : null}
                <Money amount={line.priceIdr} className="mt-1 font-bold" />
              </div>
              {line.lineStatus === "issued" ? (
                <>
                  <p className="text-(length:--density-text)">
                    {t("posKasirTicket.step.ready")}{" "}
                    <span className="text-muted-foreground">
                      {t("posKasirTicket.step.readyHint")}
                    </span>
                  </p>
                  {issue.isError ? (
                    <IssueError error={issue.error} onRetry={runIssue} />
                  ) : null}
                  <div>
                    <Button
                      type="button"
                      size="lg"
                      disabled={issue.isPending}
                      aria-busy={issue.isPending}
                      onClick={runIssue}
                    >
                      <Ticket aria-hidden="true" />
                      {issue.isPending
                        ? t("posKasirTicket.step.issuing")
                        : t("posKasirTicket.step.issue")}
                    </Button>
                  </div>
                </>
              ) : line.lineStatus === "pending" ? (
                <Notice
                  tone="warning"
                  title={t("posKasirTicket.step.pendingTitle")}
                >
                  <span className="grid justify-items-start gap-3">
                    {t("posKasirTicket.step.pendingHint")}
                    <Button asChild variant="outline">
                      <Link to="/pos/bayar/$orderId" params={{ orderId }}>
                        {t("posKasirTicket.step.payLink")}
                      </Link>
                    </Button>
                  </span>
                </Notice>
              ) : (
                <Notice tone="danger" title={t("posKasirTicket.step.badTitle")}>
                  <span className="grid justify-items-start gap-3">
                    {t("posKasirTicket.step.badHint")}
                    <Button asChild variant="outline">
                      <Link to="/pos/tiket">
                        {t("posKasirTicket.step.sellNew")}
                      </Link>
                    </Button>
                  </span>
                </Notice>
              )}
            </>
          )}
        </div>
      </PosPanel>
    </div>
  );
}
