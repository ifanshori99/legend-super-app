// TEN-09: Payroll policies are portable by legal-entity and employee-group
// keys. Employee records, payroll results, bank details and IDs never travel.
import { z } from "zod";
import { payrollPolicySchema, type PayrollPolicy } from "./policies.ts";

const keySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/)
  .refine(
    (key) =>
      !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(
        key,
      ),
    "Keys must not look like an id",
  );

export const payrollSettingsConfigItemSchema = z.strictObject({
  key: keySchema,
  kind: z.literal("payroll_policy"),
  legalEntityKey: keySchema,
  name: payrollPolicySchema.shape.name,
  employeeGroup: payrollPolicySchema.shape.employeeGroup,
  cycle: payrollPolicySchema.shape.cycle,
  payDateAdjustment: payrollPolicySchema.shape.payDateAdjustment,
  jkkRiskClass: payrollPolicySchema.shape.jkkRiskClass,
  bpjsProgrammes: payrollPolicySchema.shape.bpjsProgrammes,
  isActive: payrollPolicySchema.shape.isActive,
});
export type PayrollSettingsConfigItem = z.infer<
  typeof payrollSettingsConfigItemSchema
>;

function policyKey(legalEntityKey: string, groupCode: string): string {
  const base = `${legalEntityKey}.${groupCode.toLowerCase()}`;
  if (base.length <= 100) return base;
  let hash = 2166136261;
  for (const char of base)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `${base.slice(0, 91)}.${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export const payrollSettingsConfigCodec = {
  section: "payroll_settings" as const,
  version: 1 as const,
  itemSchema: payrollSettingsConfigItemSchema,
  toTemplate(
    rows: readonly PayrollPolicy[],
    context: { legalEntityKeys: ReadonlyMap<string, string> },
  ): PayrollSettingsConfigItem[] {
    const items = rows.map((row) => {
      const legalEntityKey = context.legalEntityKeys.get(row.legalEntityId);
      if (!legalEntityKey)
        throw new Error(
          "payroll_settings: source legal entity has no portable key",
        );
      return payrollSettingsConfigItemSchema.parse({
        key: policyKey(legalEntityKey, row.employeeGroup.code),
        kind: "payroll_policy",
        legalEntityKey,
        name: row.name,
        employeeGroup: row.employeeGroup,
        cycle: row.cycle,
        payDateAdjustment: row.payDateAdjustment,
        jkkRiskClass: row.jkkRiskClass,
        bpjsProgrammes: row.bpjsProgrammes,
        isActive: row.isActive,
      });
    });
    const result = payrollSettingsConfigCodec.fromTemplate(items);
    if (!result.ok) throw new Error(result.issues.join("; "));
    return items;
  },
  fromTemplate(
    items: readonly unknown[],
    context: { legalEntityKeys?: ReadonlySet<string> } = {},
  ):
    | { ok: true; drafts: PayrollSettingsConfigItem[] }
    | { ok: false; issues: string[] } {
    const issues: string[] = [];
    const drafts: PayrollSettingsConfigItem[] = [];
    const keys = new Set<string>();
    const groups = new Set<string>();
    for (const raw of items) {
      const parsed = payrollSettingsConfigItemSchema.safeParse(raw);
      if (!parsed.success) {
        issues.push(
          `payroll_settings: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`,
        );
        continue;
      }
      const item = parsed.data;
      if (keys.has(item.key))
        issues.push(`payroll_settings item ${item.key}: duplicate key`);
      keys.add(item.key);
      const group = `${item.legalEntityKey}\u0000${item.employeeGroup.code}`;
      if (groups.has(group))
        issues.push(
          `payroll_settings item ${item.key}: duplicate employee group in legal entity`,
        );
      groups.add(group);
      if (
        context.legalEntityKeys &&
        !context.legalEntityKeys.has(item.legalEntityKey)
      )
        issues.push(
          `payroll_settings item ${item.key}: unknown legal entity key ${item.legalEntityKey}`,
        );
      drafts.push(item);
    }
    return issues.length ? { ok: false, issues } : { ok: true, drafts };
  },
};
