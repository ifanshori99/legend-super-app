// Shareholder statement issuing (PRD v1.7 §3.37, SH-01, SH-04; bead
// legend-2ljb). After a distribution line is paid: build that shareholder's
// statement through the contract, render the PDF, store it in object storage,
// set `statement_file_key` once and notify the shareholder's login by email.
//
// The caller (the payment route) runs this AFTER the payment commits and treats
// a failure as non-fatal: the key stays null and issuing again later is safe.
// Issuing is idempotent: the object key is derived from the line id, a line
// that already has a key is a no-op, and the key is written with
// `WHERE statement_file_key IS NULL`, so a race cannot overwrite it. The email
// goes out only by the call that wins that write, so a re-issue never sends a
// second message. The address is masked in logs.

import { and, eq, isNull } from "drizzle-orm";
import {
  attachDistributionStatement,
  buildDistributionStatement,
  type DistributionLine,
  type DistributionRun,
  type DistributionStatement,
} from "@starter/shared/accounting";
import type { EmailProvider, ObjectStorage } from "@starter/shared/adapters";
import { CoreError, type ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import {
  distributionLines,
  distributionRuns,
  profitEntities,
  shareholders,
} from "../db/schema/accounting-profit-share.ts";
import { tenants } from "../db/schema/platform-org.ts";
import { user } from "../db/schema/user.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import {
  maskEmail,
  renderStatementEmail,
} from "./profit-share-statement-email.ts";
import { renderDistributionStatementPdf } from "./profit-share-statement-pdf.ts";

export type StatementIssuerDeps = {
  /** `null`/missing: no storage provider is wired yet, issuing answers 503. */
  storage?: ObjectStorage | null;
  /** `null`/missing: no email provider is wired, the notice is skipped. */
  email?: EmailProvider | null;
  now?: () => Date;
};

let defaultDeps: StatementIssuerDeps = {};

/** Deployment bootstrap injects the real storage and email adapters here. */
export function configureProfitShareStatementDeps(deps: StatementIssuerDeps) {
  defaultDeps = deps;
}

export function statementFileKey(lineId: string): string {
  return `profit-share-statements/${lineId}.pdf`;
}

type Loaded = {
  statement: DistributionStatement;
  tenantName: string;
  recipientEmail: string | null;
};

async function load(
  context: ScopedTenantContext,
  input: { distributionRunId: string; distributionLineId: string },
): Promise<Loaded> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select({
        run: distributionRuns,
        line: distributionLines,
        shareholder: shareholders,
        entityName: profitEntities.name,
      })
      .from(distributionLines)
      .innerJoin(
        distributionRuns,
        and(
          eq(distributionRuns.tenantId, distributionLines.tenantId),
          eq(distributionRuns.id, distributionLines.distributionRunId),
        ),
      )
      .innerJoin(
        shareholders,
        and(
          eq(shareholders.tenantId, distributionLines.tenantId),
          eq(shareholders.id, distributionLines.shareholderId),
        ),
      )
      .innerJoin(
        profitEntities,
        and(
          eq(profitEntities.tenantId, distributionRuns.tenantId),
          eq(profitEntities.id, distributionRuns.profitEntityId),
        ),
      )
      .where(
        and(
          eq(distributionLines.tenantId, tenantId),
          eq(distributionLines.id, input.distributionLineId),
          eq(distributionLines.distributionRunId, input.distributionRunId),
        ),
      )
      .limit(1);
    if (!row)
      throw new CoreError("NOT_FOUND", "Baris pembagian tidak ditemukan.");

    // Only this line goes into the run object: the builder, and so the PDF and
    // the email, can never see another shareholder's row (SH-01).
    const line = {
      id: row.line.id,
      tenantId: row.line.tenantId,
      distributionRunId: row.line.distributionRunId,
      shareholderId: row.line.shareholderId,
      shareBp: row.line.shareBp,
      grossIdr: row.line.grossIdr,
      carryDeductedIdr: row.line.carryDeductedIdr,
      taxWithheldIdr: row.line.taxWithheldIdr,
      netIdr: row.line.netIdr,
      paymentStatus: row.line.paymentStatus,
      paymentRef: row.line.paymentRef,
      paidAt: row.line.paidAt?.toISOString() ?? null,
      statementFileKey: row.line.statementFileKey,
    } as unknown as DistributionLine;
    const run = {
      id: row.run.id,
      tenantId: row.run.tenantId,
      profitEntityId: row.run.profitEntityId,
      fiscalPeriodId: row.run.fiscalPeriodId,
      period: row.run.period,
      type: row.run.type,
      status: row.run.status,
      adjustsRunId: row.run.adjustsRunId,
      lines: [line],
    } as unknown as DistributionRun;
    if (line.paymentStatus !== "paid")
      throw new CoreError("CONFLICT", "Baris pembagian belum dibayar.");
    // Contract check: statements exist only on an approved or paid run.
    attachDistributionStatement(run, line.id, statementFileKey(line.id));

    const statement = buildDistributionStatement({
      run,
      line,
      shareholder: { id: row.shareholder.id, name: row.shareholder.name },
      profitEntity: { id: row.run.profitEntityId, name: row.entityName },
    } as Parameters<typeof buildDistributionStatement>[0]);

    const [tenant] = await tx
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    let recipientEmail: string | null = null;
    if (row.shareholder.userId) {
      const [account] = await tx
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, row.shareholder.userId))
        .limit(1);
      recipientEmail = account?.email ?? null;
    }
    return {
      statement,
      tenantName: tenant?.name ?? "Legend",
      recipientEmail,
    };
  });
}

