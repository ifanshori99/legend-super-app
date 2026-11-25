import { useEffect, useId, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Minus, Plus } from "lucide-react";
import { useT } from "@/components/i18n";
import { ApiError } from "@/lib/api/errors";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Notice } from "@/features/ws04-pos-kasir/components/shared";
import { lineTotalIdr } from "@/features/ws04-pos-order/cart-logic";
import { useDraftCart } from "@/features/ws04-pos-order/draft-store";
import {
  isContractPending,
  useAddToTable,
  useCaptainCartKey,
  useCaptainCartLocked,
  usePendingCaptainOrder,
  useTableOrder,
} from "@/features/ws04-pos-order/hooks";
import { captainMeta } from "@/features/ws04-pos-order/captain-wire";
import { needsCashierClose } from "@/features/ws04-pos-order/order-flow";
import { sameOrder } from "@/features/ws04-pos-order/order-wire";
import type { CartLine } from "@/features/ws04-pos-order/types";
import { CaptainShell } from "./captain-shell";
import {
  lineDetails,
  lockDraft,
  tableSessionText,
} from "./captain-order-parts";

const MAX_QUANTITY = 99;

// /pos/captain/meja/$tableId/tinjau — check the draft, choose per item whether
// it goes to the kitchen now or is held, then send. Held items stay on the
// table order until the captain sends them.
export function ReviewScreen({ tableId }: { tableId: string }) {
  const t = useT();
  const navigate = useNavigate();
  const tableOrder = useTableOrder(tableId);
  const cartKey = useCaptainCartKey(tableId);
  const draftKey = cartKey ?? "captain:none";
  const rawDraft = useDraftCart(draftKey);
  const locked = useCaptainCartLocked(cartKey);
  const draft = lockDraft(rawDraft, locked);
  const submit = useAddToTable({ draftKey });
  const pending = usePendingCaptainOrder(cartKey);
  const [editingId, setEditingId] = useState<string | null>(null);
  // The line the captain just removed, kept briefly so "Urungkan" can restore it.
  const [removed, setRemoved] = useState<{
    line: CartLine;
    index: number;
  } | null>(null);

  useEffect(() => {
    if (!removed) return;
    const timer = setTimeout(() => setRemoved(null), 8000);
    return () => clearTimeout(timer);
  }, [removed]);

  const undoRemove = () => {
    if (!removed) return;
    const next = [...draft.lines];
    next.splice(Math.min(removed.index, next.length), 0, removed.line);
    draft.replace(next);
    setRemoved(null);
  };

  const tableLabel = tableOrder.data?.table.label;
  const heldCount = draft.lines.filter((line) => line.hold).length;
  const sentCount = draft.lines.length - heldCount;
  const editing = draft.lines.find((line) => line.lineId === editingId) ?? null;
  const tableHref = `/pos/captain/meja/${encodeURIComponent(tableId)}`;
  const tableMissing =
    tableOrder.isError &&
    !tableOrder.data &&
    tableOrder.error instanceof ApiError &&
    tableOrder.error.status === 404;
  const tableFailed = tableOrder.isError && !tableOrder.data;
  const table = tableOrder.data?.table ?? null;
  const tableReady = table !== null;
  const seated = table !== null && table.sessionId !== null;
  const keyRefused = submit.isError && needsCashierClose(submit.error);
  const differs =
    table !== null &&
    pending.pending !== null &&
    !sameOrder(draft.lines, captainMeta(table), pending.pending);

  const send = () => {
    if (submit.isPending || !table || !seated) return;
    submit.mutate(
      {
        tableId,
        tableSessionId: table.sessionId,
        tableLabel: table.label,
        lines: draft.lines,
      },
      {
        onSettled: pending.refresh,
        onSuccess: () => {
          void navigate({
            to: "/pos/captain/meja/$tableId",
            params: { tableId },
          });
        },
      },
    );
  };

  return (
    <CaptainShell
      context={
        tableLabel
          ? t("posCaptainOrder.table.title", { table: tableLabel })
          : t("posCaptainOrder.table.loadingTitle")
      }
      contextSub={
        tableOrder.data ? tableSessionText(t, tableOrder.data.table) : undefined
      }
      title={t("posCaptainOrder.review.title")}
      subtitle={
        tableLabel
          ? t("posCaptainOrder.review.subtitle", { table: tableLabel })
          : undefined
      }
      backTo={`${tableHref}/tambah`}
      bottomBar={
        seated && draft.lines.length > 0 ? (
          <div className="grid gap-1 text-center">
            <Button
              size="lg"
              className="w-full"
              loading={submit.isPending}
              onClick={send}
            >
              {submit.isPending
                ? t("posCaptainOrder.review.submitting")
                : sentCount > 0
                  ? t("posCaptainOrder.review.submit")
                  : t("posCaptainOrder.review.submitHeldOnly")}
            </Button>
            <p className="text-sm text-muted-foreground">
              {t("posCaptainOrder.review.summary", {
                sent: sentCount,
                held: heldCount,
              })}
            </p>
          </div>
        ) : undefined
      }
    >
      <div data-slot="captain-review" className="grid content-start gap-4">
        {removed && (
          <Notice
            tone="info"
            role="status"
            title={t("posCaptainOrder.review.lineRemoved")}
          >
            <Button type="button" variant="outline" onClick={undoRemove}>
              {t("posCaptainOrder.review.undo")}
            </Button>
          </Notice>
        )}

        {locked && (
          <Notice tone="info" title={t("posCaptainOrder.locked.title")}>
            {t("posCaptainOrder.locked.body")}
          </Notice>
        )}

        {pending.pending && !submit.isPending && !keyRefused && (
          <Notice tone="warning" title={t("posCaptainOrder.pending.title")}>
            <div className="grid gap-2">
              <p>{t("posCaptainOrder.pending.body")}</p>
              <div className="flex flex-wrap gap-2">
                {differs ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => rawDraft.replace(pending.pending!.lines)}
                  >
                    {t("posCaptainOrder.pending.restore")}
                  </Button>
                ) : (
                  <Button type="button" variant="outline" onClick={send}>
                    {t("posCaptainOrder.pending.resend")}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    pending.close();
                    submit.reset();
                  }}
                >
                  {t("posCaptainOrder.pending.close")}
                </Button>
              </div>
            </div>
          </Notice>
        )}

        {keyRefused && (
          <Notice tone="danger" title={t("posCaptainOrder.refused.title")}>
            <div className="grid gap-2">
              <p>{t("posCaptainOrder.refused.body")}</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  pending.close();
                  submit.reset();
                }}
              >
                {t("posCaptainOrder.pending.close")}
              </Button>
            </div>
          </Notice>
        )}

        {submit.isError && !keyRefused && (
          <Notice
            tone="danger"
            title={t("posCaptainOrder.review.submitFailed")}
          >
            {isContractPending(submit.error)
              ? t("posCaptainOrder.contractPending")
              : submit.error instanceof ApiError &&
                t("posCaptainOrder.review.submitFailedReason", {
                  message: submit.error.message,
                })}
          </Notice>
        )}

        {tableMissing ? (
          <EmptyState
            title={t("posCaptainOrder.order.notFoundTitle")}
            description={t("posCaptainOrder.order.notFoundHint")}
            action={
              <Button asChild>
                <Link to="/pos/captain">
                  {t("posCaptainOrder.order.backToTables")}
                </Link>
              </Button>
            }
          />
        ) : tableFailed ? (
          <ErrorState
            title={t("posCaptainOrder.order.loadFailedTitle")}
            description={
              isContractPending(tableOrder.error)
                ? t("posCaptainOrder.contractPending")
                : t("posCaptainOrder.order.loadFailedHint")
            }
            error={tableOrder.error}
            onRetry={() => void tableOrder.refetch()}
          />
        ) : !tableReady ? (
          <div
            role="status"
            aria-busy="true"
            aria-label={t("posCaptainOrder.order.loading")}
            className="grid gap-3"
          >
            <Skeleton className="h-24 rounded-container" />
            <Skeleton className="h-24 rounded-container" />
            <Skeleton className="h-16 rounded-control" />
          </div>
        ) : !seated ? (
          <EmptyState
            title={t("posCaptainOrder.noSession.title")}
            description={t("posCaptainOrder.noSession.hint")}
            action={
              <Button asChild>
                <Link to="/pos/captain/meja/$tableId" params={{ tableId }}>
                  {t("posCaptainOrder.noSession.action")}
                </Link>
              </Button>
            }
          />
        ) : draft.lines.length === 0 ? (
          <EmptyState
            title={t("posCaptainOrder.review.emptyTitle")}
            description={t("posCaptainOrder.review.emptyHint")}
            action={
              <Button asChild>
                <Link
                  to="/pos/captain/meja/$tableId/tambah"
                  params={{ tableId }}
                >
                  {t("posCaptainOrder.review.emptyAction")}
                </Link>
              </Button>
            }
          />
        ) : (
          <>
            <ul className="grid gap-3">
              {draft.lines.map((line) => (
                <li key={line.lineId}>
                  <ReviewLine
                    line={line}
                    locked={locked}
                    onEdit={() => setEditingId(line.lineId)}
                    onToggleHold={() => draft.toggleHold(line.lineId)}
                  />
                </li>
              ))}
            </ul>
            <Button asChild variant="outline" size="lg" className="w-full">
              <Link to="/pos/captain/meja/$tableId/tambah" params={{ tableId }}>
                <Plus aria-hidden="true" />
                {t("posCaptainOrder.review.addMore")}
              </Link>
            </Button>
            <p className="text-base text-muted-foreground">
              {t("posCaptainOrder.review.footnoteHint")}
            </p>
          </>
        )}
      </div>

      {editing && (
        <EditLineDialog
          key={editing.lineId}
          line={editing}
          onClose={() => setEditingId(null)}
          onSave={(quantity, note) => {
            draft.replace(
              draft.lines.map((line) =>
                line.lineId === editing.lineId
                  ? { ...line, quantity, note }
                  : line,
              ),
            );
            setEditingId(null);
          }}
          onRemove={() => {
            const index = draft.lines.findIndex(
              (line) => line.lineId === editing.lineId,
            );
            setRemoved({ line: editing, index });
            draft.remove(editing.lineId);
            setEditingId(null);
          }}
        />
      )}
    </CaptainShell>
  );
}

