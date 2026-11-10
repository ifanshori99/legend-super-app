# Brief: engineer — balapan reversal klaim poin split (legend-ec6fa)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul bagian, Read offset/limit), lalu ikuti. Tingkat K (poin = nilai uang): satu subagent architect review.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. `git worktree add .worktrees/ec6fa-claim-race -b ws/ec6fa-claim-race origin/ws/split-claim-hide` (81efe255). Push cabang kerja ke origin tiap commit. Jangan push main, jangan --force.

## Tujuan
Reproduksi dulu dengan test konkuren: refund commit di antara update `redeemSplit` dan commit transaksi klaim -> poin klaim lolos dari `reverseTableClaims` (`loyalty-earn-consumer.ts:527`). Perbaiki dengan urutan kunci yang sama (mis. `FOR UPDATE` baris order di kedua jalur) atau cek ulang refund di dalam tx klaim. Tanpa deadlock dengan tender POS / webhook QR.


## Tambahan: temuan Codex 380 (second-opinion split bill, milestone/m1 29ddcbf7)
Periksa dulu apakah sudah tertutup oleh basis udu47 (81efe255) atau pekerjaan race ini; bila belum, test gagal-dulu lalu fix di cabang ini.
1. P1 `apps/api/src/services/qr-order-consumers.ts:733`: dua intent lunas sebelum event dikonsumsi; event pertama membatalkan bagian kedua, event kedua berhenti di baris 520 sehingga tokennya tidak terbit. Fix: rekonsiliasi semua bagian yang sudah dibayar sebelum membatalkan bagian tersisa.
2. P1 `apps/api/src/services/bill-split.service.ts:695`: pengambilan token klaim hanya memeriksa sesi meja, tanpa kepemilikan bagian; tamu A mengambil ID bagian B dari `/bill` lalu mendapat token klaim B. Fix: wajibkan bukti khusus bagian (mis. id intent/pembayar yang membayar bagian itu).
3. P2 `bill-split.service.ts:659`: batas klaim = waktu bayar + 24 jam, seharusnya waktu meja tutup + 24 jam. Fix: expiry dari `closedAt`; test jeda bayar 10:00, tutup 22:00.

## Kartu
`legend-ec6fa`. `ghostex board associate legend-ec6fa`, `bd update legend-ec6fa --status in_progress`; selesai `--status review` + `bd comment`.

## Scope
- Boleh diubah: `table-claim.service.ts`, `bill-split.service.ts`, `loyalty-earn-consumer.ts` (bagian reversal klaim), test.
- Jangan disentuh: migrasi, pembayaran gateway, charge order, POS acting-staff (thread lain), HRIS, edge.

## Bukti selesai
- Test konkuren gagal-dulu, hijau setelah fix; ulang 5x tanpa flaky.
- Typecheck dan test terarah lewat `heavy`. Architect review, temuan nyata dibetulkan.

## Batas kerja ulang (Retro 11)
- `typecheck`/`tsc` gagal 2 kali: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan SEMUA error, jalankan sekali lagi. Gagal ketiga: lapor dengan isi log.
- Jangan `pkill`/`killall`. Jam dari `date '+%H:%M'`. Edit pakai tool Edit.

## Laporan
SHA, test gagal-dulu, urutan kunci, temuan review, risiko.
