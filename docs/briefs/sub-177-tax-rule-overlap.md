# Sub-brief 177: tax rule overlap guard (legend-de3b)

Worktree (edit ONLY here): `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/tax-rule-overlap` (branch `ws/tax-rule-overlap`). Do not commit. Do not touch auto-journal, refund, `pos-shift.service.ts`, `pos-order.service.ts`, `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/*`.
Decision (CTO, `docs/briefs/177-tax-rule-overlap.md` in main checkout): mirror service charge legend-mdh0. `publishTaxRule` refuses a second active rule that would tie in `resolveTaxRule` with 409 `TAX_RULE_AMBIGUOUS` naming the other rule. Owner replaces a rule by publishing an inactive version (tombstone) of the old code first, then the new one. Existing duplicates are NOT changed automatically: they are listed and the owner fixes them.

Reference code: `assertNoServiceChargeOverlap` + `publishServiceChargeRule` in `apps/api/src/services/tax.service.ts` (~905-1060); engine `packages/shared/src/tax/calculate.ts` (`effectiveRuleVersions` :63, `pickMostSpecific` :101, `resolveTaxRule` :131: rank `[level item3/category2/itemClass1, outletId!==null, channels.length>0, regionCode!==null]`, channels empty = all, regionCode null = any). Tests: `apps/api/src/test/tax-service-overlap.test.ts`.

## Contract (all slices code against this)

### Shared: `packages/shared/src/tax/overlap.ts` (export from `packages/shared/src/tax/index.ts`)
```ts
export type TaxRuleTieLevel = "item" | "category" | "itemClass";
export type TaxRuleTie = {
  a: TaxRule; b: TaxRule;            // a = the rule being checked (or lower id), b = peer
  outletId: OutletId | null;         // null = tenant-wide view
  channel: TaxChannel;
  regionCode: string | null;
  level: TaxRuleTieLevel;
  key: string;                        // the itemId / categoryId / itemClass that ties
  effectiveDate: BusinessDate;        // first date both are in force and tie
};
/** One tie between exactly these two rules, using `resolveTaxRule([a, b], ...)` and catching TAX_RULE_AMBIGUOUS. */
export function taxRuleTie(a: TaxRule, b: TaxRule, outletId: OutletId | null): Omit<TaxRuleTie, "effectiveDate"> | null;
/** All pairwise ties among published rules in force, per outlet view, on `from` and on each later effectiveFrom. `onlyRuleId` limits to pairs containing that rule. One entry per unordered pair (first date found). */
export function findTaxRuleTies(rules: readonly TaxRule[], opts: { outletIds: readonly (OutletId | null)[]; from: BusinessDate; onlyRuleId?: string }): TaxRuleTie[];
```
Probe contexts for a pair: channels = a.channels if non-empty else all `taxChannelSchema.options`; regions = a.regionCode !== null ? [a.regionCode] : [null, b.regionCode if non-null]; lines: each a.itemIds (categoryId null), each a.categoryIds (with a sentinel itemId matching nothing), each a.itemClasses (sentinel itemId, categoryId null). Symmetric check: also probe with b's dimensions (swap) so a tie is found whichever rule is broader. Inactive rules never tie (effectiveRuleVersions drops tombstones). Outlet view `null` uses the sentinel outlet `00000000-0000-4000-8000-000000000000` for `effectiveRuleVersions`. Pure, no I/O. Unit tests next to existing shared tax tests (find where they live).

### API
- `assertNoTaxRuleOverlap(tx, tenantId, published)` in `tax.service.ts`, called in `publishTaxRule` after the row is marked published, under the existing `lockTaxConfig` (already taken at the top of `publishTaxRule`). Load published rules tenant-wide + (if outlet rule) that outlet; `findTaxRuleTies(rows, { outletIds: [published.outletId], from: published.effectiveFrom, onlyRuleId: published.id })`; first tie → `throw new TaxError("TAX_RULE_AMBIGUOUS", msg)` (rolls back). msg (Indonesian): `Aturan pajak ${mine.code} bertabrakan dengan aturan aktif ${peer.code} untuk pesanan ${channel} (${key}): keduanya berlaku sama kuat dan kasir akan gagal menghitung. Matikan aturan lama dulu (terbitkan versi tidak aktif) atau ubah cakupan aturan ini.`
- `listTaxRuleConflicts(context, actorUserId, query: { outletId?: OutletId })` in `tax.service.ts`, same permission as listing tax rules. Views: tenant-wide (null) + every outlet that has outlet-scoped rules (or only `query.outletId` and null when given). `from` = business today (same helper publish uses). Returns DTO below.
- Shared endpoint contract `listTaxRuleConflicts` in `packages/shared/src/tax/endpoints.ts` next to `listTaxRules`: `GET /tax/rules/conflicts`, query `{ outletId?: OutletId }`, response `{ conflicts: TaxRuleConflict[] }` where `TaxRuleConflict = { ruleA: { id, code, version, outletId }, ruleB: { id, code, version, outletId }, outletId: OutletId | null, channel: TaxChannel, regionCode: string | null, level: TaxRuleTieLevel, key: string, effectiveDate: BusinessDate }`.
- Route in `apps/api/src/routes/tax.routes.ts`: `taxRouter.get("/rules/conflicts", config, ...)` placed before any `/rules/:taxRuleId` GET, same pattern as `GET /rules`.

