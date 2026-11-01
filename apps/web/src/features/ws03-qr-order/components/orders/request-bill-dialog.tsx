// "Minta tagihan" confirmation (PRD §3 F10 "Minta Tagihan": the request lands
// on the phone of the zone waiter).
import * as React from "react";
import { CircleAlert, Receipt } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { useSendServiceRequest } from "@/features/ws03-qr-order/hooks";

function ConfirmBody({
  sessionId,
  onDone,
}: {
  sessionId: string;
  onDone: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const send = useSendServiceRequest(sessionId);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("qrOrders.status.bill.title")}</DialogTitle>
        <DialogDescription>
          {t("qrOrders.status.bill.description")}
        </DialogDescription>
      </DialogHeader>
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
            {t("qrOrders.status.bill.sendError")}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button
          loading={send.isPending}
          onClick={() =>
            send.mutate(
              { type: "request_bill" },
              {
                onSuccess: () => {
                  toast({
                    title: t("qrOrders.status.bill.success"),
                    tone: "success",
                  });
                  onDone();
                },
              },
            )
          }
        >
          {send.isPending
            ? t("qrOrders.status.bill.confirming")
            : t("qrOrders.status.bill.confirm")}
        </Button>
        <DialogClose asChild>
          <Button variant="ghost">{t("qrOrders.status.bill.cancel")}</Button>
        </DialogClose>
      </DialogFooter>
    </>
  );
}

export function RequestBillDialog({
  sessionId,
  disabled,
  onRequested,
}: {
  sessionId: string;
  disabled: boolean;
  onRequested: () => void;
}) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" disabled={disabled}>
          <Receipt aria-hidden="true" />
          {t("qrOrders.status.waiter.billButton")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <ConfirmBody
          sessionId={sessionId}
          onDone={() => {
            onRequested();
            setOpen(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
