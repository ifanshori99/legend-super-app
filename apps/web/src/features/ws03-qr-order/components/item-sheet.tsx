// Item detail as a bottom sheet (dialog on wider screens): full-bleed hero
// photo, then variant, modifier groups with min/max rules, note and quantity
// (PRD §3 F10, ORD-01; DESIGN.md v2 §4 "Media"). The CTA is never silently
// disabled: pressing it with an incomplete choice explains what is missing next
// to the group. Prices shown are a preview; the server prices the cart line
// (ORD-03).
import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { QrMenuItem } from "@starter/shared/qr-order";
import { ApiError } from "@/lib/api/errors";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { MediaPlate } from "@/components/ui/media-plate";
import { Money } from "@/components/ui/money";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useTableJourney } from "../context";
import { useAddToCart } from "../hooks";
import {
  MAX_NOTE_LENGTH,
  emptySelection,
  groupRule,
  previewLineTotal,
  selectedInGroup,
  toggleModifier,
  validateSelection,
  type Selection,
  type SelectionIssue,
} from "../lib/item-options.ts";
import { ChoiceGroup } from "./choice-group";
import { labelText } from "./item-card";
import { Notice } from "./notice";
import { Stepper } from "./stepper";

type TFn = ReturnType<typeof useT>;

function issueText(t: TFn, item: QrMenuItem, issue: SelectionIssue): string {
  const groupName = (id: string) =>
    item.modifierGroups.find((group) => group.id === id)?.name ?? "";
  switch (issue.code) {
    case "variant_required":
      return t("qrMenu.sheet.error.variantRequired");
    case "modifier_min":
      return t("qrMenu.sheet.error.modifierMin", {
        min: issue.min,
        group: groupName(issue.groupId),
      });
    case "modifier_max":
      return t("qrMenu.sheet.error.modifierMax", {
        max: issue.max,
        group: groupName(issue.groupId),
      });
    case "modifier_sold_out": {
      const name =
        item.modifierGroups
          .flatMap((group) => group.modifiers)
          .find((modifier) => modifier.id === issue.modifierId)?.name ?? "";
      return t("qrMenu.sheet.error.modifierSoldOut", { name });
    }
    case "note_too_long":
      return t("qrMenu.sheet.error.noteTooLong", { max: MAX_NOTE_LENGTH });
    case "item_sold_out":
      return t("qrMenu.sheet.error.itemSoldOut", { name: item.name });
    case "quantity_invalid":
      return t("qrMenu.sheet.error.generic");
  }
}

function ruleText(
  t: TFn,
  rule: { required: boolean; min: number; max: number },
): string {
  const range =
    rule.min === rule.max
      ? rule.max === 1
        ? t("qrMenu.sheet.chooseOne")
        : t("qrMenu.sheet.chooseRange", { min: rule.min, max: rule.max })
      : rule.min === 0
        ? t("qrMenu.sheet.chooseUpTo", { max: rule.max })
        : t("qrMenu.sheet.chooseRange", { min: rule.min, max: rule.max });
  return `${rule.required ? t("qrMenu.sheet.required") : t("qrMenu.sheet.optional")} · ${range}`;
}

export function ItemSheet({
  item,
  onClose,
}: {
  item: QrMenuItem | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      {item && <SheetBody key={item.id} item={item} onClose={onClose} />}
    </Dialog>
  );
}

