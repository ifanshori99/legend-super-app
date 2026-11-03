// Create and edit supplier master data (PRD v1.7 §3 F18 "Supplier"; contract
// createSupplierInputSchema / updateSupplierInputSchema). The same dialog
// serves the list screen ("Tambah supplier") and the detail profile section.
import * as React from "react";
import {
  createSupplierInputSchema,
  updateSupplierInputSchema,
  type Supplier,
} from "@starter/shared/inventory";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField, fieldErrors } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  useAttemptKey,
  useCreateSupplier,
  useUpdateSupplier,
} from "../supplier-hooks";

type Draft = {
  name: string;
  legalName: string;
  contactName: string;
  phone: string;
  email: string;
  address: string;
  paymentTermsDays: string;
  rating: string;
  isActive: boolean;
};

const EMPTY_DRAFT: Draft = {
  name: "",
  legalName: "",
  contactName: "",
  phone: "",
  email: "",
  address: "",
  paymentTermsDays: "0",
  rating: "none",
  isActive: true,
};

const RATING_OPTIONS = [
  { value: "1", labelKey: "inventorySuppliers.rating.1" },
  { value: "2", labelKey: "inventorySuppliers.rating.2" },
  { value: "3", labelKey: "inventorySuppliers.rating.3" },
  { value: "4", labelKey: "inventorySuppliers.rating.4" },
  { value: "5", labelKey: "inventorySuppliers.rating.5" },
] as const;

