// Confirms a maintenance flag with an optional note. `updateFacilityUnit`
// accepts `note` for the audit trail even though `FacilityUnit` has no note
// column (contract `updateFacilityUnitSchema`), so the dialog sends it and the
// tile does not repeat it.
import * as React from "react";
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
import { Textarea } from "@/components/ui/textarea";
import type { FacilityUnit } from "@starter/shared/facility";

export function MaintenanceDialog({
  unit,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  unit: FacilityUnit | null;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (note?: string) => void;
}) {
  const t = useT();
  const [note, setNote] = React.useState("");

  return (
    <Dialog
      open={unit !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("facilityStaff.board.maintenanceDialog.title", {
              unit: unit?.code ?? "",
            })}
          </DialogTitle>
          <DialogDescription>
            {t("facilityStaff.board.maintenanceDialog.hint")}
          </DialogDescription>
        </DialogHeader>
        <FormField
          label={t("facilityStaff.board.maintenanceDialog.noteLabel")}
          hint={t("facilityStaff.board.maintenanceDialog.noteHint")}
        >
          <Textarea
            value={note}
            maxLength={500}
            placeholder={t(
              "facilityStaff.board.maintenanceDialog.notePlaceholder",
            )}
            onChange={(event) => setNote(event.target.value)}
          />
        </FormField>
        {error && (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            loading={pending}
            onClick={() => onConfirm(note.trim() || undefined)}
          >
            {t("facilityStaff.board.maintenanceDialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
