import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  CircleCheck,
  RotateCw,
  ShieldCheck,
} from "lucide-react";
import type { PosIssueChargeAttemptOutcome } from "@starter/shared/pos";
import { idr } from "@starter/shared/core";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/errors";
import {
  Notice,
  PosPageHeading,
  PosPanel,
  PosTwoPane,
  StatusPill,
} from "@/features/ws04-pos-kasir/components/shared";
import {
  useChargeAttempts,
  useChargeTerminals,
  useIssueCharge,
} from "../charge-hooks";
import type { IssueChargeDetail } from "../charge-endpoints";
import { chargeSurchargeIdr } from "../charge-logic";
import {
  chargePhase,
  methodOfSignature,
  terminalOfSignature,
  type ChargeMethod,
} from "../charge-method-logic";
import {
  EdcSales,
  EndedCodeNotice,
  GatewayWaiting,
  MethodPicker,
  TerminalPicker,
} from "./charge-method-panels";
import {
  ChargeResolveDialog,
  type ResolvableAttempt,
} from "./charge-resolve-dialog";

function BackLink({ orderId }: { orderId: string | null }) {
  const t = useT();
  return (
    <Button asChild variant="outline">
      {orderId ? (
        <Link to="/pos/pesanan/$orderId" params={{ orderId }}>
          <ArrowLeft aria-hidden="true" />
          {t("posIssueCharge.screen.back")}
        </Link>
      ) : (
        <Link to="/pos/meja">
          <ArrowLeft aria-hidden="true" />
          {t("posIssueCharge.screen.back")}
        </Link>
      )}
    </Button>
  );
}

function LoadingShape() {
  const t = useT();
  return (
    <div aria-busy="true" role="status" className="grid gap-4">
      <span className="sr-only">{t("posIssueCharge.screen.loading")}</span>
      <Skeleton className="h-16 w-80 max-w-full" />
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,25rem)]">
        <Skeleton className="h-[30rem] rounded-container" />
        <Skeleton className="h-[30rem] rounded-container" />
      </div>
    </div>
  );
}

function SuccessNotice({
  title,
  children,
}: {
  title: string;
  children: string;
}) {
  return (
    <div
      data-slot="notice"
      data-tone="success"
      className="rounded-control border-(length:--border-w) border-success bg-success-subtle px-4 py-3 text-success"
    >
      <p className="flex items-center gap-2 text-(length:--density-text) leading-6 font-semibold">
        <CircleCheck className="size-5 shrink-0" aria-hidden="true" />
        {title}
      </p>
      <p className="mt-1 text-base leading-6 text-foreground">{children}</p>
    </div>
  );
}

function AmountBox({ label, amountIdr }: { label: string; amountIdr: number }) {
  return (
    <div className="grid gap-1 rounded-container bg-muted p-card">
      <span>{label}</span>
      <Money amount={amountIdr} size="xl" className="font-bold" />
    </div>
  );
}

function DetailPanel({
  charge,
  paid,
}: {
  charge: IssueChargeDetail;
  paid: boolean;
}) {
  const t = useT();
  // Both figures are the server's; the gap only explains them.
  const surchargeIdr = chargeSurchargeIdr(charge);
  const order = charge.tableLabel
    ? t("posIssueCharge.detail.orderTable", {
        number: charge.orderNumber,
        table: charge.tableLabel,
      })
    : t("posIssueCharge.detail.order", { number: charge.orderNumber });
  const line = (label: string, item: IssueChargeDetail["original"]) => (
    <div className="flex items-start justify-between gap-4">
      <span className="grid min-w-0 gap-1">
        <span>{label}</span>
        <span className="text-base text-muted-foreground">
          {t("posIssueCharge.detail.portion", {
            name: item.name,
            count: item.quantity,
          })}
        </span>
      </span>
      <Money amount={item.lineTotalIdr} className="font-semibold" />
    </div>
  );
  return (
    <PosPanel
      title={t("posIssueCharge.detail.title")}
      aside={
        paid ? (
          <StatusPill tone="success">
            {t("posIssueCharge.status.paid")}
          </StatusPill>
        ) : (
          <StatusPill tone="warning">
            {t("posIssueCharge.status.unpaid")}
          </StatusPill>
        )
      }
    >
      <div className="grid gap-4">
        <p className="text-base text-muted-foreground">{order}</p>
        <div className="grid gap-4 border-t border-border pt-4">
          {line(t("posIssueCharge.detail.unavailable"), charge.original)}
          {line(t("posIssueCharge.detail.replacement"), charge.replacement)}
        </div>
        <div className="grid gap-2 rounded-container bg-muted p-card">
          {surchargeIdr > 0 && (
            <div className="flex items-center justify-between gap-4">
              <span>{t("posIssueCharge.detail.surcharge")}</span>
              <Money amount={surchargeIdr} className="font-semibold" />
            </div>
          )}
          <div className="flex items-center justify-between gap-4 font-semibold">
            <span>{t("posIssueCharge.detail.due")}</span>
            <Money amount={charge.amountIdr} />
          </div>
        </div>
        <p className="text-base text-muted-foreground">
          {t("posIssueCharge.detail.hint")}
        </p>
      </div>
    </PosPanel>
  );
}

