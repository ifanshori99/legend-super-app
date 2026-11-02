// Channel price lists with effective dates (PRD §8 "Harga per Kanal").
// The list that applies on the business date is the latest effective one;
// the editor saves the whole price grid in one write.
import * as React from "react";
import { CalendarClock, Plus, Tags, Trash2 } from "lucide-react";
import type { PriceList } from "@starter/shared/menu";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import {
  useCreatePriceList,
  useDeletePriceList,
  useItems,
  usePriceListItems,
  usePriceLists,
  useSetPriceListItems,
  useUpdatePriceList,
} from "../hooks";
import {
  businessDateToday,
  effectivePriceList,
  formatBusinessDate,
} from "../lib";
import { ConfirmDialog } from "./confirm-dialog";

const CHANNELS = [
  "dine_in",
  "takeaway",
  "gofood",
  "grabfood",
  "shopeefood",
  "reservation",
] as const;

type Channel = (typeof CHANNELS)[number];

type Editor =
  | { mode: "new" }
  | { mode: "edit-date"; priceList: PriceList }
  | { mode: "grid"; priceList: PriceList };

function PriceListActions({
  priceList,
  label,
  onManage,
  onEditDate,
  onDelete,
  showLabel = false,
}: {
  priceList: PriceList;
  label: string;
  onManage: () => void;
  onEditDate: () => void;
  onDelete: () => void;
  showLabel?: boolean;
}) {
  const t = useT();
  return (
    <div className="flex items-center justify-end gap-1">
      {showLabel ? (
        <Button type="button" variant="outline" size="sm" onClick={onManage}>
          <Tags aria-hidden="true" />
          {t("menu.prices.manage")}
        </Button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("menu.prices.manage")}
          onClick={onManage}
        >
          <Tags aria-hidden="true" />
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t("menu.prices.editDate")}
        onClick={onEditDate}
      >
        <CalendarClock aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t("menu.prices.deleteTitle", {
          channel: label,
          date: formatBusinessDate(priceList.effectiveFrom),
        })}
        onClick={onDelete}
      >
        <Trash2 aria-hidden="true" />
      </Button>
    </div>
  );
}

