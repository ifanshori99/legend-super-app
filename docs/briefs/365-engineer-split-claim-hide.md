# Brief: engineer — klaim poin split: sembunyikan kode latihan/refund (legend-udu47)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul bagian, Read offset/limit), lalu ikuti. Tingkat K (poin = nilai uang): satu subagent architect review.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. `git worktree add .worktrees/split-claim-hide -b ws/split-claim-hide origin/ws/cpq2-qr-read-models` (d3dc89d2). Push cabang kerja ke origin tiap commit. Jangan push main, jangan --force.

## Tujuan
Ikuti `bd show legend-udu47`: (1) `getSplitClaim`/`getSplitClaimByToken` tidak menampilkan kode untuk bagian split pesanan latihan atau yang sudah di-refund; (2) `redeemSplitClaimTx` yang tidak terpakai: hapus, atau beri cek latihan/refund bila ada pemanggil; (3) cek `refundSplit` (`pos-order-corrections.ts:418`) menarik poin klaim tanpa dobel, test-kan.

## Kartu
`legend-udu47`. `ghostex board associate legend-udu47`, `bd update legend-udu47 --status in_progress`; selesai `--status review` + `bd comment`.

## Scope
- Boleh diubah: `bill-split.service.ts`, service klaim poin tabel, `pos-order-corrections.ts` (hanya bagian reversal klaim), test.
- Jangan disentuh: migrasi, pembayaran gateway, charge order, HRIS, edge.

## Bukti selesai
- Test gagal-dulu tiap butir. Typecheck dan test terarah lewat `heavy`. Architect review, temuan nyata dibetulkan.

## Batas kerja ulang (Retro 11)
- `typecheck`/`tsc` gagal 2 kali: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan SEMUA error, jalankan sekali lagi. Gagal ketiga: lapor dengan isi log.
- Jangan `pkill`/`killall`. Jam dari `date '+%H:%M'`. Edit pakai tool Edit.

## Laporan
SHA, test gagal-dulu, temuan review, risiko.
