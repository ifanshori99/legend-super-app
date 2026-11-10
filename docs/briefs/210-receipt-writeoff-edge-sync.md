# Brief: engineer — write-off nomor struk ikut tersinkron ke edge node (legend-jcby0)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/receipt-writeoff-edge-sync` dari `integ/m1-batch27` f448cf94 (memuat write-off 0hzqw dengan perbaikan 0156), lalu langsung `git merge --no-ff 996cc889` (`ws/receipt-run-self-heal`, legend-hfq3z, belum di merge train) di cabang itu sebagai commit pertama. Worktree `.worktrees/receipt-writeoff-edge-sync`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-jcby0` (P1, gerbang rilis, tingkat K: nomor dokumen, sinkron edge). `receipt_number_writeoffs` (dari 0hzqw) tidak ikut tersinkron ke edge; `edge-device-sync.ts` hanya membawa `receipt_sequences`. Tutup Hari yang dilayani edge (`edge/mode.ts:77`) tetap ditolak `RECEIPT_SEQUENCE_GAP` sesudah owner melakukan write-off di cloud.
Keputusan CTO: baris write-off ditarik ke edge lewat device sync pull yang sudah ada (bekerja saat offline sesudah tersinkron), bukan meneruskan cek celah ke cloud. Write-off tetap hanya dibuat di cloud; edge hanya menyimpan salinan baca. Cek celah di edge (port yang sama dengan cloud) menghitung write-off seperti di cloud, termasuk aturan "struk terlambat membatalkan write-off". Detail: `bd show legend-jcby0`, `bd show legend-0hzqw`, runbook `docs/runbooks/receipt-number-writeoff.md`.

## Kartu
`ghostex board associate legend-jcby0`, `bd update legend-jcby0 --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: `edge-device-sync.ts` bagian pull, skema shared edge untuk payload pull, penyimpanan salinan di edge, port cek celah edge, runbook (hapus aturan sementara "tutup hari lewat cloud" bila sudah tidak perlu), test. Migrasi hanya bila edge butuh tabel salinan: pakai `0161` when `1794240000000` (0155-0160 dipesan cabang lain) dan catat. Jangan: endpoint write-off cloud, logika klaim/rotasi/alokasi urutan struk, edge PIN pull, refund, payroll, auth, `worker-main.ts`, UI.

## Bukti selesai
Test reproduksi gagal dulu di basis: write-off di cloud, edge tarik, Tutup Hari di edge masih tertahan. Sesudah perbaikan: Tutup Hari di edge lulus sesudah pull; edge offline sesudah pull tetap lulus; struk terlambat di edge membatalkan write-off seperti di cloud; tenant lain tidak ikut tertarik; pull berulang idempoten. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan; test root hanya lewat `pnpm test`. tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh. Review K: reviewer Opus + architect paralel. Tulis brief Codex `docs/briefs/210b-second-opinion-receipt-writeoff-edge-sync.md` di folder utama (tidak di-commit).

## Laporan
Sekali: hasil, bukti, file berubah, SHA, migrasi dan langkah rilis (urutan edge build vs cloud), risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
