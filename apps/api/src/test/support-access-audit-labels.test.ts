// Audit log labels for the support access actions (legend-npkpz, TEN-04).
// The audit screen (apps/web/src/features/ws11-audit/labels.ts actionLabel)
// looks an action up as auditSettings.audit.actions.<action with "." -> "_">
// and shows the raw code when the key is missing. Every action the support
// access service writes must therefore have a catalog entry.
import { describe, expect, it } from "vitest";
import { createTranslator, isMessageKey } from "@starter/shared/i18n";

const SUPPORT_ACCESS_ACTIONS = {
  "support_access.granted": "Akses dukungan diberikan",
  "support_access.denied": "Akses dukungan ditolak",
  "support_access.ended": "Akses dukungan diakhiri",
  "support_access.expired": "Akses dukungan kedaluwarsa",
  "support_access.impersonation_started": "Sesi dukungan dimulai",
  "support_access.impersonation_ended": "Sesi dukungan diakhiri",
} as const;

const t = createTranslator();

describe("legend-npkpz TEN-04 support access audit labels", () => {
  it.each(Object.entries(SUPPORT_ACCESS_ACTIONS))(
    "legend-npkpz TEN-04 %s has an audit label",
    (action, label) => {
      const key = `auditSettings.audit.actions.${action.replaceAll(".", "_")}`;
      expect(isMessageKey(key)).toBe(true);
      if (isMessageKey(key)) expect(t(key)).toBe(label);
    },
  );

  it("legend-npkpz TEN-04 the support access grant object type has a label", () => {
    const key = "auditSettings.audit.objectTypes.support_access_grant";
    expect(isMessageKey(key)).toBe(true);
    if (isMessageKey(key)) expect(t(key)).toBe("Akses dukungan");
  });
});
