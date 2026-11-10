# Brief: engineer — urutan nomor struk terikat ke satu edge node (legend-zsdd)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/receipt-seq-edge` dari ujung `milestone/m1` terbaru, worktree `.worktrees/receipt-seq-edge`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-zsdd` (P1, tingkat K: nomor dokumen + migrasi). Edge yang dibangun ulang atau standby yang mengambil alih menarik urutan perangkat lalu menerbitkan ulang nomor yang sudah dipakai edge lama tapi belum sampai cloud. Perbaikan: kolom baru di `receipt_sequences` yang mengikat urutan ke satu edge node; prefix baru saat edge dibangun ulang atau standby mengambil alih; status urutan yang ditolak tampil ke kasir/dashboard (kini hanya log). Pertahankan perbaikan sementara legend-3yqy sampai jalur baru menggantikannya. Detail: `bd show legend-zsdd`, `bd show legend-3yqy`, `bd show legend-ol6v` (applier edge->cloud, belum dikerjakan; jangan dikerjakan di sini).

## Kartu
`ghostex board associate legend-zsdd`, `bd update legend-zsdd --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: skema/migrasi `receipt_sequences`, layanan urutan struk cloud dan edge, enrolment/takeover edge bagian urutan struk, endpoint/DTO status urutan, test. `edge/runtime.ts` hanya bila wajib (catat). Jangan: PIN edge (`staff_pin*`, `access-applier.ts`: agent lain), `pos-shift.service.ts`, modul refund, auto-journal, payroll, open bill, `app.ts`, `routes/index.ts`, `worker-main.ts`.

## Bukti selesai
Test reproduksi gagal dulu: edge dibangun ulang tidak menerbitkan nomor yang sudah dipakai; standby ambil alih memakai prefix baru; dua edge tidak bisa memegang urutan yang sama. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan; test root hanya lewat `pnpm test`. tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh. Review K: reviewer Opus + architect paralel. Brief Codex `docs/briefs/187b-second-opinion-receipt-seq-edge.md` di folder utama (tidak di-commit). Migrasi: nomor + `when` di atas 1794222890808.

## Laporan
Sekali: hasil, bukti, file berubah, SHA, migrasi, urutan rilis edge vs cloud, risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
