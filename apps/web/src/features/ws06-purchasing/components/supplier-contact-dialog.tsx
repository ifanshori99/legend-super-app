// Add one supplier contact (contract createSupplierContactInputSchema). The
// primary flag decides who receives a PO (`primarySupplierContact`); the mock
// and the API keep at most one primary per supplier.
import * as React from "react";
import { createSupplierContactInputSchema } from "@starter/shared/inventory";
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
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { useAttemptKey, useCreateSupplierContact } from "../supplier-hooks";

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function SupplierContactForm({
  supplierId,
  defaultPrimary,
  onClose,
}: {
  supplierId: string;
  /** First contact is primary by default. */
  defaultPrimary: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const create = useCreateSupplierContact();
  const attempt = useAttemptKey();
  // The wrapper mounts this form only while open, so initial state is the reset.
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [isPrimary, setIsPrimary] = React.useState(defaultPrimary);
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const primaryId = React.useId();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const payload = {
      name: name.trim(),
      role: nullable(role),
      phone: phone.trim(),
      email: nullable(email),
      isPrimary,
    };
    setErrors({});
    setFormError(null);
    const parsed = createSupplierContactInputSchema.safeParse({
      ...payload,
      idempotencyKey: attempt.keyFor(payload),
    });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      setFormError(t("inventorySuppliers.contacts.saveError"));
      return;
    }
    try {
      await create.mutateAsync({ supplierId, body: parsed.data });
      attempt.settle();
      toast({
        title: t("inventorySuppliers.contacts.created"),
        description: t("inventorySuppliers.contacts.createdHint"),
        tone: "success",
      });
      onClose();
    } catch (error) {
      setFormError(
        error instanceof ApiError && error.message.length > 0
          ? error.message
          : t("inventorySuppliers.contacts.saveError"),
      );
    }
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>
          {t("inventorySuppliers.contacts.dialogTitle")}
        </DialogTitle>
        <DialogDescription>
          {t("inventorySuppliers.contacts.dialogDescription")}
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="grid gap-4">
        <FormField
          label={t("inventorySuppliers.contacts.dialogName")}
          required
          error={errors.name}
        >
          <Input
            value={name}
            maxLength={150}
            autoComplete="name"
            onChange={(event) => setName(event.target.value)}
          />
        </FormField>
        <FormField
          label={t("inventorySuppliers.contacts.dialogRole")}
          error={errors.role}
        >
          <Input
            value={role}
            maxLength={60}
            onChange={(event) => setRole(event.target.value)}
          />
        </FormField>
        <FormField
          label={t("inventorySuppliers.contacts.dialogPhone")}
          hint={t("inventorySuppliers.form.phoneHint")}
          required
          error={errors.phone}
        >
          <Input
            type="tel"
            value={phone}
            autoComplete="tel"
            onChange={(event) => setPhone(event.target.value)}
          />
        </FormField>
        <FormField
          label={t("inventorySuppliers.contacts.dialogEmail")}
          error={errors.email}
        >
          <Input
            type="email"
            value={email}
            autoComplete="email"
            onChange={(event) => setEmail(event.target.value)}
          />
        </FormField>
        <div className="grid gap-1">
          <div className="flex items-center gap-2">
            <Checkbox
              id={primaryId}
              checked={isPrimary}
              onCheckedChange={(checked) => setIsPrimary(checked === true)}
            />
            <Label htmlFor={primaryId}>
              {t("inventorySuppliers.contacts.dialogPrimary")}
            </Label>
          </div>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("inventorySuppliers.contacts.dialogPrimaryHint")}
          </p>
        </div>
        {formError && (
          <p role="alert" className="text-sm leading-5 font-medium text-danger">
            {formError}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onClose()}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={create.isPending}>
            {t("inventorySuppliers.contacts.dialogSubmit")}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

export function SupplierContactDialog({
  supplierId,
  defaultPrimary,
  open,
  onOpenChange,
}: {
  supplierId: string;
  defaultPrimary: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <SupplierContactForm
          supplierId={supplierId}
          defaultPrimary={defaultPrimary}
          onClose={() => {
            onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}
