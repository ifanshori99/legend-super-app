// Variants of one menu item (PRD §8 "Struktur Menu": ukuran, panas/dingin).
// Add, rename and delete inside the item editor; price per variant lives in
// the channel price lists.
import * as React from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { Variant } from "@starter/shared/menu";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import {
  useCreateVariant,
  useDeleteVariant,
  useUpdateVariant,
  useVariants,
} from "../hooks";
import { ConfirmDialog } from "./confirm-dialog";

type EditorState = { mode: "new" } | { mode: "edit"; variant: Variant };

export function VariantSection({ itemId }: { itemId: string }) {
  const t = useT();
  const toast = useToast();
  const variants = useVariants(itemId);
  const createVariant = useCreateVariant();
  const updateVariant = useUpdateVariant();
  const deleteVariant = useDeleteVariant();

  const [editor, setEditor] = React.useState<EditorState | null>(null);
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState<string | undefined>();
  const [deleting, setDeleting] = React.useState<Variant | null>(null);

  function openNew() {
    setName("");
    setError(undefined);
    setEditor({ mode: "new" });
  }

  function openEdit(variant: Variant) {
    setName(variant.name);
    setError(undefined);
    setEditor({ mode: "edit", variant });
  }

  function save() {
    const trimmed = name.trim();
    if (trimmed === "") {
      setError(t("menu.errors.required"));
      return;
    }
    const onSuccess = () => {
      toast({
        title:
          editor?.mode === "edit"
            ? t("menu.variants.updatedToast")
            : t("menu.variants.createdToast"),
        tone: "success",
      });
      setEditor(null);
    };
    if (editor?.mode === "edit") {
      updateVariant.mutate(
        { variantId: editor.variant.id, body: { name: trimmed } },
        { onSuccess, onError: () => setError(t("menu.errors.saveFailed")) },
      );
      return;
    }
    createVariant.mutate(
      { itemId, body: { name: trimmed } },
      { onSuccess, onError: () => setError(t("menu.errors.saveFailed")) },
    );
  }

  function confirmDelete() {
    if (!deleting) return;
    deleteVariant.mutate(deleting.id, {
      onSuccess: () => {
        toast({ title: t("menu.variants.deletedToast"), tone: "success" });
        setDeleting(null);
      },
      onError: () =>
        toast({ title: t("menu.errors.deleteInUse"), tone: "danger" }),
    });
  }

  const rows = variants.data?.data ?? [];

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="type-heading">{t("menu.variants.title")}</h3>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("menu.variants.description")}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={openNew}>
          <Plus aria-hidden="true" />
          {t("menu.variants.add")}
        </Button>
      </div>

      {variants.isPending ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t("common.loading")}
        </p>
      ) : variants.isError ? (
        <div className="rounded-container border-(length:--border-w) bg-card p-4 shadow-hairline">
          <p className="text-sm text-danger" role="alert">
            {t("state.errorHint")}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void variants.refetch()}
          >
            {t("common.retry")}
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-container border-(length:--border-w) bg-card px-4 py-6 text-center shadow-hairline">
          <p className="text-sm font-semibold">
            {t("menu.variants.emptyTitle")}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("menu.variants.emptyHint")}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-container border-(length:--border-w) bg-card shadow-hairline">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("menu.variants.columns.name")}</TableHead>
                <TableHead numeric>
                  {t("menu.variants.columns.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((variant) => (
                <TableRow key={variant.id}>
                  <TableCell>{variant.name}</TableCell>
                  <TableCell numeric>
                    <div className="flex justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("menu.variants.edit")}
                        onClick={() => openEdit(variant)}
                      >
                        <Pencil aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("menu.variants.deleteTitle", {
                          name: variant.name,
                        })}
                        onClick={() => setDeleting(variant)}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog
        open={editor !== null}
        onOpenChange={(open) => !open && setEditor(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editor?.mode === "edit"
                ? t("menu.variants.edit")
                : t("menu.variants.add")}
            </DialogTitle>
          </DialogHeader>
          <FormField
            label={t("menu.variants.name")}
            hint={t("menu.variants.nameHint")}
            error={error}
            required
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
            />
          </FormField>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditor(null)}
              disabled={createVariant.isPending || updateVariant.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              loading={createVariant.isPending || updateVariant.isPending}
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
        title={t("menu.variants.deleteTitle", { name: deleting?.name ?? "" })}
        description={t("menu.variants.deleteBody")}
        confirmLabel={t("common.delete")}
        pending={deleteVariant.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
