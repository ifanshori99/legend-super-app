// Tiers and their benefits (/kelola/loyalty/tier; PRD v1.7 §3.20 "Tier": tiers
// qualify on rolling spend OR visits and carry a points multiplier, a birthday
// reward, reservation priority, exclusive promos and a free-shower quota).
// There is no delete endpoint: a tier is retired with the "active" switch, so
// the history of past tiers stays intact.
import * as React from "react";
import { Pencil, Plus } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money, NumberDisplay } from "@/components/ui/money";
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
import type { LoyaltyTier } from "@starter/shared/crm";
import { useCreateTier, useTiers, useUpdateTier } from "../hooks";
import {
  emptyTierForm,
  formatMultiplier,
  hasErrors,
  tierBody,
  tierFormFrom,
  validateTierForm,
  type TierField,
  type TierForm,
  type ValidationErrors,
} from "../lib";

type Editor = { mode: "new" } | { mode: "edit"; tier: LoyaltyTier };

function TierStatus({ active }: { active: boolean }) {
  const t = useT();
  return (
    <Badge tone={active ? "success" : "neutral"}>
      {active ? t("loyalty.tiers.active") : t("loyalty.tiers.inactive")}
    </Badge>
  );
}

export function TiersPage() {
  const t = useT();
  const toast = useToast();
  const tiersQuery = useTiers();
  const createTier = useCreateTier();
  const updateTier = useUpdateTier();

  const [search, setSearch] = React.useState("");
  const [editor, setEditor] = React.useState<Editor | null>(null);
  const [form, setForm] = React.useState<TierForm>(emptyTierForm());
  const [errors, setErrors] = React.useState<ValidationErrors<TierField>>({});
  const [saveFailed, setSaveFailed] = React.useState(false);

  const tiers = React.useMemo(
    () => [...(tiersQuery.data?.data ?? [])].sort((a, b) => a.rank - b.rank),
    [tiersQuery.data],
  );
  const filtered = tiers.filter((tier) =>
    tier.name
      .toLocaleLowerCase("id-ID")
      .includes(search.trim().toLocaleLowerCase("id-ID")),
  );

  function openNew() {
    const nextRank =
      tiers.reduce((highest, tier) => Math.max(highest, tier.rank), 0) + 1;
    setForm({ ...emptyTierForm(), rank: String(nextRank) });
    setErrors({});
    setSaveFailed(false);
    setEditor({ mode: "new" });
  }

  function openEdit(tier: LoyaltyTier) {
    setForm(tierFormFrom(tier));
    setErrors({});
    setSaveFailed(false);
    setEditor({ mode: "edit", tier });
  }

  function set<Field extends TierField>(field: Field, value: TierForm[Field]) {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setSaveFailed(false);
  }

  function save() {
    const next = validateTierForm(form);
    setErrors(next);
    if (hasErrors(next)) return;
    const body = tierBody(form);
    const onSuccess = (saved: LoyaltyTier) => {
      toast({
        title:
          editor?.mode === "edit"
            ? t("loyalty.tiers.updatedToast", { name: saved.name })
            : t("loyalty.tiers.createdToast", { name: saved.name }),
        tone: "success",
      });
      setEditor(null);
    };
    const onError = () => setSaveFailed(true);
    if (editor?.mode === "edit")
      updateTier.mutate(
        { tierId: editor.tier.id, body },
        { onSuccess, onError },
      );
    else createTier.mutate(body, { onSuccess, onError });
  }

  const pending = createTier.isPending || updateTier.isPending;
  const state = tiersQuery.isPending
    ? "loading"
    : tiersQuery.isError
      ? "error"
      : tiers.length === 0
        ? "empty"
        : "ready";

  return (
    <>
      <DataTableShell
        title={t("loyalty.tiers.title")}
        description={t("loyalty.tiers.description")}
        state={state}
        search={{
          value: search,
          onChange: setSearch,
          label: t("loyalty.tiers.searchPlaceholder"),
        }}
        actions={
          <Button type="button" onClick={openNew}>
            <Plus aria-hidden="true" />
            {t("loyalty.tiers.add")}
          </Button>
        }
        onRetry={() => void tiersQuery.refetch()}
        empty={{
          title: t("loyalty.tiers.emptyTitle"),
          description: t("loyalty.tiers.emptyHint"),
          action: (
            <Button type="button" variant="outline" onClick={openNew}>
              {t("loyalty.tiers.add")}
            </Button>
          ),
        }}
        noResults={filtered.length === 0 && tiers.length > 0}
        rowCount={filtered.length}
      >
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("loyalty.tiers.columns.name")}</TableHead>
                <TableHead numeric>{t("loyalty.tiers.columns.rank")}</TableHead>
                <TableHead numeric>
                  {t("loyalty.tiers.columns.spend")}
                </TableHead>
                <TableHead numeric>
                  {t("loyalty.tiers.columns.visits")}
                </TableHead>
                <TableHead numeric>
                  {t("loyalty.tiers.columns.multiplier")}
                </TableHead>
                <TableHead>{t("loyalty.tiers.columns.birthday")}</TableHead>
                <TableHead>{t("loyalty.tiers.columns.status")}</TableHead>
                <TableHead numeric>
                  {t("loyalty.tiers.columns.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((tier) => (
                <TableRow key={tier.id}>
                  <TableCell className="font-medium">{tier.name}</TableCell>
                  <TableCell numeric>
                    <NumberDisplay value={tier.rank} />
                  </TableCell>
                  <TableCell numeric>
                    <Money amount={tier.thresholdSpendIdr} />
                  </TableCell>
                  <TableCell numeric>
                    <NumberDisplay value={tier.thresholdVisits} />
                  </TableCell>
                  <TableCell numeric>
                    <span className="tabular">
                      {formatMultiplier(tier.benefits.pointsMultiplierBp)}
                    </span>
                  </TableCell>
                  <TableCell className="tabular">
                    {t("loyalty.tiers.pointsValue", {
                      count: tier.benefits.birthdayRewardPoints,
                    })}
                  </TableCell>
                  <TableCell>
                    <TierStatus active={tier.isActive} />
                  </TableCell>
                  <TableCell numeric>
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("loyalty.tiers.edit", {
                          name: tier.name,
                        })}
                        onClick={() => openEdit(tier)}
                      >
                        <Pencil aria-hidden="true" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <ul className="md:hidden">
          {filtered.map((tier) => (
            <li
              key={tier.id}
              className="grid gap-2 border-b px-card py-3 last:border-b-0"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="grid min-w-0 gap-0.5">
                  <span className="font-medium">{tier.name}</span>
                  <span className="tabular text-sm text-muted-foreground">
                    {formatMultiplier(tier.benefits.pointsMultiplierBp)} ·{" "}
                    {t("loyalty.tiers.pointsValue", {
                      count: tier.benefits.birthdayRewardPoints,
                    })}
                  </span>
                  <span className="tabular text-sm text-muted-foreground">
                    <Money amount={tier.thresholdSpendIdr} size="sm" />
                  </span>
                </div>
                <TierStatus active={tier.isActive} />
              </div>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => openEdit(tier)}
                >
                  <Pencil aria-hidden="true" />
                  {t("loyalty.tiers.edit", { name: tier.name })}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </DataTableShell>

      <Dialog
        open={editor !== null}
        onOpenChange={(open) => !open && !pending && setEditor(null)}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editor?.mode === "edit"
                ? t("loyalty.tiers.editTitle")
                : t("loyalty.tiers.newTitle")}
            </DialogTitle>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t("loyalty.tiers.fields.name")}
              error={errors.name && t(errors.name)}
              required
              className="sm:col-span-2"
            >
              <Input
                value={form.name}
                onChange={(event) => set("name", event.target.value)}
                autoComplete="off"
              />
            </FormField>

            <FormField
              label={t("loyalty.tiers.fields.rank")}
              hint={t("loyalty.tiers.fields.rankHint")}
              error={errors.rank && t(errors.rank)}
              required
            >
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                value={form.rank}
                onChange={(event) => set("rank", event.target.value)}
              />
            </FormField>

            <FormField
              label={t("loyalty.tiers.fields.multiplier")}
              hint={t("loyalty.tiers.fields.multiplierHint")}
              error={errors.multiplier && t(errors.multiplier)}
              required
            >
              <Input
                inputMode="decimal"
                value={form.multiplier}
                onChange={(event) => set("multiplier", event.target.value)}
                autoComplete="off"
              />
            </FormField>

            <FormField
              label={t("loyalty.tiers.fields.spend")}
              error={errors.spend && t(errors.spend)}
              required
            >
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                value={form.spend}
                onChange={(event) => set("spend", event.target.value)}
              />
            </FormField>

            <FormField
              label={t("loyalty.tiers.fields.visits")}
              hint={t("loyalty.tiers.fields.visitsHint")}
              error={errors.visits && t(errors.visits)}
              required
            >
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                value={form.visits}
                onChange={(event) => set("visits", event.target.value)}
              />
            </FormField>

            <FormField
              label={t("loyalty.tiers.fields.birthdayPoints")}
              error={errors.birthdayPoints && t(errors.birthdayPoints)}
              required
            >
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                value={form.birthdayPoints}
                onChange={(event) => set("birthdayPoints", event.target.value)}
              />
            </FormField>

            <FormField
              label={t("loyalty.tiers.fields.facilityQuota")}
              error={errors.facilityQuota && t(errors.facilityQuota)}
              required
            >
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                value={form.facilityQuota}
                onChange={(event) => set("facilityQuota", event.target.value)}
              />
            </FormField>

            <div className="flex items-start justify-between gap-4 rounded-lg border-(length:--border-w) p-3">
              <div className="grid gap-0.5">
                <Label htmlFor="tier-priority">
                  {t("loyalty.tiers.fields.reservationPriority")}
                </Label>
              </div>
              <Switch
                id="tier-priority"
                checked={form.reservationPriority}
                onCheckedChange={(checked) =>
                  set("reservationPriority", checked)
                }
              />
            </div>

            <div className="flex items-start justify-between gap-4 rounded-lg border-(length:--border-w) p-3">
              <div className="grid gap-0.5">
                <Label htmlFor="tier-exclusive">
                  {t("loyalty.tiers.fields.exclusivePromotions")}
                </Label>
              </div>
              <Switch
                id="tier-exclusive"
                checked={form.exclusivePromotions}
                onCheckedChange={(checked) =>
                  set("exclusivePromotions", checked)
                }
              />
            </div>

            <div className="flex items-start justify-between gap-4 rounded-lg border-(length:--border-w) p-3 sm:col-span-2">
              <div className="grid gap-0.5">
                <Label htmlFor="tier-active">
                  {t("loyalty.tiers.fields.isActive")}
                </Label>
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("loyalty.tiers.deactivateHint")}
                </p>
              </div>
              <Switch
                id="tier-active"
                checked={form.isActive}
                onCheckedChange={(checked) => set("isActive", checked)}
              />
            </div>
          </div>

          {saveFailed && (
            <p role="alert" className="text-sm leading-5 text-danger">
              {t("loyalty.tiers.saveFailed")}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditor(null)}
              disabled={pending}
            >
              {t("common.cancel")}
            </Button>
            <Button type="button" loading={pending} onClick={save}>
              {t("loyalty.tiers.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
