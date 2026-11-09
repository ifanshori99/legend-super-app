# WS-08 explore (read-only map)

Repo: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ws08-site` (branch ws/ws08-site from milestone/m1). Card text: `bd show <id> --json`.
Output for each card: relevant files with line numbers, what already exists, what is missing, migrations touched (latest number in apps/api/drizzle), existing test files to extend. Max ~60 lines. No fixes, no edits.

## A. Public site (legend-qgr6)
- `GET /api/public/site` missing: apps/api/src/routes/public-site.routes.ts only serves /menu. Find contract `getPublicSite` / public site schema in packages/shared, the web caller and WebsiteError at `/` (apps/web), tenant/brand/website settings tables + services, how tenant is resolved from Host on public routes (TEN-08 whitelabel: platform name must not leak on tenant domains).
- Also check branch `ws/fix-whitelabel` (`git diff milestone/m1...ws/fix-whitelabel --stat`, then its getPublicSite use in manifest) and `ws/fix-auth06` commit bcad09cf note.
- Existing public-site tests.

## B. Promo + refund (legend-nloi, legend-q1e0, legend-9be7, legend-ba8p, legend-jh27)
- crm-promo routes/services/schema, Idempotency-Key pattern in ws05 routes, order-promo-refund.ts, promoPartialRefundPort, refund module/tx (where to inject), promotion_customer_usage/vouchers/facility_rewards tables, customer_profiles + products tables existence, per-outlet opt-out implementation.

## C. CRM loyalty/campaign (legend-o9fc, legend-a8up, legend-pxm8, legend-7fcc)
- packages/shared/src/crm/{loyalty,promo,campaign...}.ts, whatsappHash computation sites, reservation hashGuestContact + audit hashIpForAudit, loyalty program contract/service/schema, campaign automation schema + FE mock apps/web/src/features/ws08-crm-campaigns/automations.ts, campaign send pipeline, feedback DTO + /kelola/ulasan, campaign detail/segment reads, previewSegment.

## D. Reservation (legend-gbkw, legend-u0q8)
- reservation routes/services/schema, reservationDepositLinkSchema, createReservation deposit link minting (WS-05 payment intent), reservation desk FE, reservation policy tables + SQL seeding to replace with admin endpoints, permissions.
