// "Hak akses" tab: the rules that issue sessions automatically (PRD v1.7 §3
// F25 "Produk & Hak Akses": minimum belanja, benefit tier, menu paket). The
// contract only offers PUT for one existing rule — there is no create or
// delete endpoint — so the screen edits and toggles the configured rules and
// says so instead of inventing a create flow.
import * as React from "react";
import type { EntitlementRule, FacilityConfig } from "@starter/shared/facility";
import { putEntitlementRuleSchema } from "@starter/shared/facility";
import { formatRupiah, type Translate } from "@starter/shared/i18n";
import type { MenuItemAdmin } from "@starter/shared/menu";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import type { PutEntitlementRuleBody } from "../api.ts";
import { usePutRule } from "../hooks.ts";
import {
  menuItemLabel,
  parseInteger,
  ruleTypeLabel,
  shortId,
  validityKindKeys,
  validityLabel,
  zodFieldErrors,
  type ValidityKind,
} from "../lib.ts";
import { ConfigSection } from "./config-section";
import { FormError } from "./form-error";

type RuleDialogState = EntitlementRule | null;

function ruleInput(
  rule: EntitlementRule,
  isEnabled: boolean,
): PutEntitlementRuleBody {
  const base = {
    facilityId: rule.facilityId,
    sessions: rule.sessions,
    validity: rule.validity,
    isEnabled,
  };
  switch (rule.type) {
    case "min_spend":
      return {
        ...base,
        type: "min_spend",
        condition: { minSpendIdr: rule.condition.minSpendIdr },
      };
    case "tier_benefit":
      return {
        ...base,
        type: "tier_benefit",
        condition: { tierKeys: [...rule.condition.tierKeys] },
      };
    case "package":
      return {
        ...base,
        type: "package",
        condition: { menuItemId: rule.condition.menuItemId },
      };
  }
}

function conditionSummary(
  rule: EntitlementRule,
  menuItems: readonly MenuItemAdmin[],
  t: Translate,
): string {
  switch (rule.type) {
    case "min_spend":
      return t("facilityAdmin.entitlements.conditionMinSpend", {
        amount: formatRupiah(rule.condition.minSpendIdr),
      });
    case "tier_benefit":
      return t("facilityAdmin.entitlements.conditionTier", {
        tiers: rule.condition.tierKeys.join(", "),
      });
    case "package":
      return t("facilityAdmin.entitlements.conditionPackage", {
        item: menuItemLabel(menuItems, rule.condition.menuItemId, t),
      });
  }
}

function validitySummary(rule: EntitlementRule, t: Translate): string {
  switch (rule.validity.kind) {
    case "operating_day":
      return t("facilityAdmin.entitlements.validity.operating_day");
    case "duration_hours":
      return t("facilityAdmin.entitlements.validity.duration_hours", {
        hours: rule.validity.hours,
      });
    case "billing_period":
      return t("facilityAdmin.entitlements.validity.billing_period");
  }
}

