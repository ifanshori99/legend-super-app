// Catalog freshness on a work-area screen (legend-10nex): the cashier warning
// while a critical stream is stale, and the sales hold once the catalog is over
// 24 hours old. An owner can allow selling for a limited time; the edge
// decides, this only shows it. Mounted in EdgeStatusLayer, so it follows the
// edge status poll and appears on every work-area screen, the kasir included.
import { useId, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { Notice } from "@/features/ws04-pos-kasir/components/shared/notice";
import { ApiError } from "@/lib/api/errors";
import {
  CATALOG_COPY,
  OVERRIDE_DEFAULT_MINUTES,
  OVERRIDE_MINUTES_OPTIONS,
  OVERRIDE_REASON_MAX,
  OVERRIDE_REASON_MIN,
  formatHourMinute,
  minutesLabel,
  salesGateOf,
} from "../catalog-sales.ts";
import {
  useCanGrantCatalogOverride,
  useCatalogSalesBlockNote,
  useEdgeStatus,
  useGrantCatalogOverride,
} from "../hooks.ts";
import { useHydrated } from "../use-now.ts";

function OverrideForm({ onDone }: { onDone: () => void }) {
  const reasonId = useId();
  const toast = useToast();
  const grant = useGrantCatalogOverride();
  const [minutes, setMinutes] = useState(String(OVERRIDE_DEFAULT_MINUTES));
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string>();

  function validate(value: string): string | undefined {
    const trimmed = value.trim();
    if (trimmed.length < OVERRIDE_REASON_MIN)
      return CATALOG_COPY.reasonTooShort;
    if (trimmed.length > OVERRIDE_REASON_MAX) return CATALOG_COPY.reasonTooLong;
    return undefined;
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const error = validate(reason);
    setReasonError(error);
    if (error) return;
    grant.mutate(
      { minutes: Number(minutes), reason: reason.trim() },
      {
        onSuccess: () => {
          toast({ title: CATALOG_COPY.granted, tone: "success" });
          onDone();
        },
      },
    );
  }

  const failure = grant.error
    ? grant.error instanceof ApiError && grant.error.status === 403
      ? CATALOG_COPY.grantForbidden
      : grant.error instanceof ApiError && grant.error.status < 500
        ? grant.error.message
        : CATALOG_COPY.grantFailed
    : null;

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>{CATALOG_COPY.dialogTitle}</DialogTitle>
        <DialogDescription>{CATALOG_COPY.dialogHint}</DialogDescription>
      </DialogHeader>
      <FormField label={CATALOG_COPY.durationLabel} required>
        <Select value={minutes} onValueChange={setMinutes}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OVERRIDE_MINUTES_OPTIONS.map((option) => (
              <SelectItem key={option} value={String(option)}>
                {minutesLabel(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      <FormField
        label={CATALOG_COPY.reasonLabel}
        id={reasonId}
        hint={CATALOG_COPY.reasonHint}
        error={reasonError}
        required
      >
        <Textarea
          value={reason}
          rows={3}
          maxLength={OVERRIDE_REASON_MAX}
          onChange={(event) => {
            setReason(event.target.value);
            if (reasonError) setReasonError(undefined);
          }}
          onBlur={() => {
            if (reason !== "") setReasonError(validate(reason));
          }}
        />
      </FormField>
      {failure && <Notice tone="danger" title={failure} />}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {CATALOG_COPY.cancel}
        </Button>
        <Button type="submit" loading={grant.isPending}>
          {CATALOG_COPY.submit}
        </Button>
      </DialogFooter>
    </form>
  );
}

// The body mounts only while open, so a typed reason never lingers.
function OverrideAction() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="mt-3 bg-background"
        onClick={() => setOpen(true)}
      >
        {CATALOG_COPY.action}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <OverrideForm onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

export function CatalogSalesNotice() {
  const hydrated = useHydrated();
  const { data, dataUpdatedAt } = useEdgeStatus();
  const canGrant = useCanGrantCatalogOverride();
  const note = useCatalogSalesBlockNote();

  if (!hydrated) return null;
  const freshness = data?.data.catalogFreshness;
  const gate = salesGateOf(freshness);
  const warning = freshness?.cashierWarning ?? null;

  const warningNotice = warning ? (
    <Notice tone="warning" title={warning} className="mb-4" />
  ) : null;

  if (gate?.blocked) {
    const unavailable = gate.reason === "GATE_UNAVAILABLE";
    const since = formatHourMinute(gate.staleSince);
    return (
      <Notice
        tone="danger"
        title={
          unavailable
            ? CATALOG_COPY.unavailableTitle
            : CATALOG_COPY.blockedTitle
        }
        className="mb-4"
        data-catalog-sales="blocked"
      >
        <p>
          {unavailable
            ? CATALOG_COPY.unavailableHint
            : CATALOG_COPY.blockedHint}
          {since && !unavailable ? ` ${CATALOG_COPY.sinceLine(since)}` : ""}
        </p>
        {canGrant && <OverrideAction />}
      </Notice>
    );
  }

  if (gate?.override) {
    const until = formatHourMinute(gate.override.untilAt);
    return (
      <>
        {warningNotice}
        <Notice
          tone="info"
          title={CATALOG_COPY.overrideTitle(until ?? "-")}
          className="mb-4"
          data-catalog-sales="override"
        >
          <p>{gate.override.reason}</p>
          <p>{CATALOG_COPY.overrideHint}</p>
        </Notice>
      </>
    );
  }

  // An order was refused but the status read since then has not confirmed the
  // hold (or an older edge image sends no salesGate): show the refusal itself.
  if (note && dataUpdatedAt < note.at) {
    return (
      <Notice
        tone="danger"
        title={note.message}
        className="mb-4"
        data-catalog-sales="refused"
      >
        {canGrant && <OverrideAction />}
      </Notice>
    );
  }

  return warningNotice;
}
