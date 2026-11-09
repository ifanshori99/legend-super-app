// "Buat kasus" from a difference line (ACC-04 "setiap selisih menjadi kasus
// dengan PIC"). The PIC list is the tenant user directory port of WS-01; it
// fails closed outside mock mode until GET /api/access/users exists.
import * as React from "react";
import type { ReconciliationRef } from "@starter/shared/accounting";
import type { UserId } from "@starter/shared/core";
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
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { useAssignablePeople } from "@/features/ws01-access/people";
import { useOpenReconciliationCase } from "../hooks";
import {
  REF_TYPE_KEYS,
  createIdempotencyKeySession,
  shortId,
  type ReconciliationCaseType,
} from "../lib";

export function OpenCaseDialog({
  open,
  onOpenChange,
  legalEntityId,
  type,
  differenceIdr,
  refs,
  description,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  legalEntityId: string;
  type: ReconciliationCaseType;
  differenceIdr: number;
  refs: readonly ReconciliationRef[];
  description: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <OpenCaseForm
          legalEntityId={legalEntityId}
          type={type}
          differenceIdr={differenceIdr}
          refs={refs}
          description={description}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function OpenCaseForm({
  legalEntityId,
  type,
  differenceIdr,
  refs,
  description,
  onClose,
}: {
  legalEntityId: string;
  type: ReconciliationCaseType;
  differenceIdr: number;
  refs: readonly ReconciliationRef[];
  description: string;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const people = useAssignablePeople();
  const openCase = useOpenReconciliationCase();
  const options = people.data?.people ?? [];
  const [ownerId, setOwnerId] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  // OpenCaseForm lives inside DialogContent, so it mounts once per opened
  // dialog: keys are stable across resends of one body and new for the next
  // dialog.
  const [keySession] = React.useState(() => createIdempotencyKeySession());
  const effectiveOwner = ownerId || options[0]?.id || "";
  const unavailable = people.data?.unavailable ?? false;

  const submit = () => {
    setError(null);
    if (effectiveOwner === "" || unavailable) return;
    const body = {
      legalEntityId,
      outletId: null,
      type,
      differenceIdr,
      ownerId: effectiveOwner as UserId,
      refs: [...refs],
    };
    openCase.mutate(
      // Same body, same key (the server replays); another body, another key.
      { ...body, idempotencyKey: keySession.current(JSON.stringify(body)) },
      {
        onSuccess: () => {
          keySession.reset();
          toast({
            title: t("accounting.cash.case.done"),
            tone: "success",
          });
          onClose();
        },
        onError: (mutationError) => {
          setError(
            mutationError instanceof ApiError
              ? mutationError.message
              : t("accounting.cash.case.failed"),
          );
        },
      },
    );
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("accounting.cash.case.title")}</DialogTitle>
        <DialogDescription>
          {t("accounting.cash.case.description")}
        </DialogDescription>
      </DialogHeader>
      <dl className="grid gap-2 rounded-container border-(length:--border-w) bg-surface-2 p-card text-sm">
        <div className="flex items-start justify-between gap-3">
          <dt className="text-muted-foreground">
            {t("accounting.cash.case.difference")}
          </dt>
          <dd>
            <Money amount={differenceIdr} />
          </dd>
        </div>
        <div className="grid gap-1">
          <dt className="text-muted-foreground">
            {t("accounting.cash.case.line")}
          </dt>
          <dd className="min-w-0">
            <span className="block truncate">{description}</span>
            <span className="block text-sm text-muted-foreground">
              {refs
                .map(
                  (ref) => `${t(REF_TYPE_KEYS[ref.type])} ${shortId(ref.id)}`,
                )
                .join(" · ")}
            </span>
          </dd>
        </div>
      </dl>
      {unavailable ? (
        <p className="text-sm leading-5 font-medium text-danger">
          {t("accounting.cash.case.noPeople")}
        </p>
      ) : (
        <FormField
          // The Select root renders no DOM node, so the label must point at the
          // trigger itself; otherwise the control has no accessible name.
          id="recon-case-pic"
          label={t("accounting.cash.case.pic")}
          hint={t("accounting.cash.case.picHint")}
          required
        >
          <Select value={effectiveOwner} onValueChange={setOwnerId}>
            <SelectTrigger id="recon-case-pic">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((person) => (
                <SelectItem key={person.id} value={person.id}>
                  {person.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      )}
      {error && (
        <p role="alert" className="text-sm leading-5 font-medium text-danger">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={openCase.isPending}
        >
          {t("common.cancel")}
        </Button>
        <Button
          type="button"
          onClick={submit}
          loading={openCase.isPending}
          disabled={effectiveOwner === "" || unavailable}
        >
          {t("accounting.cash.case.submit")}
        </Button>
      </DialogFooter>
    </>
  );
}
