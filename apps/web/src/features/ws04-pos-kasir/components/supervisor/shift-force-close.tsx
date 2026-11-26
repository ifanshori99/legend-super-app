import { useId, useRef, useState, type ReactNode } from "react";
import { cn } from "cn";
import { ShieldCheck } from "lucide-react";
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
import { ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { fieldClass, Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useOutletClock } from "@/lib/tenant-context";
import { forceCloseNoteValid } from "../../shift-extra-api";
import { thirdPersons } from "../../shift-extra-logic";
import {
  useForceCloseShift,
  useForceCloseView,
  useForceCloseViewer,
  useForceCloseWitnesses,
  useSubmitForcedCount,
  useWitnessForcedCount,
} from "../../shift-hooks";
import type { ForceCloseView } from "../../shift-extra-types";
import { CASH_DENOMINATIONS_IDR } from "../../types";
import {
  DenominationCounter,
  Notice,
  PosPageHeading,
  PosPanel,
  PosTwoPane,
  StateBlock,
  StatusPill,
  denominationTotal,
  type StatusPillTone,
} from "../shared";
import { formatShiftTime } from "../shift/shift-format";
import { ActionError } from "../shift/shift-parts";

const PIN_LENGTH = 6;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 rounded-control border-(length:--border-w) border-border bg-background p-4">
      <span className="text-base text-muted-foreground">{label}</span>
      <strong className="text-(length:--density-text)">{children}</strong>
    </div>
  );
}

function SideRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-(length:--density-text)">
      <span>{label}</span>
      <strong className="tabular text-right">{children}</strong>
    </div>
  );
}

function Shell({
  title,
  subtitle,
  pill,
  pillTone = "warning",
  sideTitle,
  side,
  mainTitle,
  footer,
  children,
}: {
  title: string;
  subtitle: string;
  pill: string;
  pillTone?: StatusPillTone;
  sideTitle: string;
  side: ReactNode;
  mainTitle: string;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-4">
      <PosPageHeading
        title={title}
        subtitle={subtitle}
        action={
          <StatusPill tone={pillTone} icon={ShieldCheck}>
            {pill}
          </StatusPill>
        }
      />
      <PosTwoPane
        className="md:grid-cols-2"
        side={
          <PosPanel title={sideTitle}>
            <div className="grid content-start gap-3">{side}</div>
          </PosPanel>
        }
      >
        <PosPanel title={mainTitle} footer={footer}>
          <div className="grid content-start gap-4">{children}</div>
        </PosPanel>
      </PosTwoPane>
    </div>
  );
}

/** A single centered message with one action (stale, own shift). */
function CenterMessage({
  title,
  subtitle,
  pill,
  pillTone,
  heading,
  body,
  actionLabel,
  onAction,
  primary,
}: {
  title: string;
  subtitle: string;
  pill: string;
  pillTone: StatusPillTone;
  heading: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
  primary: boolean;
}) {
  return (
    <div className="grid gap-4">
      <PosPageHeading
        title={title}
        subtitle={subtitle}
        action={<StatusPill tone={pillTone}>{pill}</StatusPill>}
      />
      <PosPanel
        title={heading}
        footer={
          <Button
            type="button"
            variant={primary ? "default" : "outline"}
            onClick={onAction}
          >
            {actionLabel}
          </Button>
        }
      >
        <p className="text-(length:--density-text) leading-6 text-muted-foreground">
          {body}
        </p>
      </PosPanel>
    </div>
  );
}

