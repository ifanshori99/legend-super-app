# legend-dn4: WhatsApp login replies, default off, opt-in with monthly quota

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/dn4` (branch `ws/dn4-wa-replies`). Do not push, do not commit (the engineer commits). Only touch the files listed for your slice.
Criterion: AUTH-03 (PRD §3 F6). Pure policy already exists: `packages/shared/src/identity/{schemas,machines}.ts` (`loginReplyPolicySchema`, `shouldSendLoginReply`, `recordLoginReply`), `WHATSAPP_LOGIN_REPLY_ENABLED_DEFAULT=false` in `limits.ts`. `mergedReplyText(maskedEmail)` is in `apps/api/src/services/identity-merge.service.ts`.
Today `identity-wa-inbound.service.ts` sends nothing and has no send path. No real WhatsApp send adapter exists; the sender is an injected function.

## Shared names (all slices use exactly these)

Table `wa_login_reply_policies` (Drizzle export `waLoginReplyPolicies`, file `apps/api/src/db/schema/wa-login-reply.ts`, exported from the schema index like its neighbours):
- `tenant_id uuid PK references tenants(id)` (one row per tenant; no row = disabled)
- `enabled boolean NOT NULL DEFAULT false`
- `free_monthly_quota integer NOT NULL DEFAULT 1000` CHECK `>= 0 AND <= 1000` (PRD: provider free quota 1.000 pesan/bulan; tenant may only lower it)
- `replies_month char(7)` nullable (`YYYY-MM`, Asia/Jakarta via `usageMonth(now).month` from `services/platform-usage.service.ts`)
- `replies_this_month integer NOT NULL DEFAULT 0` CHECK `>= 0`
- `updated_by text`, `created_at`, `updated_at` timestamptz
- ENABLE + FORCE RLS on `tenant_id = current_setting('app.tenant_id')::uuid` style used by other tenant tables; grants to `legend_app` SELECT, INSERT, UPDATE (no DELETE).

Service `apps/api/src/services/wa-login-reply.service.ts`:
```ts
export type LoginReplyKind = "success" | "error" | "merged";
export type LoginReplySender = (input: {
  tenantId: string; receivingNumber: string; to: string; reference: string; text: string;
}) => Promise<void>;
export function loginReplyText(kind: LoginReplyKind, maskedEmail?: string | null): string;
/** Atomic: one UPDATE ... WHERE enabled AND (month-aware count) < quota RETURNING. true = a slot was taken. */
export async function claimLoginReplySlot(tenantId: string, now: Date): Promise<boolean>;
/** Claim then send. Never throws; send failure is swallowed (slot stays used). false = nothing sent. */
export async function sendLoginReply(input: {
  sender: LoginReplySender | undefined; tenantId: string; brandId: string | null;
  receivingNumber: string; to: string; eventId: string; kind: LoginReplyKind;
  maskedEmail?: string | null; now: Date;
}): Promise<boolean>;
```
Rules: no `sender` => return false BEFORE claiming (no quota use). Month rollover inside the same UPDATE (`replies_month <> :m` resets count to 1). Runs under `withTenant` with an `establishTenantContext({source:"webhook"})` scoped context (see `completeLink` in identity-wa-inbound.service.ts). `reference` = `login-reply:${eventId}`.

Inbound wiring (`identity-wa-inbound.service.ts`): `ProcessInboundDeps.sendReply?: LoginReplySender`. After the transaction commits (never inside it), call `sendLoginReply` when a challenge was found: `login` -> `success` (or `merged` with masked e-mail when completeLink merged), `rejected` with a found challenge -> `error`. No reply for: duplicate, unknown (not a login message), rate_limited, no challenge found. Reply failure never changes the outcome.

Settings service `apps/api/src/services/wa-login-reply-settings.service.ts`:
```ts
export type LoginReplySettings = { enabled: boolean; freeMonthlyQuota: number; repliesThisMonth: number; month: string };
export async function getLoginReplySettings(context: ScopedTenantContext, now?: Date): Promise<LoginReplySettings>;
export async function updateLoginReplySettings(context, input: { enabled: boolean; freeMonthlyQuota?: number }, now?: Date): Promise<LoginReplySettings>;
```
Update upserts the row, writes `recordAudit` action `wa_login_reply.settings_updated` (before/after enabled + quota, actor = context user) in the same tx; audit only when something changed. `repliesThisMonth` reads 0 when the stored month differs from the current month.
Route: in `routes/platform-integrations.routes.ts` (or a new sibling mounted next to it): `GET /whatsapp/login-replies` and `PUT /whatsapp/login-replies`, both `requireTenantPermission("org.settings.manage")`, strict Zod body `{ enabled: boolean, freeMonthlyQuota?: int 0..1000 }`. Follow the file's existing patterns.

Migration: `apps/api/drizzle/0226_wa_login_reply_policies.sql`, journal entry idx 226 `when` 1794305000000, run as the non-superuser migrator.

## Slices
- A: schema + migration + journal.
- B: `wa-login-reply.service.ts` + inbound wiring.
- C: settings service + route.
- D: tests (written from this contract, must fail first): `apps/api/src/test/wa-login-reply.test.ts` (zero sends by default in success, error, merge, rejected, rate-limited branches with a spy sender; opt-in sends; stops at quota; month rollover; parallel claims never exceed quota; cross-tenant isolation; no sender => no quota use) and `apps/api/src/test/wa-login-reply-settings-api.test.ts` (permission, audit on change, no audit on no-op, strict body). Model on `src/test/whatsapp-number-claim.test.ts`.
Run tests only as `LEGEND_TEST_FILES="src/test/x.test.ts" pnpm test` from the worktree root.
