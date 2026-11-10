# Brief: engineer — perangkat edge yang menolak run struk pengganti pulih sendiri (legend-hfq3z)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/receipt-run-self-heal` dari `integ/m1-batch24` 94d769c6 (berisi ws/edge-restore-retired, legend-sduiq; gate penuh sedang jalan). Worktree `.worktrees/receipt-run-self-heal`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge. Bila m1 sudah memuat 94d769c6 saat lapor, rebase ke m1.

## Tujuan
`legend-hfq3z` (P2, tingkat K: nomor dokumen). Bila run pengganti ditolak edge karena prefix atau id bentrok, perangkat berhenti menjual (`RECEIPT_SEQUENCE_NOT_PROVISIONED`, fail closed) sampai prosedur manual zsdd. Tanda: `receiptSequencesRefused > 0` yang menetap. Edge melaporkan run yang ditolak (id dan alasan) di pull berikutnya; cloud memensiunkan run itu dan memberi run baru dengan prefix baru, idempoten, tanpa melompati atau menggandakan nomor. Perubahan protokol pull: cloud dulu lalu edge; edge lama tanpa laporan tetap jalan seperti sekarang; cloud lama mengabaikan field baru. Detail: `bd show legend-hfq3z`, `bd show legend-sduiq`, `bd show legend-zsdd`.

## Kartu
`ghostex board associate legend-hfq3z`, `bd update legend-hfq3z --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: protokol pull urutan struk edge (shared schema), klaim/rotasi run di cloud, apply run di edge, migrasi `0158` dengan when `1794237000000` bila wajib (0157 dipesan edge PIN; catat), test. Jangan: celah struk dan Tutup Hari (`receiptGapsForDevice`, `closePosDay`, write-off; thread lain), edge PIN, refund, payroll, auth, `worker-main.ts`.

## Bukti selesai
Test reproduksi gagal dulu: run pengganti yang ditolak edge membuat perangkat berhenti menjual di base; sesudah perbaikan, pull berikutnya memberi run baru dan penjualan jalan; laporan berulang tidak membuat run ganda; edge lama dan cloud lama tetap kompatibel; lintas tenant tidak bocor. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan; test root hanya lewat `pnpm test`. tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh. Review K: reviewer Opus + architect paralel. Brief Codex `docs/briefs/204b-second-opinion-receipt-run-self-heal.md` di folder utama (tidak di-commit).

## Laporan
Sekali: hasil, bukti, file berubah, SHA, migrasi dan urutan rilis, risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
