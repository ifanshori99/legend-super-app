import { useRef, useState, useSyncExternalStore } from "react";
import { cn } from "cn";
import { Check } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui/money";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { validateModifiers } from "@/features/ws04-pos-order/cart-logic";
import type {
  MenuItem,
  MenuVariant,
  ModifierGroup,
  SelectedModifier,
} from "@/features/ws04-pos-order/types";

// The variant choice is shown as a required single-choice group of its own.
const VARIANT_GROUP_ID = "__variant";

export interface ModifierSelection {
  variant: MenuVariant | null;
  modifiers: SelectedModifier[];
  note: string;
  quantity: number;
}

// Desktop is a centered dialog; up to 700 px the same form docks to the
// bottom as a sheet (thumb reach).
const COMPACT_QUERY = "(max-width: 700px)";

function subscribeCompact(onChange: () => void) {
  const query = window.matchMedia(COMPACT_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function useIsCompact(): boolean {
  return useSyncExternalStore(
    subscribeCompact,
    () => window.matchMedia(COMPACT_QUERY).matches,
    () => false,
  );
}

export function ModifierDialog({
  item,
  open,
  onOpenChange,
  onConfirm,
}: {
  item: MenuItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (selection: ModifierSelection) => void;
}) {
  const compact = useIsCompact();
  if (!item) return null;
  // The form mounts only while open, so each opening starts blank.
  const form = (
    <ModifierForm
      item={item}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
    />
  );
  return compact ? (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        hideClose
        data-density="kontras"
        className="gap-3"
      >
        {form}
      </SheetContent>
    </Sheet>
  ) : (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose
        data-density="kontras"
        className="gap-3 sm:max-w-[500px]"
      >
        {form}
      </DialogContent>
    </Dialog>
  );
}

function ModifierForm({
  item,
  onOpenChange,
  onConfirm,
}: {
  item: MenuItem;
  onOpenChange: (open: boolean) => void;
  onConfirm: (selection: ModifierSelection) => void;
}) {
  const t = useT();
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [note, setNote] = useState("");
  const [variantId, setVariantId] = useState<string | null>(null);
  // Required-group errors stay quiet until the first "Tambah ke keranjang" tap.
  const [attempted, setAttempted] = useState(false);
  const groupRefs = useRef<Record<string, HTMLFieldSetElement | null>>({});

  const modifiers: SelectedModifier[] = item.modifierGroups.flatMap((group) =>
    group.options
      .filter((option) => chosen[group.id]?.includes(option.id))
      .map((option) => ({
        groupId: group.id,
        optionId: option.id,
        name: option.name,
        priceDeltaIdr: option.priceDeltaIdr,
      })),
  );
  const variant = item.variants.find((entry) => entry.id === variantId) ?? null;
  const variantGroup: ModifierGroup | null =
    item.variants.length > 0
      ? {
          id: VARIANT_GROUP_ID,
          name: t("posOrderCatalog.modifier.variantGroup"),
          required: true,
          min: 1,
          max: 1,
          options: item.variants.map((entry) => ({
            id: entry.id,
            name: entry.name,
            priceDeltaIdr: 0,
          })),
        }
      : null;
  const variantMissing = variantGroup !== null && variant === null;
  const unitPriceIdr =
    (variant?.priceIdr ?? item.priceIdr) +
    modifiers.reduce((sum, m) => sum + m.priceDeltaIdr, 0);
  const check = validateModifiers(item, modifiers);
  const missing = [
    ...(variantMissing ? [VARIANT_GROUP_ID] : []),
    ...(check.ok ? [] : check.missingGroupIds),
  ];

  function choose(group: ModifierGroup, optionId: string) {
    setChosen((prev) => {
      const current = prev[group.id] ?? [];
      const selected = current.includes(optionId);
      if (group.max === 1) {
        // Radio: pick replaces; picking the chosen one again clears an optional group.
        const next = selected ? (group.required ? current : []) : [optionId];
        return { ...prev, [group.id]: next };
      }
      if (selected) {
        return { ...prev, [group.id]: current.filter((id) => id !== optionId) };
      }
      if (current.length >= group.max) return prev;
      return { ...prev, [group.id]: [...current, optionId] };
    });
  }

  function submit() {
    if (missing.length > 0) {
      setAttempted(true);
      const first = groupRefs.current[missing[0]!];
      first?.querySelector<HTMLInputElement>("input")?.focus();
      first?.scrollIntoView({ block: "nearest" });
      return;
    }
    onConfirm({ variant, modifiers, note: note.trim(), quantity: 1 });
    onOpenChange(false);
  }

  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <DialogTitle className="text-xl font-bold">{item.name}</DialogTitle>
        <Money amount={unitPriceIdr} className="pt-0.5 font-bold" />
      </div>
      <DialogDescription className="text-sm">
        {t("posOrderCatalog.modifier.description")}
      </DialogDescription>

      {variantGroup && (
        <ModifierGroupField
          group={variantGroup}
          selectedIds={variantId ? [variantId] : []}
          missing={attempted && variantMissing}
          priceOf={(optionId) =>
            item.variants.find((entry) => entry.id === optionId)?.priceIdr ??
            null
          }
          onChoose={(optionId) => setVariantId(optionId)}
          fieldsetRef={(el) => {
            groupRefs.current[VARIANT_GROUP_ID] = el;
          }}
        />
      )}

      {item.modifierGroups.map((group) => (
        <ModifierGroupField
          key={group.id}
          group={group}
          selectedIds={chosen[group.id] ?? []}
          missing={attempted && missing.includes(group.id)}
          onChoose={(optionId) => choose(group, optionId)}
          fieldsetRef={(el) => {
            groupRefs.current[group.id] = el;
          }}
        />
      ))}

      <div className="grid gap-1.5">
        <Label htmlFor="modifier-note" className="text-base">
          {t("posOrderCatalog.modifier.noteLabel")}
          <span className="font-normal text-muted-foreground">
            {t("posOrderCatalog.modifier.noteOptional")}
          </span>
        </Label>
        <Textarea
          id="modifier-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder={t("posOrderCatalog.modifier.notePlaceholder")}
          rows={2}
          className="min-h-16 resize-none"
        />
      </div>

      <div className="mt-1 flex gap-2">
        <Button
          type="button"
          variant="outline"
          className="flex-1 font-bold whitespace-normal"
          onClick={() => onOpenChange(false)}
        >
          {t("posOrderCatalog.modifier.cancel")}
        </Button>
        {/* Always styled as the primary action: a tap without a required choice
            shows the message and moves focus to that group. */}
        <Button
          type="button"
          className="flex-1 font-bold whitespace-normal"
          onClick={submit}
        >
          {t("posOrderCatalog.modifier.confirm")}
        </Button>
      </div>
    </>
  );
}

function groupHint(group: ModifierGroup, t: ReturnType<typeof useT>): string {
  if (group.required) {
    return group.max === 1
      ? t("posOrderCatalog.modifier.required")
      : t("posOrderCatalog.modifier.requiredMin", { min: group.min });
  }
  return group.max === 1
    ? t("posOrderCatalog.modifier.optional")
    : t("posOrderCatalog.modifier.optionalMax", { max: group.max });
}

function ModifierGroupField({
  group,
  selectedIds,
  missing,
  onChoose,
  fieldsetRef,
  priceOf,
}: {
  /** Shows each option's own price (variants) instead of a "+" delta. */
  priceOf?: (optionId: string) => number | null;
  group: ModifierGroup;
  selectedIds: string[];
  missing: boolean;
  onChoose: (optionId: string) => void;
  fieldsetRef: (el: HTMLFieldSetElement | null) => void;
}) {
  const t = useT();
  const single = group.max === 1;
  const full = !single && selectedIds.length >= group.max;
  const errorId = `modifier-error-${group.id}`;
  return (
    <fieldset
      ref={fieldsetRef}
      className="m-0 grid min-w-0 gap-2 border-0 p-0"
      aria-describedby={missing ? errorId : undefined}
    >
      <legend className="mb-1 p-0 text-base font-bold">
        {group.name} · {groupHint(group, t)}
      </legend>
      {group.options.map((option) => {
        const selected = selectedIds.includes(option.id);
        const blocked = full && !selected;
        return (
          <label
            key={option.id}
            className={cn(
              "flex min-h-control items-center justify-between gap-3 rounded-control border-(length:--border-w) bg-card px-3.5 py-2 text-(length:--density-text) has-focus-visible:shadow-focus",
              selected ? "border-primary bg-primary/5" : "border-border",
              blocked ? "opacity-60" : "cursor-pointer hover:bg-surface-2",
            )}
          >
            <input
              type={single ? "radio" : "checkbox"}
              name={group.id}
              className="sr-only"
              checked={selected}
              aria-disabled={blocked || undefined}
              onChange={() => {}}
              onClick={() => {
                if (!blocked) onChoose(option.id);
              }}
            />
            <span className="flex min-w-0 items-center gap-2.5">
              <span
                aria-hidden="true"
                className={cn(
                  "grid size-[22px] shrink-0 place-items-center border-2",
                  single ? "rounded-full" : "rounded-md",
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input",
                )}
              >
                {selected && <Check className="size-3.5" strokeWidth={3} />}
              </span>
              <span className="[overflow-wrap:anywhere]">{option.name}</span>
            </span>
            {priceOf && priceOf(option.id) !== null && (
              <span className="shrink-0 text-muted-foreground">
                <Money amount={priceOf(option.id) ?? 0} />
              </span>
            )}
            {!priceOf && option.priceDeltaIdr !== 0 && (
              <span className="shrink-0 text-muted-foreground">
                {option.priceDeltaIdr > 0 && "+"}
                <Money amount={option.priceDeltaIdr} />
              </span>
            )}
          </label>
        );
      })}
      {full && (
        <p className="text-sm text-muted-foreground">
          {t("posOrderCatalog.modifier.maxReached", { max: group.max })}
        </p>
      )}
      {missing && (
        <p
          id={errorId}
          role="alert"
          className="text-sm font-semibold text-danger"
        >
          {t("posOrderCatalog.modifier.missing", {
            group: group.name.toLocaleLowerCase("id-ID"),
          })}
        </p>
      )}
    </fieldset>
  );
}
