// Item detail ("Pilihan menu", legend-2re1, design/mockups/final-a-detail-*):
// a full-screen sheet on the ivory canvas on phones, a centered dialog from lg
// up. Floating glass nav on top (close + title) over the hero photo, option
// groups on solid paper, sticky glass footer with quantity and the rust CTA.
// The CTA is never silently disabled: pressing it with an incomplete choice
// explains what is missing in the group and moves focus there. Prices shown
// are a preview; the server prices the cart line (ORD-03).
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlert, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { QrMenuItem } from "@starter/shared/qr-order";
import { formatRupiah } from "@starter/shared/i18n";
import { cn } from "cn";
import { ApiError } from "@/lib/api/errors";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MediaPlate } from "@/components/ui/media-plate";
import { Money } from "@/components/ui/money";
import { useToast } from "@/components/ui/toast";
import { useTableJourney } from "../context";
import { useAddToCart } from "../hooks";
import {
  MAX_NOTE_LENGTH,
  emptySelection,
  formatAvailableFrom,
  groupRule,
  previewLineTotal,
  selectedInGroup,
  toggleModifier,
  validateSelection,
  type Selection,
  type SelectionIssue,
} from "../lib/item-options.ts";
import { ChoiceGroup } from "./choice-group";
import { CompanionOffer, useCompanion } from "./glass/companion-offer";
import { QrFooter, QrStepper, qrRoundIcon } from "./glass/qr-primitives";
import { labelText } from "./item-card";
import { Notice } from "./notice";

type TFn = ReturnType<typeof useT>;

