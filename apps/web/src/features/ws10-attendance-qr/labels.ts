// Map contract enum values to catalog keys and status tones. An enum added in
// the contract fails typecheck here instead of rendering a raw value.
import type { MessageKey } from "@starter/shared/i18n";
import type {
  AttendanceMethod,
  AttendanceType,
  AttendanceValidity,
} from "@starter/shared/hris";
import type { StatusKind } from "@/components/ui/badge";

export const ATTENDANCE_TYPE_KEY: Record<AttendanceType, MessageKey> = {
  in: "attendanceQr.type.in",
  out: "attendanceQr.type.out",
  break_start: "attendanceQr.type.break_start",
  break_end: "attendanceQr.type.break_end",
};

export const ATTENDANCE_METHOD_KEY: Record<AttendanceMethod, MessageKey> = {
  selfie_geo: "attendanceQr.method.selfie_geo",
  rotating_qr: "attendanceQr.method.rotating_qr",
  manual_correction: "attendanceQr.method.manual_correction",
  outlet_device: "attendanceQr.method.outlet_device",
};

export const ATTENDANCE_VALIDITY: Record<
  AttendanceValidity,
  { status: StatusKind; labelKey: MessageKey }
> = {
  valid: { status: "success", labelKey: "attendanceQr.validity.valid" },
  flagged: { status: "warning", labelKey: "attendanceQr.validity.flagged" },
  rejected: { status: "danger", labelKey: "attendanceQr.validity.rejected" },
};

/** Flagged and rejected samples surface before the valid ones (F25 sampling). */
export function validityRank(validity: AttendanceValidity): number {
  if (validity === "rejected") return 0;
  if (validity === "flagged") return 1;
  return 2;
}
