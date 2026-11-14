# Brief: second-opinion (Codex, xhigh) — celah jurnal otomatis GL

## Peran
Baca `~/.agents/team/roles/second-opinion.md`, lalu ikuti. Jangan jalankan `bd`. Tidak mengubah file.

## Repo dan diff
`/Users/ifanshori99/Projects/legend super app/legend`. Rentang: `git diff milestone/m1...origin/ws/auto-journal-gaps` (19d9345fc). Sudah direview architect Claude xhigh.

Berkas (hanya ini): `apps/api/drizzle/0561_cash_movement_mapping_backfill.sql`, `apps/api/src/services/accounting-auto-journal-amounts.ts`, `apps/api/src/services/inventory-gl-consumer.ts`, `packages/shared/src/accounting/coa.ts`, `packages/shared/src/accounting/posting-rules.ts`. Subagent Codex maks 3: (1) refund gateway per tender (2jyr/27mt), (2) kas masuk/keluar + backfill 0561, (3) HPP periode tutup (tgb3).

## Invariant
- Jurnal seimbang, idempoten (`aj:cash-movement:<id>`, retry/replay tidak ganda), isolasi tenant.
- Refund gateway: bagian `customer_deposit` dibatasi `refundGatewayIdr`; tidak ada akun dikredit dua kali; kuitansi pending diparkir lalu diulang.
- Backfill 0561: hanya INSERT, idempoten, tidak menimpa pemetaan tenant; memetakan hanya bila nama akun persis seed dan akun belum dipakai peran lain; FORCE RLS pulih.
- HPP periode tutup: late adjustment ke hari terbuka pertama, tidak mengubah periode tertutup.
- Diketahui (jangan laporkan ulang): legend-ym2kr (kas keluar needsApproval), legend-3a5m (settlement), LOW legacy 2jyr.

## Laporan
Satu baris per temuan: `path:baris`, tingkat (P1/P2/P3), masalah, skenario gagal konkret, saran. Tanpa temuan: satu baris.
