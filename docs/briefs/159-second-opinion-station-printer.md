# Brief 159: second opinion, station printer validation and KDS 404 (legend-e087, legend-qqvf)

Role: second-opinion (Codex). Tier K (authorization). Effort high. Read-only: do not edit, commit or push.

## Where
- Repo: `/Users/ifanshori99/Projects/legend super app/legend`, worktree `.worktrees/station-printer`, branch `ws/station-printer`.
- Diff range: `6f3063c7..5864a36c` (code + tests; the next commit b39cb392 is PROGRESS only).
- Background: `bd show legend-e087` and `bd show legend-qqvf`. A kitchen station may point at a printer. Before this change the printer could belong to another outlet or tenant, or be inactive. KDS tickets of another station answered 403, which told a station-scoped user the ticket exists.

## Run (one pass, about 100 non-test lines)
Files: `apps/api/src/services/menu.service.ts` (station create/update, printer validation, `FOR SHARE` on the device row, unchanged printer value not rewritten), `apps/api/src/services/kds.service.ts` (foreign-station ticket and item answer 404 like an unknown ticket). Tests in `apps/api/src/test/station-printer.test.ts`, `kds.test.ts`, `e2e-az/az-d-kds.test.ts` may be read for intent; they do not count.
Read for context, not in the diff: `apps/api/src/services/station-access.ts` (station scope, deny by default), the station and printer device schemas under `apps/api/src/db/schema/`.

## Invariants to try to break
1. A station's printer is always an active printer device of the same tenant and the same outlet as the station, on create and on update, including when the station moves outlet or the printer is deactivated or moved concurrently.
2. Every invalid printer case answers the same 422; the answer does not reveal whether a printer id exists in another outlet or tenant.
3. An update that sends the station's current printer value writes nothing, so a stale form cannot overwrite a manager's newer change.
4. A station-scoped user gets the same 404 for a ticket or item of another station as for a ticket that does not exist, on every KDS read and action (bump, recall, start, item moves); outlet-wide users keep access.
5. Tenant isolation on every query touched.

## Report
Findings with file:line, severity (High/Medium/Low), a concrete failing scenario and a suggested fix, or "no findings". Plain text, at most 600 words. Write it to `docs/briefs/159-second-opinion-station-printer.result.md` in the main checkout.