### Web (`apps/web/src/features/ws05-tax/`)
- `api.ts`/`queries.ts`/`hooks.ts`: `listTaxRuleConflicts` + query (invalidate it wherever tax rule queries are invalidated after create/publish).
- `tax-rules-page.tsx`: when conflicts exist, a warning banner (house UI standard `~/.agents/team/ui-standard.md`, existing alert component) listing each pair: codes, outlet (or "Semua outlet"), channel, key, date, and the fix: "Nonaktifkan salah satu: buat versi baru aturan itu dengan status Tidak aktif lalu terbitkan." Each pair gets a button opening the existing tax-rule dialog for a new version of that rule (reuse the existing "new version" flow) with `isActive` preset false if the dialog supports a preset; otherwise just open it.
- `errors.ts`: for `TAX_RULE_AMBIGUOUS` show the server message (it names the other rule) when present, falling back to the catalog string. Applies to service charge too.
- i18n strings in `packages/shared/src/i18n/messages/id.ts` (+ `en.ts` if it exists) under the tax namespace.

## Slices
- S1 shared overlap module + unit tests: `packages/shared/src/tax/overlap.ts`, `index.ts`, shared test file.
- S2 API: `tax.service.ts`, `tax.routes.ts`, `packages/shared/src/tax/endpoints.ts`.
- S3 Web + i18n: `apps/web/src/features/ws05-tax/*`, `packages/shared/src/i18n/messages/*`.
- S4 tests (test-writer, isolated worktree on pre-fix HEAD bd62055c): new `apps/api/src/test/tax-rule-overlap.test.ts`:
  1. Repro: provision default (`provisionDefaultTaxConfig` or tenant creation) → owner `createTaxRule` tenant-wide `CUSTOM-PBJT` food_beverage → `publishTaxRule`. Pre-fix: publish succeeds and a POS or QR quote fails 409 `TAX_RULE_AMBIGUOUS` (see `qr-order-api.test.ts:740` raw-rule pattern / helpers). Post-fix expectation: publish rejects with TaxError `TAX_RULE_AMBIGUOUS` whose message contains `PBJT-FNB`; nothing published; quote still works.
  2. Fix path: publish inactive version of `PBJT-FNB` (v2, isActive false), then `CUSTOM-PBJT` publish succeeds; pricing uses CUSTOM rate.
  3. Non-overlap: outlet-scoped rule, item-level rule, different channel set → publish OK (no false positive).
  4. Race: two drafts that tie, published concurrently → exactly one succeeds, other 409; `pg_locks` shows a non-granted advisory lock on `tax:provisioning:<tenantId>` while one waits (pattern: `provisioning-race.test.ts`).
  5. Conflicts listing: raw-insert two published tying rules → `listTaxRuleConflicts` returns the pair; after tombstoning one → empty.
  Run pre-fix (`LEGEND_TEST_FILES="src/test/tax-rule-overlap.test.ts" pnpm test` from worktree root, after `pnpm worktree:setup`): 1, 2(publish of CUSTOM without tombstone), 4, 5 must fail; report failure lines and the file's absolute path.

## Fix round 1 (review findings)

### F-UI (web + i18n only; do not edit API/shared tax files)
1. Banner never shows UUIDs: item/category key → name via existing item/category queries used by `tax-rule-dialog.tsx` pickers if available; otherwise only the level label ("item tertentu"/"kategori tertentu"). itemClass via existing label.
2. Banner shows outlet name (existing outlet list hook in ws05-tax `outlet.ts`/queries) instead of "Satu outlet"; show region when non-null.
3. Buttons: label "Buat versi nonaktif {code}"; disabled until the rules query is loaded; if the rule is not in the loaded page, fetch it (existing API) or show a toast — never a silent no-op. After the draft is saved from this flow, show "Draf versi nonaktif dibuat. Terbitkan agar berlaku." and make the draft easy to find (highlight/scroll or open publish).
4. Title copy "{count} pasang aturan pajak bertabrakan"; fix copy to match the toggle label "Aturan aktif" (e.g. "matikan sakelar Aturan aktif"); present tense only when effectiveDate <= today, else "mulai {date}".
5. Dialog with `presetInactive`: short note why it is inactive (names the other code); default `effectiveFrom` = later of the normal suggestion and `conflict.effectiveDate`.
6. a11y/layout: no `role="alert"` (use labelled region or `role="status"`), heading level after the page h2, banner placed below the shell header (not above the title).
7. `errors.ts`: show the server message for TAX_RULE_AMBIGUOUS only when the response body actually carried one (not the ApiError English fallback); else catalog string.

### F-API (api + shared tax only)
1. Server 409 messages contain no raw ids/enums: tax rule message `Aturan pajak ${mine} bertabrakan dengan aturan aktif ${peer} untuk ${channelLabel} (${scopeLabel}) ...` where channelLabel/itemClass use Indonesian labels (reuse shared i18n `id.ts` labels if importable server-side, else a small map in shared tax), item/category level → "item tertentu"/"kategori tertentu" (no UUID). Apply the same label mapping to the existing service-charge message; keep any assertions in `tax-service-overlap.test.ts` passing (update only if they assert raw enums, report it).
2. `listTaxRuleConflicts`: compute `from` per view with the same business-day helper publish uses (`businessToday(tx, context, outletId, now)`), calling `findTaxRuleTies` per view and de-duplicating pairs.
3. (architect) Tax rule 409 message also states the tie date and the peer version: "... dengan aturan aktif ${peer.code} v${peer.version} mulai ${tie.effectiveDate} ...".