function issueText(t: TFn, item: QrMenuItem, issue: SelectionIssue): string {
  const groupName = (id: string) =>
    item.modifierGroups.find((group) => group.id === id)?.name ?? "";
  switch (issue.code) {
    case "variant_required":
      return t("qrGlass.item.error.variantBefore");
    case "modifier_min":
      if (issue.min === 1)
        return t("qrGlass.item.error.chooseBefore", {
          group: groupName(issue.groupId).toLowerCase(),
        });
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
  const nameId = useId();
  const toast = useToast();
  const journey = useTableJourney();
  const {
    menu,
    sessionId,
    view,
    viewError,
    ended,
    openJoin,
    guest,
    startOver,
    stashSelection,
    peekSelection,
    clearSelection,
  } = journey;
  // Choices an unjoined guest made before the guest count; used once.
  const [selection, setSelection] = useState<Selection>(
    () => peekSelection(item.id) ?? emptySelection(),
  );
  useEffect(() => clearSelection(), [clearSelection]);
  const [attempted, setAttempted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const groupRefs = useRef(new Map<string, HTMLElement>());
  const navigate = useNavigate();
  const companion = useCompanion(item.id);
  const add = useAddToCart(sessionId ?? "none");

  const soldOut = item.status !== "available";
  const availableTime =
    item.status === "unavailable_until" && item.availableFrom
      ? formatAvailableFrom(
          item.availableFrom,
          menu?.outlet.timeZone ?? "Asia/Jakarta",
        )
      : null;
  const availableLabel = availableTime
    ? t("qrGlass.menu.card.availableFrom", { time: availableTime })
    : null;
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
      // Focus the first group that needs a choice (or the note field).
      const first = issues[0];
      const key =
        first.code === "variant_required"
          ? "variant"
          : "groupId" in first
            ? first.groupId
            : "note";
      requestAnimationFrame(() => groupRefs.current.get(key)?.focus());
      return;
    }
    if (!guest || !sessionId) {
      // The join control lives in the menu header, under this sheet: close
      // the sheet and let the menu reopen it once the guest has joined.
      stashSelection(item.id, selection);
      onClose();
      openJoin(item.id);
      return;
    }
    // The CTA is busy while the session view loads, so this is only a guard.
    if (cartVersion === undefined) {
      setServerError(t("qrMenu.sheet.error.generic"));
      return;
    }
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

  const issueFor = (groupId: string) =>
    shown.find((issue) => "groupId" in issue && issue.groupId === groupId);
  const variantIssue = shown.find((issue) => issue.code === "variant_required");
  const noteIssue = shown.find((issue) => issue.code === "note_too_long");
  const openCompanion = (itemId: string) =>
    void navigate({
      to: ".",
      search: (previous: Record<string, unknown>) => ({
        ...previous,
        item: itemId,
      }),
      replace: true,
    });

  // Just joined: the session view is still loading, so there is no cart
  // version to add against yet. Show the CTA busy instead of a silent no-op.
  const viewLoading = Boolean(
    guest && sessionId && !view && !viewError && !ended,
  );
  const ctaDisabledReason = soldOut
    ? (availableLabel ?? t("qrMenu.sheet.soldOutAction"))
    : !orderingOpen
      ? t("qrMenu.sheet.orderingClosed")
      : null;

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        // The dialog announces the dish; "Pilihan menu" stays as the nav title.
        aria-labelledby={nameId}
        className={cn(
          "fixed inset-0 z-50 flex flex-col bg-background text-foreground outline-none",
          "lg:inset-auto lg:top-1/2 lg:left-1/2 lg:max-h-[calc(100dvh-2rem)] lg:w-[min(40rem,calc(100%-2rem))] lg:-translate-x-1/2 lg:-translate-y-1/2 lg:overflow-hidden lg:rounded-qr-float lg:border lg:border-border lg:shadow-overlay",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-4 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 lg:data-[state=open]:slide-in-from-bottom-0 lg:data-[state=open]:zoom-in-95",
        )}
      >
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-(--pad) pb-(--pad) [--pad:1rem] lg:[--pad:1.5rem]">
          {/* Glass nav floats over the hero photo (negative margin pulls the
              photo up under it); sticky, so it stays while the list scrolls. */}
          <div className="qr-glass sticky top-[max(0.75rem,env(safe-area-inset-top))] z-30 mx-2 mt-3 -mb-17 grid min-h-14 grid-cols-[2.75rem_1fr_2.75rem] items-center gap-2 rounded-qr-nav px-1.5 py-1.5">
            <DialogClose
              className={cn(qrRoundIcon, "bg-transparent shadow-none")}
            >
              <X aria-hidden="true" />
              <span className="sr-only">{t("common.close")}</span>
            </DialogClose>
            <DialogTitle
              asChild
              className="min-w-0 truncate text-center type-heading"
            >
              <p>{t("qrGlass.item.title")}</p>
            </DialogTitle>
            <span aria-hidden="true" />
          </div>
          <DialogDescription className="sr-only">
            {t("qrMenu.sheet.description")}
          </DialogDescription>

          <div className="overflow-hidden rounded-qr-media">
            <MediaPlate
              ratio="hero"
              src={item.photoUrl}
              alt=""
              muted={soldOut}
              className="rounded-none"
            />
          </div>

          <div className="mt-4 grid gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id={nameId} className="min-w-0 type-display">
                {item.name}
              </h2>
              <Money amount={item.priceIdr} size="lg" className="shrink-0" />
            </div>
            {item.description && (
              <p className="text-base leading-6 text-muted-foreground">
                {item.description}
              </p>
            )}
            {item.labels.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {item.labels.map((label) => (
                  <Badge key={label} tone="brand">
                    {labelText(t, label)}
                  </Badge>
                ))}
              </div>
            )}
            {item.allergens.length > 0 && (
              <p className="text-sm leading-5">
                {t("qrMenu.sheet.allergens", {
                  list: item.allergens.join(", "),
                })}
              </p>
            )}
          </div>

          {soldOut && (
            <Notice
              tone="warning"
              title={availableLabel ?? t("qrGlass.item.soldOut.title")}
              className="mt-4"
            >
              {availableLabel
                ? t("qrGlass.item.soldOut.hintUntil")
                : t("qrGlass.item.soldOut.hint")}
            </Notice>
          )}

          {!soldOut && (
            <div className="mt-4 grid gap-3">
              {item.variants.length > 0 && (
                <OptionFieldset
                  id="variant"
                  register={groupRefs}
                  title={t("qrMenu.sheet.variantTitle")}
                  rule={`${t("qrMenu.sheet.required")} · ${t("qrMenu.sheet.chooseOne")}`}
                  error={variantIssue ? issueText(t, item, variantIssue) : null}
                >
                  <ChoiceGroup
                    name={t("qrMenu.sheet.variantTitle")}
                    multiple={false}
                    invalid={Boolean(variantIssue)}
                    describedBy="variant-error"
                    selected={selection.variantId ? [selection.variantId] : []}
                    onToggle={(id) =>
                      setSelection((current) => ({
                        ...current,
                        variantId: id,
                      }))
                    }
                    options={item.variants.map((variant) => ({
                      id: variant.id,
                      name: variant.name,
                      priceIdr: variant.priceIdr,
                      priceMode: "absolute" as const,
                    }))}
                  />
                </OptionFieldset>
              )}

              {item.modifierGroups.map((group) => {
                const issue = issueFor(group.id);
                return (
                  <OptionFieldset
                    key={group.id}
                    id={group.id}
                    register={groupRefs}
                    title={group.name}
                    rule={ruleText(t, groupRule(group))}
                    error={issue ? issueText(t, item, issue) : null}
                  >
                    <ChoiceGroup
                      name={group.name}
                      multiple={group.maxSelect > 1}
                      invalid={Boolean(issue)}
                      describedBy={`group-${group.id}-error`}
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
                  </OptionFieldset>
                );
              })}

              {companion && orderingOpen && !ended && (
                <CompanionOffer item={companion} onOpenItem={openCompanion} />
              )}

              <div className="grid gap-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <Label
                    htmlFor={`note-${item.id}`}
                    className="text-base font-semibold"
                  >
                    {t("qrGlass.item.note.label")}
                  </Label>
                  <span className="text-sm text-muted-foreground">
                    {t("qrMenu.sheet.optional")}
                  </span>
                </div>
                <Input
                  id={`note-${item.id}`}
                  ref={(el) => {
                    if (el) groupRefs.current.set("note", el);
                  }}
                  maxLength={MAX_NOTE_LENGTH + 40}
                  value={selection.note}
                  placeholder={t("qrGlass.item.note.placeholder")}
                  aria-invalid={noteIssue ? true : undefined}
                  aria-describedby={`note-${item.id}-hint`}
                  onChange={(event) =>
                    setSelection((current) => ({
                      ...current,
                      note: event.target.value,
                    }))
                  }
                />
                <p
                  id={`note-${item.id}-hint`}
                  aria-live="polite"
                  className={cn(
                    "text-sm",
                    noteIssue
                      ? "flex items-center gap-1.5 font-medium text-danger"
                      : "sr-only",
                  )}
                >
                  {noteIssue ? (
                    <>
                      <CircleAlert
                        className="size-4 shrink-0"
                        aria-hidden="true"
                      />
                      {issueText(t, item, noteIssue)}
                    </>
                  ) : (
                    t("qrMenu.sheet.noteHint", { max: MAX_NOTE_LENGTH })
                  )}
                </p>
              </div>
            </div>
          )}

          <p className="mt-4 text-center text-sm text-muted-foreground">
            {t("qrMenu.sheet.priceExcludes")}
          </p>

          <QrFooter className="mt-3">
            {serverError && <Notice tone="danger" title={serverError} />}
            {ended ? (
              <Button
                type="button"
                className="w-full"
                onClick={() => {
                  onClose();
                  startOver();
                }}
              >
                {t("qrMenu.session.startOver")}
              </Button>
            ) : ctaDisabledReason ? (
              <Button type="button" className="w-full" disabled>
                {ctaDisabledReason}
              </Button>
            ) : (
              <div className="flex items-center gap-3">
                <QrStepper
                  tone="outline"
                  value={selection.quantity}
                  min={1}
                  max={99}
                  busy={add.isPending}
                  onChange={(quantity) =>
                    setSelection((current) => ({ ...current, quantity }))
                  }
                  decreaseLabel={t("qrMenu.sheet.decrease")}
                  increaseLabel={t("qrMenu.sheet.increase")}
                  valueLabel={`${t("qrMenu.sheet.quantity")} ${selection.quantity}`}
                />
                <Button
                  type="button"
                  className="min-w-0 flex-1"
                  loading={add.isPending || viewLoading}
                  onClick={submit}
                >
                  {viewLoading
                    ? t("common.loading")
                    : t("qrGlass.item.submit", { amount: formatRupiah(total) })}
                </Button>
              </div>
            )}
          </QrFooter>
        </div>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

/**
 * One option group: title and rule on one line. After a failed add the group
 * turns into the error block (soft red fill, 3px left rule, alert icon and
 * text) and receives focus; the live region stays mounted so it is announced.
 */
function OptionFieldset({
  id,
  register,
  title,
  rule,
  error,
  children,
}: {
  id: string;
  register: { current: Map<string, HTMLElement> };
  title: string;
  rule: string;
  error: string | null;
  children: ReactNode;
}) {
  const errorId = id === "variant" ? "variant-error" : `group-${id}-error`;
  return (
    <fieldset
      ref={(el) => {
        if (el) register.current.set(id, el);
      }}
      tabIndex={-1}
      aria-describedby={errorId}
      className={cn(
        "-mx-(--pad) grid scroll-mt-24 scroll-mb-40 gap-2 border-l-[3px] px-[calc(var(--pad)-3px)] py-2 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        error ? "border-danger bg-danger-subtle" : "border-transparent",
      )}
    >
      <legend className="flex w-full items-baseline justify-between gap-2">
        <span className="text-base font-semibold">{title}</span>
        <span className="text-sm text-muted-foreground">{rule}</span>
      </legend>
      {children}
      <p
        id={errorId}
        aria-live="polite"
        className={cn(
          "flex items-center gap-2 text-sm font-medium text-danger",
          !error && "hidden",
        )}
      >
        {error && (
          <>
            <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
            {error}
          </>
        )}
      </p>
    </fieldset>
  );
}
