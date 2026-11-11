// "Hapus riwayat?" confirmation. Destructive and permanent, so it names what
// goes away and keeps Batal first. A partial failure stays open with a retry.
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
import { useToast } from "@/components/ui/toast";
import { useOnline } from "@/lib/use-online";
import { useDeleteAllConversations } from "../hooks";

export function DeleteHistoryDialog({
  open,
  onOpenChange,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const online = useOnline();
  const remove = useDeleteAllConversations();

  const confirm = () =>
    remove.mutate(undefined, {
      onSuccess: () => {
        toast({ title: t("aiChat.delete.done"), tone: "success" });
        onOpenChange(false);
        onDeleted();
      },
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) remove.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("aiChat.delete.title")}</DialogTitle>
          <DialogDescription>{t("aiChat.delete.body")}</DialogDescription>
        </DialogHeader>
        {(remove.isError || !online) && (
          <div
            role="alert"
            className="grid gap-1 rounded-container border-(length:--border-w) border-danger bg-danger-subtle p-3 text-sm"
          >
            <p className="font-semibold">{t("aiChat.delete.errorTitle")}</p>
            <p>
              {online
                ? t("aiChat.delete.errorBody")
                : t("aiChat.delete.offlineBody")}
            </p>
          </div>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => onOpenChange(false)}
          >
            {t("aiChat.delete.cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="min-h-11"
            loading={remove.isPending}
            disabled={!online}
            onClick={confirm}
          >
            {remove.isPending
              ? t("aiChat.delete.deleting")
              : t("aiChat.delete.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