export function EntitlementsTab({
  facilityId,
  config,
  menuItems,
}: {
  facilityId: string;
  config: FacilityConfig;
  menuItems: readonly MenuItemAdmin[];
}) {
  const t = useT();
  const toast = useToast();
  const putRule = usePutRule(facilityId);
  const [dialog, setDialog] = React.useState<RuleDialogState>(null);

  const rules = [...config.entitlementRules]
    .filter((rule) => rule.facilityId === facilityId)
    .sort((a, b) => a.type.localeCompare(b.type));

  function toggle(rule: EntitlementRule, isEnabled: boolean) {
    putRule.mutate(
      { ruleId: rule.id, body: ruleInput(rule, isEnabled) },
      {
        onSuccess: () =>
          toast({
            title: t("facilityAdmin.entitlements.updated"),
            tone: "success",
          }),
        onError: (error) =>
          toast({
            title: t("facilityAdmin.entitlements.updateFailed"),
            description: error instanceof ApiError ? error.message : undefined,
            tone: "danger",
          }),
      },
    );
  }

  return (
    <div className="grid gap-5">
      <ConfigSection
        slot="facility-entitlements"
        title={t("facilityAdmin.entitlements.title")}
        description={t("facilityAdmin.entitlements.description")}
      >
        {rules.length === 0 ? (
          <EmptyState
            title={t("facilityAdmin.entitlements.empty")}
            description={t("facilityAdmin.entitlements.emptyHint")}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("facilityAdmin.entitlements.columnsType")}
                </TableHead>
                <TableHead>
                  {t("facilityAdmin.entitlements.columnsCondition")}
                </TableHead>
                <TableHead numeric>
                  {t("facilityAdmin.entitlements.columnsSessions")}
                </TableHead>
                <TableHead>
                  {t("facilityAdmin.entitlements.columnsValidity")}
                </TableHead>
                <TableHead>{t("facilityAdmin.common.status")}</TableHead>
                <TableHead className="text-right">
                  {t("facilityAdmin.common.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule) => {
                const typeName = t(ruleTypeLabel[rule.type]);
                const enabledLabel = t(
                  rule.isEnabled
                    ? "facilityAdmin.entitlements.disable"
                    : "facilityAdmin.entitlements.enable",
                  { type: typeName },
                );
                return (
                  <TableRow
                    key={rule.id}
                    data-slot="entitlement-rule"
                    data-rule-id={rule.id}
                  >
                    <TableCell>
                      <Badge tone="neutral">{typeName}</Badge>
                    </TableCell>
                    <TableCell>
                      {conditionSummary(rule, menuItems, t)}
                    </TableCell>
                    <TableCell numeric>{rule.sessions}</TableCell>
                    <TableCell>{validitySummary(rule, t)}</TableCell>
                    <TableCell>
                      <Switch
                        checked={rule.isEnabled}
                        disabled={putRule.isPending}
                        aria-label={enabledLabel}
                        onCheckedChange={(checked) => toggle(rule, checked)}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={t("facilityAdmin.entitlements.edit", {
                            type: typeName,
                          })}
                          onClick={() => setDialog(rule)}
                        >
                          {t("facilityAdmin.common.edit")}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </ConfigSection>

      {dialog && (
        <RuleDialog
          key={dialog.id}
          open
          onOpenChange={(open) => !open && setDialog(null)}
          facilityId={facilityId}
          rule={dialog}
          menuItems={menuItems}
        />
      )}
    </div>
  );
}

function RuleDialog({
  open,
  onOpenChange,
  facilityId,
  rule,
  menuItems,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  facilityId: string;
  rule: EntitlementRule;
  menuItems: readonly MenuItemAdmin[];
}) {
  const t = useT();
  const toast = useToast();
  const putRule = usePutRule(facilityId);
  const [sessions, setSessions] = React.useState(String(rule.sessions));
  const [validityKind, setValidityKind] = React.useState<ValidityKind>(
    rule.validity.kind,
  );
  const [hours, setHours] = React.useState(
    rule.validity.kind === "duration_hours"
      ? String(rule.validity.hours)
      : "24",
  );
  const [minSpend, setMinSpend] = React.useState(
    rule.type === "min_spend" ? String(rule.condition.minSpendIdr) : "",
  );
  const [tierKeys, setTierKeys] = React.useState(
    rule.type === "tier_benefit" ? rule.condition.tierKeys.join(", ") : "",
  );
  const [menuItemId, setMenuItemId] = React.useState(
    rule.type === "package" ? rule.condition.menuItemId : "none",
  );
  const [enabled, setEnabled] = React.useState(rule.isEnabled);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string>();

  const combos = menuItems.filter((item) => item.type === "combo");
  const menuChoices: { id: string; name: string }[] = combos.map((item) => ({
    id: item.id,
    name: item.name,
  }));
  if (
    menuItemId !== "none" &&
    !menuChoices.some((item) => item.id === menuItemId)
  )
    menuChoices.push({
      id: menuItemId,
      name: t("facilityAdmin.products.menuFallback", {
        id: shortId(menuItemId),
      }),
    });

  const typeName = t(ruleTypeLabel[rule.type]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    const sessionCount = parseInteger(sessions);
    if (sessionCount === null || sessionCount < 1 || sessionCount > 100)
      next.sessions = t("facilityAdmin.products.errorsSessionsInvalid");
    let durationHours: number | null = null;
    if (validityKind === "duration_hours") {
      durationHours = parseInteger(hours);
      if (durationHours === null || durationHours < 1 || durationHours > 8760)
        next.hours = t("facilityAdmin.entitlements.errorsHoursInvalid");
    }
    const minSpendIdr =
      rule.type === "min_spend" ? parseInteger(minSpend) : null;
    if (rule.type === "min_spend" && (minSpendIdr === null || minSpendIdr <= 0))
      next.minSpendIdr = t("facilityAdmin.entitlements.errorsMinSpendInvalid");
    const tiers =
      rule.type === "tier_benefit"
        ? tierKeys
            .split(",")
            .map((key) => key.trim())
            .filter((key) => key.length > 0)
        : [];
    if (rule.type === "tier_benefit") {
      if (tiers.length === 0)
        next.tierKeys = t("facilityAdmin.entitlements.errorsTierRequired");
      else if (tiers.some((key) => key.length > 30))
        next.tierKeys = t("facilityAdmin.errors.tierKeyLength");
      else if (new Set(tiers).size !== tiers.length)
        next.tierKeys = t("facilityAdmin.errors.tierKeyDuplicate");
    }

    setErrors(next);
    if (Object.keys(next).length > 0) {
      setFormError(t("form.errorSummary", { count: Object.keys(next).length }));
      return;
    }
    setFormError(undefined);
    if (sessionCount === null) return;

    const validity =
      validityKind === "duration_hours"
        ? {
            kind: "duration_hours" as const,
            hours: durationHours ?? 24,
          }
        : validityKind === "operating_day"
          ? { kind: "operating_day" as const }
          : { kind: "billing_period" as const };

    let body: PutEntitlementRuleBody;
    switch (rule.type) {
      case "min_spend":
        body = {
          facilityId: rule.facilityId,
          type: "min_spend",
          sessions: sessionCount,
          validity,
          isEnabled: enabled,
          condition: { minSpendIdr: minSpendIdr ?? 0 },
        };
        break;
      case "tier_benefit":
        body = {
          facilityId: rule.facilityId,
          type: "tier_benefit",
          sessions: sessionCount,
          validity,
          isEnabled: enabled,
          condition: { tierKeys: tiers },
        };
        break;
      case "package":
        body = {
          facilityId: rule.facilityId,
          type: "package",
          sessions: sessionCount,
          validity,
          isEnabled: enabled,
          condition: {
            menuItemId:
              menuItemId === "none" ? (combos[0]?.id ?? "") : menuItemId,
          },
        };
        break;
      default:
        throw new Error("Unsupported entitlement rule type");
    }

    const parsed = putEntitlementRuleSchema.safeParse(body);
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      setFormError(
        t("form.errorSummary", { count: parsed.error.issues.length }),
      );
      return;
    }

    putRule.mutate(
      { ruleId: rule.id, body: parsed.data },
      {
        onSuccess: () => {
          toast({
            title: t("facilityAdmin.entitlements.updated"),
            tone: "success",
          });
          onOpenChange(false);
        },
        onError: (error) =>
          setFormError(
            error instanceof ApiError
              ? error.message
              : t("facilityAdmin.entitlements.updateFailed"),
          ),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("facilityAdmin.entitlements.dialogTitle", { type: typeName })}
          </DialogTitle>
          <DialogDescription>
            {t("facilityAdmin.entitlements.dialogHint")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t("facilityAdmin.entitlements.fieldsSessions")}
              error={errors.sessions}
              required
            >
              <Input
                inputMode="numeric"
                value={sessions}
                onChange={(event) => setSessions(event.target.value)}
              />
            </FormField>
            <FormField
              label={t("facilityAdmin.entitlements.fieldsValidity")}
              required
            >
              <Select
                value={validityKind}
                onValueChange={(value) =>
                  setValidityKind(value as ValidityKind)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {validityKindKeys.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {t(validityLabel(kind))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>
          {validityKind === "duration_hours" && (
            <FormField
              label={t("facilityAdmin.entitlements.fieldsHours")}
              error={errors.hours}
              required
            >
              <Input
                inputMode="numeric"
                value={hours}
                onChange={(event) => setHours(event.target.value)}
              />
            </FormField>
          )}
          {rule.type === "min_spend" && (
            <FormField
              label={t("facilityAdmin.entitlements.fieldsMinSpendIdr")}
              error={errors.minSpendIdr}
              required
            >
              <Input
                inputMode="numeric"
                value={minSpend}
                onChange={(event) => setMinSpend(event.target.value)}
              />
            </FormField>
          )}
          {rule.type === "tier_benefit" && (
            <FormField
              label={t("facilityAdmin.entitlements.fieldsTierKeys")}
              hint={t("facilityAdmin.entitlements.fieldsTierKeysHint")}
              error={errors.tierKeys}
              required
            >
              <Input
                value={tierKeys}
                onChange={(event) => setTierKeys(event.target.value)}
                autoComplete="off"
              />
            </FormField>
          )}
          {rule.type === "package" && (
            <FormField
              label={t("facilityAdmin.entitlements.fieldsMenuItem")}
              required
            >
              <Select value={menuItemId} onValueChange={setMenuItemId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {menuChoices.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          )}
          <div className="flex items-start justify-between gap-3">
            <Label htmlFor="facility-rule-enabled">
              {t("facilityAdmin.entitlements.fieldsEnabled")}
            </Label>
            <Switch
              id="facility-rule-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          </div>
          <FormError message={formError} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("common.cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" loading={putRule.isPending}>
              {t("facilityAdmin.entitlements.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