// /pos/tagih-selisih/$chargeId: the cashier takes the price difference of a
// dearer menu swap in cash, by QRIS or by EDC card (legend-shabi, legend-t93l8).
// The amount is the server's charge, never typed. While a code or an EDC sale
// is out, or an answer never arrived, the method is locked and only the status
// can be checked, so the charge is never paid twice.
export function ChargeScreen({ chargeId }: { chargeId: string }) {
  return (
    <div data-density="kontras" className="grid gap-4">
      <ChargeBody chargeId={chargeId} />
    </div>
  );
}

/** A refusal the server named: its catalog text, else the server's own. */
function useFailureText() {
  const t = useT();
  return (code: string | null, message: string) =>
    code === "EDC_AGENT_NOT_READY" ? t("posIssueCharge.edc.notReady") : message;
}

function ChargeBody({ chargeId }: { chargeId: string }) {
  const t = useT();
  const failureText = useFailureText();
  const query = useIssueCharge(chargeId);
  const charge = query.data;
  const attempts = useChargeAttempts(chargeId, charge);
  const [checking, setChecking] = useState(false);
  const [notRecorded, setNotRecorded] = useState(false);
  const [picked, setPicked] = useState<ChargeMethod>("cash");
  const [saleId, setSaleId] = useState<string | null>(null);
  const [pickedTerminal, setPickedTerminal] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolved, setResolved] = useState<PosIssueChargeAttemptOutcome | null>(
    null,
  );
  const terminalsQuery = useChargeTerminals(
    picked === "edc_card" || attempts.lock !== null,
  );

  if (query.isLoading) return <LoadingShape />;

  // A failed re-read keeps the last charge on screen (the code stays visible),
  // but nothing can be collected until the server answers again.
  if (query.error && !charge) {
    const missing =
      query.error instanceof ApiError && query.error.status === 404;
    if (missing)
      return (
        <EmptyState
          title={t("posIssueCharge.screen.emptyTitle")}
          description={t("posIssueCharge.screen.emptyHint")}
          action={<BackLink orderId={null} />}
        />
      );
    return (
      <ErrorState
        error={query.error}
        title={t("posIssueCharge.screen.errorTitle")}
        description={t("posIssueCharge.screen.errorHint")}
        action={
          <div className="flex flex-wrap gap-3">
            <Button
              loading={query.isFetching}
              onClick={() => void query.refetch()}
            >
              <RotateCw aria-hidden="true" />
              {t("common.retry")}
            </Button>
            <BackLink orderId={null} />
          </div>
        }
      />
    );
  }

  if (!charge)
    return (
      <EmptyState
        title={t("posIssueCharge.screen.emptyTitle")}
        description={t("posIssueCharge.screen.emptyHint")}
        action={<BackLink orderId={null} />}
      />
    );

  // A known success counts at once; the refetch only confirms it. A QRIS code
  // is not a success: the swap stays unpaid until the server says paid.
  const phase = attempts.settled ? "paid" : chargePhase(charge);
  const paid = phase === "paid";
  const amount = formatRupiah(charge.amountIdr);
  const { failure, pending, lock } = attempts;
  // (a) An attempt without an answer holds the picker to its own method.
  const only = lock ? methodOfSignature(lock.signature) : null;
  const method: ChargeMethod = only ?? picked;
  const lockedTerminal = lock ? terminalOfSignature(lock.signature) : null;
  const terminals = terminalsQuery.data ?? [];
  const terminalId =
    lockedTerminal ??
    terminals.find((item) => item.id === pickedTerminal)?.id ??
    (terminals.length === 1 ? terminals[0]!.id : null);

  // What a supervisor may settle: this browser's cash or card start without
  // an answer, or a card sale it started whose answer is unknown (d).
  const unknownSale = charge.edcSales.find((sale) => sale.status === "unknown");
  const unknownSaleKey = unknownSale ? attempts.saleKey(unknownSale.id) : null;
  let resolvable: ResolvableAttempt | null = null;
  if (lock?.signature.startsWith("cash:"))
    resolvable = { method: "cash", key: lock.key, needsStatement: false };
  else if (lock?.signature.startsWith("edc:"))
    resolvable = {
      method: "edc",
      key: lock.key,
      needsStatement: unknownSale !== undefined,
    };
  else if (unknownSaleKey)
    resolvable = { method: "edc", key: unknownSaleKey, needsStatement: true };

  const checkStatus = async () => {
    setChecking(true);
    // refetch() never throws: a failed read is not "not recorded". The result
    // stays unknown and the check button stays.
    const result = await query.refetch();
    setChecking(false);
    if (result.isError || !result.data) return;
    const read = chargePhase(result.data);
    // Still out or under review: the lock below stays.
    if (read !== "choose" && read !== "edc_approved") return;
    attempts.resolve();
    setNotRecorded(read === "choose");
  };

  const send = (request: Parameters<typeof attempts.send>[0]) => {
    setNotRecorded(false);
    setResolved(null);
    attempts.send(request);
  };

  const due = (
    <AmountBox
      label={t("posIssueCharge.collect.difference")}
      amountIdr={charge.amountIdr}
    />
  );
  const checkButton = (
    <Button
      size="lg"
      variant="outline"
      className="w-full"
      loading={checking}
      onClick={() => void checkStatus()}
    >
      {checking
        ? t("posIssueCharge.unknown.checking")
        : t("posIssueCharge.unknown.check")}
    </Button>
  );
  const resolveButton = resolvable && (
    <Button
      size="lg"
      variant="outline"
      className="w-full"
      onClick={() => setResolving(true)}
    >
      <ShieldCheck aria-hidden="true" />
      {t("posIssueCharge.resolve.action")}
    </Button>
  );
  const stale = query.isError && (
    <Notice tone="danger" title={t("posIssueCharge.waiting.staleTitle")}>
      <p>{t("posIssueCharge.waiting.stale")}</p>
    </Notice>
  );
  const waitingPill = (
    <StatusPill tone="warning">{t("posIssueCharge.waiting.pill")}</StatusPill>
  );
  const checkMachine = (
    <Notice tone="info" title={t("posIssueCharge.edc.checkMachineTitle")}>
      <p>
        {t("posIssueCharge.edc.checkMachine")}
        {unknownSale &&
          !resolvable &&
          ` ${t("posIssueCharge.edc.otherDevice")}`}
      </p>
    </Notice>
  );

  let pill = (
    <StatusPill tone="warning">{t("posIssueCharge.status.unpaid")}</StatusPill>
  );
  let body;
  // The form's one action stays in reach when the panel is taller than the
  // viewport (sticky panel footer).
  let footer;
  if (paid) {
    pill = (
      <StatusPill tone="success">{t("posIssueCharge.status.paid")}</StatusPill>
    );
    body = (
      <>
        <AmountBox
          label={t("posIssueCharge.success.paidAmount")}
          amountIdr={charge.amountIdr}
        />
        <SuccessNotice
          title={t(
            resolved === "recorded"
              ? "posIssueCharge.resolve.recordedTitle"
              : "posIssueCharge.success.title",
          )}
        >
          {t(
            attempts.settledMethod === "cash"
              ? "posIssueCharge.success.hint"
              : "posIssueCharge.success.settledHint",
            { amount },
          )}
        </SuccessNotice>
        <Button asChild size="lg" className="w-full">
          <Link to="/pos/pesanan/$orderId" params={{ orderId: charge.orderId }}>
            {t("posIssueCharge.success.action")}
          </Link>
        </Button>
      </>
    );
  } else if (phase === "closed") {
    pill = (
      <StatusPill tone="neutral">
        {t(
          `posIssueCharge.status.${charge.status as "waived" | "expired" | "voided"}`,
        )}
      </StatusPill>
    );
    body = (
      <Notice tone="info" title={t("posIssueCharge.closed.title")}>
        <p>{t("posIssueCharge.closed.hint")}</p>
      </Notice>
    );
  } else if (pending) {
    const edc = attempts.sendingMethod === "edc_start";
    body = (
      <>
        {due}
        <Notice
          tone="info"
          role="status"
          title={t(
            edc
              ? "posIssueCharge.edc.sendingTitle"
              : "posIssueCharge.collect.recording",
          )}
        >
          <p>
            {t(
              edc
                ? "posIssueCharge.edc.sendingHint"
                : "posIssueCharge.collect.recordingHint",
            )}
          </p>
        </Notice>
        <Button size="lg" className="w-full" loading disabled>
          {t("posIssueCharge.collect.pending")}
        </Button>
      </>
    );
  } else if (phase === "review") {
    pill = (
      <StatusPill tone="danger">{t("posIssueCharge.review.pill")}</StatusPill>
    );
    body = (
      <>
        {due}
        <EdcSales charge={charge} selectedId={null} onSelect={setSaleId} />
        <Notice tone="danger" title={t("posIssueCharge.review.title")}>
          <p>{t("posIssueCharge.review.hint")}</p>
        </Notice>
        {stale}
        {checkButton}
      </>
    );
  } else if (phase === "gateway_waiting" && charge.payment) {
    pill = waitingPill;
    body = (
      <>
        {due}
        <GatewayWaiting payment={charge.payment} />
        {stale}
        {checkButton}
      </>
    );
  } else if (phase === "gateway_confirming") {
    pill = waitingPill;
    body = (
      <>
        {due}
        <Notice
          tone="info"
          role="status"
          title={t("posIssueCharge.qris.confirmingTitle")}
        >
          <p>{t("posIssueCharge.qris.confirming")}</p>
        </Notice>
        {stale}
        {checkButton}
      </>
    );
  } else if (phase === "edc_waiting") {
    pill = waitingPill;
    body = (
      <>
        {due}
        <EdcSales charge={charge} selectedId={null} onSelect={setSaleId} />
        <Notice
          tone="warning"
          role="status"
          title={t(
            unknownSale
              ? "posIssueCharge.edc.waitingTitle"
              : "posIssueCharge.edc.pendingTitle",
          )}
        >
          <p>
            {t(
              unknownSale
                ? "posIssueCharge.edc.waiting"
                : "posIssueCharge.edc.pending",
            )}{" "}
            {t("posIssueCharge.waiting.locked")}
          </p>
        </Notice>
        {unknownSale && checkMachine}
        {stale}
        {checkButton}
        {unknownSale && resolveButton}
      </>
    );
  } else if (failure || query.isError) {
    const notRead = failure?.kind === "not_read";
    const unknown = !notRead && failure?.kind !== "failed";
    pill = (
      <StatusPill tone="danger">{t("posIssueCharge.status.failed")}</StatusPill>
    );
    body = (
      <>
        {due}
        {failure && (
          <Notice
            tone="danger"
            title={t(
              notRead
                ? "posIssueCharge.precheck.title"
                : unknown
                  ? "posIssueCharge.unknown.title"
                  : "posIssueCharge.failed.title",
            )}
          >
            <p>
              {notRead
                ? t("posIssueCharge.precheck.hint")
                : unknown
                  ? t("posIssueCharge.unknown.hint")
                  : `${t("posIssueCharge.failed.hint")} ${failureText(failure.code, failure.message)}`}
            </p>
          </Notice>
        )}
        {stale}
        {unknown ? (
          <>
            {checkButton}
            {resolveButton}
          </>
        ) : (
          <Button
            size="lg"
            className="w-full"
            onClick={notRead ? attempts.clear : attempts.resolve}
          >
            <RotateCw aria-hidden="true" />
            {t("common.retry")}
          </Button>
        )}
      </>
    );
  } else if (phase === "edc_approved") {
    const sale = charge.edcSales.find((item) => item.id === saleId);
    pill = (
      <StatusPill tone="info">
        {t("posIssueCharge.edc.approvedPill")}
      </StatusPill>
    );
    body = (
      <>
        {due}
        <p className="text-base text-muted-foreground">
          {t("posIssueCharge.edc.pick")}
        </p>
        <EdcSales charge={charge} selectedId={saleId} onSelect={setSaleId} />
      </>
    );
    footer = (
      <Button
        size="lg"
        className="w-full"
        disabled={!sale}
        onClick={() =>
          sale && send({ method: "edc_card", edcTransactionId: sale.id })
        }
      >
        {t("posIssueCharge.edc.record", { amount })}
        <ArrowRight aria-hidden="true" />
      </Button>
    );
  } else {
    const methodName = only ? t(`posIssueCharge.method.${only}`) : "";
    body = (
      <>
        <p className="text-base text-muted-foreground">
          {t("posIssueCharge.collect.hint")}
        </p>
        {due}
        {resolved === "closed" && (
          <Notice
            tone="info"
            role="status"
            title={t("posIssueCharge.resolve.closedTitle")}
          >
            <p>{t("posIssueCharge.resolve.closed")}</p>
          </Notice>
        )}
        {notRecorded && (
          <Notice
            tone="info"
            role="status"
            title={t("posIssueCharge.unknown.notRecordedTitle")}
          >
            <p>{t("posIssueCharge.unknown.notRecorded")}</p>
          </Notice>
        )}
        {only && (
          <Notice
            tone="warning"
            title={t("posIssueCharge.method.lockedTitle", {
              method: methodName,
            })}
          >
            <p>
              {t("posIssueCharge.method.lockedHint", { method: methodName })}
              {resolvable && ` ${t("posIssueCharge.method.lockedResolveHint")}`}
            </p>
          </Notice>
        )}
        <EndedCodeNotice payment={charge.payment} />
        <MethodPicker value={method} onChange={setPicked} only={only} />
        {method === "cash" && (
          <Notice
            tone="warning"
            title={t("posIssueCharge.collect.receive", { amount })}
          >
            <p>{t("posIssueCharge.collect.receiveHint")}</p>
          </Notice>
        )}
        {method === "qris" && (
          <p className="text-base text-muted-foreground">
            {t("posIssueCharge.qris.startHint")}
          </p>
        )}
        {method === "edc_card" && (
          <>
            <EdcSales charge={charge} selectedId={null} onSelect={setSaleId} />
            <TerminalPicker
              terminals={terminals}
              value={terminalId}
              onChange={setPickedTerminal}
              lockedId={lockedTerminal}
              loading={terminalsQuery.isLoading}
              failed={terminalsQuery.isError}
            />
            <p className="text-base text-muted-foreground">
              {t("posIssueCharge.edc.startHint")}
            </p>
          </>
        )}
        {resolveButton}
      </>
    );
    if (method === "cash")
      footer = (
        <Button
          size="lg"
          className="w-full"
          onClick={() =>
            send({ method: "cash", receivedIdr: idr(charge.amountIdr) })
          }
        >
          {t("posIssueCharge.collect.action", { amount })}
          <ArrowRight aria-hidden="true" />
        </Button>
      );
    if (method === "qris")
      footer = (
        <Button
          size="lg"
          className="w-full"
          onClick={() => send({ method: "qris" })}
        >
          {t(
            charge.payment?.method === "qris"
              ? "posIssueCharge.qris.renew"
              : "posIssueCharge.qris.start",
            { amount },
          )}
          <ArrowRight aria-hidden="true" />
        </Button>
      );
    if (method === "edc_card")
      footer = (
        <Button
          size="lg"
          className="w-full"
          disabled={terminalId === null}
          onClick={() =>
            terminalId && send({ method: "edc_start", terminalId })
          }
        >
          {t("posIssueCharge.edc.start", { amount })}
          <ArrowRight aria-hidden="true" />
        </Button>
      );
  }

  return (
    <div className="grid gap-4">
      <PosPageHeading
        title={t("posIssueCharge.screen.title")}
        subtitle={t("posIssueCharge.screen.subtitle")}
        action={<BackLink orderId={charge.orderId} />}
      />
      <PosTwoPane
        sidePosition="end"
        side={
          <PosPanel
            title={t("posIssueCharge.collect.title")}
            aside={pill}
            footer={footer}
          >
            <div className="grid gap-4">{body}</div>
          </PosPanel>
        }
      >
        <DetailPanel charge={charge} paid={paid} />
      </PosTwoPane>
      {resolvable && (
        <ChargeResolveDialog
          chargeId={chargeId}
          amountIdr={charge.amountIdr}
          attempt={resolvable}
          open={resolving}
          onOpenChange={setResolving}
          onSettled={(outcome, key) => {
            attempts.settledAttempt(key);
            setResolved(outcome);
            setNotRecorded(false);
          }}
        />
      )}
    </div>
  );
}
