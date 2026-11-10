// Work certificate ("Surat Keterangan Kerja") for a leaving employee (WS-10
// lifecycle, brief 299). Routes: routes/hris-work-certificate.routes.ts.
//
// - HR (`hr.employee.manage` at the employee's home outlet) reads it once the
//   offboarding is `revoked` or `completed`; before that it is a 409. A leaver
//   has no access any more, so there is no self route: the certificate is
//   handed over through HR. Any other viewer of the row gets 403, and a row the
//   caller cannot reach answers 404 like a missing one.
// - The first read assigns `certificate_no` = `SK/<YYYY>/<NNNN>` (sequence per
//   tenant per Jakarta year, under an advisory lock so two first reads cannot
//   take the same number) and stamps `certificate_issued_at`. Later reads, and
//   the PDF, return the same number and date. A cancelled offboarding has no
//   certificate (404).
// - The PDF is rendered from the same data (hris-work-certificate-pdf.ts).

import { and, eq, sql } from "drizzle-orm";
import type { ScopedTenantContext, TenantId } from "@starter/shared/core";
import type { WorkCertificate } from "@starter/shared/hris";
import { db } from "../db/index.ts";
import { employees, positions } from "../db/schema/hris.ts";
import { hrisOffboardings } from "../db/schema/hris-lifecycle.ts";
import { legalEntities, outlets, tenants } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import {
  HRIS_AUDIT_SAFE_FIELDS,
  forbidden,
  hrisAuditEntry,
  loadHrisAccess,
  notFound,
  type Tx,
} from "./hris-access.ts";
import { renderWorkCertificatePdf } from "./hris-work-certificate-pdf.ts";

export const HRIS_OFFBOARDING_OBJECT_TYPE = "hris_offboarding";
const CERTIFICATE_NUMBER = /^SK\/\d{4}\/(\d+)$/;

export type WorkCertificatePdfFile = { pdf: Buffer; filename: string };

const offboardingNotFound = () => notFound("Offboarding");

/** Jakarta calendar year of an instant. */
function jakartaYear(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
  }).format(date);
}

/** Next `SK/<year>/<NNNN>`; the caller holds the per-tenant-year lock. */
async function nextCertificateNo(
  tx: Tx,
  tenantId: TenantId,
  year: string,
): Promise<string> {
  const prefix = `SK/${year}/`;
  const [row] = await tx
    .select({
      last: sql<
        string | null
      >`max(substring(${hrisOffboardings.certificateNo} from '[0-9]+$')::int)`,
    })
    .from(hrisOffboardings)
    .where(
      and(
        eq(hrisOffboardings.tenantId, tenantId),
        sql`${hrisOffboardings.certificateNo} LIKE ${`${prefix}%`}`,
      ),
    );
  const next = Number(row?.last ?? 0) + 1;
  return `${prefix}${String(next).padStart(4, "0")}`;
}

/** Sequence of a stored number, for tests and callers that sort. */
export function certificateSequence(certificateNo: string): number | null {
  const match = CERTIFICATE_NUMBER.exec(certificateNo);
  return match ? Number(match[1]) : null;
}

