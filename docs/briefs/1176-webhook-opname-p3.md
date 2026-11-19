# 1176 Webhook + opname P3 lanjutan 1167 (engineer, 19 Nov)

Peran: `~/.agents/team/roles/engineer.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (test-writer + implementer per kartu, berkas terpisah).
Template kerja: `docs/briefs/_TEMPLATE-workstream.md`. Langkah 0 worktree: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`.

Base: `ws/1167-p3-webhook-opname` (1014c8963, memuat ws/1144). Cabang kerja: `ws/1176-webhook-opname-p3`. Landing sesudah 1167. Tingkat K (webhook pembayaran): architect effort high sebelum lapor. Tanpa migrasi; bila perlu kolom baru: berhenti dan lapor ke CTO (nomor 0708+).

## Kartu (baca `bd show <id>`)
1. `legend-dhzqb` webhook: baris `received` yang macet (proses mati sesudah claim) diulang tiap 5 menit tanpa batas. Pakai kolom yang sudah ada (`attempts` atau setara) untuk `attempts+1` saat claim `stuckReceived`, backoff naik, dan sesudah batas pindah ke `failed` + alert sekali. Test: crash-loop berhenti di batas; pembayaran tetap tercatat sekali; baris `failed` tetap bisa diulang manual.
2. `legend-nxqrw` `purchase-return.service.ts:~977` masih menjawab `INSUFFICIENT_STOCK` dari stok tersembunyi untuk penghitung opname buta. Samakan dengan `BLIND_COUNT_LOCKED` 409 (pola 0hzu di base), penolakan sebelum cek stok. Test: jawaban sama untuk stok cukup dan kurang; aktor bukan penghitung tetap normal.

## Batas
- Jangan sentuh: `order-given.ts`, `reservation-*`, `edge-*`, `access.service.ts`, `platform-approval.service.ts`, `payroll-payout*`, `hris-*`.

## Bukti selesai
Test gagal-dulu per kartu (terarah lewat `heavy`), typecheck api lewat `heavy` sekali dengan exit code di laporan, prettier + eslint file berubah, `db:generate` kosong. Tunggu job heavy dengan Bash run_in_background, jangan akhiri giliran dengan kabar tunggu. Commit dan push ke cabang kerja.

## Laporan
SHA, kartu selesai, jumlah subagent dan puncak bersamaan, hasil gate, temuan architect dan fixnya, yang belum teruji. Lapor sekali.
