// Structured shift handover (PRD v1.7 §3 F41 "Serah Terima Shift"; OPS-05).
// The five sections are the contract's `shiftHandoverNotes`; at least one must
// be filled. The receiving shift confirms afterwards — the submitting shift
// cannot acknowledge its own handover (contract machine).
//
// Shift pickers: the HRIS contract exposes shift assignments but no template
// list yet, so mock mode reads the shared demo catalog (see
// ../shift-templates.ts). Against a real API the list is null and the form
// says so instead of inventing names (reported follow-up).
import * as React from "react";
import { createShiftHandoverInputSchema } from "@starter/shared/operations";
import type { ShiftTemplate } from "@starter/shared/hris";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useAttemptKey, useCreateHandover } from "../hooks.ts";
import {
  HANDOVER_NOTE_KEYS,
  HANDOVER_NOTE_LABEL_KEYS,
  type HandoverNoteKey,
} from "../lib.ts";

type NoteKey = HandoverNoteKey;

export function HandoverFormDialog({
  outletId,
  shiftOptions,
  trigger,
}: {
  outletId: string;
  /** Null when the shift-template list is not available from the API yet. */
  shiftOptions: readonly ShiftTemplate[] | null;
  trigger: React.ReactElement;
}) {
  const t = useT();
  const toast = useToast();
  const create = useCreateHandover();
  const attempt = useAttemptKey();
  const [open, setOpen] = React.useState(false);
  const [fromShift, setFromShift] = React.useState("");
  const [toShift, setToShift] = React.useState("");
  const [notes, setNotes] = React.useState<Record<NoteKey, string>>({
    cash: "",
    criticalStock: "",
    openComplaints: "",
    equipmentIssues: "",
    specialNotes: "",
  });
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    // Reset the dialog each time it opens (React lint flags setState in an
    // effect; the form intentionally starts from the first shift pair).
    /* eslint-disable react-hooks/set-state-in-effect */
    const options = shiftOptions ?? [];
    setFromShift(options[0]?.id ?? "");
    setToShift(options[1]?.id ?? options[0]?.id ?? "");
    setNotes({
      cash: "",
      criticalStock: "",
      openComplaints: "",
      equipmentIssues: "",
      specialNotes: "",
    });
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, shiftOptions]);

  const disabled = shiftOptions === null || shiftOptions.length < 2;

  function updateNote(key: NoteKey, value: string) {
    setNotes((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const payload = {
      outletId,
      fromShiftTemplateId: fromShift,
      toShiftTemplateId: toShift,
      notes: {
        cash: notes.cash.trim() || null,
        criticalStock: notes.criticalStock.trim() || null,
        openComplaints: notes.openComplaints.trim() || null,
        equipmentIssues: notes.equipmentIssues.trim() || null,
        specialNotes: notes.specialNotes.trim() || null,
      },
    };
    const parsed = createShiftHandoverInputSchema.safeParse({
      ...payload,
      idempotencyKey: attempt.keyFor(payload),
    });
    if (!parsed.success) {
      const notesFilled = Object.values(payload.notes).some(
        (value) => value !== null,
      );
      setError(
        t(
          notesFilled
            ? "opsEquipment.handover.form.invalid"
            : "opsEquipment.handover.notesRequired",
        ),
      );
      return;
    }
    try {
      await create.mutateAsync(parsed.data);
      attempt.settle();
      toast({
        title: t("opsEquipment.handover.toasts.created"),
        tone: "success",
      });
      setOpen(false);
    } catch {
      setError(t("opsEquipment.handover.actionError"));
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("opsEquipment.handover.form.title")}</DialogTitle>
          <DialogDescription>
            {t("opsEquipment.handover.notesHint")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4" noValidate>
          {shiftOptions === null ? (
            <p className="rounded-container bg-warning-subtle p-3 text-sm text-foreground">
              {t("opsEquipment.handover.form.shiftUnavailable")}
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={t("opsEquipment.handover.form.from")} required>
                <Select value={fromShift} onValueChange={setFromShift}>
                  <SelectTrigger>
                    <SelectValue
                      placeholder={t("opsEquipment.handover.form.chooseShift")}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {shiftOptions.map((shift) => (
                      <SelectItem
                        key={shift.id}
                        value={shift.id}
                        className="min-h-11"
                      >
                        {shift.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label={t("opsEquipment.handover.form.to")} required>
                <Select value={toShift} onValueChange={setToShift}>
                  <SelectTrigger>
                    <SelectValue
                      placeholder={t("opsEquipment.handover.form.chooseShift")}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {shiftOptions.map((shift) => (
                      <SelectItem
                        key={shift.id}
                        value={shift.id}
                        className="min-h-11"
                      >
                        {shift.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </div>
          )}
          <fieldset className="grid gap-4">
            <legend className="text-sm font-semibold">
              {t("opsEquipment.handover.notesTitle")}
            </legend>
            {HANDOVER_NOTE_KEYS.map((key) => (
              <FormField key={key} label={t(HANDOVER_NOTE_LABEL_KEYS[key])}>
                <Textarea
                  value={notes[key]}
                  onChange={(event) => updateNote(key, event.target.value)}
                  rows={2}
                />
              </FormField>
            ))}
          </fieldset>
          {error && (
            <p role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="submit"
              loading={create.isPending}
              disabled={disabled}
            >
              {t("opsEquipment.handover.form.submit")}
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
