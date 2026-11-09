# Brief 112: Codex second-opinion WS-03 menu dan QR order (tingkat K)

Peran: second-opinion. Baca `~/.agents/team/roles/second-opinion.md`.
Cabang: `ws/ws03-menu` d06b163c (basis `milestone/m1`). Hanya baca, jangan commit.
Diff: `git diff milestone/m1...ws/ws03-menu -- <file>`. Abaikan test, fixture, sample, dan `drizzle/meta`.
Tulis temuan P0-P3 dengan file:line dan skenario gagal ke `docs/reviews/codex-ws03-<run>.md`.

## Run A (uang): open-bill dan harga QR
`apps/api/src/services/open-bill-control.service.ts`, `apps/api/src/db/schema/open-bill.ts`, `packages/shared/src/qr-order/open-bill.ts`, `apps/api/src/services/qr-order-pricing.ts`, `packages/shared/src/qr-order/pricing.ts`, migrasi 0086/0087 di cabang ini.
Cek: batas sisa tagihan bisa dilewati (race antar pesanan, split tender, deposit), pengurangan pembayaran kasir, FORCE RLS dan policy, audit throttle.

## Run B (akses data publik): sesi tamu dan scope
`guest-session-scope.ts`, `guest-menu.service.ts`, `qr-guest-reads.service.ts`, `table-session.service.ts`, `service-request.service.ts`, `routes/qr-order.routes.ts`, `routes/service-request.routes.ts`, `middleware/public-rate-limit.ts`, scope media menu per outlet, RBAC stasiun.
Cek: tamu membaca data sesi/meja/outlet lain, scan meja sekunder, rate limit bisa diakali (IP header), media outlet lain (403).

Laporan: jumlah temuan per tingkat, 3 teratas, path berkas review.
