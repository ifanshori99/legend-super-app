// Per-item unit conversions ("satuan beli, satuan simpan, satuan resep",
// PRD §16). One row per purchase/storage pair; the factor is how many of the
// target unit one source unit holds. Used by the item editor and the units
// screen, so both stay identical.
import * as React from "react";
import { Trash2 } from "lucide-react";
import { parseDecimal4 } from "@starter/shared/core";
import type { Uom } from "@starter/shared/inventory";
import { z } from "zod";
import { useT } from "@/components/i18n";
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
import {
  useConversions,
  useCreateConversion,
  useDeleteConversion,
} from "../hooks";
import { decimalFromInput, formatQuantity } from "../lib";

function unitName(units: readonly Uom[], id: string): string {
  const unit = units.find((row) => row.id === id);
  return unit ? `${unit.code} — ${unit.name}` : "—";
}

export function ConversionsEditor({
  itemId,
  itemName,
  units,
}: {
  itemId: string;
  itemName: string;
  units: readonly Uom[];
}) {
  const t = useT();
  const toast = useToast();
  const conversionsQuery = useConversions(itemId);
  const createConversion = useCreateConversion();
  const deleteConversion = useDeleteConversion();

  const conversions = conversionsQuery.data?.data ?? [];

  const [fromUomId, setFromUomId] = React.useState("");
  const [toUomId, setToUomId] = React.useState("");
  const [factor, setFactor] = React.useState("");
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [formError, setFormError] = React.useState<string | undefined>();

  const fromValue = fromUomId || units[0]?.id || "";
  const toValue =
    toUomId ||
    units.find((unit) => unit.id !== fromValue)?.id ||
    units[1]?.id ||
    "";

  const schema = React.useMemo(
    () =>
      z
        .object({
          fromUomId: z.string().min(1, t("inventory.units.fromUom")),
          toUomId: z.string().min(1, t("inventory.units.toUom")),
          factor: z
            .string()
            .trim()
            .min(1, t("inventory.errors.required"))
            .refine(
              (value) => {
                const parsed = decimalFromInput(value);
                return parsed !== null && parseDecimal4(parsed) > 0n;
              },
              { message: t("inventory.units.invalidFactor") },
            ),
        })
        .refine((value) => value.fromUomId !== value.toUomId, {
          path: ["toUomId"],
          message: t("inventory.units.invalidFactor"),
        }),
    [t],
  );

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = schema.safeParse({
      fromUomId: fromValue,
      toUomId: toValue,
      factor,
    });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      setFormError(
        t("form.errorSummary", { count: parsed.error.issues.length }),
      );
      return;
    }
    setErrors({});
    setFormError(undefined);
    const normalized = decimalFromInput(parsed.data.factor);
    if (normalized === null) return;
    createConversion.mutate(
      {
        params: { itemId },
        body: {
          fromUomId: parsed.data.fromUomId,
          toUomId: parsed.data.toUomId,
          factor: normalized,
          idempotencyKey: crypto.randomUUID(),
        },
      },
      {
        onSuccess: () => {
          toast({
            title: t("inventory.units.conversionAdded"),
            tone: "success",
          });
          setFactor("");
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

  function remove(conversionId: string) {
    deleteConversion.mutate(
      { itemId, conversionId },
      {
        onSuccess: () =>
          toast({
            title: t("inventory.units.conversionRemoved"),
            tone: "success",
          }),
        onError: () =>
          toast({ title: t("inventory.errors.saveFailed"), tone: "danger" }),
      },
    );
  }

  return (
    <div className="grid min-w-0 gap-3">
      <div className="grid gap-1">
        <h3 className="text-base leading-6 font-semibold">
          {t("inventory.units.conversionsTitle", { item: itemName })}
        </h3>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("inventory.units.conversionsHint")}
        </p>
      </div>

      {conversionsQuery.isPending ? (
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      ) : conversions.length === 0 ? (
        <EmptyState
          title={t("inventory.units.emptyConversions")}
          description={t("inventory.units.emptyConversionsHint")}
          className="rounded-lg border"
        />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("inventory.units.conversionColumns.from")}
                </TableHead>
                <TableHead>
                  {t("inventory.units.conversionColumns.to")}
                </TableHead>
                <TableHead numeric>
                  {t("inventory.units.conversionColumns.factor")}
                </TableHead>
                <TableHead className="text-right">
                  {t("inventory.units.conversionColumns.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {conversions.map((conversion) => (
                <TableRow key={conversion.id}>
                  <TableCell>{unitName(units, conversion.fromUomId)}</TableCell>
                  <TableCell>{unitName(units, conversion.toUomId)}</TableCell>
                  <TableCell numeric>
                    {formatQuantity(conversion.factor)}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("inventory.units.removeConversion", {
                          from: unitName(units, conversion.fromUomId),
                          to: unitName(units, conversion.toUomId),
                        })}
                        disabled={deleteConversion.isPending}
                        onClick={() => remove(conversion.id)}
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

      <form
        className="grid gap-3 rounded-lg border bg-muted/40 p-3 sm:grid-cols-3"
        onSubmit={submit}
        noValidate
      >
        <FormField label={t("inventory.units.fromUom")} required>
          <Select value={fromValue} onValueChange={setFromUomId}>
            <SelectTrigger>
              <SelectValue placeholder={t("inventory.units.fromUom")} />
            </SelectTrigger>
            <SelectContent>
              {units.map((unit) => (
                <SelectItem key={unit.id} value={unit.id}>
                  {unit.code} — {unit.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField
          label={t("inventory.units.toUom")}
          error={errors.toUomId}
          required
        >
          <Select value={toValue} onValueChange={setToUomId}>
            <SelectTrigger>
              <SelectValue placeholder={t("inventory.units.toUom")} />
            </SelectTrigger>
            <SelectContent>
              {units.map((unit) => (
                <SelectItem key={unit.id} value={unit.id}>
                  {unit.code} — {unit.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField
          label={t("inventory.units.factor")}
          hint={t("inventory.units.factorHint")}
          error={errors.factor}
          required
        >
          <Input
            value={factor}
            onChange={(event) => setFactor(event.target.value)}
            inputMode="decimal"
            autoComplete="off"
          />
        </FormField>
        <Button
          type="submit"
          variant="outline"
          loading={createConversion.isPending}
          className="sm:col-span-3 sm:justify-self-end"
        >
          {t("inventory.units.addConversion")}
        </Button>
        {formError && (
          <p
            role="alert"
            className="rounded-lg border border-danger bg-danger-subtle px-3 py-2 text-sm font-medium text-danger sm:col-span-3"
          >
            {formError}
          </p>
        )}
      </form>
    </div>
  );
}
