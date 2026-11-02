// Step 3: product, add-ons and how the guest gets access (PRD §3 F22 "Produk &
// Hak Akses", "Add-on Opsional", F23; alur S langkah 3, alur T).
//
// Redemption (FAC-04, FAC-07) is offered only when the subscription quota is
// usable: the reason line under the choice comes from the contract's quota
// machine, so an unpaid bill past its grace period says why instead of failing
// at the door.
import { Check } from "lucide-react";
import { RadioGroup } from "radix-ui";
import type {
  FacilityAddon,
  FacilityProduct,
  FacilitySubscriptionView,
} from "@starter/shared/facility";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Money } from "@/components/ui/money";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { cn } from "cn";
import {
  canRedeem,
  draftPayableIdr,
  redeemableSessions,
  selectedAddons,
  toggleAddon,
  type BookingDraft,
} from "../flow";
import { Section } from "./shared";

export function ExtrasStep({
  products,
  addons,
  subscription,
  draft,
  onDraftChange,
  onContinue,
}: {
  products: readonly FacilityProduct[];
  addons: readonly FacilityAddon[];
  subscription: FacilitySubscriptionView | null;
  draft: BookingDraft;
  onDraftChange: (draft: BookingDraft) => void;
  onContinue: () => void;
}) {
  const t = useT();
  const redeemable = canRedeem(subscription);
  const remaining = redeemableSessions(subscription);
  const total = draftPayableIdr(draft, products, addons);
  const chosenAddons = selectedAddons(draft, addons);

  return (
    <div className="grid gap-5">
      <h2 className="font-brand type-title">{t("facility.extras.title")}</h2>

      <Section title={t("facility.extras.productLabel")}>
        <RadioGroup.Root
          value={draft.productId ?? ""}
          onValueChange={(productId) => onDraftChange({ ...draft, productId })}
          aria-label={t("facility.extras.productLabel")}
          className="grid divide-y divide-border overflow-hidden rounded-container border-(length:--border-w) bg-card shadow-hairline"
        >
          {products.map((product) => (
            <RadioGroup.Item
              key={product.id}
              value={product.id}
              className={cn(
                "group flex items-start gap-3 p-4 text-left transition-colors duration-(--duration-fast) focus-visible:outline-offset-[-2px]",
                "hover:bg-surface-2 data-[state=checked]:bg-surface-2",
              )}
            >
              <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border-(length:--border-w) border-input bg-card transition-colors duration-(--duration-fast) group-data-[state=checked]:border-foreground group-data-[state=checked]:bg-foreground">
                <RadioGroup.Indicator>
                  <Check
                    className="size-3 text-background"
                    aria-hidden="true"
                  />
                </RadioGroup.Indicator>
              </span>
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="font-semibold">{product.name}</span>
                <span className="text-sm leading-5 text-muted-foreground">
                  {t("facility.extras.productSessions", {
                    count: product.sessions,
                  })}
                </span>
                {product.type === "package_component" && (
                  <span className="text-sm leading-5 text-muted-foreground">
                    {t("facility.extras.breakfastNote")}
                  </span>
                )}
              </span>
              <Money
                amount={product.priceIdr}
                size="md"
                className="shrink-0 font-semibold"
              />
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
      </Section>

      <Section title={t("facility.extras.addonsLabel")}>
        {addons.length === 0 ? (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("facility.extras.noAddons")}
          </p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-container border-(length:--border-w) bg-card shadow-hairline">
            {addons.map((addon) => {
              const checked = draft.addonIds.includes(addon.id);
              return (
                <li key={addon.id}>
                  <label
                    htmlFor={`addon-${addon.id}`}
                    className="flex min-h-control cursor-pointer items-center gap-3 px-4 py-3 transition-colors duration-(--duration-fast) hover:bg-surface-2"
                  >
                    <Checkbox
                      id={`addon-${addon.id}`}
                      checked={checked}
                      onCheckedChange={() =>
                        onDraftChange({
                          ...draft,
                          addonIds: toggleAddon(draft.addonIds, addon.id),
                        })
                      }
                    />
                    <span className="min-w-0 flex-1 text-sm leading-5 font-medium">
                      {addon.name}
                    </span>
                    <Money amount={addon.priceIdr} size="sm" />
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-sm leading-5 text-muted-foreground">
          {t("facility.extras.addonsHint")}
        </p>
      </Section>

      <Section title={t("facility.extras.sourceLabel")}>
        <Card className="gap-3">
          {redeemable ? (
            <SegmentedControl
              label={t("facility.extras.sourceLabel")}
              value={draft.source}
              onValueChange={(value) =>
                onDraftChange({
                  ...draft,
                  source:
                    value === "subscription" ? "subscription" : "purchase",
                })
              }
              options={[
                { value: "purchase", label: t("facility.extras.payNow") },
                { value: "subscription", label: t("facility.extras.useQuota") },
              ]}
            />
          ) : (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("facility.extras.redeemUnavailable")}{" "}
              {subscription?.quota.reason === "quota_exhausted"
                ? t("facility.subscription.reason.quota_exhausted")
                : t("facility.list.noSubscriptionHint")}
            </p>
          )}
          {redeemable && draft.source === "subscription" ? (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("facility.extras.redeemHint", {
                remaining,
                perPeriod: subscription?.quota.perPeriod ?? 0,
              })}
            </p>
          ) : (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("facility.extras.payHint")}
            </p>
          )}
        </Card>
      </Section>

      <Card className="gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <p className="type-eyebrow text-muted-foreground">
            {draft.source === "subscription"
              ? t("facility.extras.payable")
              : t("facility.extras.subtotal")}
          </p>
          <Money amount={total} size="stat" />
        </div>
        {chosenAddons.length > 0 && draft.source === "subscription" && (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("facility.review.addons")}:{" "}
            {chosenAddons.map((addon) => addon.name).join(", ")}
          </p>
        )}
        <p className="text-sm leading-5 text-muted-foreground">
          {t("facility.extras.taxNote")}
        </p>
      </Card>

      <Button
        size="lg"
        onClick={onContinue}
        disabled={!draft.productId || products.length === 0}
      >
        {draft.source === "subscription" && total === 0
          ? t("facility.extras.issueWithQuota")
          : t("facility.extras.pay")}
      </Button>
    </div>
  );
}
