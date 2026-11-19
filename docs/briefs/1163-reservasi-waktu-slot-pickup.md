# 1163 Reservasi waktu, slot tiket, nomor panggil (engineer, 19 Nov)

Peran: `~/.agents/team/roles/engineer.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Template kerja: `docs/briefs/_TEMPLATE-workstream.md`. Langkah 0 worktree: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`.

Base: `milestone/m1`. Cabang kerja: `ws/1163-reservasi-slot-pickup`. Tingkat K (uang DP): architect effort xhigh sebelum lapor.

## Kartu
1. `legend-pdi5u` (tutup `legend-ytwlo` sebagai duplikat): jalur reservasi masih memakai waktu lokal sebagai bukti. File: `services/reservation-core.ts:715-721,883`, `reservation-deposit-resend.ts:113`. Keputusan CTO (arah membatasi pembayaran): bukti waktu dari jam server/penyedia (`provider_final`, migrasi 0405 sudah di m1); DP yang terbukti terlambat TIDAK dikreditkan otomatis ke reservasi, melainkan masuk dana belum teralokasi yang ditahan untuk finance. Test: DP terlambat tidak mengurangi tagihan dan tidak hilang.
2. `legend-tkxhs` POS kasir: jam kosong tiket untuk kasir murni (ekstrak inti ketersedian). File: `facility-slots.service.ts`, `facility-pos-ticket-catalog.ts`. Jangan menambah izin `facility.booth.operate`.
3. `legend-hpze7` panggil `allocatePickupCall` dari alur order (sisa). File: `pos-order.service.ts:~991`, `test/pickup.test.ts`. Keputusan founder Q51 (9 Nov): pesanan tidak pernah ditolak; nomor panggil berhuruf A-001..A-999 lalu B-001 dst; sesudah Z-999 lanjut AA-001 (keputusan CTO). legend-ggpoe sudah ditutup: cek dulu bagian mana yang sudah ada di m1, kerjakan sisanya saja.

## Batas
- Jangan sentuh: `reservation-deposit-credit.ts`, `reservation-deposit-remainder.ts` (diubah int/batch95), `order-given.ts`, `payment-admin.service.ts`.
- Tanpa migrasi. Bila ternyata perlu: berhenti dan lapor ke CTO untuk nomor.

## Bukti selesai
Test gagal-dulu per kartu (terarah lewat `heavy`), typecheck api (+ shared/web bila tersentuh) lewat `heavy` sekali, prettier + eslint file berubah, `db:generate` kosong. Commit dan push ke cabang kerja.

## Laporan
SHA, kartu selesai (tutup ytwlo sebagai duplikat pdi5u), jumlah subagent dan puncak bersamaan, hasil gate, temuan architect dan fixnya, yang belum teruji.
