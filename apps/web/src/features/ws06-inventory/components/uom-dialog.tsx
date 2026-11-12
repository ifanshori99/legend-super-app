// Add / rename dialog of the unit editor (bead legend-7z38l). Validation and
// the error mapping live in ../uom-state.ts; the code is typed once and is
// read-only when renaming.
import * as React from "react";
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
import { newIdempotencyKey } from "../../../lib/idempotency.ts";
import { useCreateUom, useUpdateUom } from "../hooks";
import {
  UOM_CODE_MAX,
  UOM_COPY,
  UOM_NAME_MAX,
  mapUomSaveError,
  validateUomForm,
  type UomFormErrors,
  type UomUnit,
} from "../uom-state";

export type UomEditor = { mode: "new" } | { mode: "edit"; unit: UomUnit };

export function UomDialog({
  editor,
  existing,
  onClose,
  onSaved,
}: {
  editor: UomEditor;
  existing: readonly UomUnit[];
  onClose: () => void;
  onSaved: (mode: UomEditor["mode"]) => void;
}) {
  const createUom = useCreateUom();
  const updateUom = useUpdateUom();
  const editing = editor.mode === "edit" ? editor.unit : null;
  const [name, setName] = React.useState(editing?.name ?? "");
  const [code, setCode] = React.useState("");
  const [errors, setErrors] = React.useState<UomFormErrors>({});
  const [formError, setFormError] = React.useState<string | undefined>();
  // One key per attempt: a retry after a lost response must not add twice.
  const [idempotencyKey] = React.useState(() => newIdempotencyKey());
  const pending = createUom.isPending || updateUom.isPending;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const result = validateUomForm(
      editing ? { mode: "edit", name } : { mode: "create", name, code },
      existing,
    );
    if (!result.ok) {
      setErrors(result.errors);
      setFormError(undefined);
      return;
    }
    setErrors({});
    setFormError(undefined);
    const onError = (error: unknown) => {
      const mapped = mapUomSaveError(error);
      if (mapped.field === "form") setFormError(mapped.message);
      else setErrors({ [mapped.field]: mapped.message });
    };
    if (editing) {
      updateUom.mutate(
        { params: { uomId: editing.id }, body: { name: result.name } },
        { onSuccess: () => onSaved("edit"), onError },
      );
      return;
    }
    createUom.mutate(
      { code: result.code ?? "", name: result.name, idempotencyKey },
      { onSuccess: () => onSaved("new"), onError },
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editing ? UOM_COPY.editTitle : UOM_COPY.addTitle}
          </DialogTitle>
          <DialogDescription>
            {editing ? UOM_COPY.editHint : UOM_COPY.addHint}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <FormField label={UOM_COPY.nameLabel} error={errors.name} required>
            <Input
              value={name}
              maxLength={UOM_NAME_MAX}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
            />
          </FormField>
          {editing ? (
            <div className="grid gap-1">
              <span className="text-sm font-semibold">
                {UOM_COPY.codeLabel}
              </span>
              <span>{editing.code}</span>
            </div>
          ) : (
            <FormField
              label={UOM_COPY.codeLabel}
              hint={UOM_COPY.codeHint}
              error={errors.code}
              required
            >
              <Input
                value={code}
                maxLength={UOM_CODE_MAX}
                onChange={(event) => setCode(event.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
              />
            </FormField>
          )}
          {formError && (
            <p
              role="alert"
              className="rounded-lg border border-danger bg-danger-subtle px-3 py-2 text-sm font-medium text-danger"
            >
              {formError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={pending}
            >
              {UOM_COPY.cancel}
            </Button>
            <Button type="submit" loading={pending}>
              {UOM_COPY.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
