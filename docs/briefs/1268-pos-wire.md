# 1268 Sambung layar kasir, bayar, shift, dan captain ke server

Dasar: `int/rc1` (= milestone/m1 + `pnpm test:shards`). Rencana dari architect 25 Nov; keputusan CTO di bawah mengalahkan rencana.

## Keputusan CTO

- Urutan: B1, 1162, mockup W5 (paralel); lalu B2, B3, W0; lalu W1-W3; lalu W4, W5, W6. Maks 3 agent mengedit.
- EDC rilis 1: manual (PIN supervisor + nomor referensi bank) tetap jadi cadangan. Founder 25 Nov malam: ECR, VA, e-wallet, kartu online, dan cetak struk edge WAJIB di rilis 1 (lihat `1269-scope-tambahan.md`); tetap terkunci sampai kartu 1269 selesai. Kode kasir, tunai sebagian, tutup paksa tetap terkunci.
- W5: mockup `design/mockups/pos/1268-pesanan-terbuka/` disetujui founder 25 Nov; tab "Belum selesai". B2 menambah untuk W5: sisa tagihan, label meja, filter beberapa status, jumlah, jumlah item ditahan di ringkasan `listPosOrders`; pesanan diparkir tidak punya harga (tampilkan tanpa harga, jangan ditebak).
- "Jangan sampai rugi": hasil tak diketahui = kunci semua cara bayar tagihan itu, ulang permintaan yang sama persis.
- Aturan agent: satu worktree per kartu (`../legend-1268-<kartu>`), test gagal-dulu, test lewat `heavy` dengan `LEGEND_TEST_FILES`, pra-gate AGENTS.md, commit per langkah dan push ke `ws/1268-<kartu>` (`command git push origin HEAD:refs/heads/ws/1268-<kartu>`), tanpa stash, tanpa baca `.env*`, laporan maks 10 baris.

**POS real-API wiring plan** (legend-rc1 at f9dea5f98; static reading only, no tests run; line counts from memory of the reads, paths relative to `(root repo)`)

## 1. Decision
- Mostly web wiring. `CONTRACT-GAPS.md` is stale because legend-dysef already shipped the backend for catalog, call number, hold per line and parked orders.
- Order: 3 small backend cards and one file split, then 3 web cards, then captain, open-orders list and e2e.
- EDC in RC1 is **standalone only** (supervisor PIN + bank reference). ECR stays locked: there is no HTTP route to `getEdgeEdcAgent`, production has no bank adapter (legend-vpx, legend-mooi), and web calls the single `VITE_API_URL` origin.
- VA, e-wallet, online card, cashier code, partial cash and force close stay locked.

## 2. Branches
- `pos-panel-bayar-sisa-5w6`, `ws/1096-pos-kasir-tiket-struk` and `ui/pos-cashier-captain` are fully merged (0 ahead). Other unmerged POS branches date from 8-19 Nov; I diffed only 1162, so the rest are not proven obsolete.
- `origin/ws/1162-pos-struk-edge`: 9 commits with no equivalent on m1. Touches `pos/schemas.ts`, `pos-receipt.service.ts`, kasir `api.ts`/`types.ts`/`mock-wire.ts`. Its commit says day close rejects DP-funded days. **Land or rule it out before B2 and W0.**

## 3. Verified gaps
| Need | Real endpoint | State |
|---|---|---|
| Catalog | `getPosCatalog` pos/endpoints.ts:149, app.ts:516 | Ready. Has variants; the UI model has none |
| Call number | pos-order.routes.ts:201 | Ready (hint only) |
| Create, submit, fire | pos-order.routes.ts:243, :269, :287 | Ready. `hold` per line endpoints.ts:143 |
| Park, resume | pos-parked-order.routes.ts:39-91 | Ready, contracts `pos/parked.ts` |
| Table pick | `GET /outlets/:id/floor` floor.routes.ts:214 | Ready |
| Seat walk-in at empty table | none; `openStaffSeatedSession` (table-session.service.ts:1127) is called only by reservations | **New B1** |
| Cash, QRIS, EDC tender | pos-order.routes.ts:390 | Ready |
| QRIS status, cancel, release | :419, :444, :463 | Ready, but no QR payload: only the customer display has it (customer-display.service.ts:757) |
| Methods and terminals for cashier | admin only, `payment.edc.manage` (payment-admin.routes.ts:55) | **New B2** |
| Approver list | open-bill only (open-bill.routes.ts:54) | **New B3** |
| Receipt | pos-receipt.routes.ts:96, PDF :139 | Cloud records print `sent` but prints nothing (pos-receipt-edge-print.ts:60): **B2** |
| Shift open, count, close, movements | pos-shift.routes.ts:132, :175, :206, :246 | Ready. `cash_shift_close` and `edc_standalone` overrides exist (access/approval.ts:479); the close accepts a PIN override ULID |
| List unpaid or held orders | :235 | API ready, **no web caller**: leaving payment loses the order |
| Service calls | service-request.routes.ts:94, :129, :145 | Ready, `tableLabel` present |

