// "Tukar / ganti shift" tab (mockups tukar-mobile, ganti-mobile). Swap = the
// peer's shift comes back; cover ("ganti shift") = `toAssignmentId: null`.
// A colleague must accept before a supervisor can decide.
import { useState, type FormEvent } from "react";
import { Info } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTenantContext } from "@/lib/tenant-context";
import {
  useMyShiftAssignments,
  useSwapCandidates,
} from "@/features/hris-requests/hooks";
import {
  rowsOf,
  shiftOptionLabel,
  validateSwap,
  type SwapCandidate,
  type SwapErrors,
  type SwapKind,
  type SwapPayload,
} from "./request-form-logic.ts";
import type { RequestSummary } from "./request-form-states.tsx";
import { FormLoading, SubmitFailure } from "./request-form-loading.tsx";
import type { ShiftAssignment } from "@starter/shared/hris";

const DEFAULT_ZONE = "Asia/Jakarta";

export type SwapSubmit = {
  kind: SwapKind;
  payload: SwapPayload;
  summary: RequestSummary;
};

export function RequestFormSwap({
  busy,
  failed,
  onSubmit,
}: {
  busy: boolean;
  failed: boolean;
  onSubmit: (request: SwapSubmit) => void;
}) {
  const t = useT();
  const { outlet } = useTenantContext();
  const timeZone = outlet?.timeZone ?? DEFAULT_ZONE;
  const [kind, setKind] = useState<SwapKind>("swap");
  const [fromAssignmentId, setFrom] = useState("");
  const [toEmployeeId, setPeer] = useState("");
  const [toAssignmentId, setPeerShift] = useState("");
  const [errors, setErrors] = useState<SwapErrors>({});

  const mine = useMyShiftAssignments();
  const candidatesQuery = useSwapCandidates(fromAssignmentId);
  const assignments = rowsOf<ShiftAssignment>(mine.data);
  const candidates = rowsOf<SwapCandidate>(candidatesQuery.data);
  const peer = candidates.find((row) => row.employeeId === toEmployeeId);

  function pickShift(value: string) {
    setFrom(value);
    setPeer("");
    setPeerShift("");
  }

  function pickPeer(value: string) {
    setPeer(value);
    setPeerShift("");
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { errors: next, payload } = validateSwap(
      { kind, fromAssignmentId, toEmployeeId, toAssignmentId },
      assignments,
    );
    setErrors(next);
    if (!payload) return;
    const own = assignments.find((row) => row.id === fromAssignmentId);
    const target = peer?.assignments.find((row) => row.id === toAssignmentId);
    onSubmit({
      kind,
      payload,
      summary: {
        bodyKey:
          kind === "swap"
            ? "hrisRequestsEmployee.success.bodySwap"
            : "hrisRequestsEmployee.success.bodyCover",
        title:
          kind === "swap"
            ? t("hrisRequestsEmployee.swap.kindSwap")
            : t("hrisRequestsEmployee.swap.kindCover"),
        period: [
          own ? shiftOptionLabel(own, timeZone) : null,
          target ? shiftOptionLabel(target, timeZone) : null,
        ]
          .filter(Boolean)
          .join(" → "),
        reason: peer?.employeeName,
      },
    });
  }

  if (mine.isPending) return <FormLoading />;
  if (mine.isError)
    return <FormLoading error onRetry={() => void mine.refetch()} />;

  return (
    <form className="grid gap-4" noValidate onSubmit={handleSubmit}>
      <FormField label={t("hrisRequestsEmployee.swap.kindLabel")} required>
        <Select
          value={kind}
          onValueChange={(value) => {
            setKind(value as SwapKind);
            setPeerShift("");
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="swap">
              {t("hrisRequestsEmployee.swap.kindSwap")}
            </SelectItem>
            <SelectItem value="cover">
              {t("hrisRequestsEmployee.swap.kindCover")}
            </SelectItem>
          </SelectContent>
        </Select>
      </FormField>

      <FormField
        label={t("hrisRequestsEmployee.swap.myShiftLabel")}
        hint={
          assignments.length === 0
            ? t("hrisRequestsEmployee.swap.myShiftEmpty")
            : undefined
        }
        error={errors.fromAssignmentId ? t(errors.fromAssignmentId) : undefined}
        required
      >
        <Select value={fromAssignmentId} onValueChange={pickShift}>
          <SelectTrigger>
            <SelectValue
              placeholder={t("hrisRequestsEmployee.swap.myShiftPlaceholder")}
            />
          </SelectTrigger>
          <SelectContent>
            {assignments.map((assignment) => (
              <SelectItem key={assignment.id} value={assignment.id}>
                {shiftOptionLabel(assignment, timeZone)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>

      <FormField
        label={t("hrisRequestsEmployee.swap.peerLabel")}
        hint={
          fromAssignmentId === ""
            ? t("hrisRequestsEmployee.swap.peerNeedShift")
            : candidatesQuery.isPending
              ? t("hrisRequestsEmployee.swap.peerLoading")
              : candidates.length === 0
                ? t("hrisRequestsEmployee.swap.peerEmpty")
                : t("hrisRequestsEmployee.swap.peerHint")
        }
        error={errors.toEmployeeId ? t(errors.toEmployeeId) : undefined}
        required
      >
        <Select
          value={toEmployeeId}
          onValueChange={pickPeer}
          disabled={fromAssignmentId === "" || candidates.length === 0}
        >
          <SelectTrigger>
            <SelectValue
              placeholder={t("hrisRequestsEmployee.swap.peerPlaceholder")}
            />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((candidate) => (
              <SelectItem
                key={candidate.employeeId}
                value={candidate.employeeId}
              >
                {candidate.employeeName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>

      {kind === "swap" &&
        peer !== undefined &&
        peer.assignments.length === 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            Daftar shift rekan belum tersedia; tukar shift belum dapat diajukan.
          </p>
        )}
      {kind === "swap" && (
        <FormField
          label={t("hrisRequestsEmployee.swap.peerShiftLabel")}
          hint={
            peer && peer.assignments.length === 0
              ? t("hrisRequestsEmployee.swap.peerShiftEmpty")
              : t("hrisRequestsEmployee.swap.peerShiftHint")
          }
          error={errors.toAssignmentId ? t(errors.toAssignmentId) : undefined}
          required
        >
          <Select
            value={toAssignmentId}
            onValueChange={setPeerShift}
            disabled={!peer || peer.assignments.length === 0}
          >
            <SelectTrigger>
              <SelectValue
                placeholder={t(
                  "hrisRequestsEmployee.swap.peerShiftPlaceholder",
                )}
              />
            </SelectTrigger>
            <SelectContent>
              {(peer?.assignments ?? []).map((assignment) => (
                <SelectItem key={assignment.id} value={assignment.id}>
                  {shiftOptionLabel(assignment, timeZone)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      )}

      <p className="flex items-start gap-2 text-sm leading-5 text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {t("hrisRequestsEmployee.swap.complianceNote")}
      </p>

      {failed && <SubmitFailure />}

      <Button type="submit" size="lg" className="w-full" loading={busy}>
        {busy
          ? t("hrisRequestsEmployee.form.submitting")
          : t("hrisRequestsEmployee.form.submit")}
      </Button>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("hrisRequestsEmployee.form.submitHint")}
      </p>
    </form>
  );
}