function CountStage({
  view,
  onBack,
  onSent,
}: {
  view: ForceCloseView;
  onBack: () => void;
  onSent: () => void;
}) {
  const t = useT();
  const { timeZone } = useOutletClock();
  const submit = useSubmitForcedCount();
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [otherIdr, setOtherIdr] = useState(0);
  const [zeroArmed, setZeroArmed] = useState(false);
  const lines = CASH_DENOMINATIONS_IDR.map((denominationIdr) => ({
    denominationIdr,
    quantity: quantities[denominationIdr] ?? 0,
  }));
  const counted = denominationTotal(lines, otherIdr);
  const confirmingZero = counted === 0 && zeroArmed;

  function send() {
    if (counted === 0 && !zeroArmed) {
      setZeroArmed(true);
      return;
    }
    submit.mutate(
      { shiftId: view.shiftId, counts: lines, otherAmountIdr: otherIdr },
      { onSuccess: onSent },
    );
  }

  return (
    <Shell
      title={t("posKasirSupervisor.force.title")}
      subtitle={t("posKasirSupervisor.force.subtitle", {
        shiftNo: view.shiftNo,
        cashier: view.cashierName,
        terminal: view.terminalLabel,
      })}
      pill={t("posKasirSupervisor.access")}
      sideTitle={t("posKasirSupervisor.force.sideTitle")}
      side={
        <>
          <SideRow label={t("posKasirSupervisor.force.cashier")}>
            {view.cashierName}
          </SideRow>
          <SideRow label={t("posKasirSupervisor.force.opened")}>
            {formatShiftTime(view.openedAt, timeZone)}
          </SideRow>
          <p className="border-t-(length:--border-w) border-border pt-3 text-base text-muted-foreground">
            {t("posKasirSupervisor.force.sideNote")}
          </p>
        </>
      }
      mainTitle={t("posKasirSupervisor.force.countTitle")}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onBack}>
            {t("posKasirSupervisor.back")}
          </Button>
          <Button type="button" loading={submit.isPending} onClick={send}>
            {submit.isPending
              ? t("posKasirSupervisor.force.sending")
              : confirmingZero
                ? t("posKasirSupervisor.force.zeroSubmit")
                : t("posKasirSupervisor.force.send")}
          </Button>
        </>
      }
    >
      <DenominationCounter
        denominations={CASH_DENOMINATIONS_IDR}
        quantities={quantities}
        onQuantityChange={(denominationIdr, quantity) => {
          setZeroArmed(false);
          setQuantities((current) => ({
            ...current,
            [denominationIdr]: quantity,
          }));
        }}
        otherIdr={otherIdr}
        onOtherChange={(value) => {
          setZeroArmed(false);
          setOtherIdr(value);
        }}
      />
      <Fact label={t("posKasirSupervisor.force.countedLabel")}>
        <Money amount={counted} className="font-bold" aria-live="polite" />
      </Fact>
      {confirmingZero && (
        <p role="status" className="text-base text-muted-foreground">
          {t("posKasirSupervisor.force.zeroConfirm")}
        </p>
      )}
      {submit.isError && (
        <ActionError
          title={t("posKasirSupervisor.force.sendFailed")}
          error={submit.error}
          onRetry={send}
        />
      )}
      <Notice tone="info" title={t("posKasirSupervisor.force.thirdTitle")}>
        {t("posKasirSupervisor.force.thirdBody")}
      </Notice>
    </Shell>
  );
}

function WitnessStage({
  view,
  onBack,
}: {
  view: ForceCloseView;
  onBack: () => void;
}) {
  const t = useT();
  const pinId = useId();
  const witnessId = useId();
  const viewer = useForceCloseViewer();
  const witnesses = useForceCloseWitnesses();
  const witness = useWitnessForcedCount(view.cashierId);
  const [chosen, setChosen] = useState("");
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string>();
  const [failure, setFailure] = useState<unknown>(null);
  // The witness is a third person: never the counter or the shift's cashier.
  const options = thirdPersons(
    witnesses.data ?? [],
    [viewer.userId, view.cashierId].filter((id): id is string => Boolean(id)),
  );
  const approverUserId = chosen || options[0]?.userId || "";
  const pending = witness.isPending;
  const count = view.count;

  // A second Enter must not send a second override while one is in flight.
  const inFlight = useRef(false);

  async function approve(event: React.FormEvent) {
    event.preventDefault();
    if (pending || inFlight.current) return;
    setFailure(null);
    if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) {
      setPinError(t("posKasirSupervisor.review.pinInvalid"));
      return;
    }
    setPinError(undefined);
    if (approverUserId === "" || !count) return;
    inFlight.current = true;
    try {
      await witness.mutateAsync({
        shiftId: view.shiftId,
        countId: count.id,
        // Same value the server checks (pos-shift.service.ts, verifyCloseApproval
        // in close and force-close): |counted - expected|, the physical variance.
        // Held refund and void cash only change the booked difference, not this.
        valueIdr: Math.abs(count.varianceIdr),
        approverUserId,
        approverName:
          options.find((option) => option.userId === approverUserId)?.name ??
          "",
        pin,
        reason: t("posKasirSupervisor.force.witnessReason"),
      });
    } catch (error) {
      setPin("");
      setFailure(error);
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <Shell
      title={t("posKasirSupervisor.force.witnessHeading")}
      subtitle={t("posKasirSupervisor.force.witnessSubtitle", {
        shiftNo: view.shiftNo,
      })}
      pill={t("posKasirSupervisor.force.stillActive")}
      sideTitle={t("posKasirSupervisor.force.countSideTitle")}
      side={
        <>
          <SideRow label={t("posKasirSupervisor.force.physical")}>
            {count && <Money amount={count.countedIdr} className="font-bold" />}
          </SideRow>
          <SideRow label={t("posKasirSupervisor.force.sentBy")}>
            {count?.countedByName}
          </SideRow>
        </>
      }
      mainTitle={t("posKasirSupervisor.force.waitingTitle")}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onBack}>
            {t("posKasirSupervisor.back")}
          </Button>
        </>
      }
    >
      <Notice tone="info" title={t("posKasirSupervisor.force.boundTitle")}>
        {t("posKasirSupervisor.force.boundBody", {
          counter: count?.countedByName ?? "",
        })}
      </Notice>
      <p className="text-base text-muted-foreground">
        {t("posKasirSupervisor.force.boundNote")}
      </p>
      <form
        onSubmit={(event) => void approve(event)}
        noValidate
        className="grid gap-4 border-t-(length:--border-w) border-border pt-4"
      >
        <h3 className="type-title">
          {t("posKasirSupervisor.force.witnessFormTitle")}
        </h3>
        {options.length > 1 && (
          <FormField
            label={t("posKasirSupervisor.force.witnessLabel")}
            id={witnessId}
            required
          >
            <select
              className={cn(fieldClass, "h-control px-3")}
              value={approverUserId}
              onChange={(event) => setChosen(event.target.value)}
            >
              {options.map((option) => (
                <option key={option.userId} value={option.userId}>
                  {option.name}
                </option>
              ))}
            </select>
          </FormField>
        )}
        <FormField
          label={t("posKasirSupervisor.review.pinLabel")}
          id={pinId}
          required
          error={pinError}
        >
          <Input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={PIN_LENGTH}
            value={pin}
            onChange={(event) => {
              setPin(event.target.value.replace(/\D/g, ""));
              if (pinError) setPinError(undefined);
            }}
            className="tabular text-2xl tracking-[0.5em]"
          />
        </FormField>
        {failure !== null && (
          <ActionError
            title={t("posKasirSupervisor.force.witnessFailed")}
            error={failure}
          />
        )}
        <div className="flex justify-end">
          <Button
            type="submit"
            loading={pending}
            disabled={witnesses.isPending || approverUserId === ""}
          >
            {pending
              ? t("posKasirSupervisor.force.witnessSubmitting")
              : t("posKasirSupervisor.force.witnessSubmit")}
          </Button>
        </div>
      </form>
    </Shell>
  );
}

