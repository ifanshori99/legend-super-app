# Brief: second-opinion — Tutup Hari memeriksa celah struk semua run outlet (legend-6b0ld)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/day-close-all-gaps`, cabang `ws/day-close-all-gaps`.
Rentang diff: `git diff 4087b661..ws/day-close-all-gaps` (base = ujung `ws/receipt-gaps-prefix`, legend-nhmct; bila cabang sudah di-rebase ke `milestone/m1`, pakai `git diff milestone/m1...ws/day-close-all-gaps`). Abaikan `docs/`.

## Berkas berisiko
- `apps/api/src/services/pos-day.service.ts` (`closePosDay`: cek celah struk sebelum menulis `pos_daily_closes`)
- `apps/api/src/services/pos-shift-ports.ts` (port baru celah struk per outlet)
- `apps/api/src/app.ts` (pemasangan port)
- `apps/api/src/services/pos-receipt.service.ts` (`receiptGapsForOutletFast`, tidak diubah tetapi kini dipakai Tutup Hari)

## Invariant (PRD)
- POS-06 / §3 F8: Tutup Hari ditolak (`RECEIPT_SEQUENCE_GAP`, tanpa menulis apa pun) selama ada nomor hilang 1..lastNumber di run mana pun milik outlet itu: run aktif atau pensiun, perangkat yang aktif hari itu atau tidak, dan urutan cloud outlet (prefix `C`).
- Rentang hilang run `edge_regressed` (di atas lastNumber cloud sampai `edge_reported_number`) tidak menahan Tutup Hari.
- Celah di outlet atau tenant lain tidak memengaruhi outlet ini (TEN-01/TEN-02, RLS).
- Port bawaan (tanpa pemasangan app.ts) tidak boleh membuat Tutup Hari lebih longgar dari sebelumnya.

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
