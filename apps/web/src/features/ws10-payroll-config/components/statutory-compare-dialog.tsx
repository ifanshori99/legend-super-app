// "Bandingkan versi": the previous version of the same table against the
// selected one, using the same flattened rows as the detail table (PAYR-02:
// a rate change is a new version, so the diff is how Finance reviews it).
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/i18n";
import type { StatutoryTableVersion } from "@starter/shared/hris/payroll";
import { STATUTORY_TYPE_KEYS, diffParameterRows, draftOfVersion } from "../lib";
import { StatutoryDiffTable } from "./statutory-parameter-table";

export function StatutoryCompareDialog({
  version,
  previous,
  onClose,
}: {
  version: StatutoryTableVersion;
  previous: StatutoryTableVersion;
  onClose: () => void;
}) {
  const t = useT();
  const rows = diffParameterRows(
    draftOfVersion(previous),
    draftOfVersion(version),
  );
  const changed = rows.some((row) => row.changed);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {t("payrollConfig.statutory.compareDialog.title", {
              type: t(STATUTORY_TYPE_KEYS[version.type]),
            })}
          </DialogTitle>
          <DialogDescription>
            {t("payrollConfig.statutory.compareDialog.description", {
              from: previous.version,
              to: version.version,
            })}
          </DialogDescription>
        </DialogHeader>

        {changed ? (
          <StatutoryDiffTable
            rows={rows}
            fromVersion={previous.version}
            toVersion={version.version}
          />
        ) : (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("payrollConfig.statutory.compareDialog.empty")}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
