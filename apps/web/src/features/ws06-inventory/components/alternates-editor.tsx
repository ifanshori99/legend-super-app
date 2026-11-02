// Substitute ingredients ("bahan alternatif", PRD §16): an ordered list of
// other items that can replace this one. Lower priority wins. Alternatives
// are their own rows in the contract, not a field on the item.
import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { z } from "zod";
import type { InventoryItem } from "@starter/shared/inventory";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback-state";
import { fieldErrors, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import {
  useCreateAlternate,
  useDeleteAlternate,
  useItemAlternates,
} from "../hooks";
import { alternatesFor } from "../lib";

export function AlternatesEditor({
  itemId,
  items,
}: {
  itemId: string;
  items: readonly InventoryItem[];
}) {
  const t = useT();
  const toast = useToast();
  const alternatesQuery = useItemAlternates(itemId);
  const createAlternate = useCreateAlternate();
  const deleteAlternate = useDeleteAlternate();

  const alternates = alternatesFor(alternatesQuery.data?.data ?? [], itemId);
  const candidates = React.useMemo(
    () =>
      items
        .filter(
          (item) =>
            item.id !== itemId &&
            !alternates.some((row) => row.alternateItemId === item.id),
        )
        .sort((a, b) => a.name.localeCompare(b.name, "id-ID")),
    [items, itemId, alternates],
  );

  const [alternateItemId, setAlternateItemId] = React.useState("");
  const [priority, setPriority] = React.useState("0");
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [formError, setFormError] = React.useState<string | undefined>();

  const selected = alternateItemId || candidates[0]?.id || "";

  const schema = React.useMemo(
    () =>
      z.object({
        alternateItemId: z.string().min(1, t("inventory.errors.required")),
        priority: z
          .string()
          .trim()
          .regex(/^\d+$/, t("inventory.errors.invalidAmount")),
      }),
    [t],
  );

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = schema.safeParse({ alternateItemId: selected, priority });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      setFormError(
        t("form.errorSummary", { count: parsed.error.issues.length }),
      );
      return;
    }
    setErrors({});
    setFormError(undefined);
    createAlternate.mutate(
      {
        params: { itemId },
        body: {
          alternateItemId: parsed.data.alternateItemId,
          priority: Number(parsed.data.priority),
          idempotencyKey: crypto.randomUUID(),
        },
      },
      {
        onSuccess: () => {
          toast({
            title: t("inventory.editor.alternates.added"),
            tone: "success",
          });
          setAlternateItemId("");
          setPriority("0");
        },
        onError: (error) =>
          setFormError(
            error instanceof ApiError
              ? error.message
              : t("inventory.errors.saveFailed"),
          ),
      },
    );
  }

  function remove(alternateId: string) {
    deleteAlternate.mutate(
      { itemId, alternateId },
      {
        onSuccess: () =>
          toast({
            title: t("inventory.editor.alternates.removed"),
            tone: "success",
          }),
        onError: () =>
          toast({ title: t("inventory.errors.saveFailed"), tone: "danger" }),
      },
    );
  }

  return (
    <div className="grid min-w-0 gap-3">
      {alternatesQuery.isPending ? (
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      ) : alternates.length === 0 ? (
        <EmptyState
          title={t("inventory.editor.alternates.empty")}
          description={t("inventory.editor.alternates.emptyHint")}
          className="rounded-lg border"
        />
      ) : (
        <ul className="grid gap-2">
          {alternates.map((alternate) => {
            const item = items.find(
              (row) => row.id === alternate.alternateItemId,
            );
            return (
              <li
                key={alternate.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {item?.name ?? t("inventory.errors.notFound")}
                  </span>
                  <Badge tone="neutral">
                    {t("inventory.editor.alternates.priorityValue", {
                      priority: alternate.priority,
                    })}
                  </Badge>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("inventory.editor.alternates.remove", {
                    name: item?.name ?? "",
                  })}
                  disabled={deleteAlternate.isPending}
                  onClick={() => remove(alternate.id)}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("inventory.editor.alternates.noCandidates")}
        </p>
      ) : (
        <form
          className="grid gap-3 rounded-lg border bg-muted/40 p-3 sm:grid-cols-2"
          onSubmit={submit}
          noValidate
        >
          <FormField
            label={t("inventory.editor.alternates.item")}
            error={errors.alternateItemId}
            required
          >
            <Select value={selected} onValueChange={setAlternateItemId}>
              <SelectTrigger>
                <SelectValue
                  placeholder={t("inventory.editor.alternates.item")}
                />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            label={t("inventory.editor.alternates.priority")}
            hint={t("inventory.editor.alternates.priorityHint")}
            error={errors.priority}
            required
          >
            <Input
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
              inputMode="numeric"
              autoComplete="off"
            />
          </FormField>
          <Button
            type="submit"
            variant="outline"
            loading={createAlternate.isPending}
            className="sm:col-span-2 sm:justify-self-end"
          >
            <Plus aria-hidden="true" />
            {t("inventory.editor.alternates.add")}
          </Button>
          {formError && (
            <p
              role="alert"
              className="rounded-lg border border-danger bg-danger-subtle px-3 py-2 text-sm font-medium text-danger sm:col-span-2"
            >
              {formError}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