/**
 * Issues the statement of one paid line. Resolves when the PDF is stored and
 * the key is set (or was already set); the email is best effort. Throws on a
 * missing storage provider, a missing line or an unpaid line.
 */
export async function issueDistributionStatement(
  context: ScopedTenantContext,
  input: { distributionRunId: string; distributionLineId: string },
  deps: StatementIssuerDeps = defaultDeps,
): Promise<void> {
  const loaded = await load(context, input);
  if (loaded.statement.statementFileKey) return;
  const storage = deps.storage;
  if (!storage)
    throw new HttpError(
      503,
      "SERVICE_UNAVAILABLE",
      "Penyimpanan dokumen belum tersedia.",
    );

  const key = statementFileKey(input.distributionLineId);
  const pdf = await renderDistributionStatementPdf(loaded.statement, {
    tenantName: loaded.tenantName,
  });
  const tenantId = context.tenant.tenantId;
  await storage.put(context, {
    tenantId,
    outletId: null,
    reference: `profit-share-statement:${input.distributionLineId}`,
    key,
    contentType: "application/pdf",
    content: new Uint8Array(pdf),
    visibility: "private",
  });

  const won = await withTenant(db, context, async (tx) => {
    const updated = await tx
      .update(distributionLines)
      .set({ statementFileKey: key })
      .where(
        and(
          eq(distributionLines.tenantId, tenantId),
          eq(distributionLines.id, input.distributionLineId),
          isNull(distributionLines.statementFileKey),
        ),
      )
      .returning({ id: distributionLines.id });
    return updated.length > 0;
  });
  if (!won || !loaded.recipientEmail || !deps.email) return;

  const message = renderStatementEmail(loaded.statement, {
    tenantName: loaded.tenantName,
  });
  try {
    await deps.email.send(context, {
      tenantId,
      outletId: null,
      reference: `profit-share-statement:${input.distributionLineId}`,
      to: loaded.recipientEmail,
      subject: message.subject,
      body: message.text,
    });
  } catch (error) {
    // The statement itself is issued; a mail failure must not undo that.
    logger.warn(
      {
        distributionLineId: input.distributionLineId,
        to: maskEmail(loaded.recipientEmail),
        errorName: error instanceof Error ? error.name : "unknown",
      },
      "profit share statement email failed",
    );
  }
}
