// Confirmation for discarding a rule or settings draft (draft -> archived).
// Published versions are never discarded: the API refuses it (R21), and the
// action is only offered on drafts.
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/components/i18n";

export function DiscardDraftDialog({
  title,
  version,
  name,
  meta,
  error,
  pending,
  onCancel,
  onConfirm,
}: {
  title: string;
  version: number;
  /** The draft being discarded, shown so the owner confirms the right one. */
  name: string;
  /** Effective date and scope line under the name. */
  meta: string;
  error?: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t("tax.discard.body", { version })}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-container border-(length:--border-w) p-card">
          <p className="font-semibold">{name}</p>
          <p className="text-sm leading-5 text-muted-foreground">{meta}</p>
        </div>
        {error && (
          <p className="text-sm leading-5 font-medium text-danger" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={pending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="outline"
            loading={pending}
            onClick={onConfirm}
          >
            {t("tax.discard.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
