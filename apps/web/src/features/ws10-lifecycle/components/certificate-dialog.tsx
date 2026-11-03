// Work certificate preview (PRD v1.7 §3 D26 "Offboarding": surat keterangan
// kerja).
//
// There is no certificate endpoint and no certificate record in the contracts,
// so this is a local preview built from the employee row: name, NIP, position,
// outlet, join/end dates, manager and company — nothing more (no salary, no
// identity number, no reason for leaving). The number is issued by the API, so
// the preview prints none. It opens only once the employee has left and the
// exit clearance is complete (PRD §3 D26). It prints through the browser dialog; the sheet keeps the light
// palette on paper and hides the shell (DESIGN.md §8, the same rule the purchase
// order print page follows).
import * as React from "react";
import { Printer } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CertificateInput } from "../lib.ts";
import { formatBusinessDate } from "../lib.ts";

/** Print only the certificate sheet; the management shell stays off paper. */
const PRINT_STYLE = `@media print {
  body * { visibility: hidden; }
  .lifecycle-certificate-sheet, .lifecycle-certificate-sheet * { visibility: visible; }
  .lifecycle-certificate-sheet { position: absolute; inset: 0; width: 100%; max-width: none; margin: 0; padding: 12mm; }
  [data-slot="dialog-content"] { position: static !important; max-height: none !important; overflow: visible !important; border: 0 !important; box-shadow: none !important; padding: 0 !important; }
  [data-slot="dialog-overlay"] { display: none !important; }
  .lifecycle-certificate-controls { display: none !important; }
  .dark .lifecycle-certificate-sheet { --foreground: var(--primary-foreground); --muted-foreground: var(--primary-foreground); --border: var(--primary-foreground); --background: var(--primary); color: var(--foreground); background: var(--background); }
}`;

function CertificateField({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="type-eyebrow text-muted-foreground">{label}</dt>
      <dd className="text-(length:--density-text)">{value}</dd>
    </div>
  );
}

function CertificateSheet({ certificate }: { certificate: CertificateInput }) {
  const t = useT();
  const { employee } = certificate;
  return (
    <article className="lifecycle-certificate-sheet grid gap-5 rounded-container border-(length:--border-w) bg-card p-card text-foreground shadow-hairline">
      <header className="grid gap-1 border-b pb-4 text-center">
        <p className="type-eyebrow text-muted-foreground">
          {certificate.company}
        </p>
        <h3 className="type-title tracking-wide">
          {t("lifecycle.certificate.heading")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("lifecycle.certificate.numberPending")}
        </p>
      </header>
      <p className="text-(length:--density-text) leading-6">
        {t("lifecycle.certificate.body", {
          name: employee.fullName,
          nip: employee.employeeNo,
        })}
      </p>
      <dl className="grid gap-4 sm:grid-cols-2">
        <CertificateField
          label={t("lifecycle.certificate.fields.name")}
          value={employee.fullName}
        />
        <CertificateField
          label={t("lifecycle.certificate.fields.nip")}
          value={employee.employeeNo}
        />
        <CertificateField
          label={t("lifecycle.certificate.fields.position")}
          value={certificate.positionName}
        />
        <CertificateField
          label={t("lifecycle.certificate.fields.outlet")}
          value={certificate.outletName}
        />
        <CertificateField
          label={t("lifecycle.certificate.fields.joinDate")}
          value={formatBusinessDate(employee.joinDate)}
        />
        <CertificateField
          label={t("lifecycle.certificate.fields.endDate")}
          value={
            employee.endDate === null
              ? t("lifecycle.common.noValue")
              : formatBusinessDate(employee.endDate)
          }
        />
        <CertificateField
          label={t("lifecycle.certificate.fields.manager")}
          value={
            certificate.managerName ?? t("lifecycle.certificate.noManager")
          }
        />
        <CertificateField
          label={t("lifecycle.certificate.fields.company")}
          value={certificate.company}
        />
      </dl>
      <p className="text-(length:--density-text) leading-6">
        {t("lifecycle.certificate.closing")}
      </p>
      <footer className="grid justify-items-end gap-1 pt-4 text-center">
        <p className="text-sm text-muted-foreground">
          {t("lifecycle.certificate.signatory")}
        </p>
        <p className="text-(length:--density-text) font-semibold">
          {certificate.managerName ?? t("lifecycle.certificate.noManager")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("lifecycle.certificate.signatureSpace")}
        </p>
      </footer>
    </article>
  );
}

export function CertificateCard({
  certificate,
  lock,
}: {
  certificate: CertificateInput;
  /** Why the certificate cannot be issued yet; null when it can. */
  lock: "notLeaving" | "clearanceOpen" | null;
}) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const lockId = React.useId();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("lifecycle.certificate.title")}</CardTitle>
        <CardDescription>
          {t("lifecycle.certificate.description")}
        </CardDescription>
        <CardAction>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{t("lifecycle.certificate.preview")}</Badge>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={lock !== null}
              aria-describedby={lock === null ? undefined : lockId}
              onClick={() => setOpen(true)}
            >
              {t("lifecycle.certificate.open")}
            </Button>
          </div>
        </CardAction>
      </CardHeader>
      {lock === null ? null : (
        <p id={lockId} className="text-sm leading-5 text-muted-foreground">
          {t(`lifecycle.certificate.locked.${lock}`)}
        </p>
      )}
      <Dialog open={open && lock === null} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <style>{PRINT_STYLE}</style>
          <DialogHeader>
            <DialogTitle>{t("lifecycle.certificate.title")}</DialogTitle>
            <DialogDescription>
              {t("lifecycle.certificate.previewNote")}
            </DialogDescription>
          </DialogHeader>
          <CertificateSheet certificate={certificate} />
          <p className="lifecycle-certificate-controls text-sm leading-5 text-muted-foreground">
            {t("lifecycle.certificate.printHint")}
          </p>
          <DialogFooter className="lifecycle-certificate-controls">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              {t("common.close")}
            </Button>
            <Button type="button" onClick={() => window.print()}>
              <Printer aria-hidden="true" />
              {t("lifecycle.certificate.print")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
