// Confirmation for publishing a rule version (PRD R21: a published version is
// immutable, so the dialog states what that means before the write).
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

export function PublishDialog({
  title,
  description,
  error,
  pending,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  error?: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
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
          <Button type="button" loading={pending} onClick={onConfirm}>
            {t("tax.publish.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
