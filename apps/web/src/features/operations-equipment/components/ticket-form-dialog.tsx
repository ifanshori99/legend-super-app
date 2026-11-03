// Report a breakdown (PRD v1.7 §3 F45): at least one photo, urgency, service
// vendor and estimated cost, plus the OPS-04 switch that marks the equipment
// broken and disables its mapped menu items.
//
// The photo is a local preview only: the contract wants media ids, and the
// real media-upload endpoint is not part of this bead. The mock mints a media
// id for the selected file; wiring the upload is a reported follow-up.
import * as React from "react";
import {
  createMaintenanceTicketInputSchema,
  type Equipment,
  type MaintenanceUrgency,
} from "@starter/shared/operations";
import type { MenuItemAdmin } from "@starter/shared/menu";
import type { Supplier } from "@starter/shared/inventory";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MediaPlate } from "@/components/ui/media-plate";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { newIdempotencyKey } from "@/lib/idempotency";
import { URGENCY_KEYS, toWholeRupiah } from "../lib.ts";
import { useAttemptKey, useCreateTicket } from "../hooks.ts";

const URGENCIES: MaintenanceUrgency[] = ["low", "medium", "high", "critical"];
type VendorOption = Pick<Supplier, "id" | "name">;

export function TicketFormDialog({
  outletId,
  equipmentOptions,
  vendors,
  menuItems,
  menuItemsLoading,
  menuItemsFailed,
  defaultEquipmentId,
  trigger,
}: {
  outletId: string;
  equipmentOptions: readonly Equipment[];
  vendors: readonly VendorOption[];
  menuItems: readonly MenuItemAdmin[];
  menuItemsLoading: boolean;
  menuItemsFailed: boolean;
  defaultEquipmentId?: string;
  trigger: React.ReactElement;
}) {
  const t = useT();
  const toast = useToast();
  const create = useCreateTicket();
  const attempt = useAttemptKey();
  const [open, setOpen] = React.useState(false);
  const [equipmentId, setEquipmentId] = React.useState(
    defaultEquipmentId ?? equipmentOptions[0]?.id ?? "",
  );
  const [urgency, setUrgency] = React.useState<MaintenanceUrgency>("medium");
  const [description, setDescription] = React.useState("");
  const [vendorId, setVendorId] = React.useState("none");
  const [cost, setCost] = React.useState("");
  const [marksBroken, setMarksBroken] = React.useState(true);
  const [file, setFile] = React.useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    // Reset the dialog each time it opens (React lint flags setState in an
    // effect; the form intentionally starts blank).
    /* eslint-disable react-hooks/set-state-in-effect */
    setEquipmentId(defaultEquipmentId ?? equipmentOptions[0]?.id ?? "");
    setUrgency("medium");
    setDescription("");
    setVendorId("none");
    setCost("");
    setMarksBroken(true);
    setFile(null);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, defaultEquipmentId, equipmentOptions]);

  React.useEffect(() => {
    // The preview URL is an external resource owned by the file input: create
    // it when the file changes and revoke it on cleanup.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    /* eslint-enable react-hooks/set-state-in-effect */
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const selectedEquipment =
    equipmentOptions.find((row) => row.id === equipmentId) ?? null;
  const lockedEquipment = defaultEquipmentId ? selectedEquipment : null;
  const menuName = new Map(menuItems.map((item) => [item.id, item.name]));
  const affectedMenus = (selectedEquipment?.linkedMenuItemIds ?? [])
    .map((id) => menuName.get(id))
    .filter((name): name is string => Boolean(name));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!file) {
      setError(t("opsEquipment.equipment.ticketForm.photoMissing"));
      return;
    }
    const costIdr = toWholeRupiah(cost);
    if (cost.trim() && costIdr === null) {
      setError(t("opsEquipment.equipment.ticketForm.invalid"));
      return;
    }
    const payload = {
      outletId,
      equipmentId,
      urgency,
      description,
      vendorId: vendorId === "none" ? null : vendorId,
      costIdr,
      marksEquipmentBroken: marksBroken,
    };
    const parsed = createMaintenanceTicketInputSchema.safeParse({
      ...payload,
      // Mock-only media id: a real flow uploads the photo first and sends the
      // media id the upload endpoint returns (follow-up).
      mediaIds: [newIdempotencyKey()],
      idempotencyKey: attempt.keyFor(payload),
    });
    if (!parsed.success) {
      setError(t("opsEquipment.equipment.ticketForm.invalid"));
      return;
    }
    try {
      await create.mutateAsync(parsed.data);
      attempt.settle();
      toast({
        title: t("opsEquipment.equipment.toasts.ticketCreated"),
        tone: "success",
      });
      setOpen(false);
    } catch {
      setError(t("opsEquipment.errors.action"));
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("opsEquipment.equipment.ticketForm.title")}
          </DialogTitle>
          <DialogDescription>
            {t("opsEquipment.equipment.ticketForm.marksBrokenHint")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4" noValidate>
          {lockedEquipment ? (
            <FormField label={t("opsEquipment.equipment.ticketForm.equipment")}>
              <Input value={lockedEquipment.name} readOnly />
            </FormField>
          ) : (
            <FormField
              label={t("opsEquipment.equipment.ticketForm.equipment")}
              required
            >
              <Select value={equipmentId} onValueChange={setEquipmentId}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={t(
                      "opsEquipment.equipment.ticketForm.chooseEquipment",
                    )}
                  />
                </SelectTrigger>
                <SelectContent>
                  {equipmentOptions.map((row) => (
                    <SelectItem
                      key={row.id}
                      value={row.id}
                      className="min-h-11"
                    >
                      {row.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          )}
          <FormField
            label={t("opsEquipment.equipment.ticketForm.urgency")}
            required
          >
            <Select
              value={urgency}
              onValueChange={(value) => setUrgency(value as MaintenanceUrgency)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {URGENCIES.map((value) => (
                  <SelectItem key={value} value={value} className="min-h-11">
                    {t(URGENCY_KEYS[value])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            label={t("opsEquipment.equipment.ticketForm.description")}
            required
          >
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
            />
          </FormField>
          <FormField
            label={t("opsEquipment.equipment.ticketForm.photo")}
            hint={t("opsEquipment.equipment.ticketForm.photoHint")}
            required
          >
            <Input
              type="file"
              accept="image/*"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </FormField>
          {file && (
            <div className="grid gap-2" data-slot="ticket-photo-preview">
              <MediaPlate
                src={previewUrl}
                alt={t("opsEquipment.equipment.ticketForm.photoAlt", {
                  name: file.name,
                })}
                ratio="card"
                className="max-w-48"
              />
              <p className="text-sm text-muted-foreground">
                {t("opsEquipment.equipment.ticketForm.photoSelected", {
                  name: file.name,
                })}
              </p>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t("opsEquipment.equipment.ticketForm.vendor")}>
              <Select value={vendorId} onValueChange={setVendorId}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={t(
                      "opsEquipment.equipment.scheduleForm.chooseVendor",
                    )}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none" className="min-h-11">
                    {t("opsEquipment.equipment.scheduleForm.noVendor")}
                  </SelectItem>
                  {vendors.map((vendor) => (
                    <SelectItem
                      key={vendor.id}
                      value={vendor.id}
                      className="min-h-11"
                    >
                      {vendor.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label={t("opsEquipment.equipment.ticketForm.cost")}>
              <Input
                type="number"
                min="0"
                step="1"
                value={cost}
                onChange={(event) => setCost(event.target.value)}
              />
            </FormField>
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              id="ticket-marks-broken"
              checked={marksBroken}
              onCheckedChange={(checked) => setMarksBroken(checked === true)}
            />
            <div className="grid gap-1">
              <Label htmlFor="ticket-marks-broken">
                {t("opsEquipment.equipment.ticketForm.marksBroken")}
              </Label>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("opsEquipment.equipment.ticketForm.marksBrokenHint")}
              </p>
            </div>
          </div>
          <section
            aria-label={t("opsEquipment.equipment.ticketForm.affectedMenus")}
            data-slot="affected-menu-preview"
            className="grid gap-2 rounded-container border border-border p-3"
          >
            <h3 className="text-sm font-semibold">
              {t("opsEquipment.equipment.ticketForm.affectedMenus")}
            </h3>
            {!marksBroken ? (
              <p className="text-sm text-muted-foreground">
                {t("opsEquipment.equipment.ticketForm.affectedMenusOff")}
              </p>
            ) : menuItemsLoading ? (
              <p className="text-sm text-muted-foreground">
                {t("opsEquipment.equipment.form.menusLoading")}
              </p>
            ) : menuItemsFailed ? (
              <p className="text-sm text-danger">
                {t("opsEquipment.equipment.form.menusFailed")}
              </p>
            ) : affectedMenus.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("opsEquipment.equipment.ticketForm.affectedMenusEmpty")}
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {affectedMenus.map((name) => (
                  <li
                    key={name}
                    data-slot="affected-menu-item"
                    className="rounded-full bg-danger-subtle px-2.5 py-0.5 text-sm font-semibold text-danger"
                  >
                    {name}
                  </li>
                ))}
              </ul>
            )}
          </section>
          {error && (
            <p role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" loading={create.isPending}>
              {t("opsEquipment.equipment.ticketForm.save")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              {t("common.cancel")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
