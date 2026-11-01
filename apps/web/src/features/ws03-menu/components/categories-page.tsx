// Categories and their display order (PRD §8 "Struktur Menu", "urutan
// tampil"). Order is saved as one PUT with the complete id list; rows are
// draggable with a mouse and reorderable with the arrow buttons.
import * as React from "react";
import { GripVertical, Pencil, Plus, Trash2 } from "lucide-react";
import type { Category } from "@starter/shared/menu";
import { useT } from "@/components/i18n";
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
  useCategories,
  useCreateCategory,
  useDeleteCategory,
  useItems,
  useReorderCategories,
  useUpdateCategory,
} from "../hooks";
import { reorderIds } from "../lib";
import { ConfirmDialog } from "./confirm-dialog";
import { ReorderButtons } from "./reorder-buttons";

const NONE = "none";

type Editor = { mode: "new" } | { mode: "edit"; category: Category };

function CategoryActions({
  category,
  pending,
  onEdit,
  onDelete,
  extra,
}: {
  category: Category;
  pending: boolean;
  onEdit: () => void;
  onDelete: () => void;
  extra?: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="flex justify-end gap-1">
      {extra}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t("menu.categories.edit")}
        onClick={onEdit}
        disabled={pending}
      >
        <Pencil aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t("menu.categories.deleteTitle", { name: category.name })}
        onClick={onDelete}
      >
        <Trash2 aria-hidden="true" />
      </Button>
    </div>
  );
}

