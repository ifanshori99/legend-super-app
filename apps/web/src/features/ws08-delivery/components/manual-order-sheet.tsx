// D12 "Mode Manual" (PRD v1.7 §3.23 "Mode Manual"): until a platform approves
// the integration the cashier records the same order through the POS. The form
// sends channel, platform order id and the picked menu items; the server
// resolves every price from the platform price list, so the client never
// submits money.
import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { DELIVERY_PLATFORMS } from "@starter/shared/delivery";
import type { DeliveryPlatform } from "@starter/shared/delivery";
import { useChannelPrices, useCreateManualOrder, useMenuItems } from "../hooks";
import {
  deliveryErrorKey,
  manualLinesTotal,
  platformKey,
  type ManualOrderLineInput,
} from "../lib";

type DraftLine = {
  /** Stable React key; the menu item may still be empty. */
  key: number;
  menuItemId: string;
  quantity: number;
};

function newLine(key: number): DraftLine {
  return { key, menuItemId: "", quantity: 1 };
}

export function ManualOrderSheet({
  open,
  onOpenChange,
  outletId,
  online,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  outletId: string;
  online: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const create = useCreateManualOrder();
  const menu = useMenuItems(open);
  const [platform, setPlatform] = React.useState<DeliveryPlatform>("gofood");
  const [externalOrderId, setExternalOrderId] = React.useState("");
  const [customerNote, setCustomerNote] = React.useState("");
  const [lines, setLines] = React.useState<DraftLine[]>([newLine(1)]);
  const [showErrors, setShowErrors] = React.useState(false);
  const nextKey = React.useRef(2);
  // Radix Select renders no DOM at its root, so the FormField id must sit on
  // the trigger (same pattern as the shareholder dialog).
  const platformFieldId = React.useId();

  const prices = useChannelPrices(outletId, platform, open);
  const menuItems = menu.data?.data ?? [];
  const platformName = t(platformKey(platform));
  const externalMissing = externalOrderId.trim() === "";
  const externalError =
    showErrors && externalMissing
      ? t("deliveryOps.manual.errorExternalOrderId")
      : undefined;
  const total = manualLinesTotal(
    lines.map<ManualOrderLineInput>((line) => ({
      menuItemId: line.menuItemId === "" ? null : line.menuItemId,
      quantity: line.quantity,
      priceIdr: prices.prices.get(line.menuItemId) ?? null,
    })),
  );
  const mutationError = create.error ? t(deliveryErrorKey(create.error)) : null;

  const reset = () => {
    setPlatform("gofood");
    setExternalOrderId("");
    setCustomerNote("");
    setLines([newLine(1)]);
    nextKey.current = 2;
    setShowErrors(false);
  };

  const updateLine = (key: number, next: Partial<DraftLine>) => {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...next } : line)),
    );
  };

  /** Closing clears the last failed attempt; the draft stays for the retry. */
  const close = (next: boolean) => {
    if (!next) {
      create.reset();
      setShowErrors(false);
    }
    onOpenChange(next);
  };

  const submit = () => {
    setShowErrors(true);
    const valid = lines.every(
      (line) => line.menuItemId !== "" && line.quantity >= 1,
    );
    if (externalMissing || !valid) return;
    create.mutate(
      {
        outletId,
        body: {
          platform,
          externalOrderId: externalOrderId.trim(),
          lines: lines.map((line) => ({
            menuItemId: line.menuItemId,
            quantity: line.quantity,
          })),
          ...(customerNote.trim() === ""
            ? {}
            : { customerNote: customerNote.trim() }),
        },
      },
      {
        onSuccess: () => {
          toast({ title: t("deliveryOps.manual.success"), tone: "success" });
          onOpenChange(false);
          reset();
        },
      },
    );
  };

  return (
    <Sheet open={open} onOpenChange={close}>
      <SheetContent side="right" className="w-[min(34rem,calc(100%-1.5rem))]">
        <SheetHeader>
          <SheetTitle>{t("deliveryOps.manual.title")}</SheetTitle>
          <SheetDescription>
            {t("deliveryOps.manual.description")}
          </SheetDescription>
        </SheetHeader>

        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              id={platformFieldId}
              label={t("deliveryOps.manual.platform")}
              required
            >
              <Select
                value={platform}
                onValueChange={(value) =>
                  setPlatform(value as DeliveryPlatform)
                }
              >
                <SelectTrigger id={platformFieldId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DELIVERY_PLATFORMS.map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {t(platformKey(entry))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField
              label={t("deliveryOps.manual.externalOrderId")}
              hint={t("deliveryOps.manual.externalOrderIdHint")}
              error={externalError}
              required
            >
              <Input
                value={externalOrderId}
                onChange={(event) => setExternalOrderId(event.target.value)}
                autoComplete="off"
                className="font-mono"
              />
            </FormField>
          </div>

          <section className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="type-eyebrow text-muted-foreground">
                {t("deliveryOps.manual.lines")}
              </h3>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  setLines((current) => [
                    ...current,
                    newLine(nextKey.current++),
                  ])
                }
              >
                <Plus aria-hidden="true" />
                {t("deliveryOps.manual.addLine")}
              </Button>
            </div>

            {menu.isPending && <Skeleton className="h-24 w-full" />}
            {menu.isError && (
              <div
                role="alert"
                className="grid gap-2 rounded-container border-(length:--border-w) bg-danger-subtle p-3 text-sm text-danger"
              >
                <p className="font-medium">
                  {t("deliveryOps.errors.fallback")}
                </p>
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void menu.refetch()}
                  >
                    {t("common.retry")}
                  </Button>
                </div>
              </div>
            )}

            {!menu.isPending && !menu.isError && (
              <ul className="grid gap-2">
                {lines.map((line, index) => {
                  const price = prices.prices.get(line.menuItemId);
                  const itemMissing = line.menuItemId === "";
                  const itemFieldId = `delivery-manual-line-${line.key}-item`;
                  return (
                    <li
                      key={line.key}
                      className="grid gap-2 rounded-container border-(length:--border-w) bg-card p-3"
                    >
                      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_5.5rem]">
                        <FormField
                          id={itemFieldId}
                          label={t("deliveryOps.manual.item")}
                          error={
                            showErrors && itemMissing
                              ? t("deliveryOps.manual.errorItem")
                              : undefined
                          }
                          required
                        >
                          <Select
                            value={line.menuItemId}
                            onValueChange={(value) =>
                              updateLine(line.key, { menuItemId: value })
                            }
                          >
                            <SelectTrigger
                              id={itemFieldId}
                              aria-invalid={
                                showErrors && itemMissing ? true : undefined
                              }
                            >
                              <SelectValue
                                placeholder={t(
                                  "deliveryOps.manual.itemPlaceholder",
                                )}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              {menuItems.map((item) => (
                                <SelectItem key={item.id} value={item.id}>
                                  {item.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormField>
                        <FormField
                          label={t("deliveryOps.manual.quantity")}
                          error={
                            showErrors && line.quantity < 1
                              ? t("deliveryOps.manual.errorQuantity")
                              : undefined
                          }
                          required
                        >
                          <Input
                            type="number"
                            min={1}
                            max={99}
                            inputMode="numeric"
                            value={line.quantity}
                            onChange={(event) =>
                              updateLine(line.key, {
                                quantity: Number(event.target.value),
                              })
                            }
                          />
                        </FormField>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 text-sm">
                          <span className="type-eyebrow text-muted-foreground">
                            {t("deliveryOps.manual.price")}
                          </span>
                          {price === undefined ? (
                            <span className="text-muted-foreground">
                              {t("deliveryOps.manual.priceUnknown")}
                            </span>
                          ) : (
                            <Money amount={price} size="sm" />
                          )}
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={lines.length === 1}
                          aria-label={t("deliveryOps.manual.removeLine")}
                          onClick={() =>
                            setLines((current) =>
                              current.filter((row) => row.key !== line.key),
                            )
                          }
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </div>
                      {index === 0 && (
                        <p className="text-xs leading-4 text-muted-foreground">
                          {prices.hasPriceList
                            ? t("deliveryOps.manual.priceHint", {
                                platform: platformName,
                              })
                            : t("deliveryOps.manual.priceMissing", {
                                platform: platformName,
                              })}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <FormField label={t("deliveryOps.manual.customerNote")}>
            <Textarea
              value={customerNote}
              onChange={(event) => setCustomerNote(event.target.value)}
              rows={2}
            />
          </FormField>

          <div className="flex items-center justify-between gap-3 rounded-container bg-surface-2 p-card">
            <span className="type-eyebrow text-muted-foreground">
              {t("deliveryOps.manual.total")}
            </span>
            {total.complete ? (
              <Money amount={total.totalIdr} size="lg" />
            ) : (
              <span className="text-right text-sm text-muted-foreground">
                {t("deliveryOps.manual.totalPartial")}
              </span>
            )}
          </div>

          {mutationError && (
            <div role="alert" className="grid gap-0.5 text-sm text-danger">
              <p className="font-semibold">
                {t("deliveryOps.manual.errorTitle")}
              </p>
              <p>{mutationError}</p>
            </div>
          )}
        </div>

        <SheetFooter>
          <Button type="button" variant="ghost" onClick={() => close(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            loading={create.isPending}
            disabled={!online}
            onClick={submit}
          >
            {t("deliveryOps.manual.submit")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
