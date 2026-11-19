# 1198 Fix SO 1196 reseal kolom beku (engineer Sonnet, 19 Nov)

Peran: `~/.agents/team/roles/engineer.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Template kerja: `docs/briefs/_TEMPLATE-workstream.md`. Langkah 0 worktree: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`.
Base: `ws/1189-sealed-reseal-frozen` (782c4b938). Cabang: `ws/1198-reseal-so1196`. Tingkat K (migrasi, kunci): architect xhigh. Migrasi kerja: ubah 0720 boleh (belum landing) atau tambah 0721 saja.
Kartu: `legend-qwm9r`. Temuan: `docs/qa/second-opinion-sealed-reseal-1196.md` (folder utama, sudah commit di ux/customer-order-benchmark; baca dengan git show ux/customer-order-benchmark:docs/qa/second-opinion-sealed-reseal-1196.md).

## Keputusan CTO
- P1: batas tenant tidak boleh bergantung pada GUC yang bisa disetel pemanggil. Fungsi mengambil tenant dari baris itu sendiri dan wajib cocok dengan parameter tenant eksplisit; DAN keanggotaan grup `legend_sealed_reseal` tidak diberikan ke login app biasa: job reseal memakai login DB terpisah (provision-roles + runbook docs/deployment.md + .env.example nama key saja). Bila login terpisah tidak bisa di lingkungan test, buktikan app login tidak bisa SET ROLE grup.
- P2 audit privilese: audit menolak hak berbahaya yang disebut laporan.
- P2 row lock: sweep tidak tertahan (NOWAIT/SKIP LOCKED + hitung ulang di pass berikut, remaining tetap jujur).
- P2 fixture: test expiry voucher lama hijau tanpa melonggarkan guard (fixture memakai jalur resmi atau disable trigger di setup test saja).

## Bukti selesai
Fail-first per temuan (skenario laporan merah di 782c4b938, hijau sesudah). Test reseal + provision-roles + voucher expiry hijau (terarah lewat heavy). db:generate kosong, typecheck api sekali lewat heavy, prettier + eslint. Architect xhigh. Commit, push, tutup kartu. Tunggu job heavy dengan Bash run_in_background satu notifikasi; tanpa Monitor/loop foreground; tanpa laporan antara.

## Laporan
SHA, kartu ditutup, subagent total dan puncak, gate, yang belum teruji. Lapor sekali.
