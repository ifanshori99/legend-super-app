// The PII field list and its catalog labels, shared by the panel and the edit
// dialog so a new field in `HRIS_PII_FIELDS` has one place to land here.
import type { MessageKey } from "@starter/shared/i18n";
import type { EmployeePii } from "@starter/shared/hris";

export const PII_FIELDS = [
  "nik",
  "npwp",
  "bpjsKesNo",
  "bpjsTkNo",
  "bankAccount",
  "emergencyContactName",
  "emergencyContactPhone",
] as const satisfies readonly (keyof EmployeePii)[];

export type PiiField = (typeof PII_FIELDS)[number];

export const PII_FIELD_LABEL: Record<PiiField, MessageKey> = {
  nik: "employeeMaster.profile.pii.fields.nik",
  npwp: "employeeMaster.profile.pii.fields.npwp",
  bpjsKesNo: "employeeMaster.profile.pii.fields.bpjsKesNo",
  bpjsTkNo: "employeeMaster.profile.pii.fields.bpjsTkNo",
  bankAccount: "employeeMaster.profile.pii.fields.bankAccount",
  emergencyContactName:
    "employeeMaster.profile.pii.fields.emergencyContactName",
  emergencyContactPhone:
    "employeeMaster.profile.pii.fields.emergencyContactPhone",
};
