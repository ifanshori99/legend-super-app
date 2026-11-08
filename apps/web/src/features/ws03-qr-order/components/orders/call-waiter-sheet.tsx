// "Panggil waiter" bottom sheet (PRD §3 F10 "Panggil Waiter": tambah pesanan,
// minta alat makan, keluhan). The form lives in a child of SheetContent, so it
// starts empty each time the sheet opens and keeps its values after a failed
// send.
import * as React from "react";
import { cn } from "cn";
import { Bell, CircleAlert } from "lucide-react";
import { RadioGroup } from "radix-ui";
import type { ServiceRequestReason } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { FormField } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useSendServiceRequest } from "@/features/ws03-qr-order/hooks";
import type { MessageKey } from "@starter/shared/i18n";

const REASONS = [
  { value: "add_order", label: "qrOrders.status.call.reasonAddOrder" },
  { value: "utensils", label: "qrOrders.status.call.reasonUtensils" },
  { value: "complaint", label: "qrOrders.status.call.reasonComplaint" },
  { value: "other", label: "qrOrders.status.call.reasonOther" },
] as const satisfies readonly {
  value: ServiceRequestReason;
  label: MessageKey;
}[];

const MESSAGE_MIN = 3;
const MESSAGE_MAX = 500;

function CallWaiterForm({
  sessionId,
  onDone,
}: {
  sessionId: string;
  onDone: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const send = useSendServiceRequest(sessionId);
  const [reason, setReason] = React.useState<ServiceRequestReason | null>(null);
  const [message, setMessage] = React.useState("");
  const [submitted, setSubmitted] = React.useState(false);

  const trimmed = message.trim();
  const reasonError =
    submitted && reason === null
      ? t("qrOrders.status.call.reasonRequired")
      : undefined;
  const messageError =
    submitted && reason === "complaint"
      ? trimmed.length < MESSAGE_MIN
        ? t("qrOrders.status.call.messageTooShort")
        : trimmed.length > MESSAGE_MAX
          ? t("qrOrders.status.call.messageTooLong")
          : undefined
      : undefined;

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (reason === null) return;
    // Contract createServiceRequestInputSchema: a waiter call needs a reason, a
    // complaint needs a message of 3+ letters. The "Keluhan" choice always
    // carries a message, so it goes out as type "complaint" (the shape the
    // waiter app reads the text from); the other reasons are plain waiter calls.
    if (reason === "complaint") {
      if (trimmed.length < MESSAGE_MIN || trimmed.length > MESSAGE_MAX) return;
      send.mutate(
        { type: "complaint", message: trimmed },
        { onSuccess: succeed },
      );
      return;
    }
    send.mutate({ type: "call_waiter", reason }, { onSuccess: succeed });
  }

  function succeed() {
    toast({ title: t("qrOrders.status.call.success"), tone: "success" });
    onDone();
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4">
      <div className="grid gap-1.5">
        <p id="call-reason-label" className="text-sm leading-5 font-semibold">
          {t("qrOrders.status.call.reasonLabel")}
        </p>
        <RadioGroup.Root
          value={reason ?? ""}
          onValueChange={(value) => setReason(value as ServiceRequestReason)}
          aria-labelledby="call-reason-label"
          aria-invalid={reasonError ? true : undefined}
          aria-describedby={reasonError ? "call-reason-error" : undefined}
          required
          className="grid gap-2"
        >
          {REASONS.map(({ value, label }) => (
            <label
              key={value}
              className={cn(
                "flex min-h-control cursor-pointer items-center gap-3 rounded-qr-media border-(length:--border-w) px-4 text-(length:--density-text) font-medium",
                reason === value
                  ? "border-primary bg-qr-selection"
                  : "border-input bg-card",
              )}
            >
              <RadioGroup.Item
                value={value}
                className="grid size-5 shrink-0 place-items-center rounded-full border-2 border-input data-[state=checked]:border-primary"
              >
                <RadioGroup.Indicator className="size-2.5 rounded-full bg-primary" />
              </RadioGroup.Item>
              {t(label)}
            </label>
          ))}
        </RadioGroup.Root>
        <div id="call-reason-error" aria-live="polite">
          {reasonError && (
            <p className="flex items-start gap-1.5 text-sm leading-5 font-medium text-danger">
              <CircleAlert
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              {reasonError}
            </p>
          )}
        </div>
      </div>

      {reason === "complaint" && (
        <FormField
          label={t("qrOrders.status.call.messageLabel")}
          hint={t("qrOrders.status.call.messageHint", {
            count: message.length,
          })}
          error={messageError}
          required
        >
          <Textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            maxLength={MESSAGE_MAX}
            rows={4}
          />
        </FormField>
      )}

      <div aria-live="polite">
        {send.isError && (
          <p
            role="alert"
            className="flex items-start gap-1.5 text-sm leading-5 font-medium text-danger"
          >
            <CircleAlert
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            {t("qrOrders.status.call.sendError")}
          </p>
        )}
      </div>

      <SheetFooter>
        <Button type="submit" loading={send.isPending}>
          {send.isPending
            ? t("qrOrders.status.call.submitting")
            : t("qrOrders.status.call.submit")}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("qrOrders.status.call.cancel")}
        </Button>
      </SheetFooter>
    </form>
  );
}

export function CallWaiterSheet({
  sessionId,
  disabled,
  variant = "outline",
  icon: Icon = Bell,
}: {
  sessionId: string;
  disabled: boolean;
  /** "ghost" in the QR desktop header (legend-2re1). */
  variant?: "outline" | "ghost";
  icon?: React.ComponentType<{ "aria-hidden"?: boolean | "true" }>;
}) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant={variant} disabled={disabled}>
          <Icon aria-hidden="true" />
          {t("qrOrders.status.waiter.callButton")}
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom">
        <SheetHeader>
          <SheetTitle>{t("qrOrders.status.call.title")}</SheetTitle>
          <SheetDescription>
            {t("qrOrders.status.call.description")}
          </SheetDescription>
        </SheetHeader>
        <CallWaiterForm sessionId={sessionId} onDone={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