export function CategoriesPage() {
  const t = useT();
  const toast = useToast();
  const categoriesQuery = useCategories({ limit: 100 });
  const itemsQuery = useItems({ limit: 100 });
  const createCategory = useCreateCategory();
  const updateCategory = useUpdateCategory();
  const deleteCategory = useDeleteCategory();
  const reorder = useReorderCategories();

  const [search, setSearch] = React.useState("");
  const [editor, setEditor] = React.useState<Editor | null>(null);
  const [name, setName] = React.useState("");
  const [parentId, setParentId] = React.useState(NONE);
  const [error, setError] = React.useState<string | undefined>();
  const [deleting, setDeleting] = React.useState<Category | null>(null);
  const [dragging, setDragging] = React.useState<string | null>(null);

  const categories = React.useMemo(
    () =>
      [...(categoriesQuery.data?.data ?? [])].sort(
        (a, b) => a.sortOrder - b.sortOrder,
      ),
    [categoriesQuery.data],
  );
  const itemCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of itemsQuery.data?.data ?? [])
      counts.set(item.categoryId, (counts.get(item.categoryId) ?? 0) + 1);
    return counts;
  }, [itemsQuery.data]);

  const filtered = categories.filter((category) =>
    category.name
      .toLocaleLowerCase("id-ID")
      .includes(search.trim().toLocaleLowerCase("id-ID")),
  );
  const reorderEnabled = search.trim() === "";

  function openNew() {
    setName("");
    setParentId(NONE);
    setError(undefined);
    setEditor({ mode: "new" });
  }

  function openEdit(category: Category) {
    setName(category.name);
    setParentId(category.parentId ?? NONE);
    setError(undefined);
    setEditor({ mode: "edit", category });
  }

  function save() {
    const trimmed = name.trim();
    if (trimmed === "") {
      setError(t("menu.errors.required"));
      return;
    }
    const body = {
      name: trimmed,
      parentId: parentId === NONE ? null : parentId,
    };
    const onSuccess = () => {
      toast({
        title:
          editor?.mode === "edit"
            ? t("menu.categories.updatedToast")
            : t("menu.categories.createdToast"),
        tone: "success",
      });
      setEditor(null);
    };
    if (editor?.mode === "edit") {
      updateCategory.mutate(
        { categoryId: editor.category.id, body },
        { onSuccess, onError: () => setError(t("menu.errors.saveFailed")) },
      );
      return;
    }
    createCategory.mutate(body, {
      onSuccess,
      onError: () => setError(t("menu.errors.saveFailed")),
    });
  }

  function confirmDelete() {
    if (!deleting) return;
    deleteCategory.mutate(deleting.id, {
      onSuccess: () => {
        toast({ title: t("menu.categories.deletedToast"), tone: "success" });
        setDeleting(null);
      },
      onError: () =>
        toast({ title: t("menu.errors.deleteInUse"), tone: "danger" }),
    });
  }

  function saveOrder(ordered: string[]) {
    reorder.mutate(
      { orderedIds: ordered },
      {
        onSuccess: () =>
          toast({ title: t("menu.categories.reorderSaved"), tone: "success" }),
        onError: () =>
          toast({ title: t("menu.errors.saveFailed"), tone: "danger" }),
      },
    );
  }

  function move(category: Category, direction: -1 | 1) {
    const ids = categories.map((row) => row.id);
    const target = ids[ids.indexOf(category.id) + direction];
    if (!target) return;
    const ordered = reorderIds(ids, category.id, target);
    if (ordered) saveOrder(ordered);
  }

  function dropBefore(targetId: string) {
    if (!dragging || dragging === targetId) return;
    const ordered = reorderIds(
      categories.map((row) => row.id),
      dragging,
      targetId,
    );
    setDragging(null);
    if (ordered) saveOrder(ordered);
  }

  return (
    <>
      <DataTableShell
        title={t("menu.categories.title")}
        description={t("menu.categories.description")}
        state={
          categoriesQuery.isPending || itemsQuery.isPending
            ? "loading"
            : categoriesQuery.isError || itemsQuery.isError
              ? "error"
              : categories.length === 0
                ? "empty"
                : "ready"
        }
        search={{
          value: search,
          onChange: setSearch,
          label: t("menu.categories.searchPlaceholder"),
        }}
        actions={
          <Button type="button" onClick={openNew}>
            <Plus aria-hidden="true" />
            {t("menu.categories.add")}
          </Button>
        }
        onRetry={() => {
          void categoriesQuery.refetch();
          void itemsQuery.refetch();
        }}
        empty={{
          title: t("menu.categories.emptyTitle"),
          description: t("menu.categories.emptyHint"),
          action: (
            <Button type="button" variant="outline" onClick={openNew}>
              {t("menu.categories.add")}
            </Button>
          ),
        }}
        noResults={filtered.length === 0 && categories.length > 0}
        rowCount={filtered.length}
      >
        <p className="border-b px-card py-2 text-sm leading-5 text-muted-foreground">
          {t("menu.categories.reorderHint")}
        </p>
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                {reorderEnabled && (
                  <TableHead className="w-24">
                    {t("menu.categories.columns.order")}
                  </TableHead>
                )}
                <TableHead>{t("menu.categories.columns.name")}</TableHead>
                <TableHead className="hidden sm:table-cell">
                  {t("menu.categories.columns.parent")}
                </TableHead>
                <TableHead numeric>
                  {t("menu.categories.columns.items")}
                </TableHead>
                <TableHead numeric>
                  {t("menu.categories.columns.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((category, index) => (
                <TableRow
                  key={category.id}
                  draggable={reorderEnabled}
                  onDragStart={() => setDragging(category.id)}
                  onDragOver={(event) => {
                    if (reorderEnabled) event.preventDefault();
                  }}
                  onDrop={() => dropBefore(category.id)}
                  onDragEnd={() => setDragging(null)}
                >
                  {reorderEnabled && (
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <GripVertical
                          aria-hidden="true"
                          className="size-4 text-muted-foreground"
                        />
                        <ReorderButtons
                          index={index}
                          count={filtered.length}
                          labelUp={t("menu.categories.moveUp", {
                            name: category.name,
                          })}
                          labelDown={t("menu.categories.moveDown", {
                            name: category.name,
                          })}
                          disabled={reorder.isPending}
                          onMove={(direction) => move(category, direction)}
                        />
                      </div>
                    </TableCell>
                  )}
                  <TableCell className="font-medium">{category.name}</TableCell>
                  <TableCell className="hidden sm:table-cell text-muted-foreground">
                    {category.parentId
                      ? (categories.find((row) => row.id === category.parentId)
                          ?.name ?? t("menu.list.noCategory"))
                      : "—"}
                  </TableCell>
                  <TableCell numeric>
                    {t("menu.categories.itemCount", {
                      count: itemCounts.get(category.id) ?? 0,
                    })}
                  </TableCell>
                  <TableCell numeric>
                    <CategoryActions
                      category={category}
                      pending={reorder.isPending}
                      onEdit={() => openEdit(category)}
                      onDelete={() => setDeleting(category)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <ul className="md:hidden">
          {filtered.map((category, index) => (
            <li
              key={category.id}
              className="grid gap-2 border-b px-card py-3 last:border-b-0"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="grid min-w-0 gap-0.5">
                  <span className="font-medium">{category.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {category.parentId
                      ? `${categories.find((row) => row.id === category.parentId)?.name ?? t("menu.list.noCategory")} · `
                      : ""}
                    {t("menu.categories.itemCount", {
                      count: itemCounts.get(category.id) ?? 0,
                    })}
                  </span>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2">
                {reorderEnabled ? (
                  <ReorderButtons
                    index={index}
                    count={filtered.length}
                    labelUp={t("menu.categories.moveUp", {
                      name: category.name,
                    })}
                    labelDown={t("menu.categories.moveDown", {
                      name: category.name,
                    })}
                    disabled={reorder.isPending}
                    onMove={(direction) => move(category, direction)}
                  />
                ) : (
                  <span />
                )}
                <CategoryActions
                  category={category}
                  pending={reorder.isPending}
                  onEdit={() => openEdit(category)}
                  onDelete={() => setDeleting(category)}
                />
              </div>
            </li>
          ))}
        </ul>
      </DataTableShell>

      <Dialog
        open={editor !== null}
        onOpenChange={(open) => !open && setEditor(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editor?.mode === "edit"
                ? t("menu.categories.edit")
                : t("menu.categories.add")}
            </DialogTitle>
          </DialogHeader>
          <FormField
            label={t("menu.categories.name")}
            hint={t("menu.categories.nameHint")}
            error={error}
            required
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
            />
          </FormField>
          <FormField label={t("menu.categories.parent")}>
            <Select value={parentId} onValueChange={setParentId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>
                  {t("menu.categories.parentNone")}
                </SelectItem>
                {categories
                  .filter((category) =>
                    editor?.mode === "edit"
                      ? category.id !== editor.category.id
                      : true,
                  )
                  .map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </FormField>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditor(null)}
              disabled={createCategory.isPending || updateCategory.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              loading={createCategory.isPending || updateCategory.isPending}
              onClick={save}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("menu.categories.deleteTitle", {
          name: deleting?.name ?? "",
        })}
        description={t("menu.categories.deleteBody")}
        confirmLabel={t("common.delete")}
        pending={deleteCategory.isPending}
        onConfirm={confirmDelete}
      />
    </>
  );
}
