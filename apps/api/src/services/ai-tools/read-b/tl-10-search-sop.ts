// TL-10 search_sop (bead legend-ktqc). Postgres full-text search
// (`to_tsvector('simple', title || ' ' || body)`) over the latest effective
// version of every SOP; no embeddings in this release.
//
// Visibility mirrors the SOP library (services/hris-sop.service.ts): a manager
// (`hr.sop.manage`) sees the documents of the outlets they reach, an employee
// (`self.sop.read` + own active employee row) sees documents of their home
// outlet and position. A caller who can see nothing gets AI_TOOL_FORBIDDEN.
// The query words are matched with OR so a natural-language question still
// finds the SOP; ranking puts the best match first.
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { searchSopInputSchema, type SearchSopOutput } from "@starter/shared/ai";
import { localDateOf, userIdSchema } from "@starter/shared/core";
import { db } from "../../../db/index.ts";
import { employees } from "../../../db/schema/hris.ts";
import { withTenant } from "../../../db/tenant.ts";
import type { AiToolHandler } from "../types.ts";
import { forbidden, tryResolveReach, uuidList } from "./support.ts";

const SNIPPET_LENGTH = 320;

type SopRow = {
  id: string;
  title: string;
  version: number;
  body: string;
};

/** Letters and digits only, so the tokens are safe inside a tsquery. */
export function sopQueryTokens(query: string): string[] {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(tokens.filter((token) => token.length >= 2))].slice(0, 12);
}

export function sopSnippet(
  body: string,
  title: string,
  tokens: string[],
): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat === "") return title.slice(0, 500);
  const lowered = flat.toLowerCase();
  const hits = tokens
    .map((token) => lowered.indexOf(token))
    .filter((index) => index >= 0);
  const at = hits.length > 0 ? Math.min(...hits) : 0;
  const start = Math.max(0, at - 80);
  const text = flat.slice(start, start + SNIPPET_LENGTH).trim();
  return `${start > 0 ? "..." : ""}${text}`.slice(0, 500);
}

const stationInOutlets = (ids: readonly string[]): SQL =>
  sql`exists (select 1 from stations st
    where st.tenant_id = sop_documents.tenant_id
      and st.id = sop_documents.station_id
      and st.outlet_id in (${uuidList(ids)}))`;

type Transaction = Parameters<Parameters<typeof withTenant>[2]>[0];

type RankedSopRow = SopRow & { rank: number | string };

export const searchSop: AiToolHandler = async (ctx, raw) => {
  const input = searchSopInputSchema.parse(raw);
  const empty: SearchSopOutput = { results: [], truncated: false };
  const manage = await tryResolveReach(ctx, "hr.sop.manage", "TL-10");
  const selfReach = ctx.access.permissions.includes("self.sop.read")
    ? await tryResolveReach(ctx, "self.sop.read", "TL-10")
    : null;
  if (!manage && !selfReach) throw forbidden();

  const tokens = sopQueryTokens(input.query);
  if (tokens.length === 0) return empty;
  const tenantId = ctx.access.tenant.tenantId;
  const today = localDateOf(ctx.now);
  const tsquery = tokens.join(" | ");

  const search = async (
    tx: Transaction,
    visible: SQL,
  ): Promise<RankedSopRow[]> => {
    const result = await tx.execute(sql`
      select sop_documents.id, sop_documents.title, sop_documents.version, sop_documents.body,
        ts_rank(to_tsvector('simple', sop_documents.title || ' ' || sop_documents.body), q) as rank
      from sop_documents, to_tsquery('simple', ${tsquery}) q
      where sop_documents.tenant_id = ${tenantId}::uuid
        and sop_documents.effective_from <= ${today}::date
        and not exists (select 1 from sop_documents next
          where next.tenant_id = sop_documents.tenant_id
            and next.supersedes_id = sop_documents.id
            and next.effective_from <= ${today}::date)
        and ${visible}
        and to_tsvector('simple', sop_documents.title || ' ' || sop_documents.body) @@ q
      order by rank desc, sop_documents.title, sop_documents.id
      limit ${input.limit + 1}
    `);
    return result.rows as RankedSopRow[];
  };

  // Each branch runs in its own reach context: the manage reach and the
  // self reach (home outlet) can differ, so one context would hide the other
  // branch's rows.
  const found: RankedSopRow[] = [];
  if (manage) {
    const visible =
      manage.outletIds === null
        ? sql`true`
        : sql`(sop_documents.station_id is null or ${stationInOutlets(manage.outletIds)})`;
    found.push(
      ...(await withTenant(db, manage.context, (tx) => search(tx, visible))),
    );
  }
  if (selfReach) {
    found.push(
      ...(await withTenant(db, selfReach.context, async (tx) => {
        const [own] = await tx
          .select({
            homeOutletId: employees.homeOutletId,
            positionId: employees.positionId,
          })
          .from(employees)
          .where(
            and(
              eq(employees.tenantId, tenantId),
              eq(employees.userId, userIdSchema.parse(ctx.access.userId)),
              inArray(employees.status, ["active", "onboarding"]),
            ),
          )
          .limit(1);
        if (!own) return [];
        const position = own.positionId
          ? sql`(sop_documents.position_id is null or sop_documents.position_id = ${own.positionId}::uuid)`
          : sql`sop_documents.position_id is null`;
        return search(
          tx,
          sql`((sop_documents.station_id is null or ${stationInOutlets([own.homeOutletId])}) and ${position})`,
        );
      })),
    );
  }

  const unique = new Map<string, RankedSopRow>();
  for (const row of found) if (!unique.has(row.id)) unique.set(row.id, row);
  const rows = [...unique.values()].sort(
    (a, b) =>
      Number(b.rank) - Number(a.rank) ||
      a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id),
  );
  const output: SearchSopOutput = {
    results: rows.slice(0, input.limit).map((row) => ({
      knowledgeChunkId: row.id,
      title: row.title,
      snippet: sopSnippet(row.body, row.title, tokens),
      sourceVersion: `v${row.version}`,
      link: `/sop/${row.id}`,
    })) as SearchSopOutput["results"],
    truncated: rows.length > input.limit,
  };
  return output;
};
