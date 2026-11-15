import { dropTestDatabase, endTestPool } from "./helpers/database-cleanup.ts";
// Tax report revision chain, database rules (beads legend-r3i8w, legend-4uapw;
// docs/DECISIONS.md 2026-11-10 "Laporan pajak: pembetulan sebagai rantai
// revisi"; migration 0231_tax_report_revisions). Real PostgreSQL on the
// disposable test DB, all statements through the owner pool (the rules live in
// CHECKs, partial unique indexes and triggers, not in the service).
//
// Assumptions (the brief names columns, not constraint names):
// - Constraints are matched by SQLSTATE only: 23514 = check_violation (CHECKs
//   and the deferred chain trigger), 23505 = unique_violation, 42501 = the
//   guard trigger's refusal (same code 0228 already uses).
// - Setting only one of superseded_at / superseded_by_id is refused, but the
//   brief does not say by which layer, so the test accepts 42501 or 23514.
// - A valid chain is built the way the service finalizes: a draft row exists,
//   the old row gets superseded_at + superseded_by_id pointing at it, then the
//   draft becomes final with revision_no / supersedes_id / correction_reason,
//   all in ONE transaction (the chain trigger is deferred to COMMIT).
// - Migration 0231 is tested on a scratch database migrated only up to idx 230.

import { randomBytes, randomUUID } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const adminUrl = process.env.STARTER_TEST_DATABASE_URL;
const owner = new Pool({ connectionString: adminUrl, max: 3 });
const drizzleFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);

const NOW = "2026-11-10T03:00:00Z";
const LINE = {
  subjectType: "outlet",
  subjectId: randomUUID(),
  subjectName: "Outlet Uji",
  taxIdMasked: null,
  outletId: null,
  baseIdr: 1000,
  taxIdr: 100,
  references: [],
};

let tenantId: string;
let legalEntityId: string;

