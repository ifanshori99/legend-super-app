// Read-only detail of one statutory version: its legal basis, effective
// window and the flattened parameter rows (rate lines, brackets, tiers). The
// footer offers the lifecycle actions the version's status allows (PAYR-02):
// a draft can be edited, published or archived; a published version is
// immutable and can only be compared with the one before it.
import { Pencil, Send, Archive, Scale } from "lucide-react";
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
import type { StatutoryTableVersion } from "@starter/shared/hris/payroll";
import {
  STATUTORY_TYPE_KEYS,
  draftOfVersion,
  formatBusinessDate,
  formatDateTime,
  parameterRows,
} from "../lib";
import { StatutoryParameterTable } from "./statutory-parameter-table";
import {
  StatutoryEffectiveBadge,
  StatutoryStatusPill,
} from "./version-status-pill";

export function StatutoryDetailDialog({
  version,
  versions,
  today,
  canRun,
  canCompare,
  onClose,
  onEdit,
  onPublish,
  onArchive,
  onCompare,
}: {
  version: StatutoryTableVersion;
  versions: readonly StatutoryTableVersion[];
  today: string;
  canRun: boolean;
  canCompare: boolean;
  onClose: () => void;
  onEdit: () => void;
  onPublish: () => void;
  onArchive: () => void;
  onCompare: () => void;
}) {
  const t = useT();
  const rows = parameterRows(draftOfVersion(version));
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("payrollConfig.statutory.detailDialog.title", {
              type: t(STATUTORY_TYPE_KEYS[version.type]),
              version: version.version,
            })}
          </DialogTitle>
          <DialogDescription>
            {t("payrollConfig.statutory.detailDialog.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <StatutoryStatusPill status={version.status} />
          <StatutoryEffectiveBadge
            version={version}
            versions={versions}
            today={today}
          />
        </div>

        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="grid gap-0.5">
            <dt className="type-eyebrow text-muted-foreground">
              {t("payrollConfig.statutory.form.effectiveFrom")}
            </dt>
            <dd className="tabular">
              {formatBusinessDate(version.effectiveFrom)}
            </dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="type-eyebrow text-muted-foreground">
              {t("payrollConfig.statutory.form.legalBasis")}
            </dt>
            <dd>{version.legalBasis}</dd>
          </div>
          {version.publishedAt && (
            <div className="grid gap-0.5">
              <dt className="type-eyebrow text-muted-foreground">
                {t("payrollConfig.statutory.detailDialog.publishedAt")}
              </dt>
              <dd className="tabular">{formatDateTime(version.publishedAt)}</dd>
            </div>
          )}
        </dl>

        <p className="text-sm leading-5 text-muted-foreground">
          {version.status === "draft"
            ? t("payrollConfig.statutory.detailDialog.draftHint")
            : t("payrollConfig.statutory.detailDialog.immutable")}
        </p>

        <StatutoryParameterTable rows={rows} />

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.close")}
          </Button>
          {version.status === "draft" && canRun && (
            <>
              <Button type="button" variant="outline" onClick={onArchive}>
                <Archive aria-hidden="true" />
                {t("payrollConfig.statutory.archive")}
              </Button>
              <Button type="button" variant="outline" onClick={onEdit}>
                <Pencil aria-hidden="true" />
                {t("payrollConfig.statutory.editDraft")}
              </Button>
              <Button type="button" onClick={onPublish}>
                <Send aria-hidden="true" />
                {t("payrollConfig.statutory.publish")}
              </Button>
            </>
          )}
          {version.status !== "draft" && canCompare && (
            <Button type="button" variant="outline" onClick={onCompare}>
              <Scale aria-hidden="true" />
              {t("payrollConfig.statutory.compare")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