function ReviewLine({
  line,
  locked,
  onEdit,
  onToggleHold,
}: {
  line: CartLine;
  locked: boolean;
  onEdit: () => void;
  onToggleHold: () => void;
}) {
  const t = useT();
  const switchId = useId();
  const details = lineDetails(line);
  return (
    <div className="rounded-container border-(length:--border-w) border-border bg-card p-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-(length:--density-text) leading-6 font-bold">
            {t("posCaptainOrder.review.lineTitle", {
              qty: line.quantity,
              name: line.name,
            })}
          </h2>
          <p className="text-base text-muted-foreground">
            <Money amount={lineTotalIdr(line)} size="sm" />
            {details.length > 0 && <> · {details.join(" · ")}</>}
          </p>
        </div>
        <Button
          variant="ghost"
          aria-label={t("posCaptainOrder.review.editNamed", {
            name: line.name,
          })}
          onClick={onEdit}
          disabled={locked}
          className="-mt-2 -mr-2 shrink-0 underline underline-offset-4"
        >
          {t("posCaptainOrder.review.edit")}
        </Button>
      </div>
      <Label
        htmlFor={switchId}
        className="mt-3 flex min-h-control cursor-pointer items-center justify-between gap-3 border-t-(length:--border-w) border-border pt-3"
      >
        <span className="grid min-w-0 gap-0.5">
          <span className="text-(length:--density-text) leading-6 font-bold">
            {line.hold
              ? t("posCaptainOrder.review.held", { course: line.course.label })
              : t("posCaptainOrder.review.sendNow")}
          </span>
          <span className="text-base font-normal text-muted-foreground">
            {line.hold
              ? t("posCaptainOrder.review.heldHint")
              : t("posCaptainOrder.review.sendNowHint")}
          </span>
        </span>
        <Switch
          id={switchId}
          checked={line.hold}
          disabled={locked}
          onCheckedChange={onToggleHold}
        />
      </Label>
    </div>
  );
}