async function seedEntity() {
  const [tenant, entity] = [randomUUID(), randomUUID()];
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Revisi Pajak', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
    [
      tenant,
      `uji-revisi-${tenant.slice(0, 8)}`,
      JSON.stringify({
        maxOutlets: 1,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', true)",
    [entity, tenant],
  );
  return { tenant, entity };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const seeded = await seedEntity();
  tenantId = seeded.tenant;
  legalEntityId = seeded.entity;
});
afterAll(async () => {
  await endTestPool(owner);
});

// Every test takes its own period, so the unique indexes never cross tests.
let periodCounter = 0;
const nextPeriod = () => `${3000 + periodCounter++}-06`;

type Queryable = Pick<Pool, "query">;

type Row = {
  id?: string;
  period: string;
  type?: string;
  status?: "draft" | "final" | "exported";
  revisionNo?: number | null;
  supersedesId?: string | null;
  supersededById?: string | null;
  supersededAt?: string | null;
  correctionReason?: string | null;
  fiscalPeriodVersion?: number | null;
  fileKey?: string | null;
};

/** A valid row by default (draft, or a normal revision 0 when filed). */
async function insertRow(q: Queryable, o: Row): Promise<string> {
  const id = o.id ?? randomUUID();
  const status = o.status ?? "draft";
  const filed = status !== "draft";
  const exported = status === "exported";
  const has = <K extends keyof Row>(key: K, fallback: Row[K]) =>
    key in o ? o[key] : fallback;
  await q.query(
    `INSERT INTO tax_reports
       (id, tenant_id, legal_entity_id, type, period, amount_idr, lines, status,
        export_format, file_key, generated_by, generated_at,
        finalized_by, finalized_at, exported_at,
        revision_no, supersedes_id, superseded_by_id, superseded_at,
        correction_reason, fiscal_period_version)
     VALUES ($1, $2, $3, $4, $5, 100, $6::jsonb, $7,
             $8, $9, 'user-1', $10,
             $11, $12, $13,
             $14, $15, $16, $17,
             $18, $19)`,
    [
      id,
      tenantId,
      legalEntityId,
      o.type ?? "pbjt",
      o.period,
      JSON.stringify([LINE]),
      status,
      exported ? "coretax_xml" : null,
      exported ? has("fileKey", `t/tax/${id}.xml`) : null,
      NOW,
      filed ? "user-2" : null,
      filed ? NOW : null,
      exported ? NOW : null,
      has("revisionNo", filed ? 0 : null),
      has("supersedesId", null),
      has("supersededById", null),
      has("supersededAt", null),
      has("correctionReason", null),
      has("fiscalPeriodVersion", 1),
    ],
  );
  return id;
}

async function inTx<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Supersedes `oldId` the way the finalize service does, inside `client`'s
 * transaction. Returns the id of the new final row.
 */
async function supersede(
  client: Queryable,
  oldId: string,
  o: {
    period: string;
    revisionNo: number;
    reason?: string | null;
    type?: string;
  },
): Promise<string> {
  const newId = await insertRow(client, { period: o.period, type: o.type });
  await client.query(
    `UPDATE tax_reports
        SET superseded_at = $2, superseded_by_id = $3, version = version + 1
      WHERE id = $1`,
    [oldId, NOW, newId],
  );
  await client.query(
    `UPDATE tax_reports
        SET status = 'final', revision_no = $2, supersedes_id = $3,
            correction_reason = $4, finalized_by = 'user-2', finalized_at = $5,
            version = version + 1
      WHERE id = $1`,
    [newId, o.revisionNo, oldId, o.reason ?? `Pembetulan ${o.revisionNo}`, NOW],
  );
  return newId;
}

const update = (id: string, set: string) =>
  owner.query(`UPDATE tax_reports SET ${set} WHERE id = $1`, [id]);

async function currentCount(period: string, type = "pbjt"): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tax_reports
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND type = $3 AND period = $4
        AND status <> 'draft' AND superseded_at IS NULL`,
    [tenantId, legalEntityId, type, period],
  );
  return rows[0]!.n;
}

async function codeOf(run: Promise<unknown>): Promise<string | null> {
  try {
    await run;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? `unexpected: ${String(error)}`;
  }
}

describe("legend-r3i8w tax_reports revision columns and CHECKs", () => {
  it("stores a draft with no revision, and a normal filing as revision 0", async () => {
    const period = nextPeriod();
    const draft = await insertRow(owner, { period });
    const final = await insertRow(owner, {
      period,
      type: "ppn",
      status: "final",
    });
    const { rows } = await owner.query(
      `SELECT id, revision_no, supersedes_id, superseded_by_id, superseded_at,
              correction_reason, fiscal_period_version
         FROM tax_reports WHERE id = ANY($1::uuid[])`,
      [[draft, final]],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(draft)).toMatchObject({
      revision_no: null,
      supersedes_id: null,
      correction_reason: null,
      fiscal_period_version: 1,
    });
    expect(byId.get(final)).toMatchObject({
      revision_no: 0,
      supersedes_id: null,
      superseded_at: null,
      correction_reason: null,
    });
  });

  it("requires fiscal_period_version on every row", async () => {
    await expect(
      codeOf(
        insertRow(owner, { period: nextPeriod(), fiscalPeriodVersion: null }),
      ),
    ).resolves.toBe("23502");
  });

  describe("each CHECK rejects its bad case", () => {
    // Each row breaks one rule; the base row is the filed revision 0 that the
    // rows needing a supersedes_id point at.
    const cases: [string, (base: string) => Omit<Row, "period">][] = [
      [
        "a filed report without a revision number",
        () => ({ status: "final", revisionNo: null }),
      ],
      ["a draft that has a revision number", () => ({ revisionNo: 0 })],
      [
        "a negative revision number",
        () => ({ status: "final", revisionNo: -1 }),
      ],
      [
        "revision 0 that supersedes another report",
        (base) => ({ status: "final", revisionNo: 0, supersedesId: base }),
      ],
      [
        "a correction (revision 1) that supersedes nothing",
        () => ({
          status: "final",
          revisionNo: 1,
          correctionReason: "Salah hitung",
        }),
      ],
      [
        "a correction without a reason",
        (base) => ({ status: "final", revisionNo: 1, supersedesId: base }),
      ],
      [
        "revision 0 that carries a reason",
        () => ({
          status: "final",
          revisionNo: 0,
          correctionReason: "tidak perlu",
        }),
      ],
      [
        "a blank correction reason",
        (base) => ({
          status: "final",
          revisionNo: 1,
          supersedesId: base,
          correctionReason: "   ",
        }),
      ],
      [
        "superseded_at without superseded_by_id",
        () => ({ status: "final", supersededAt: NOW }),
      ],
      [
        "superseded_by_id without superseded_at",
        (base) => ({ status: "final", supersededById: base }),
      ],
    ];

    it.each(cases)("rejects %s", async (_name, build) => {
      const basePeriod = nextPeriod();
      const base = await insertRow(owner, {
        period: basePeriod,
        status: "final",
      });
      await expect(
        codeOf(insertRow(owner, { period: nextPeriod(), ...build(base) })),
      ).resolves.toBe("23514");
    });

    it("rejects a report that supersedes itself", async () => {
      const id = randomUUID();
      await expect(
        codeOf(
          insertRow(owner, {
            id,
            period: nextPeriod(),
            status: "final",
            supersededById: id,
            supersededAt: NOW,
          }),
        ),
      ).resolves.toBe("23514");
    });
  });
});

describe("legend-r3i8w one current report per period (unique indexes)", () => {
  it("rejects a second filed report while the first is still current", async () => {
    const period = nextPeriod();
    const first = await insertRow(owner, { period, status: "final" });
    // A correction row inserted without superseding the first one: two filed
    // rows for the key, both with superseded_at NULL.
    await expect(
      codeOf(
        insertRow(owner, {
          period,
          status: "final",
          revisionNo: 1,
          supersedesId: first,
          correctionReason: "Salah hitung",
        }),
      ),
    ).resolves.toBe("23505");
    expect(await currentCount(period)).toBe(1);
  });

  it("rejects two current revision-0 reports for the same key", async () => {
    const period = nextPeriod();
    await insertRow(owner, { period, status: "final" });
    await expect(
      codeOf(insertRow(owner, { period, status: "exported" })),
    ).resolves.toBe("23505");
  });

  it("rejects a duplicate revision_no even when the duplicate is itself superseded", async () => {
    const period = nextPeriod();
    const rev0 = await insertRow(owner, { period, status: "final" });
    const rev1 = await inTx((c) =>
      supersede(c, rev0, { period, revisionNo: 1 }),
    );
    // Superseded already, so the "one current" index is not involved: only the
    // (key, revision_no) index can refuse it.
    await expect(
      codeOf(
        insertRow(owner, {
          period,
          status: "final",
          revisionNo: 1,
          supersedesId: rev0,
          correctionReason: "Salinan",
          supersededAt: NOW,
          supersededById: rev1,
        }),
      ),
    ).resolves.toBe("23505");
  });

  it("lets drafts and other keys sit beside the current report", async () => {
    const period = nextPeriod();
    await insertRow(owner, { period, status: "final" });
    await insertRow(owner, { period }); // the draft of the next correction
    await insertRow(owner, { period, type: "ppn", status: "final" });
    await insertRow(owner, { period: nextPeriod(), status: "final" });
  });

  it("builds a chain 0 -> 1 -> 2 that keeps exactly one current report", async () => {
    const period = nextPeriod();
    const rev0 = await insertRow(owner, { period, status: "exported" });
    const rev1 = await inTx((c) =>
      supersede(c, rev0, { period, revisionNo: 1 }),
    );
    expect(await currentCount(period)).toBe(1);
    const rev2 = await inTx((c) =>
      supersede(c, rev1, { period, revisionNo: 2 }),
    );
    expect(await currentCount(period)).toBe(1);

    const { rows } = await owner.query(
      `SELECT id, revision_no, supersedes_id, superseded_by_id, superseded_at IS NOT NULL AS superseded
         FROM tax_reports WHERE tenant_id = $1 AND period = $2 AND type = 'pbjt'
        ORDER BY revision_no`,
      [tenantId, period],
    );
    expect(rows).toEqual([
      {
        id: rev0,
        revision_no: 0,
        supersedes_id: null,
        superseded_by_id: rev1,
        superseded: true,
      },
      {
        id: rev1,
        revision_no: 1,
        supersedes_id: rev0,
        superseded_by_id: rev2,
        superseded: true,
      },
      {
        id: rev2,
        revision_no: 2,
        supersedes_id: rev1,
        superseded_by_id: null,
        superseded: false,
      },
    ]);
  });
});

describe("legend-r3i8w deferred chain trigger (checked at COMMIT)", () => {
  /** Runs `body` in a transaction and returns the SQLSTATE of the failure. */
  async function commitCode(body: (client: PoolClient) => Promise<void>) {
    return codeOf(inTx(body));
  }

  it("rejects at COMMIT an old row superseded by a replacement with the wrong revision number", async () => {
    const period = nextPeriod();
    const rev0 = await insertRow(owner, { period, status: "final" });
    const code = await commitCode(async (c) => {
      // Replacement claims revision 2; the old row is revision 0, so it must be 1.
      await supersede(c, rev0, { period, revisionNo: 2 });
    });
    expect(code).toBe("23514");
    // Rolled back: the old report is still the current one.
    expect(await currentCount(period)).toBe(1);
    const { rows } = await owner.query(
      "SELECT superseded_at FROM tax_reports WHERE id = $1",
      [rev0],
    );
    expect(rows[0].superseded_at).toBeNull();
  });

  it("rejects at COMMIT an old row whose replacement is still a draft", async () => {
    const period = nextPeriod();
    const rev0 = await insertRow(owner, { period, status: "final" });
    const code = await commitCode(async (c) => {
      const draft = await insertRow(c, { period });
      await c.query(
        "UPDATE tax_reports SET superseded_at = $2, superseded_by_id = $3 WHERE id = $1",
        [rev0, NOW, draft],
      );
    });
    expect(code).toBe("23514");
    expect(await currentCount(period)).toBe(1);
  });

  it("rejects at COMMIT a replacement that belongs to another period", async () => {
    const period = nextPeriod();
    const otherPeriod = nextPeriod();
    const rev0 = await insertRow(owner, { period, status: "final" });
    const otherRev0 = await insertRow(owner, {
      period: otherPeriod,
      status: "final",
    });
    const code = await commitCode(async (c) => {
      // The "replacement" is a correction of the OTHER period's report.
      const foreign = await supersede(c, otherRev0, {
        period: otherPeriod,
        revisionNo: 1,
      });
      await c.query(
        "UPDATE tax_reports SET superseded_at = $2, superseded_by_id = $3 WHERE id = $1",
        [rev0, NOW, foreign],
      );
    });
    expect(code).toBe("23514");
    expect(await currentCount(period)).toBe(1);
    expect(await currentCount(otherPeriod)).toBe(1);
  });

  it("rejects at COMMIT a replacement that does not point back at the old row", async () => {
    const period = nextPeriod();
    const rev0 = await insertRow(owner, { period, status: "final" });
    const code = await commitCode(async (c) => {
      const draft = await insertRow(c, { period });
      await c.query(
        "UPDATE tax_reports SET superseded_at = $2, superseded_by_id = $3 WHERE id = $1",
        [rev0, NOW, draft],
      );
      // Final revision 1 but with supersedes_id of a different (new) row.
      const stray = await insertRow(c, {
        period: nextPeriod(),
        status: "final",
      });
      await c.query(
        `UPDATE tax_reports
            SET status = 'final', revision_no = 1, supersedes_id = $2,
                correction_reason = 'Salah hitung', finalized_by = 'user-2', finalized_at = $3
          WHERE id = $1`,
        [draft, stray, NOW],
      );
    });
    expect(code).toBe("23514");
    expect(await currentCount(period)).toBe(1);
  });

  it("commits a consistent chain", async () => {
    const period = nextPeriod();
    const rev0 = await insertRow(owner, { period, status: "final" });
    await expect(
      inTx((c) => supersede(c, rev0, { period, revisionNo: 1 })),
    ).resolves.toEqual(expect.any(String));
    expect(await currentCount(period)).toBe(1);
  });
});

describe("legend-r3i8w guard trigger on revision data", () => {
  const SUPERSEDE_FIELDS = "superseded_at = NULL, superseded_by_id = NULL";

  it("lets a draft change freely, including fiscal_period_version, and be deleted", async () => {
    const period = nextPeriod();
    const draft = await insertRow(owner, { period });
    await update(
      draft,
      "fiscal_period_version = 7, amount_idr = 5, lines = '[]'::jsonb",
    );
    const del = await owner.query("DELETE FROM tax_reports WHERE id = $1", [
      draft,
    ]);
    expect(del.rowCount).toBe(1);
  });

  it("lets a draft become final and fill the revision fields", async () => {
    // Covered by supersede(); here the first filing (revision 0) from a draft.
    const period = nextPeriod();
    const draft = await insertRow(owner, { period, fiscalPeriodVersion: 2 });
    await update(
      draft,
      `status = 'final', revision_no = 0, finalized_by = 'user-2', finalized_at = '${NOW}', version = version + 1`,
    );
    const { rows } = await owner.query(
      "SELECT status, revision_no FROM tax_reports WHERE id = $1",
      [draft],
    );
    expect(rows[0]).toEqual({ status: "final", revision_no: 0 });
  });

  describe("after draft the revision fields are locked", () => {
    it.each([
      ["revision_no", "revision_no = 5"],
      ["supersedes_id", "supersedes_id = NULL"],
      ["correction_reason", "correction_reason = 'alasan lain'"],
      ["fiscal_period_version", "fiscal_period_version = 9"],
    ])("rejects changing %s of a correction", async (_name, set) => {
      const period = nextPeriod();
      const rev0 = await insertRow(owner, { period, status: "final" });
      const rev1 = await inTx((c) =>
        supersede(c, rev0, { period, revisionNo: 1 }),
      );
      await expect(codeOf(update(rev1, set))).resolves.toBe("42501");
    });

    it("rejects changing fiscal_period_version of a normal filing", async () => {
      const filed = await insertRow(owner, {
        period: nextPeriod(),
        status: "final",
      });
      await expect(
        codeOf(update(filed, "fiscal_period_version = 9")),
      ).resolves.toBe("42501");
    });
  });

  describe("superseded_at + superseded_by_id", () => {
    it("can be set together once, from NULL (the chain tests above)", async () => {
      const period = nextPeriod();
      const rev0 = await insertRow(owner, { period, status: "final" });
      await inTx((c) => supersede(c, rev0, { period, revisionNo: 1 }));
      const { rows } = await owner.query(
        "SELECT superseded_at, superseded_by_id FROM tax_reports WHERE id = $1",
        [rev0],
      );
      expect(rows[0].superseded_at).not.toBeNull();
      expect(rows[0].superseded_by_id).not.toBeNull();
    });

    it("cannot be set on its own (one without the other)", async () => {
      const filed = await insertRow(owner, {
        period: nextPeriod(),
        status: "final",
      });
      const code = await codeOf(update(filed, `superseded_at = '${NOW}'`));
      expect(["42501", "23514"]).toContain(code);
    });

    it("cannot be cleared, repointed or changed once set", async () => {
      const period = nextPeriod();
      const rev0 = await insertRow(owner, { period, status: "final" });
      await inTx((c) => supersede(c, rev0, { period, revisionNo: 1 }));
      const unrelated = await insertRow(owner, {
        period: nextPeriod(),
        status: "final",
      });
      await expect(codeOf(update(rev0, SUPERSEDE_FIELDS))).resolves.toBe(
        "42501",
      );
      await expect(
        codeOf(update(rev0, `superseded_by_id = '${unrelated}'`)),
      ).resolves.toBe("42501");
      await expect(
        codeOf(
          update(rev0, "superseded_at = superseded_at + interval '1 day'"),
        ),
      ).resolves.toBe("42501");
    });
  });

  describe("a superseded row rejects any change", () => {
    it("rejects final -> exported on a superseded report", async () => {
      const period = nextPeriod();
      const rev0 = await insertRow(owner, { period, status: "final" });
      await inTx((c) => supersede(c, rev0, { period, revisionNo: 1 }));
      await expect(
        codeOf(
          update(
            rev0,
            `status = 'exported', export_format = 'coretax_xml', file_key = 'late.xml', exported_at = '${NOW}'`,
          ),
        ),
      ).resolves.toBe("42501");
    });

    it("rejects even a version bump, and deleting it", async () => {
      const period = nextPeriod();
      const rev0 = await insertRow(owner, { period, status: "exported" });
      await inTx((c) => supersede(c, rev0, { period, revisionNo: 1 }));
      await expect(codeOf(update(rev0, "version = version + 1"))).resolves.toBe(
        "42501",
      );
      await expect(
        codeOf(owner.query("DELETE FROM tax_reports WHERE id = $1", [rev0])),
      ).resolves.toBe("42501");
    });

    it("keeps the new current report exportable", async () => {
      const period = nextPeriod();
      const rev0 = await insertRow(owner, { period, status: "final" });
      const rev1 = await inTx((c) =>
        supersede(c, rev0, { period, revisionNo: 1 }),
      );
      await update(
        rev1,
        `status = 'exported', export_format = 'coretax_xml', file_key = 'rev1.xml', exported_at = '${NOW}', version = version + 1`,
      );
    });
  });

  describe("file_key is locked once set (re-export cannot swap the file)", () => {
    it("rejects swapping or clearing the file of an exported report", async () => {
      const exported = await insertRow(owner, {
        period: nextPeriod(),
        status: "exported",
        fileKey: "t/tax/original.xml",
      });
      await expect(
        codeOf(update(exported, "file_key = 't/tax/other.xml'")),
      ).resolves.toBe("42501");
      await expect(
        codeOf(
          update(
            exported,
            "file_key = NULL, export_format = NULL, exported_at = NULL, status = 'final'",
          ),
        ),
      ).resolves.toBe("42501");
      const { rows } = await owner.query(
        "SELECT file_key FROM tax_reports WHERE id = $1",
        [exported],
      );
      expect(rows[0].file_key).toBe("t/tax/original.xml");
    });

    it("lets the first export fill file_key, and a repeat that keeps it", async () => {
      const filed = await insertRow(owner, {
        period: nextPeriod(),
        status: "final",
      });
      await update(
        filed,
        `status = 'exported', export_format = 'coretax_xml', file_key = 'first.xml', exported_at = '${NOW}', version = version + 1`,
      );
      // A repeated export keeps the same file: a version bump alone is allowed.
      await update(filed, "version = version + 1");
    });
  });
});

// ---- finalize_idempotency_key (added inside migration 0231) --------------------
//
// Assumptions: the key is filled by the same UPDATE that turns the draft final
// (like revision_no). Once non-NULL it can be neither changed nor cleared (guard
// trigger, 42501). Uniqueness is per tenant, over non-NULL keys only (23505).
// The column is varchar(100): 101 characters is refused with 22001.

describe("legend-r3i8w finalize_idempotency_key", () => {
  const unique = () => randomBytes(4).toString("hex");
  const FINALIZE =
    "status = 'final', revision_no = 0, finalized_by = 'user-2', " +
    `finalized_at = '${NOW}', version = version + 1`;

  /** A draft filed with `key`, as the finalize service does it. */
  async function filedWith(key: string | null, period = nextPeriod()) {
    const id = await insertRow(owner, { period });
    await update(
      id,
      key === null
        ? FINALIZE
        : `${FINALIZE}, finalize_idempotency_key = '${key}'`,
    );
    return id;
  }

  const keyOf = async (id: string) =>
    (
      await owner.query<{ k: string | null }>(
        "SELECT finalize_idempotency_key AS k FROM tax_reports WHERE id = $1",
        [id],
      )
    ).rows[0]!.k;

  it("is NULL on a draft and is filled when the draft becomes final", async () => {
    const period = nextPeriod();
    const draft = await insertRow(owner, { period });
    expect(await keyOf(draft)).toBeNull();
    await update(
      draft,
      `${FINALIZE}, finalize_idempotency_key = 'fin-${unique()}'`,
    );
    expect(await keyOf(draft)).toMatch(/^fin-/);
  });

  it("lets a draft change its key freely while still a draft", async () => {
    const draft = await insertRow(owner, { period: nextPeriod() });
    await update(draft, "finalize_idempotency_key = 'draft-a'");
    await update(draft, "finalize_idempotency_key = 'draft-b'");
    await update(draft, "finalize_idempotency_key = NULL");
  });

  it("rejects changing the key once the report is final", async () => {
    const id = await filedWith(`lock-${unique()}`);
    const before = await keyOf(id);
    await expect(
      codeOf(update(id, "finalize_idempotency_key = 'other'")),
    ).resolves.toBe("42501");
    expect(await keyOf(id)).toBe(before);
  });

  it("rejects clearing the key once the report is final", async () => {
    const id = await filedWith(`clear-${unique()}`);
    const before = await keyOf(id);
    await expect(
      codeOf(update(id, "finalize_idempotency_key = NULL")),
    ).resolves.toBe("42501");
    expect(await keyOf(id)).toBe(before);
  });

  it("keeps the key locked through export, and a version bump that leaves it alone is fine", async () => {
    const id = await filedWith(`exp-${unique()}`);
    const before = await keyOf(id);
    await update(
      id,
      `status = 'exported', export_format = 'coretax_xml', file_key = 'k.xml', exported_at = '${NOW}', version = version + 1`,
    );
    expect(await keyOf(id)).toBe(before);
    await expect(
      codeOf(update(id, "finalize_idempotency_key = 'swap'")),
    ).resolves.toBe("42501");
  });

  it("rejects the same key on two reports of one tenant (partial unique index)", async () => {
    const key = `dup-${unique()}`;
    await filedWith(key);
    const second = await insertRow(owner, { period: nextPeriod() });
    await expect(
      codeOf(
        update(second, `${FINALIZE}, finalize_idempotency_key = '${key}'`),
      ),
    ).resolves.toBe("23505");
    // Still a draft: the failed statement changed nothing.
    const { rows } = await owner.query(
      "SELECT status FROM tax_reports WHERE id = $1",
      [second],
    );
    expect(rows[0].status).toBe("draft");
  });

  it("rejects the same key even for another type or legal entity of the tenant", async () => {
    const key = `scope-${unique()}`;
    await filedWith(key);
    const other = await insertRow(owner, {
      period: nextPeriod(),
      type: "ppn",
    });
    await expect(
      codeOf(update(other, `${FINALIZE}, finalize_idempotency_key = '${key}'`)),
    ).resolves.toBe("23505");
  });

  it("allows many rows without a key (NULL is not a duplicate)", async () => {
    await filedWith(null);
    await filedWith(null);
    await insertRow(owner, { period: nextPeriod() });
    await insertRow(owner, { period: nextPeriod() });
  });

  it("allows the same key in different tenants", async () => {
    const key = `tenant-${unique()}`;
    await filedWith(key);
    const otherTenant = await seedEntity();
    const id = randomUUID();
    await owner.query(
      `INSERT INTO tax_reports
         (id, tenant_id, legal_entity_id, type, period, amount_idr, lines, status,
          generated_by, generated_at, finalized_by, finalized_at, revision_no,
          fiscal_period_version, finalize_idempotency_key)
       VALUES ($1, $2, $3, 'pbjt', $4, 100, $5::jsonb, 'final',
               'user-1', $6, 'user-2', $6, 0, 1, $7)`,
      [
        id,
        otherTenant.tenant,
        otherTenant.entity,
        nextPeriod(),
        JSON.stringify([LINE]),
        NOW,
        key,
      ],
    );
    expect(await keyOf(id)).toBe(key);
  });

  it("is a varchar(100): 100 characters fit, 101 do not", async () => {
    const ok = await filedWith("a".repeat(100));
    expect((await keyOf(ok))!.length).toBe(100);
    const draft = await insertRow(owner, { period: nextPeriod() });
    await expect(
      codeOf(update(draft, `finalize_idempotency_key = '${"b".repeat(101)}'`)),
    ).resolves.toBe("22001");
  });
});

// ---- Migration 0231 on a database that already holds a report ----------------

const lastBeforeRevisions = 230;
const adminOnly = () => {
  if (
    !adminUrl ||
    !process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-")
  )
    throw new Error(
      "Run this suite through pnpm test so it gets the disposable PostgreSQL server.",
    );
  return adminUrl;
};

function urlFor(database: string) {
  const url = new URL(adminOnly());
  url.pathname = `/${database}`;
  return url.toString();
}

function copyMigrationsUpTo0230() {
  const dir = mkdtempSync(join(tmpdir(), "legend-mig-0230-"));
  const folder = join(dir, "drizzle");
  cpSync(drizzleFolder, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { idx: number }[];
  };
  journal.entries = journal.entries.filter((e) => e.idx <= lastBeforeRevisions);
  writeFileSync(journalPath, JSON.stringify(journal));
  return { dir, folder };
}

describe("legend-r3i8w migration 0231 on a database migrated only to 0230", () => {
  const scratchName = `tax_rev_up_${randomBytes(6).toString("hex")}`;
  let admin: Pool;
  let scratch: Pool;
  let workDir: string;

  const hasColumn = async (column: string) => {
    const { rows } = await scratch.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tax_reports' AND column_name = $1`,
      [column],
    );
    return rows.length > 0;
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: adminOnly(), max: 1 });
    await admin.query(`CREATE DATABASE ${scratchName}`);
    scratch = new Pool({ connectionString: urlFor(scratchName), max: 2 });
    const copy = copyMigrationsUpTo0230();
    workDir = copy.dir;
    await migrate(drizzle(scratch), { migrationsFolder: copy.folder });

    // One draft report from before 0231. Seeded with FK checks off (the disposable
    // server's user is a superuser, as in contract-tax-scheme-migration.test.ts)
    // so the tenant / legal entity chain need not be built.
    const client = await scratch.connect();
    try {
      await client.query("SET session_replication_role = replica");
      await client.query(
        `INSERT INTO tax_reports
           (id, tenant_id, legal_entity_id, type, period, amount_idr, lines, status, generated_by)
         VALUES ($1, $2, $3, 'pbjt', '2025-01', 0, '[]'::jsonb, 'draft', 'user-1')`,
        [randomUUID(), randomUUID(), randomUUID()],
      );
    } finally {
      await client.query("RESET session_replication_role").catch(() => {});
      client.release();
    }
  }, 180_000);

  afterAll(async () => {
    if (scratch) await endTestPool(scratch);
    if (admin) {
      try {
        await dropTestDatabase(admin, scratchName);
      } finally {
        await endTestPool(admin);
      }
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("starts without the revision columns and with one draft row (the fixture really stops at 0230)", async () => {
    expect(await hasColumn("revision_no")).toBe(false);
    const { rows } = await scratch.query(
      "SELECT count(*)::int AS n FROM tax_reports",
    );
    expect(rows[0].n).toBe(1);
  });

  it("fails while tax_reports has a row, and leaves the table untouched", async () => {
    await expect(
      migrate(drizzle(scratch), { migrationsFolder: drizzleFolder }),
    ).rejects.toThrow(/tax_reports/);
    expect(await hasColumn("revision_no")).toBe(false);
    expect(await hasColumn("fiscal_period_version")).toBe(false);
    const { rows } = await scratch.query(
      "SELECT count(*)::int AS n FROM tax_reports",
    );
    expect(rows[0].n).toBe(1);
  }, 120_000);

  it("applies once the table is empty and adds the revision columns", async () => {
    await scratch.query("DELETE FROM tax_reports");
    await expect(
      migrate(drizzle(scratch), { migrationsFolder: drizzleFolder }),
    ).resolves.not.toThrow();
    for (const column of [
      "revision_no",
      "supersedes_id",
      "superseded_by_id",
      "superseded_at",
      "correction_reason",
      "fiscal_period_version",
      "finalize_idempotency_key",
    ])
      expect(await hasColumn(column), column).toBe(true);
    const { rows } = await scratch.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'tax_reports' AND column_name = 'fiscal_period_version'`,
    );
    expect(rows[0].is_nullable).toBe("NO");
  }, 120_000);
});
