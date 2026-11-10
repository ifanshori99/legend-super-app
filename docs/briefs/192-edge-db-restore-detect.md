# Brief: engineer — deteksi database edge hasil restore/clone (legend-yd0h8)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/edge-restore-detect` dari `ws/receipt-seq-edge` 64638306 (legend-zsdd, antre merge train; base cc188ee0 batch16). Worktree `.worktrees/edge-restore-detect`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge. Saat zsdd masuk m1, rebase ke m1.

## Tujuan
`legend-yd0h8` (P1, release-gate, tingkat K: nomor dokumen). `instance_id` tinggal di DB edge, jadi restore backup/snapshot VM atau clone mempertahankannya dan edge mencetak ulang nomor yang terbit sesudah backup. Perbaikan: tiap pull melaporkan `lastNumber` lokal per run yang terikat; cloud menyimpan nilai tertinggi yang pernah dilaporkan dan merotasi run (prefix baru) bila laporan mundur. Rotasi berulang pada node yang sama (dua DB hidup di satu node id) diberi rate-limit dan tampil sebagai peringatan di status edge. Prosedur manual zsdd tetap berlaku. Detail: `bd show legend-yd0h8`, `bd show legend-zsdd`, `bd show legend-ol6v` (applier edge->cloud, jangan dikerjakan di sini).

## Kartu
`ghostex board associate legend-yd0h8`, `bd update legend-yd0h8 --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: layanan urutan struk cloud dan edge (bagian pull/klaim/rotasi), payload pull edge, status edge, skema `receipt_sequences` bila perlu kolom high-water, test. Migrasi: nomor 0153 ke atas, `when` di atas 1794231000000; ws/edge-pin-pull juga akan memakai nomor sesudah 0152, jadi catat nomormu, CTO menomori ulang saat merge. Jangan: PIN edge (`staff_pin*`, `access-applier.ts`), refund, pos-day, pos-shift, auto-journal, payroll, `app.ts`, `routes/index.ts`, `worker-main.ts`.

## Bukti selesai
Test reproduksi gagal dulu: edge yang di-restore ke titik sebelum nomor terakhir dirotasi ke prefix baru dan tidak mencetak ulang nomor; laporan normal (maju atau sama) tidak memicu rotasi; edge lama tanpa field laporan tetap jalan; rotasi berulang memicu peringatan dan tidak berputar tanpa batas. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan; test root hanya lewat `pnpm test`. tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh. Review K: reviewer Opus + architect paralel. Brief Codex `docs/briefs/192b-second-opinion-edge-restore-detect.md` di folder utama (tidak di-commit).

## Laporan
Sekali: hasil, bukti, file berubah, SHA, migrasi, urutan rilis edge vs cloud, risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