## 4. Existing web bugs the cards must fix
1. `confirmCash` (kasir/api.ts) re-reads the order first. After a lost answer remaining is 0, so it throws CONTRACT_PENDING instead of replaying. `expectedStatus` is in the server fingerprint, so a rebuilt body returns IDEMPOTENCY_KEY_REUSED. Freeze key **and** body.
2. It always completes after cash; the server refuses when an item is held (pos-order.service.ts:1326) or status is not `sent`.
3. Keys live in memory (`useRef`, module Map) while the cart is in sessionStorage: refresh after an unknown outcome can duplicate an order.
4. `qris-panel.tsx` auto-starts and auto-renews a QR. `useRecordEdcStandalone` has no key.
5. `fetchActiveShift` takes any open shift; a caller with `view_all` gets another cashier's.
6. `POS_PATH` (web `lib/api/acting-staff.ts:173`) omits `/pos/orders/:id/points` and `/tickets`, so those lack the cashier header on shared devices (points route fails closed).

## 5. Money invariants (every card)
- Body never carries a price or applied amount. Display the server result; cart total is labelled an estimate until create returns.
- Intent = {key, exact body, outlet, actor, order}, persisted **before** send. Clear only on 2xx or a definitive refusal of that key. Timeout, 5xx, 401, 403 or 429 after an earlier unknown: keep it.
- Unresolved intent locks **all** methods for that bill, survives refresh, and replays the same bytes.
- `authorized` is never paid. Success only from captured tenders plus DP with remaining 0.

## 6. Cards
**Wave 0** (slot 1: B2; slot 2: B1; slot 3: B3 then W0)
- **B1 walk-in seat** (Sonnet, access review; 4 h). New `POST /api/outlets/:outletId/tables/:tableId/staff-session` {pax, key}, permission `floor.table.operate`. Files: `qr-order/endpoints.ts`+`schemas.ts`, `routes/table-sessions.routes.ts`, new `services/staff-open-session.service.ts`, `routes/index.ts` if needed, web `lib/api/acting-staff.ts` (path, plus bug 6), new `test/staff-open-session.test.ts`. Tests: replay, two-device race gives one session, dirty/inactive, other outlet/tenant, shared device without token.
- **B2 POS reads** (Opus, money; 9 h). (a) `GET .../pos/payment-options`: allowlisted methods + active terminals, no secrets; ECR and unsupported disabled. (b) QR payload on `getPosQris` only while hold `open`, unexpired, amount = remaining, caller has `pos.payment.accept`. (c) receipt result says `queued_to_printer` or `not_printed`. (d) `listPosOrders` filter by `tableSessionId`. Files: `pos/endpoints.ts`, `pos/schemas.ts`, `pos/fixtures.ts`, `pos-order.routes.ts`, `pos-qris-hold.ts`, `pos-order.service.ts`, `pos-receipt-delivery.service.ts`, `pos-receipt-edge-print.ts`, new `pos-payment-options.service.ts`, tests. Tests: payload absent for cancelling/paid/expired/changed bill; no payload for `order.view` only; cloud never reports printed.
- **B3 approvers** (Sonnet, access; 3 h). `GET /api/pos-overrides/approvers?outletId&action`, server-filtered by the action's approve permission and a usable PIN, excluding requester. Files: `access/override.ts`, `device-pin.routes.ts`, new `pos-override-approvers.service.ts`, test.
- **W0 split** (Sonnet; 2 h, no behaviour change). Move shift/supervisor/day code from kasir `api.ts`+`hooks.ts` to `shift-api.ts`, `shift-hooks.ts`; update imports. Existing tests stay green.

