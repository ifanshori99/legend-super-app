# Brief: engineer — celah nomor struk per prefix di laporan shift (legend-nhmct)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/receipt-gaps-prefix` dari `ws/edge-restore-detect` b6d6c8b4 (legend-yd0h8, antre merge train sesudah ws/edge-pin-pull; berisi legend-zsdd). Worktree `.worktrees/receipt-gaps-prefix`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge. Saat yd0h8 masuk m1, rebase ke m1 sebelum lapor bila sempat.

## Tujuan
`legend-nhmct` (P2, tingkat K: nomor dokumen). Sesudah zsdd satu perangkat bisa punya beberapa run. `receiptGapsForDevice` (`pos-receipt.service.ts`) memeriksa semua run, tetapi port `setPosReceiptGapsPort` (`app.ts`, dipakai laporan shift) hanya membawa ordinal, jadi P1 hilang #3 dan P2 hilang #3 tampil sebagai satu "3" tanpa prefix. Perlebar port ke `{prefix, missing[]}` atau nomor terformat (P2-000003) dan perbarui laporan shift. Tambahan dari yd0h8: run yang dipensiunkan `edge_regressed` menampilkan rentang yang hilang (lastNumber yang dilaporkan edge sampai high-water `edge_reported_number`) untuk rekonsiliasi. Detail: `bd show legend-nhmct`, `bd show legend-yd0h8`.

## Kartu
`ghostex board associate legend-nhmct`, `bd update legend-nhmct --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: `receiptGapsForDevice` dan port-nya di `pos-receipt.service.ts`, `setPosReceiptGapsPort` di `app.ts`, bagian celah struk di `pos-shift.service.ts` dan DTO/UI laporan shift yang menampilkannya, test. Jangan: logika klaim/rotasi/alokasi urutan struk edge (thread lain mengerjakan legend-sduiq di area itu), skema/migrasi, refund, pos-day, edge PIN, payroll, auth, `worker-main.ts`.

## Bukti selesai
Test reproduksi gagal dulu: dua run dengan nomor hilang yang sama tampil terpisah dengan prefix; run `edge_regressed` menampilkan rentang hilangnya; perangkat satu run tampil seperti sebelumnya. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan; test root hanya lewat `pnpm test`. tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh. Review K: reviewer Opus + architect paralel. Brief Codex `docs/briefs/196b-second-opinion-receipt-gaps-prefix.md` di folder utama (tidak di-commit).

## Laporan
Sekali: hasil, bukti, file berubah, SHA, risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
