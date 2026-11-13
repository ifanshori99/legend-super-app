# Brief: engineer — daftar pengecualian finance (API) + helper rekening sumber payout (legend-4oclu, legend-s7roi)

Peran: baca `~/.agents/team/roles/engineer.md`. Model Sonnet. Area uang/pajak: "jangan sampai rugi".

## Konteks
Beberapa jalur sekarang sengaja "lolos tapi dicatat" dan finance perlu melihatnya:
- Order edge `tax_missing`/`tax_mismatch` (dijurnal semua ke PBJT, tanpa `tax_snapshots`, tidak masuk rekap PBJT per aturan) — `ws/edge-sales-gl`.
- Void EDC edge yang parkir `AutoJournalVoidUnsupported` (perlu koreksi manual).
- Struk edge yang dilewati (`edge_receipt_skips`, `ws/edge-sync-resilience`) dan dead-letter link edge.
- Fee payout `fee_posted=false` (`ws/payroll-payout-hardening`, sudah punya route sendiri; cukup ditautkan/dihitung).
`legend-s7roi`: satukan pencarian rekening sumber payout jadi satu helper aktif (gagal tertutup), dan jurnal biaya transfer overpaid ke beban bank 8101 (keputusan CTO).

## Repo
Cabang dasar perlu memuat semua cabang di atas. Bila batch61/62 belum masuk m1, buat worktree dari `origin/ws/payroll-payout-hardening` lalu `git merge --no-ff origin/ws/edge-sync-resilience` (lapor bila konflik bukan mekanis). Cabang `ws/finance-exceptions`. Migrasi rentang **0546-0549**.

## Kerja
1. 4oclu (API saja, tanpa UI): endpoint finance read-only `GET` daftar pengecualian per tenant (filter jenis, outlet, periode), dengan jumlah dan nilai rupiah. Izin finance yang sudah ada untuk laporan; scope tenant/outlet. UI menyusul lewat mockup.
2. s7roi: helper rekening sumber aktif dipakai settle, repost, overpaid, approve/export; jurnal fee overpaid tepat sekali.

## Test gagal-dulu
Tiap jenis pengecualian muncul tepat sekali dengan nilai benar; tenant/outlet lain tidak terlihat; tanpa izin 403. s7roi: rekening nonaktif ditolak di semua jalur; fee overpaid dijurnal sekali, gaji tidak berubah.

## Review
Tingkat K: satu subagent `architect` effort xhigh, maks 2 ronde.

## Bukti selesai
Test terarah lewat `heavy`, typecheck api lewat `heavy`, prettier + eslint, `db:generate` kosong, registry migrasi. Push tanpa force. `bd update --status review` + `bd comment`.

## Batas
Jangan merge ke m1, deploy, `pkill`, `pnpm test` penuh. Maks 4 subagent bersamaan.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
