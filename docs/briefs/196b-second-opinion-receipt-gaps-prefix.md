# Brief: second-opinion — celah nomor struk per prefix di laporan shift (legend-nhmct)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/receipt-gaps-prefix`, cabang `ws/receipt-gaps-prefix`.
Rentang diff: `git diff b6d6c8b4..ws/receipt-gaps-prefix` (base = ujung `ws/edge-restore-detect`, legend-yd0h8; bila cabang sudah di-rebase ke `milestone/m1`, pakai `git diff milestone/m1...ws/receipt-gaps-prefix`). Abaikan `docs/`.

## Berkas berisiko
- `apps/api/src/services/pos-receipt.service.ts` (`receiptGapsForDevice`, `receiptGapsOfRun`)
- `apps/api/src/services/pos-shift-ports.ts` (tipe port `PosReceiptGapsPort`)
- `apps/api/src/services/pos-shift.service.ts` (laporan shift: pemetaan port ke DTO)
- `apps/api/src/services/pos-day.service.ts` (satu baris: penolakan Tutup Hari `RECEIPT_SEQUENCE_GAP`)
- `packages/shared/src/pos/schemas.ts` (`posShiftReportSchema.receiptGaps`)

## Invariant (PRD)
- POS-06 / §3 F8: tiap nomor 1..lastNumber setiap run perangkat harus ada; Tutup Hari ditolak selama ada nomor hilang di run mana pun (aktif atau pensiun) milik perangkat outlet itu.
- Satu perangkat bisa punya beberapa run (prefix P1, P2, ...). Nomor hilang yang sama di dua run harus tampil terpisah dengan prefix-nya; tidak boleh digabung atau hilang.
- Run yang dipensiunkan `edge_regressed` (database edge di-restore): rentang di atas lastNumber cloud sampai high-water `edge_reported_number` ditampilkan untuk rekonsiliasi. Rentang ini tidak menahan Tutup Hari (tidak ada jalur penyelesaian).
- Perangkat satu run tanpa celah tetap `[]`; laporan shift tidak membocorkan data perangkat/outlet/tenant lain (TEN-01/TEN-02).

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
