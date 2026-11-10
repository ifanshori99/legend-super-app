# W3 review brief (legend-cqrw, K tier)

Worktree: .worktrees/ws03-menu-w2. Uncommitted files = W3 only (`git status --porcelain`, `git diff`).
Card: `bd show legend-cqrw`. Decisions: per-outlet policy table via 0087; defaults Rp 3.000.000 / 45 min / 180 s (never "no limit");
limit check = single guarded call in qr-order.service.ts → 409 QR_ORDER_OPEN_BILL_LIMIT; breaches audited + outbox `open_bill.limit_exceeded`;
inactivity sweep in worker-main.ts → zone waiters, once per idle spell.
Check at least:

- 0087 under a plain non-superuser table-owner migrator: FKs into FORCE-RLS tables (outlets, tenants) need the NO FORCE/FORCE pattern of 0065/0068 (see apps/api/src/test/edge-received-events-migration.test.ts). RLS policies match neighbours (tenant + outlet, polqual + polwithcheck; db/outlet-rls.test.ts guard).
- Limit math: integer IDR, which total (incl. tax/service? pending vs placed vs voided orders), race between two concurrent placements (lock on session row?), refusal happens before any write.
- Audit-in-own-transaction: cannot be abused to spam; no leak of tenant data.
- Sweep: per-tenant try/catch, idempotency of "once per idle spell", system actor, cost on many tenants.
- Copied waiterRecipients helper diverging from service-request.service.ts.
  Output: real bugs only, `path:line: severity: problem. fix.`, max 12 lines. Read-only; you may run targeted tests via `LEGEND_TEST_FILES=... heavy pnpm test`.