function ReadyStage({
  view,
  onBack,
}: {
  view: ForceCloseView;
  onBack: () => void;
}) {
  const t = useT();
  const noteId = useId();
  const close = useForceCloseShift();
  const count = view.count;
  const variance = count?.varianceIdr ?? 0;
  const varianceKey =
    variance < 0
      ? "posKasirSupervisor.force.short"
      : variance > 0
        ? "posKasirSupervisor.force.over"
        : "posKasirSupervisor.force.even";
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string>();
  const [confirming, setConfirming] = useState(false);

  // First step: check the reason and ask for the confirmation.
  function askConfirm() {
    if (close.isPending) return;
    // The supervisor writes why (O4: e.g. the tablet is lost); the API needs 10.
    if (!forceCloseNoteValid(note)) {
      setNoteError(t("posKasirSupervisor.force.noteTooShort"));
      return;
    }
    setConfirming(true);
  }

  function closeNow() {
    if (close.isPending) return;
    setConfirming(false);
    close.mutate({ shiftId: view.shiftId, note });
  }

  return (
    <Shell
      title={t("posKasirSupervisor.force.readyHeading")}
      subtitle={t("posKasirSupervisor.force.subtitle", {
        shiftNo: view.shiftNo,
        cashier: view.cashierName,
        terminal: view.terminalLabel,
      })}
      pill={t("posKasirSupervisor.force.approved")}
      pillTone="success"
      sideTitle={t("posKasirSupervisor.force.countSideTitle")}
      side={
        <>
          <SideRow label={t("posKasirSupervisor.force.physical")}>
            {count && <Money amount={count.countedIdr} className="font-bold" />}
          </SideRow>
          <SideRow label={t("posKasirSupervisor.force.system")}>
            {count && (
              <Money amount={count.expectedIdr} className="font-bold" />
            )}
          </SideRow>
          <SideRow label={t(varianceKey)}>
            <Money amount={Math.abs(variance)} className="font-bold" />
          </SideRow>
        </>
      }
      mainTitle={t("posKasirSupervisor.force.receivedTitle")}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onBack}>
            {t("posKasirSupervisor.back")}
          </Button>
          <Button type="button" loading={close.isPending} onClick={askConfirm}>
            {close.isPending
              ? t("posKasirSupervisor.force.closing")
              : t("posKasirSupervisor.force.closeForce")}
          </Button>
        </>
      }
    >
      <FormField
        label={t("posKasirSupervisor.force.reasonLabel")}
        id={noteId}
        required
        error={noteError}
      >
        <Textarea
          value={note}
          placeholder={t("posKasirSupervisor.force.notePlaceholder")}
          onChange={(event) => {
            setNote(event.target.value);
            if (noteError) setNoteError(undefined);
          }}
          rows={3}
        />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <Fact label={t("posKasirSupervisor.force.counter")}>
          {count?.countedByName}
        </Fact>
        <Fact label={t("posKasirSupervisor.force.approver")}>
          {view.witnessName}
        </Fact>
      </div>
      {close.isError && (
        <ActionError
          title={t("posKasirSupervisor.force.closeFailed")}
          error={close.error}
          onRetry={closeNow}
        />
      )}
      <Notice tone="warning" title={t("posKasirSupervisor.force.lockTitle")}>
        {t("posKasirSupervisor.force.lockBody")}
      </Notice>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent role="alertdialog" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("posKasirSupervisor.force.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("posKasirSupervisor.force.confirmBody", {
                shiftNo: view.shiftNo,
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <SideRow label={t(varianceKey)}>
              <Money amount={Math.abs(variance)} className="font-bold" />
            </SideRow>
            <SideRow label={t("posKasirSupervisor.force.confirmReason")}>
              <span className="font-normal break-words">{note.trim()}</span>
            </SideRow>
          </div>
          <DialogFooter className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={() => setConfirming(false)}
            >
              {t("posKasirSupervisor.force.confirmCancel")}
            </Button>
            <Button type="button" size="lg" onClick={closeNow}>
              {t("posKasirSupervisor.force.closeForce")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}

function Loading() {
  const t = useT();
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t("posKasirSupervisor.force.loadingLabel")}
      className="grid gap-4"
    >
      <Skeleton className="h-9 w-64" />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-72 rounded-container" />
        <Skeleton className="h-72 rounded-container" />
      </div>
    </div>
  );
}