function draftFromSupplier(supplier: Supplier): Draft {
  return {
    name: supplier.name,
    legalName: supplier.legalName ?? "",
    contactName: supplier.contactName ?? "",
    phone: supplier.phone ?? "",
    email: supplier.email ?? "",
    address: supplier.address ?? "",
    paymentTermsDays: String(supplier.paymentTermsDays),
    rating: supplier.rating === null ? "none" : String(supplier.rating),
    isActive: supplier.isActive,
  };
}

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function SupplierForm({
  supplier,
  onClose,
}: {
  /** Existing supplier = edit mode; undefined = create. */
  supplier?: Supplier;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const create = useCreateSupplier();
  const update = useUpdateSupplier();
  const attempt = useAttemptKey();
  // The wrapper mounts this form only while open, so initial state is the reset.
  const [draft, setDraft] = React.useState<Draft>(() =>
    supplier ? draftFromSupplier(supplier) : EMPTY_DRAFT,
  );
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const activeId = React.useId();
  const editing = Boolean(supplier);
  const mutation = editing ? update : create;

  const setField = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const base = {
      name: draft.name.trim(),
      legalName: nullable(draft.legalName),
      contactName: nullable(draft.contactName),
      phone: nullable(draft.phone),
      email: nullable(draft.email),
      address: nullable(draft.address),
      paymentTermsDays: Number(draft.paymentTermsDays),
      rating: draft.rating === "none" ? null : Number(draft.rating),
    };
    setErrors({});
    setFormError(null);
    if (supplier) {
      const parsed = updateSupplierInputSchema.safeParse({
        ...base,
        isActive: draft.isActive,
        expectedUpdatedAt: supplier.updatedAt,
      });
      if (!parsed.success) {
        setErrors(fieldErrors(parsed.error));
        setFormError(t("inventorySuppliers.form.invalid"));
        return;
      }
      try {
        await update.mutateAsync({
          supplierId: supplier.id,
          body: parsed.data,
        });
        toast({
          title: t("inventorySuppliers.form.updated"),
          description: t("inventorySuppliers.form.updatedHint"),
          tone: "success",
        });
        onClose();
      } catch (error) {
        setFormError(
          error instanceof ApiError && error.message.length > 0
            ? error.message
            : t("inventorySuppliers.form.saveError"),
        );
      }
      return;
    }
    const parsed = createSupplierInputSchema.safeParse({
      ...base,
      idempotencyKey: attempt.keyFor(base),
    });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      setFormError(t("inventorySuppliers.form.invalid"));
      return;
    }
    try {
      await create.mutateAsync(parsed.data);
      attempt.settle();
      toast({
        title: t("inventorySuppliers.form.created"),
        description: t("inventorySuppliers.form.createdHint"),
        tone: "success",
      });
      onClose();
    } catch (error) {
      setFormError(
        error instanceof ApiError && error.message.length > 0
          ? error.message
          : t("inventorySuppliers.form.saveError"),
      );
    }
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>
          {editing
            ? t("inventorySuppliers.form.editTitle")
            : t("inventorySuppliers.form.createTitle")}
        </DialogTitle>
        <DialogDescription>
          {editing
            ? t("inventorySuppliers.form.editDescription")
            : t("inventorySuppliers.form.createDescription")}
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="grid gap-4">
        <FormField
          label={t("inventorySuppliers.form.name")}
          required
          error={errors.name}
        >
          <Input
            value={draft.name}
            maxLength={150}
            autoComplete="organization"
            onChange={(event) => setField("name", event.target.value)}
          />
        </FormField>
        <FormField
          label={t("inventorySuppliers.form.legalName")}
          error={errors.legalName}
        >
          <Input
            value={draft.legalName}
            maxLength={200}
            onChange={(event) => setField("legalName", event.target.value)}
          />
        </FormField>
        <FormField
          label={t("inventorySuppliers.form.contactName")}
          error={errors.contactName}
        >
          <Input
            value={draft.contactName}
            maxLength={150}
            onChange={(event) => setField("contactName", event.target.value)}
          />
        </FormField>
        <FormField
          label={t("inventorySuppliers.form.phone")}
          hint={t("inventorySuppliers.form.phoneHint")}
          error={errors.phone}
        >
          <Input
            type="tel"
            value={draft.phone}
            autoComplete="tel"
            onChange={(event) => setField("phone", event.target.value)}
          />
        </FormField>
        <FormField
          label={t("inventorySuppliers.form.email")}
          error={errors.email}
        >
          <Input
            type="email"
            value={draft.email}
            autoComplete="email"
            onChange={(event) => setField("email", event.target.value)}
          />
        </FormField>
        <FormField
          label={t("inventorySuppliers.form.address")}
          error={errors.address}
        >
          <Input
            value={draft.address}
            maxLength={300}
            onChange={(event) => setField("address", event.target.value)}
          />
        </FormField>
        <FormField
          label={t("inventorySuppliers.form.paymentTermsDays")}
          hint={t("inventorySuppliers.form.paymentTermsHint")}
          required
          error={errors.paymentTermsDays}
        >
          <Input
            type="number"
            min={0}
            max={365}
            step={1}
            value={draft.paymentTermsDays}
            onChange={(event) =>
              setField("paymentTermsDays", event.target.value)
            }
          />
        </FormField>
        <FormField
          label={t("inventorySuppliers.form.rating")}
          hint={t("inventorySuppliers.form.ratingHint")}
          error={errors.rating}
        >
          <Select
            value={draft.rating}
            onValueChange={(value) => setField("rating", value)}
          >
            <SelectTrigger aria-label={t("inventorySuppliers.form.rating")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">
                {t("inventorySuppliers.form.ratingNone")}
              </SelectItem>
              {RATING_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        {editing && (
          <div className="flex items-center gap-2">
            <Checkbox
              id={activeId}
              checked={draft.isActive}
              onCheckedChange={(checked) =>
                setField("isActive", checked === true)
              }
            />
            <Label htmlFor={activeId}>
              {t("inventorySuppliers.form.isActive")}
            </Label>
          </div>
        )}
        {formError && (
          <p role="alert" className="text-sm leading-5 font-medium text-danger">
            {formError}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onClose()}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            {editing
              ? t("inventorySuppliers.form.submitEdit")
              : t("inventorySuppliers.form.submitCreate")}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

export function SupplierFormDialog({
  open,
  onOpenChange,
  supplier,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supplier?: Supplier;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <SupplierForm
          supplier={supplier}
          onClose={() => {
            onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}