function SheetBody({
  item,
  onClose,
}: {
  item: QrMenuItem;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const journey = useTableJourney();
  const { menu, sessionId, view, ended, openJoin, guest } = journey;
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [attempted, setAttempted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const submitWhenJoined = useRef(false);
  const firstErrorRef = useRef<HTMLFieldSetElement | null>(null);
  const add = useAddToCart(sessionId ?? "none");

  const soldOut = item.status === "sold_out";
  const orderingOpen = menu?.orderingOpen ?? true;
  const issues = useMemo(
    () => validateSelection(item, selection),
    [item, selection],
  );
  const shown = attempted ? issues : [];
  const total = previewLineTotal(item, selection);
  const cartVersion = view?.cart.version;

  const submit = () => {
    setAttempted(true);
    setServerError(null);
    if (issues.length > 0) {
      requestAnimationFrame(() =>
        firstErrorRef.current?.scrollIntoView({
          block: "center",
          behavior: "smooth",
        }),
      );
      return;
    }
    if (!guest || !sessionId) {
      submitWhenJoined.current = true;
      openJoin();
      return;
    }
    if (cartVersion === undefined) return;
    add.mutate(
      {
        cartVersion,
        line: {
          menuItemId: item.id,
          variantId: selection.variantId,
          quantity: selection.quantity,
          modifierIds: selection.modifierIds,
          note: selection.note.trim() || undefined,
        },
      },
      {
        onSuccess: () => {
          toast({
            title: t("qrMenu.toast.added", { name: item.name }),
            description: t("qrMenu.toast.addedHint"),
            tone: "success",
          });
          onClose();
        },
        onError: (error) => {
          if (error instanceof ApiError && error.code === "ITEM_SOLD_OUT")
            setServerError(
              t("qrMenu.sheet.error.itemSoldOut", { name: item.name }),
            );
          else if (error instanceof ApiError && error.code === "CONFLICT")
            setServerError(t("qrMenu.sheet.error.conflict"));
          else if (error instanceof ApiError && error.code === "SESSION_CLOSED")
            setServerError(t("qrMenu.sheet.error.closed"));
          else setServerError(t("qrMenu.sheet.error.generic"));
        },
      },
    );
  };

  // The guest tapped "Tambah" before joining: finish the add once they have.
  useEffect(() => {
    if (submitWhenJoined.current && guest && cartVersion !== undefined) {
      submitWhenJoined.current = false;
      submit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guest, cartVersion]);

  const issueFor = (groupId: string) =>
    shown.find((issue) => "groupId" in issue && issue.groupId === groupId);
  const variantIssue = shown.find((issue) => issue.code === "variant_required");
  const firstGroupIssue = shown.find((issue) => "groupId" in issue);
  const firstErrorId = variantIssue
    ? "variant"
    : firstGroupIssue && "groupId" in firstGroupIssue
      ? firstGroupIssue.groupId
      : null;

  const ctaDisabledReason = soldOut
    ? t("qrMenu.sheet.soldOutAction")
    : !orderingOpen
      ? t("qrMenu.sheet.orderingClosed")
      : ended
        ? t("qrMenu.session.startOver")
        : null;

  return (
    <DialogContent className="gap-0 p-0 sm:pb-0" hideClose>
      {/* Full-bleed hero: cancel the dialog's card padding on three sides
          (DESIGN.md v2 §4 "Media"); auto width plus equal negative margins
          keeps the plate exactly as wide as the sheet. */}
      <MediaPlate
        ratio="hero"
        src={item.photoUrl}
        alt=""
        muted={soldOut}
        className="-mx-card -mt-card shrink-0 rounded-none"
        topEnd={
          <DialogClose className="grid size-10 place-items-center rounded-full bg-card text-foreground shadow-card">
            <X className="size-5" aria-hidden="true" />
            <span className="sr-only">{t("common.close")}</span>
          </DialogClose>
        }
      />
      <div className="grid gap-3 px-card pt-card">
        <DialogHeader>
          <DialogTitle className="type-title">{item.name}</DialogTitle>
          <DialogDescription className="sr-only">
            {t("qrMenu.sheet.description")}
          </DialogDescription>
        </DialogHeader>
        {item.labels.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {item.labels.map((label) => (
              <Badge key={label} tone="brand">
                {labelText(t, label)}
              </Badge>
            ))}
          </div>
        )}
        {item.description && (
          <p className="text-(length:--density-text) leading-6 text-muted-foreground">
            {item.description}
          </p>
        )}
        <Money amount={item.priceIdr} size="stat" />
        {item.allergens.length > 0 && (
          <p className="text-sm leading-5">
            {t("qrMenu.sheet.allergens", { list: item.allergens.join(", ") })}
          </p>
        )}
        {soldOut && (
          <Notice tone="warning" title={t("qrMenu.sheet.soldOutNotice")} />
        )}
      </div>

      {!soldOut && (
        <div className="grid gap-5 px-card pt-5">
          {item.variants.length > 0 && (
            <fieldset
              className="grid gap-2"
              ref={firstErrorId === "variant" ? firstErrorRef : undefined}
            >
              <legend className="mb-2 flex w-full items-baseline justify-between gap-2">
                <span className="font-semibold">
                  {t("qrMenu.sheet.variantTitle")}
                </span>
                <span className="text-sm text-muted-foreground">
                  {t("qrMenu.sheet.required")} · {t("qrMenu.sheet.chooseOne")}
                </span>
              </legend>
              <ChoiceGroup
                name={t("qrMenu.sheet.variantTitle")}
                multiple={false}
                invalid={Boolean(variantIssue)}
                describedBy="variant-error"
                selected={selection.variantId ? [selection.variantId] : []}
                onToggle={(id) =>
                  setSelection((current) => ({ ...current, variantId: id }))
                }
                options={item.variants.map((variant) => ({
                  id: variant.id,
                  name: variant.name,
                  priceIdr: variant.priceIdr,
                  priceMode: "absolute" as const,
                }))}
              />
              <p
                id="variant-error"
                aria-live="polite"
                className="text-sm font-medium text-danger"
              >
                {variantIssue ? issueText(t, item, variantIssue) : null}
              </p>
            </fieldset>
          )}

          {item.modifierGroups.map((group) => {
            const rule = groupRule(group);
            const issue = issueFor(group.id);
            const errorId = `group-${group.id}-error`;
            return (
              <fieldset
                key={group.id}
                className="grid gap-2"
                ref={firstErrorId === group.id ? firstErrorRef : undefined}
              >
                <legend className="mb-2 flex w-full items-baseline justify-between gap-2">
                  <span className="font-semibold">{group.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {ruleText(t, rule)}
                  </span>
                </legend>
                <ChoiceGroup
                  name={group.name}
                  multiple={group.maxSelect > 1}
                  invalid={Boolean(issue)}
                  describedBy={errorId}
                  selected={selectedInGroup(group, selection)}
                  onToggle={(id) =>
                    setSelection((current) =>
                      toggleModifier(item, current, group.id, id),
                    )
                  }
                  options={group.modifiers.map((modifier) => ({
                    id: modifier.id,
                    name: modifier.name,
                    priceIdr: modifier.priceIdr,
                    soldOut: modifier.soldOut,
                  }))}
                />
                <p
                  id={errorId}
                  aria-live="polite"
                  className="text-sm font-medium text-danger"
                >
                  {issue ? issueText(t, item, issue) : null}
                </p>
              </fieldset>
            );
          })}

          <div className="grid gap-1.5">
            <Label htmlFor={`note-${item.id}`}>
              {t("qrMenu.sheet.noteLabel")}{" "}
              <span className="font-normal text-muted-foreground">
                ({t("common.optional")})
              </span>
            </Label>
            <Textarea
              id={`note-${item.id}`}
              rows={2}
              maxLength={MAX_NOTE_LENGTH + 40}
              value={selection.note}
              placeholder={t("qrMenu.sheet.notePlaceholder")}
              onChange={(event) =>
                setSelection((current) => ({
                  ...current,
                  note: event.target.value,
                }))
              }
            />
            <p className="text-sm text-muted-foreground">
              {t("qrMenu.sheet.noteHint", { max: MAX_NOTE_LENGTH })}
            </p>
          </div>
        </div>
      )}

      <div className="sticky bottom-0 grid gap-2 border-t bg-card px-card pt-3 pb-[max(var(--card-pad),env(safe-area-inset-bottom))]">
        {serverError && <Notice tone="danger" title={serverError} />}
        {ctaDisabledReason ? (
          <Button type="button" size="lg" disabled>
            {ctaDisabledReason}
          </Button>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <Stepper
                value={selection.quantity}
                min={1}
                max={99}
                onChange={(quantity) =>
                  setSelection((current) => ({ ...current, quantity }))
                }
                decreaseLabel={t("qrMenu.sheet.decrease")}
                increaseLabel={t("qrMenu.sheet.increase")}
                valueLabel={`${t("qrMenu.sheet.quantity")} ${selection.quantity}`}
              />
              <Money amount={total} size="lg" />
            </div>
            <Button
              type="button"
              size="lg"
              className="w-full"
              loading={add.isPending}
              onClick={submit}
            >
              {t("qrMenu.sheet.submit")}
            </Button>
          </>
        )}
        <p className="text-center text-sm text-muted-foreground">
          {t("qrMenu.sheet.priceExcludes")}
        </p>
      </div>
    </DialogContent>
  );
}