**Wave 1** (3 parallel; each owns only its message namespace)
- **W1 cashier order** (Sonnet; 10 h). Files: `ws04-pos-order/{api,hooks,types,queries,cart-logic,draft-store,mock-engine}.ts`, `components/cashier/**`, `modifier-dialog.tsx`, `i18n/messages/pos-order-cart.ts`, new `apps/web/test/pos-order-wire.test.ts`. Map variants; send `tableSessionId`, not label; create (`key:create`) then submit (`key:submit`, `draft`); persist intent with draft; park/resume keyed. Tests: no price in body; lost create or submit reply yields one order; refresh keeps key; variant required; sold-out 409 keeps cart.
- **W2 payment + receipt** (**Opus**; 14 h). Files: kasir `api.ts`, `hooks.ts`, `types.ts`, `mock-engine.ts`, `mock-wire.ts`, `queries.ts`, new `payment-intent-store.ts` (pattern: `charge-key-store.ts`), `components/payment/**`, `components/shared/supervisor-pin-dialog.tsx`, gateway/EDC messages, test. Cash; QRIS started by tap only, polled, cancel waits for proof, no auto-renew; EDC standalone via `edc_standalone` override worth exactly remaining. Keep `complete` separate: with held items show "lunas, ada item ditahan". `not_printed` offers PDF. Tests: bugs 1-4; unknown cash then QRIS blocked; two tabs; 409 QRIS hold; unsupported methods locked.
- **W3 shift** (Sonnet; 7 h). Files: `shift-api.ts`, `shift-hooks.ts`, `shift-extra-api.ts`, `components/shift/**`, `components/supervisor/**`, shift messages, test. Active shift = this cashier + device. Count, then supervisor PIN **on the cashier's device** (requester must be the cashier; objectType `pos_shift_count`), then `closePosShift`. Uses W2's PIN dialog as is. Tests: no expected/variance in cashier view; stale/superseded count recounts; replay closes once; QRIS hold blocks; force close locked.

**Wave 2**
- **W4 captain** (Sonnet; 8 h, after W1). Files: `components/captain/**`, then `ws04-pos-order/{api,hooks,types}.ts`. Floor board, B1, `createPosOrder` channel `captain` + submit (a new order per session, never a faked merge), fire by server item id, calls inbox. Tests: no session means no order; `request_bill` needs acknowledge; retry gives one order.
- **W5 open orders + fire** (ui-engineer; 7 h). New `ws04-pos-open-orders/**`, route `_ops/pos.pesanan.index.tsx`, fire action in `ws04-pos-order-detail/**`. **Needs a founder-approved mockup.** Fire all, then complete, then receipt.
- **W6 e2e + docs** (Sonnet; 6 h). New `e2e/pos-real.spec.ts` (EDC standalone, sandbox/simulated QRIS), both `CONTRACT-GAPS.md`.

Total about 70 agent-hours, plus architect review on B1, B2, B3, W2, W3.

## 7. Outlet acceptance
Registered device + PIN → open shift → dine-in (walk-in) and takeaway → hold, fire → cash with change, QRIS, EDC standalone → receipt or PDF → count → supervisor PIN → closed. Dropping every response once leaves one order, one tender, one shift close.

## 8. New backend
Required: B1, B2 a-d, B3. Deferred and locked: ECR route + adapters, cashier-code lookup, partial/split amount, VA/e-wallet/card, force-close witness flow, cashier name/shift number, `getIssueCharge` (legend-f1mmf).

## 9. Risks and CTO decisions
- **Physical print needs the edge to serve POS.** On cloud-hosted POS only PDF/browser print works; confirm RC1 topology before W2.
- QRIS go-live needs provider credentials (founder); build on sandbox.
- If W5 slips, do not pilot: unpaid orders are unreachable.
- Claim order: 1162 decision → B2; W1-W3 start only after wave 0 merges.
