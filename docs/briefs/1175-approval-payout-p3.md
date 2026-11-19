# 1175 Approval + payout P3 lanjutan 1164 (engineer, 19 Nov)

Peran: `~/.agents/team/roles/engineer.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (test-writer + implementer per kartu).
Template kerja: `docs/briefs/_TEMPLATE-workstream.md`. Langkah 0 worktree: `node ~/.claude/scripts/worktree-slim.mjs --full && heavy pnpm worktree:setup` (ada migrasi).

Base: `ws/1164-payout-recurring-approval` (d9806d79d, SIAP batch96). Cabang kerja: `ws/1175-approval-payout-p3`. Landing sesudah 1164. Tingkat K (uang/akses + migrasi): architect effort xhigh sebelum lapor. Migrasi kerja: 0707 saja.

## Kartu (baca `bd show <id>`)
1. `legend-52e52` `cancelApprovalRequest` modul refund, jurnal, profit-share, settlement belum cek tenggat sesudah `lockChain`. Samakan dengan fix SO 1160 P2 di base (waktu segar max(jam pemanggil, jam server) sesudah lock). Test barrier dua koneksi per modul (cukup satu helper + tabel kasus): cancel lewat tenggat 409 tanpa status/event cancelled; kontrol sebelum tenggat sukses.
2. `legend-1e9py` migrasi 0706: cek pemegang lock operasi payout tanpa filter database. Migrasi 0707 `CREATE OR REPLACE` badan fungsi dengan filter `current_database()` (pg_locks/pg_stat_activity), tanpa ubah data. Journal, snapshot, data-import-registry ikut; `db:generate` kosong.
3. `legend-9cx64` payout_attest: simpan waktu MFA yang sudah dicek / `attested_at` pakai `clock_timestamp()` (race MFA saat langkah berjalan). Bila butuh kolom baru: pakai migrasi 0707 yang sama, lapor di laporan.

## Batas
- Jangan sentuh: `payment-webhook*`, `order-given.ts`, `reservation-*`, `edge-*`, `access.service.ts`, `sole-owner-self-approval.ts`, `hris-*` (thread 1172).
- Migrasi hanya 0707. Butuh lebih: berhenti dan lapor ke CTO.

## Bukti selesai
Test gagal-dulu per kartu (terarah lewat `heavy`), typecheck api lewat `heavy` sekali dengan exit code di laporan, prettier + eslint file berubah, `db:generate` kosong. Tunggu job heavy dengan Bash run_in_background, jangan akhiri giliran dengan kabar tunggu. Commit dan push ke cabang kerja.

## Laporan
SHA, kartu selesai, jumlah subagent dan puncak bersamaan, hasil gate, temuan architect dan fixnya, yang belum teruji. Lapor sekali.
