// "Daftarkan perangkat": back-office enrollment through the cloud registry
// (POST /api/devices, needs device.registry.manage). The signed token in the
// answer is handed to the caller (shown once) and is not kept here.
import * as React from "react";
import type { Device } from "@starter/shared/edge";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
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
import { newIdempotencyKey } from "@/lib/idempotency";
import { deviceErrorMessage } from "../errors.ts";
import { useEnrollDevice } from "../hooks.ts";
import { DEVICE_TYPES, DEVICE_TYPE_LABEL, enrollLabelValid } from "../logic.ts";
import type { IssuedToken } from "./device-token-dialog.tsx";

export function EnrollDialog({
  open,
  outlets,
  defaultOutletId,
  onOpenChange,
  onEnrolled,
}: {
  open: boolean;
  outlets: readonly { id: string; name: string }[];
  /** Pre-selected outlet (the registry's outlet filter, when one is chosen). */
  defaultOutletId?: string;
  onOpenChange: (open: boolean) => void;
  onEnrolled: (issued: IssuedToken) => void;
}) {
  const t = useT();
  const enroll = useEnrollDevice(({ device, token }) =>
    onEnrolled({ token, deviceLabel: device.label, kind: "enrolled" }),
  );
  const [outletId, setOutletId] = React.useState(defaultOutletId ?? "");
  const [type, setType] = React.useState<Device["type"]>("pos");
  const [label, setLabel] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  // One key per confirmation: a retry after a network error replays the same
  // request instead of enrolling a second device.
  const keyRef = React.useRef<string | null>(null);

  const reset = () => {
    setOutletId(defaultOutletId ?? "");
    setType("pos");
    setLabel("");
    setTouched(false);
    setServerError(null);
    keyRef.current = null;
    enroll.reset();
  };
  const pending = enroll.isPending;
  const close = () => {
    // The one-time token is still on its way: closing now would lose it.
    if (pending) return;
    reset();
    onOpenChange(false);
  };
  const outletOk = outlets.some((o) => o.id === outletId);
  const labelOk = enrollLabelValid(label);
  const changed = () => {
    keyRef.current = null;
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!outletOk || !labelOk || enroll.isPending) return;
    setServerError(null);
    const idempotencyKey = (keyRef.current ??= newIdempotencyKey());
    enroll.mutate(
      { outletId, type, label: label.trim(), idempotencyKey },
      {
        onSuccess: () => {
          reset();
          onOpenChange(false);
        },
        onError: (error) => setServerError(deviceErrorMessage(error, t)),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <DialogContent
        hideClose={pending}
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
        onInteractOutside={(event) => pending && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t("deviceRegistry.enroll.title")}</DialogTitle>
          <DialogDescription>
            {t("deviceRegistry.enroll.description")}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={submit} noValidate>
          <FormField
            label={t("deviceRegistry.enroll.outletLabel")}
            error={
              touched && !outletOk
                ? t("deviceRegistry.enroll.outletError")
                : undefined
            }
            hint={
              outlets.length === 0
                ? t("deviceRegistry.enroll.noOutlets")
                : undefined
            }
            required
          >
            <Select
              value={outletId}
              onValueChange={(value) => {
                setOutletId(value);
                changed();
              }}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={t("deviceRegistry.enroll.outletPlaceholder")}
                />
              </SelectTrigger>
              <SelectContent>
                {outlets.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label={t("deviceRegistry.enroll.typeLabel")} required>
            <Select
              value={type}
              onValueChange={(value) => {
                setType(value as Device["type"]);
                changed();
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEVICE_TYPES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(DEVICE_TYPE_LABEL[item])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            label={t("deviceRegistry.enroll.nameLabel")}
            hint={t("deviceRegistry.enroll.nameHint")}
            error={
              touched && !labelOk
                ? t("deviceRegistry.enroll.nameError")
                : undefined
            }
            required
          >
            <Input
              value={label}
              onChange={(event) => {
                setLabel(event.target.value);
                changed();
              }}
              maxLength={255}
              autoComplete="off"
            />
          </FormField>
          {serverError && (
            <p role="alert" className="text-sm text-danger">
              {serverError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={close}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={pending}>
              {t("deviceRegistry.enroll.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
