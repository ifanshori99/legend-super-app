// Split the bill: equal, per person or per item (PRD §3 F10 "Split Bill").
// The preview uses the same largest-remainder helper as the server, so the
// amounts shown are the amounts that will be created (ORD-06).
import { useMemo, useState } from "react";
import { Minus, Plus } from "lucide-react";
import type {
  CreateSplitsInput,
  SessionBill,
  SessionParticipant,
  SessionParticipantId,
} from "@starter/shared/qr-order";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui/money";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  previewEqualSplit,
  previewItemSplit,
  splitDraftError,
  splitScope,
  type SplitMode,
} from "../../domain.ts";
import { useCreateSplits } from "../../hooks";
import { idempotencyKey } from "../../lib/ids";

const MAX_PARTS = 50;
type ItemAssignments = Extract<
  CreateSplitsInput,
  { method: "by_item" }
>["assignments"];

export function SplitPanel({
  sessionId,
  bill,
  participants,
  myParticipantId,
  onDone,
}: {
  sessionId: string;
  bill: SessionBill;
  participants: readonly SessionParticipant[];
  myParticipantId: string | null;
  onDone: () => void;
}) {
  const t = useT();
  const create = useCreateSplits(sessionId);
  const [mode, setMode] = useState<SplitMode>("equal");
  const [parts, setParts] = useState(
    Math.max(2, Math.min(participants.length, 8)),
  );
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set(participants.map((p) => p.id)),
  );
  const [owners, setOwners] = useState<Readonly<Record<string, string>>>({});
  const [key, setKey] = useState(() => idempotencyKey("split"));

  // The server splits a pay-first order waiting for payment on its own, else
  // the whole bill; the preview must divide exactly the same amount (ORD-06).
  const scope = useMemo(
    () => splitScope(bill.orders, bill.totals.paidIdr),
    [bill.orders, bill.totals.paidIdr],
  );
  const orderItems = useMemo(
    () => (scope?.orders ?? bill.orders).flatMap((order) => order.items),
    [scope, bill.orders],
  );
  const itemIds = orderItems.map((item) => item.id);
  const total = scope?.totalIdr ?? bill.totals.totalIdr;

  const guestLabel = (participantId: string) => {
    const n = participants.findIndex((p) => p.id === participantId) + 1;
    return participantId === myParticipantId
      ? t("qrOrders.bill.guestYou", { n })
      : t("qrOrders.bill.guest", { n });
  };

  // by-item assignments: items grouped by the guest who pays them.
  const assignments = useMemo(() => {
    const byGuest = new Map<string, string[]>();
    for (const item of orderItems) {
      const owner = owners[item.id];
      if (owner) byGuest.set(owner, [...(byGuest.get(owner) ?? []), item.id]);
    }
    return [...byGuest.entries()].map(([participantId, orderItemIds]) => ({
      participantId,
      orderItemIds,
    }));
  }, [orderItems, owners]);

  const chosenIds = participants
    .filter((p) => chosen.has(p.id))
    .map((p) => p.id);
  const error = splitDraftError({
    mode,
    parts,
    participantCount: chosenIds.length,
    itemIds,
    assignments,
  });
  const itemsLeft = itemIds.filter((id) => !owners[id]).length;

  const preview: { label: string; amountIdr: number }[] | null = (() => {
    if (error !== null) return null;
    if (mode === "equal")
      return previewEqualSplit(total, parts).map((amountIdr, i) => ({
        label: t("qrOrders.bill.part", { n: i + 1 }),
        amountIdr,
      }));
    if (mode === "by_person")
      return previewEqualSplit(total, chosenIds.length).map((amountIdr, i) => ({
        label: guestLabel(chosenIds[i]),
        amountIdr,
      }));
    const amounts = previewItemSplit(
      total,
      orderItems.map((item) => ({
        orderItemId: item.id,
        lineTotalIdr: item.lineTotalIdr,
      })),
      assignments,
    );
    return amounts.map((amountIdr, i) => ({
      label: guestLabel(assignments[i].participantId),
      amountIdr,
    }));
  })();

  function buildInput(): CreateSplitsInput {
    if (mode === "equal")
      return { method: "equal", parts, idempotencyKey: key };
    if (mode === "by_person")
      return {
        method: "by_person",
        participantIds: chosenIds as SessionParticipantId[],
        idempotencyKey: key,
      };
    return {
      method: "by_item",
      assignments: assignments as ItemAssignments,
      idempotencyKey: key,
    };
  }

  function submit() {
    if (error !== null) return;
    create.mutate(buildInput(), {
      onSuccess: () => {
        setKey(idempotencyKey("split"));
        onDone();
      },
    });
  }

  const errorText =
    error === "TOO_FEW_PARTS"
      ? t("qrOrders.bill.errorTooFew")
      : error === "TOO_MANY_PARTS"
        ? t("qrOrders.bill.errorTooMany")
        : error === "ITEMS_UNASSIGNED"
          ? t("qrOrders.bill.errorUnassigned")
          : error === "ITEM_TWICE"
            ? t("qrOrders.bill.errorTwice")
            : null;

  return (
    <section aria-labelledby="bill-split" className="grid gap-4">
      <div className="grid gap-1">
        <h2 id="bill-split" className="text-lg leading-7 font-semibold">
          {t("qrOrders.bill.splitTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("qrOrders.bill.splitHint")}
        </p>
      </div>

      <SegmentedControl<SplitMode>
        label={t("qrOrders.bill.modeLabel")}
        value={mode}
        onValueChange={setMode}
        options={[
          { value: "equal", label: t("qrOrders.bill.modeEqual") },
          { value: "by_person", label: t("qrOrders.bill.modePerson") },
          { value: "by_item", label: t("qrOrders.bill.modeItem") },
        ]}
      />

      {mode === "equal" && (
        <div className="flex items-center gap-4">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t("qrOrders.bill.equalDecrease")}
            disabled={parts <= 2}
            onClick={() => setParts((n) => Math.max(2, n - 1))}
          >
            <Minus aria-hidden="true" />
          </Button>
          <output
            aria-live="polite"
            className="min-w-24 text-center text-xl font-semibold tabular"
          >
            {t("qrOrders.bill.equalValue", { count: parts })}
          </output>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t("qrOrders.bill.equalIncrease")}
            disabled={parts >= MAX_PARTS}
            onClick={() => setParts((n) => Math.min(MAX_PARTS, n + 1))}
          >
            <Plus aria-hidden="true" />
          </Button>
        </div>
      )}

      {mode === "by_person" && (
        <fieldset className="grid gap-2">
          <legend className="font-semibold">
            {t("qrOrders.bill.personTitle")}
          </legend>
          <p className="text-sm text-muted-foreground">
            {t("qrOrders.bill.personHint")}
          </p>
          {participants.map((participant) => (
            <div
              key={participant.id}
              className="flex min-h-12 items-center gap-3 rounded-xl border-(length:--border-w) px-3"
            >
              <Checkbox
                id={`split-person-${participant.id}`}
                checked={chosen.has(participant.id)}
                onCheckedChange={(checked) =>
                  setChosen((current) => {
                    const next = new Set(current);
                    if (checked === true) next.add(participant.id);
                    else next.delete(participant.id);
                    return next;
                  })
                }
              />
              <Label
                htmlFor={`split-person-${participant.id}`}
                className="min-h-12 flex-1 items-center"
              >
                {guestLabel(participant.id)}
              </Label>
            </div>
          ))}
        </fieldset>
      )}

      {mode === "by_item" && (
        <div className="grid gap-2">
          <p className="font-semibold">{t("qrOrders.bill.itemTitle")}</p>
          <p className="text-sm text-muted-foreground">
            {t("qrOrders.bill.itemHint")}
          </p>
          <ul className="divide-y rounded-xl border-(length:--border-w)">
            {orderItems.map((item) => (
              <li key={item.id} className="grid gap-2 p-card">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 font-medium">
                    {item.name}
                    <span className="text-muted-foreground">
                      {" "}
                      × {item.quantity}
                    </span>
                  </span>
                  <Money amount={item.lineTotalIdr} />
                </div>
                <Select
                  value={owners[item.id] ?? ""}
                  onValueChange={(value) =>
                    setOwners((current) => ({ ...current, [item.id]: value }))
                  }
                >
                  <SelectTrigger
                    aria-label={`${t("qrOrders.bill.itemOwner")}: ${item.name}`}
                  >
                    <SelectValue placeholder={t("qrOrders.bill.itemPick")} />
                  </SelectTrigger>
                  <SelectContent>
                    {participants.map((participant) => (
                      <SelectItem key={participant.id} value={participant.id}>
                        {guestLabel(participant.id)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </li>
            ))}
          </ul>
          {itemsLeft > 0 && (
            <p className="text-sm font-medium text-warning">
              {t("qrOrders.bill.itemsLeft", { count: itemsLeft })}
            </p>
          )}
        </div>
      )}

      <div className="grid gap-2" aria-live="polite">
        <p className="font-semibold">{t("qrOrders.bill.previewTitle")}</p>
        {preview ? (
          <>
            <ul className="divide-y rounded-xl border-(length:--border-w) px-card">
              {preview.map((row, index) => (
                <li
                  key={`${row.label}-${index}`}
                  className="flex items-baseline justify-between gap-4 py-2"
                >
                  <span>{row.label}</span>
                  <Money amount={row.amountIdr} />
                </li>
              ))}
            </ul>
            <p className="text-sm text-muted-foreground">
              {t("qrOrders.bill.previewSum", { amount: formatRupiah(total) })}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {errorText ?? t("qrOrders.bill.previewPending")}
          </p>
        )}
      </div>

      {create.isError && (
        <p role="alert" className="text-sm font-medium text-danger">
          {t("qrOrders.bill.createFailed")}
        </p>
      )}
      <Button
        type="button"
        variant="secondary"
        disabled={error !== null}
        loading={create.isPending}
        onClick={submit}
      >
        {create.isPending
          ? t("qrOrders.bill.creatingSplit")
          : t("qrOrders.bill.createSplit")}
      </Button>
    </section>
  );
}