export async function getWorkCertificate(
  context: ScopedTenantContext,
  actorUserId: string,
  offboardingId: string,
  now = new Date(),
): Promise<WorkCertificate> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const [offboarding] = await tx
      .select()
      .from(hrisOffboardings)
      .where(
        and(
          eq(hrisOffboardings.tenantId, tenantId),
          eq(hrisOffboardings.id, offboardingId),
        ),
      );
    if (!offboarding || offboarding.status === "cancelled")
      throw offboardingNotFound();
    const [employee] = await tx
      .select()
      .from(employees)
      .where(
        and(
          eq(employees.tenantId, tenantId),
          eq(employees.id, offboarding.employeeId),
        ),
      );
    if (!employee) throw offboardingNotFound();

    const viewer = access.viewerFor({
      id: employee.id,
      homeOutletId: employee.homeOutletId,
    });
    if (!viewer) throw offboardingNotFound();
    if (viewer.kind !== "hr") throw forbidden();
    if (offboarding.status === "open")
      throw new HttpError(
        409,
        "CERTIFICATE_NOT_READY",
        "Surat keterangan kerja belum tersedia: akses karyawan belum dicabut.",
      );

    let certificateNo = offboarding.certificateNo;
    let issuedAt = offboarding.certificateIssuedAt;
    if (certificateNo === null || issuedAt === null) {
      const year = jakartaYear(now);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`legend:work-certificate:${tenantId}:${year}`}, 0))`,
      );
      // Re-read under the lock: a concurrent first read may have assigned it.
      const [fresh] = await tx
        .select({
          certificateNo: hrisOffboardings.certificateNo,
          certificateIssuedAt: hrisOffboardings.certificateIssuedAt,
        })
        .from(hrisOffboardings)
        .where(
          and(
            eq(hrisOffboardings.tenantId, tenantId),
            eq(hrisOffboardings.id, offboarding.id),
          ),
        );
      if (fresh?.certificateNo && fresh.certificateIssuedAt) {
        certificateNo = fresh.certificateNo;
        issuedAt = fresh.certificateIssuedAt;
      } else {
        certificateNo = await nextCertificateNo(tx, tenantId, year);
        issuedAt = now;
        await tx
          .update(hrisOffboardings)
          .set({
            certificateNo,
            certificateIssuedAt: issuedAt,
            updatedAt: now,
          })
          .where(
            and(
              eq(hrisOffboardings.tenantId, tenantId),
              eq(hrisOffboardings.id, offboarding.id),
            ),
          );
        await recordAudit(
          tx,
          context,
          hrisAuditEntry(context, actorUserId, now, {
            outletId: employee.homeOutletId,
            action: "hris.offboarding.certificate_issued",
            objectType: HRIS_OFFBOARDING_OBJECT_TYPE,
            objectId: offboarding.id,
            after: { status: offboarding.status },
          }),
          HRIS_AUDIT_SAFE_FIELDS,
        );
      }
    }

    const [tenant] = await tx
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    const [entity] = employee.legalEntityId
      ? await tx
          .select({ name: legalEntities.name })
          .from(legalEntities)
          .where(
            and(
              eq(legalEntities.tenantId, tenantId),
              eq(legalEntities.id, employee.legalEntityId),
            ),
          )
      : [];
    const [outlet] = await tx
      .select({ name: outlets.name })
      .from(outlets)
      .where(
        and(
          eq(outlets.tenantId, tenantId),
          eq(outlets.id, employee.homeOutletId),
        ),
      );
    const [position] = employee.positionId
      ? await tx
          .select({ name: positions.name })
          .from(positions)
          .where(
            and(
              eq(positions.tenantId, tenantId),
              eq(positions.id, employee.positionId),
            ),
          )
      : [];
    const [manager] = employee.managerId
      ? await tx
          .select({ fullName: employees.fullName })
          .from(employees)
          .where(
            and(
              eq(employees.tenantId, tenantId),
              eq(employees.id, employee.managerId),
            ),
          )
      : [];

    return {
      offboardingId: offboarding.id,
      certificateNo,
      issuedAt: issuedAt.toISOString(),
      company: { name: entity?.name ?? tenant?.name ?? "" },
      employee: {
        id: employee.id,
        fullName: employee.fullName,
        employeeNo: employee.employeeNo,
      },
      // The contract wants a name; an employee with no position prints "-".
      positionName: position?.name ?? "-",
      outletName: outlet?.name ?? "",
      joinDate: employee.joinDate,
      lastWorkingDate: offboarding.lastWorkingDate,
      exitType: offboarding.exitType,
      managerName: manager?.fullName ?? null,
    } as WorkCertificate;
  });
}

export async function getWorkCertificatePdf(
  context: ScopedTenantContext,
  actorUserId: string,
  offboardingId: string,
  now = new Date(),
): Promise<WorkCertificatePdfFile> {
  const certificate = await getWorkCertificate(
    context,
    actorUserId,
    offboardingId,
    now,
  );
  const slug = certificate.employee.employeeNo
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return {
    pdf: await renderWorkCertificatePdf(certificate),
    filename: `surat-keterangan-kerja-${slug || "karyawan"}.pdf`,
  };
}