// Quantity and note of one draft line. Choices (modifiers) are not editable
// here: ModifierDialog has no preset, so the captain removes and re-adds.
function EditLineDialog({
  line,
  onClose,
  onSave,
  onRemove,
}: {
  line: CartLine;
  onClose: () => void;
  onSave: (quantity: number, note: string) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const noteId = useId();
  const [quantity, setQuantity] = useState(line.quantity);
  const [note, setNote] = useState(line.note);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-density="kontras">
        <DialogHeader>
          <DialogTitle>
            {t("posCaptainOrder.review.editDialog.title")}
          </DialogTitle>
          <DialogDescription>
            {t("posCaptainOrder.review.editDialog.description")}
          </DialogDescription>
        </DialogHeader>
        <p className="text-(length:--density-text) font-semibold">
          {line.name}
        </p>
        <div className="flex items-center justify-between gap-3">
          <span className="text-(length:--density-text) font-semibold">
            {t("posCaptainOrder.review.editDialog.quantity")}
          </span>
          <div className="flex items-center gap-3 font-semibold">
            <Button
              variant="outline"
              size="icon"
              aria-label={t("posCaptainOrder.add.decrease", {
                name: line.name,
              })}
              onClick={() => setQuantity((value) => Math.max(1, value - 1))}
            >
              <Minus aria-hidden="true" />
            </Button>
            <span
              className="min-w-6 text-center tabular-nums"
              aria-live="polite"
            >
              {quantity}
            </span>
            <Button
              variant="outline"
              size="icon"
              aria-label={t("posCaptainOrder.add.increase", {
                name: line.name,
              })}
              onClick={() =>
                setQuantity((value) => Math.min(MAX_QUANTITY, value + 1))
              }
            >
              <Plus aria-hidden="true" />
            </Button>
          </div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={noteId}>
            {t("posCaptainOrder.review.editDialog.note")}
          </Label>
          <Textarea
            id={noteId}
            value={note}
            maxLength={200}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t("posCaptainOrder.review.editDialog.notePlaceholder")}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onRemove}>
            {t("posCaptainOrder.review.editDialog.remove")}
          </Button>
          <Button onClick={() => onSave(quantity, note.trim())}>
            {t("posCaptainOrder.review.editDialog.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
