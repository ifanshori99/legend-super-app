// Reward catalog (/kelola/loyalty/reward; PRD v1.7 §3.20 "Reward Katalog":
// menu gratis, upgrade or voucher, each with a points cost, stock and validity
// window). A reward is never deleted: it is retired with the "active" switch,
// so past redemptions keep pointing at a real row.
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
import { NumberDisplay } from "@/components/ui/money";
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
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { formatNumber, type Translate } from "@starter/shared/i18n";
import type { Reward } from "@starter/shared/crm";
import {
  useCreateReward,
  useMenuItems,
  useRewards,
  useUpdateReward,
} from "../hooks";
import {
  emptyRewardForm,
  formatDateShort,
  hasErrors,
  rewardBody,
  rewardFormFrom,
  rewardTypeKey,
  validateRewardForm,
  type RewardField,
  type RewardForm,
  type ValidationErrors,
} from "../lib";

type Editor = { mode: "new" } | { mode: "edit"; reward: Reward };
type ActiveFilter = "all" | "true" | "false";

/** Sentinel for the optional menu-item select (Radix needs a non-empty value). */
const NONE = "none";

function StatusBadge({ active }: { active: boolean }) {
  const t = useT();
  return (
    <Badge tone={active ? "success" : "neutral"}>
      {active ? t("loyalty.rewards.active") : t("loyalty.rewards.inactive")}
    </Badge>
  );
}

function validityLabel(reward: Reward, t: Translate): string {
  const from = formatDateShort(reward.validFrom);
  return reward.validUntil === null
    ? t("loyalty.rewards.validityFrom", { from })
    : t("loyalty.rewards.validityRange", {
        from,
        to: formatDateShort(reward.validUntil),
      });
}