// Force close (legend-7mlf): the cashier used all recounts. The supervisor
// counts the drawer, a third supervisor approves that count by PIN, then the
// shift closes with it. The own cashier can do none of this.
export function ShiftForceClose({
  shiftId,
  onBack,
}: {
  shiftId: string;
  onBack: () => void;
}) {
  const t = useT();
  const query = useForceCloseView(shiftId);
  const [recount, setRecount] = useState(false);
  const view = query.data;

  if (query.isPending) return <Loading />;
  if (query.isError || !view)
    return (
      <div className="grid justify-items-center gap-2">
        <ErrorState
          error={query.error}
          title={t("posKasirSupervisor.force.errorTitle")}
          description={t("posKasirSupervisor.force.errorHint")}
          onRetry={() => void query.refetch()}
        />
        <Button type="button" variant="outline" onClick={onBack}>
          {t("posKasirSupervisor.back")}
        </Button>
      </div>
    );

  if (view.ownShift)
    return (
      <CenterMessage
        title={t("posKasirSupervisor.title")}
        subtitle={t("posKasirSupervisor.force.ownSubtitle", {
          shiftNo: view.shiftNo,
          cashier: view.cashierName,
        })}
        pill={t("posKasirSupervisor.force.ownPill")}
        pillTone="warning"
        heading={t("posKasirSupervisor.force.ownTitle")}
        body={t("posKasirSupervisor.force.ownBody")}
        actionLabel={t("posKasirSupervisor.force.ownAction")}
        onAction={onBack}
        primary={false}
      />
    );

  if (view.stage === "closed")
    return (
      <PosPanel
        title={t("posKasirSupervisor.force.doneTitle")}
        footer={
          <Button type="button" onClick={onBack}>
            {t("posKasirSupervisor.back")}
          </Button>
        }
      >
        <StateBlock
          mark="ok"
          role="status"
          title={t("posKasirSupervisor.force.doneTitle")}
          description={t("posKasirSupervisor.force.doneBody", {
            approver: view.witnessName ?? "",
          })}
        />
      </PosPanel>
    );

  if (view.stale && !recount)
    return (
      <CenterMessage
        title={t("posKasirSupervisor.force.staleHeading")}
        subtitle={t("posKasirSupervisor.force.staleSubtitle", {
          shiftNo: view.shiftNo,
          terminal: view.terminalLabel,
        })}
        pill={t("posKasirSupervisor.force.notClosed")}
        pillTone="danger"
        heading={t("posKasirSupervisor.force.staleTitle")}
        body={t("posKasirSupervisor.force.staleBody")}
        actionLabel={t("posKasirSupervisor.force.staleAction")}
        onAction={() => setRecount(true)}
        primary
      />
    );

  if (view.stage === "count" || recount)
    return (
      <CountStage
        view={view}
        onBack={onBack}
        onSent={() => setRecount(false)}
      />
    );
  if (view.stage === "witness")
    return <WitnessStage view={view} onBack={onBack} />;
  return <ReadyStage view={view} onBack={onBack} />;
}