export function PriceListsPage() {
  const t = useT();
  const toast = useToast();
  const priceListsQuery = usePriceLists({ limit: 100 });
  const itemsQuery = useItems({ limit: 100 });
  const createPriceList = useCreatePriceList();
  const updatePriceList = useUpdatePriceList();
  const deletePriceList = useDeletePriceList();

  const today = businessDateToday();
  const [editor, setEditor] = React.useState<Editor | null>(null);
  const [channel, setChannel] = React.useState<Channel>("dine_in");
  const [effectiveFrom, setEffectiveFrom] = React.useState(today);
  const [error, setError] = React.useState<string | undefined>();
  const [deleting, setDeleting] = React.useState<PriceList | null>(null);

  const lists = React.useMemo(
    () => priceListsQuery.data?.data ?? [],
    [priceListsQuery.data],
  );
  const items = itemsQuery.data?.data ?? [];
  const activeByChannel = React.useMemo(
    () =>
      new Map(
        CHANNELS.map((value) => [
          value,
          effectivePriceList(lists, value, today)?.id,
        ]),
      ),
    [lists, today],
  );

  function openNew() {
    setChannel("dine_in");
    setEffectiveFrom(today);
    setError(undefined);
    setEditor({ mode: "new" });
  }

  function openDate(priceList: PriceList) {
    setEffectiveFrom(priceList.effectiveFrom);
    setError(undefined);
    setEditor({ mode: "edit-date", priceList });
  }

  function save() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      setError(t("menu.errors.required"));
      return;
    }
    const onSuccess = () => {
      toast({
        title:
          editor?.mode === "edit-date"
            ? t("menu.prices.updatedToast")
            : t("menu.prices.createdToast"),
        tone: "success",
      });
      setEditor(null);
    };
    if (editor?.mode === "edit-date") {
      updatePriceList.mutate(
        {
          priceListId: editor.priceList.id,
          body: { effectiveFrom },
        },
        { onSuccess, onError: () => setError(t("menu.errors.saveFailed")) },
      );
      return;
    }
    createPriceList.mutate(
      { channel, effectiveFrom },
      { onSuccess, onError: () => setError(t("menu.errors.saveFailed")) },
    );
  }

  function confirmDelete() {
    if (!deleting) return;
    deletePriceList.mutate(deleting.id, {
      onSuccess: () => {
        toast({ title: t("menu.prices.deletedToast"), tone: "success" });
        setDeleting(null);
      },
      onError: () =>
        toast({ title: t("menu.errors.deleteInUse"), tone: "danger" }),
    });
  }

  return (
    <>
      <DataTableShell
        title={t("menu.prices.title")}
        description={t("menu.prices.description")}
        state={
          priceListsQuery.isPending
            ? "loading"
            : priceListsQuery.isError
              ? "error"
              : lists.length === 0
                ? "empty"
                : "ready"
        }
        actions={
          <Button type="button" onClick={openNew}>
            <Plus aria-hidden="true" />
            {t("menu.prices.add")}
          </Button>
        }
        onRetry={() => void priceListsQuery.refetch()}
        empty={{
          title: t("menu.prices.emptyTitle"),
          description: t("menu.prices.emptyHint"),
          action: (
            <Button type="button" variant="outline" onClick={openNew}>
              {t("menu.prices.add")}
            </Button>
          ),
        }}
        rowCount={lists.length}
      >
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("menu.prices.columns.channel")}</TableHead>
                <TableHead>{t("menu.prices.columns.effectiveFrom")}</TableHead>
                <TableHead>{t("menu.prices.columns.state")}</TableHead>
                <TableHead numeric>
                  {t("menu.prices.columns.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lists.map((priceList) => {
                const active =
                  activeByChannel.get(priceList.channel) === priceList.id;
                const scheduled = priceList.effectiveFrom > today;
                return (
                  <TableRow key={priceList.id}>
                    <TableCell className="font-medium">
                      {t(`menu.prices.channels.${priceList.channel}`)}
                    </TableCell>
                    <TableCell className="tabular">
                      {formatBusinessDate(priceList.effectiveFrom)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        tone={
                          active ? "success" : scheduled ? "info" : "neutral"
                        }
                      >
                        {active
                          ? t("menu.prices.state.active")
                          : scheduled
                            ? t("menu.prices.state.scheduled")
                            : t("menu.prices.state.past")}
                      </Badge>
                    </TableCell>
                    <TableCell numeric>
                      <PriceListActions
                        priceList={priceList}
                        label={t(`menu.prices.channels.${priceList.channel}`)}
                        onManage={() => setEditor({ mode: "grid", priceList })}
                        onEditDate={() => openDate(priceList)}
                        onDelete={() => setDeleting(priceList)}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        <ul className="md:hidden">
          {lists.map((priceList) => {
            const active =
              activeByChannel.get(priceList.channel) === priceList.id;
            const scheduled = priceList.effectiveFrom > today;
            return (
              <li
                key={priceList.id}
                className="grid gap-2 border-b px-card py-3 last:border-b-0"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="grid min-w-0 gap-0.5">
                    <span className="font-medium">
                      {t(`menu.prices.channels.${priceList.channel}`)}
                    </span>
                    <span className="text-sm tabular text-muted-foreground">
                      {t("menu.prices.effectiveFrom")}{" "}
                      {formatBusinessDate(priceList.effectiveFrom)}
                    </span>
                  </div>
                  <Badge
                    tone={active ? "success" : scheduled ? "info" : "neutral"}
                  >
                    {active
                      ? t("menu.prices.state.active")
                      : scheduled
                        ? t("menu.prices.state.scheduled")
                        : t("menu.prices.state.past")}
                  </Badge>
                </div>
                <PriceListActions
                  priceList={priceList}
                  label={t(`menu.prices.channels.${priceList.channel}`)}
                  showLabel
                  onManage={() => setEditor({ mode: "grid", priceList })}
                  onEditDate={() => openDate(priceList)}
                  onDelete={() => setDeleting(priceList)}
                />
              </li>
            );
          })}
        </ul>
      </DataTableShell>

      <Dialog
        open={editor?.mode === "new" || editor?.mode === "edit-date"}
        onOpenChange={(open) => !open && setEditor(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editor?.mode === "edit-date"
                ? t("menu.prices.editDate")
                : t("menu.prices.add")}
            </DialogTitle>
            <DialogDescription>
              {t("menu.prices.description")}
            </DialogDescription>
          </DialogHeader>
          {editor?.mode !== "edit-date" && (
            <FormField label={t("menu.prices.channel")} required>
              <Select
                value={channel}
                onValueChange={(value) => setChannel(value as Channel)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHANNELS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`menu.prices.channels.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          )}
          <FormField
            label={t("menu.prices.effectiveFrom")}
            error={error}
            required
          >
            <Input
              type="date"
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
            />
          </FormField>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditor(null)}
              disabled={createPriceList.isPending || updatePriceList.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              loading={createPriceList.isPending || updatePriceList.isPending}
              onClick={save}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {editor?.mode === "grid" && (
        <PriceGrid
          priceList={editor.priceList}
          items={items}
          onClose={() => setEditor(null)}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("menu.prices.deleteTitle", {
          channel: deleting
            ? t(`menu.prices.channels.${deleting.channel}`)
            : "",
          date: deleting ? formatBusinessDate(deleting.effectiveFrom) : "",
        })}
        description={t("menu.prices.deleteBody")}
        confirmLabel={t("common.delete")}
        pending={deletePriceList.isPending}
        onConfirm={confirmDelete}
      />
    </>
  );
}

function PriceGrid({
  priceList,
  items,
  onClose,
}: {
  priceList: PriceList;
  items: { id: string; name: string; type: "single" | "combo" }[];
  onClose: () => void;
}) {
  const t = useT();
  const priceItems = usePriceListItems(priceList.id);
  const rows = priceItems.data?.data ?? [];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("menu.prices.editorTitle", {
              channel: t(`menu.prices.channels.${priceList.channel}`),
              date: formatBusinessDate(priceList.effectiveFrom),
            })}
          </DialogTitle>
          <DialogDescription>
            {t("menu.prices.editorDescription")}
          </DialogDescription>
        </DialogHeader>
        {priceItems.isPending ? (
          <p className="text-sm text-muted-foreground" role="status">
            {t("common.loading")}
          </p>
        ) : priceItems.isError ? (
          <div>
            <p className="text-sm text-danger" role="alert">
              {t("state.errorHint")}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void priceItems.refetch()}
            >
              {t("common.retry")}
            </Button>
          </div>
        ) : (
          <PriceGridForm
            priceList={priceList}
            items={items}
            initial={rows}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PriceGridForm({
  priceList,
  items,
  initial,
  onClose,
}: {
  priceList: PriceList;
  items: { id: string; name: string }[];
  initial: { itemId: string; variantId: string | null; priceIdr: number }[];
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const save = useSetPriceListItems();
  const [search, setSearch] = React.useState("");

  const initialPrices = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const row of initial)
      if (row.variantId === null) map.set(row.itemId, String(row.priceIdr));
    return map;
  }, [initial]);

  const [draft, setDraft] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(initialPrices),
  );

  const filtered = items.filter((item) =>
    item.name
      .toLocaleLowerCase("id-ID")
      .includes(search.trim().toLocaleLowerCase("id-ID")),
  );
  const dirtyCount = items.filter(
    (item) => (draft[item.id] ?? "") !== (initialPrices.get(item.id) ?? ""),
  ).length;

  function submit() {
    const entries = items
      .map((item) => ({ item, value: (draft[item.id] ?? "").trim() }))
      .filter(({ value }) => value !== "")
      .map(({ item, value }) => ({
        itemId: item.id,
        variantId: null,
        priceIdr: Number(value),
      }));
    if (
      entries.some(
        (entry) => !Number.isInteger(entry.priceIdr) || entry.priceIdr < 0,
      )
    ) {
      toast({ title: t("menu.errors.invalidAmount"), tone: "danger" });
      return;
    }
    save.mutate(
      { priceListId: priceList.id, body: { items: entries } },
      {
        onSuccess: () => {
          toast({ title: t("menu.prices.editorSavedToast"), tone: "success" });
          onClose();
        },
        onError: () =>
          toast({ title: t("menu.errors.saveFailed"), tone: "danger" }),
      },
    );
  }

  return (
    <div className="grid gap-3">
      <Input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={t("menu.prices.editorSearch")}
        aria-label={t("menu.prices.editorSearch")}
        className="h-control-sm"
      />
      <div className="max-h-[50dvh] overflow-y-auto rounded-container border-(length:--border-w)">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("menu.prices.editorColumns.item")}</TableHead>
              <TableHead numeric>
                {t("menu.prices.editorColumns.price")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((item) => {
              const id = `price-${item.id}`;
              return (
                <TableRow key={item.id}>
                  <TableCell>
                    <label htmlFor={id} className="font-medium">
                      {item.name}
                    </label>
                  </TableCell>
                  <TableCell numeric>
                    <Input
                      id={id}
                      type="number"
                      min={0}
                      step={1000}
                      inputMode="numeric"
                      value={draft[item.id] ?? ""}
                      placeholder={t("menu.prices.editorNoPrice")}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          [item.id]: event.target.value,
                        }))
                      }
                      className="h-control-sm w-32 text-right"
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-sm text-muted-foreground">
        {dirtyCount > 0
          ? t("menu.prices.editorDirty", { count: dirtyCount })
          : t("menu.categories.itemCount", { count: items.length })}
      </p>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={save.isPending}
        >
          {t("common.cancel")}
        </Button>
        <Button type="button" loading={save.isPending} onClick={submit}>
          {t("menu.prices.editorSave")}
        </Button>
      </DialogFooter>
    </div>
  );
}