export function RewardsPage() {
  const t = useT();
  const toast = useToast();
  const [filter, setFilter] = React.useState<ActiveFilter>("all");
  const rewardsQuery = useRewards(filter === "all" ? undefined : filter);
  const menuItemsQuery = useMenuItems();
  const createReward = useCreateReward();
  const updateReward = useUpdateReward();

  const [search, setSearch] = React.useState("");
  const [editor, setEditor] = React.useState<Editor | null>(null);
  const [form, setForm] = React.useState<RewardForm>(() => emptyRewardForm());
  const [errors, setErrors] = React.useState<ValidationErrors<RewardField>>({});
  const [saveFailed, setSaveFailed] = React.useState(false);

  const rewards = React.useMemo(
    () =>
      [...(rewardsQuery.data?.data ?? [])].sort(
        (a, b) => a.sortOrder - b.sortOrder,
      ),
    [rewardsQuery.data],
  );
  const filtered = rewards.filter((reward) =>
    reward.name
      .toLocaleLowerCase("id-ID")
      .includes(search.trim().toLocaleLowerCase("id-ID")),
  );
  const menuItems = menuItemsQuery.data ?? [];

  function openNew() {
    setForm(emptyRewardForm());
    setErrors({});
    setSaveFailed(false);
    setEditor({ mode: "new" });
  }

  function openEdit(reward: Reward) {
    setForm(rewardFormFrom(reward));
    setErrors({});
    setSaveFailed(false);
    setEditor({ mode: "edit", reward });
  }

  function set<Field extends RewardField>(
    field: Field,
    value: RewardForm[Field],
  ) {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setSaveFailed(false);
  }

  function save() {
    const next = validateRewardForm(form);
    setErrors(next);
    if (hasErrors(next)) return;
    const body = rewardBody(form);
    const onSuccess = (saved: Reward) => {
      toast({
        title:
          editor?.mode === "edit"
            ? t("loyalty.rewards.updatedToast", { name: saved.name })
            : t("loyalty.rewards.createdToast", { name: saved.name }),
        tone: "success",
      });
      setEditor(null);
    };
    const onError = () => setSaveFailed(true);
    if (editor?.mode === "edit")
      updateReward.mutate(
        { rewardId: editor.reward.id, body },
        { onSuccess, onError },
      );
    else createReward.mutate(body, { onSuccess, onError });
  }

  const pending = createReward.isPending || updateReward.isPending;
  const state = rewardsQuery.isPending
    ? "loading"
    : rewardsQuery.isError
      ? "error"
      : rewards.length === 0
        ? "empty"
        : "ready";
  const isVoucher = form.type === "voucher";

  return (
    <>
      <DataTableShell
        title={t("loyalty.rewards.title")}
        description={t("loyalty.rewards.description")}
        state={state}
        search={{
          value: search,
          onChange: setSearch,
          label: t("loyalty.rewards.searchPlaceholder"),
        }}
        actions={
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select
              value={filter}
              onValueChange={(value) => setFilter(value as ActiveFilter)}
            >
              <SelectTrigger
                aria-label={t("loyalty.rewards.filterLabel")}
                className="sm:w-44"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t("loyalty.rewards.filter.all")}
                </SelectItem>
                <SelectItem value="true">
                  {t("loyalty.rewards.filter.active")}
                </SelectItem>
                <SelectItem value="false">
                  {t("loyalty.rewards.filter.inactive")}
                </SelectItem>
              </SelectContent>
            </Select>
            <Button type="button" onClick={openNew}>
              <Plus aria-hidden="true" />
              {t("loyalty.rewards.add")}
            </Button>
          </div>
        }
        onRetry={() => void rewardsQuery.refetch()}
        empty={{
          title: t("loyalty.rewards.emptyTitle"),
          description: t("loyalty.rewards.emptyHint"),
          action: (
            <Button type="button" variant="outline" onClick={openNew}>
              {t("loyalty.rewards.add")}
            </Button>
          ),
        }}
        noResults={filtered.length === 0 && rewards.length > 0}
        rowCount={filtered.length}
      >
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("loyalty.rewards.columns.name")}</TableHead>
                <TableHead>{t("loyalty.rewards.columns.type")}</TableHead>
                <TableHead numeric>
                  {t("loyalty.rewards.columns.points")}
                </TableHead>
                <TableHead numeric>
                  {t("loyalty.rewards.columns.stock")}
                </TableHead>
                <TableHead>{t("loyalty.rewards.columns.validity")}</TableHead>
                <TableHead>{t("loyalty.rewards.columns.status")}</TableHead>
                <TableHead numeric>
                  {t("loyalty.rewards.columns.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((reward) => (
                <TableRow key={reward.id}>
                  <TableCell className="font-medium">{reward.name}</TableCell>
                  <TableCell>
                    <Badge tone="neutral">
                      {t(rewardTypeKey(reward.type))}
                    </Badge>
                  </TableCell>
                  <TableCell numeric>
                    <NumberDisplay value={reward.pointsCost} />
                  </TableCell>
                  <TableCell numeric>
                    {reward.stock === null ? (
                      <span className="text-muted-foreground">
                        {t("loyalty.rewards.stockUnlimited")}
                      </span>
                    ) : (
                      <NumberDisplay value={reward.stock} />
                    )}
                  </TableCell>
                  <TableCell className="tabular text-sm">
                    {validityLabel(reward, t)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge active={reward.isActive} />
                  </TableCell>
                  <TableCell numeric>
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("loyalty.rewards.edit", {
                          name: reward.name,
                        })}
                        onClick={() => openEdit(reward)}
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
          {filtered.map((reward) => (
            <li
              key={reward.id}
              className="grid gap-2 border-b px-card py-3 last:border-b-0"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="grid min-w-0 gap-0.5">
                  <span className="font-medium">{reward.name}</span>
                  <span className="tabular text-sm text-muted-foreground">
                    {t(rewardTypeKey(reward.type))} ·{" "}
                    {t("loyalty.rewards.pointsValue", {
                      count: formatNumber(reward.pointsCost),
                    })}
                  </span>
                  <span className="tabular text-sm text-muted-foreground">
                    {validityLabel(reward, t)}
                  </span>
                </div>
                <StatusBadge active={reward.isActive} />
              </div>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => openEdit(reward)}
                >
                  <Pencil aria-hidden="true" />
                  {t("loyalty.rewards.edit", { name: reward.name })}
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
                ? t("loyalty.rewards.editTitle")
                : t("loyalty.rewards.newTitle")}
            </DialogTitle>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t("loyalty.rewards.fields.name")}
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
              label={t("loyalty.rewards.fields.description")}
              className="sm:col-span-2"
            >
              <Textarea
                value={form.description}
                onChange={(event) => set("description", event.target.value)}
                rows={2}
              />
            </FormField>

            <FormField
              id="reward-type"
              label={t("loyalty.rewards.fields.type")}
              hint={t("loyalty.rewards.fields.typeHint")}
              required
            >
              <Select
                value={form.type}
                onValueChange={(value) =>
                  set("type", value as RewardForm["type"])
                }
              >
                <SelectTrigger id="reward-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["free_item", "item_upgrade", "voucher"] as const).map(
                    (type) => (
                      <SelectItem key={type} value={type}>
                        {t(rewardTypeKey(type))}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </FormField>

            <FormField
              label={t("loyalty.rewards.fields.pointsCost")}
              error={errors.pointsCost && t(errors.pointsCost)}
              required
            >
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                value={form.pointsCost}
                onChange={(event) => set("pointsCost", event.target.value)}
              />
            </FormField>

            <FormField
              label={t("loyalty.rewards.fields.stock")}
              hint={t("loyalty.rewards.fields.stockHint")}
              error={errors.stock && t(errors.stock)}
            >
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                value={form.stock}
                onChange={(event) => set("stock", event.target.value)}
              />
            </FormField>

            <FormField
              label={t("loyalty.rewards.fields.sortOrder")}
              error={errors.sortOrder && t(errors.sortOrder)}
              required
            >
              <Input
                type="number"
                inputMode="numeric"
                value={form.sortOrder}
                onChange={(event) => set("sortOrder", event.target.value)}
              />
            </FormField>

            <FormField
              label={t("loyalty.rewards.fields.validFrom")}
              error={errors.validFrom && t(errors.validFrom)}
              required
            >
              <Input
                type="date"
                value={form.validFrom}
                onChange={(event) => set("validFrom", event.target.value)}
              />
            </FormField>

            <FormField
              label={t("loyalty.rewards.fields.validUntil")}
              hint={t("loyalty.rewards.fields.validUntilHint")}
              error={errors.validUntil && t(errors.validUntil)}
            >
              <Input
                type="date"
                value={form.validUntil}
                onChange={(event) => set("validUntil", event.target.value)}
              />
            </FormField>

            {isVoucher ? (
              <FormField
                label={t("loyalty.rewards.fields.voucherValue")}
                hint={t("loyalty.rewards.fields.voucherValueHint")}
                error={errors.voucherValue && t(errors.voucherValue)}
                required
                className="sm:col-span-2"
              >
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={form.voucherValue}
                  onChange={(event) => set("voucherValue", event.target.value)}
                />
              </FormField>
            ) : (
              <FormField
                id="reward-menu-item"
                label={t("loyalty.rewards.fields.menuItem")}
                hint={t("loyalty.rewards.fields.menuItemHint")}
                error={errors.menuItemId && t(errors.menuItemId)}
                required
                className="sm:col-span-2"
              >
                <Select
                  value={form.menuItemId === "" ? NONE : form.menuItemId}
                  onValueChange={(value) =>
                    set("menuItemId", value === NONE ? "" : value)
                  }
                >
                  <SelectTrigger id="reward-menu-item">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>
                      {t("loyalty.rewards.fields.menuItem")}
                    </SelectItem>
                    {menuItems.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            )}

            <div className="flex items-start justify-between gap-4 rounded-lg border-(length:--border-w) p-3 sm:col-span-2">
              <div className="grid gap-0.5">
                <Label htmlFor="reward-active">
                  {t("loyalty.rewards.fields.isActive")}
                </Label>
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("loyalty.rewards.fields.deactivateHint")}
                </p>
              </div>
              <Switch
                id="reward-active"
                checked={form.isActive}
                onCheckedChange={(checked) => set("isActive", checked)}
              />
            </div>
          </div>

          {saveFailed && (
            <p role="alert" className="text-sm leading-5 text-danger">
              {t("loyalty.rewards.saveFailed")}
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
              {t("loyalty.rewards.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
