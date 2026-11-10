// Warning for published tax rules that tie in the engine (legend-de3b): the
// cashier cannot price an item both rules cover. Existing duplicates are never
// changed automatically; the owner switches one off with an inactive version.
import { TriangleAlert } from "lucide-react";
import type { TaxRuleConflict } from "@starter/shared/tax";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { CHANNEL_KEYS, ITEM_CLASS_KEYS } from "../labels";
import { formatBusinessDate } from "../lib";

export function RuleConflictsBanner({
  conflicts,
  outletNames,
  today,
  disabled,
  onDeactivate,
}: {
  conflicts: readonly TaxRuleConflict[];
  /** Outlet id to name, from the outlet list. */
  outletNames: ReadonlyMap<string, string>;
  /** Outlet business date: a tie before it is in force now. */
  today: string;
  /** True until the rules list is loaded (the buttons need the rule). */
  disabled: boolean;
  /** Open the new-version dialog (inactive) for one side of this pair. */
  onDeactivate: (
    ruleId: string,
    code: string,
    other: { code: string; effectiveDate: string },
  ) => void;
}) {
  const t = useT();
  if (conflicts.length === 0) return null;
  return (
    <section
      aria-labelledby="tax-rule-conflicts-title"
      className="m-card mb-0 grid gap-3 rounded-container border-(length:--border-w) bg-warning-subtle p-card"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert
          className="mt-0.5 size-icon shrink-0 text-warning"
          aria-hidden="true"
        />
        <div className="grid gap-0.5">
          <h3 id="tax-rule-conflicts-title" className="font-semibold">
            {t("tax.conflicts.title", { count: conflicts.length })}
          </h3>
          <p className="text-sm leading-5">{t("tax.conflicts.body")}</p>
        </div>
      </div>
      <ul className="grid gap-3">
        {conflicts.map((conflict) => {
          const target =
            conflict.level === "itemClass"
              ? t(
                  ITEM_CLASS_KEYS[
                    conflict.key as keyof typeof ITEM_CLASS_KEYS
                  ] ?? "tax.conflicts.level.item",
                )
              : t(`tax.conflicts.level.${conflict.level}`);
          const outlet =
            conflict.outletId === null
              ? t("tax.conflicts.allOutlets")
              : (outletNames.get(conflict.outletId) ??
                t("tax.conflicts.outletUnknown"));
          const when =
            conflict.effectiveDate <= today
              ? t("tax.conflicts.active")
              : t("tax.conflicts.startsOn", {
                  date: formatBusinessDate(conflict.effectiveDate),
                });
          return (
            <li
              key={`${conflict.ruleA.id}:${conflict.ruleB.id}`}
              className="grid gap-2 border-t pt-3 first:border-t-0 first:pt-0"
            >
              <p className="text-sm leading-5">
                <span className="font-semibold">
                  {conflict.ruleA.code} v{conflict.ruleA.version}
                </span>
                {" · "}
                <span className="font-semibold">
                  {conflict.ruleB.code} v{conflict.ruleB.version}
                </span>
                <span className="text-muted-foreground">
                  {" — "}
                  {outlet}
                  {" · "}
                  {t(CHANNEL_KEYS[conflict.channel])}
                  {" · "}
                  {target}
                  {conflict.regionCode !== null && (
                    <>
                      {" · "}
                      {t("tax.conflicts.region", {
                        region: conflict.regionCode,
                      })}
                    </>
                  )}
                  {" · "}
                  {when}
                </span>
              </p>
              <p className="text-sm leading-5">{t("tax.conflicts.fix")}</p>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    [conflict.ruleA, conflict.ruleB],
                    [conflict.ruleB, conflict.ruleA],
                  ] as const
                ).map(([rule, other]) => (
                  <Button
                    key={rule.id}
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() =>
                      onDeactivate(rule.id, rule.code, {
                        code: other.code,
                        effectiveDate: conflict.effectiveDate,
                      })
                    }
                  >
                    {t("tax.conflicts.deactivate", { code: rule.code })}
                  </Button>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
