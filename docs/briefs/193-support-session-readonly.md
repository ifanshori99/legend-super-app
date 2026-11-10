# Brief: engineer — sesi akses dukungan benar-benar baca-saja di /kelola (legend-cg071)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/support-readonly` dari ujung `milestone/m1` terbaru, worktree `.worktrees/support-readonly`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-cg071` (tingkat K: auth). Banner "Hanya baca" sesi support tampil di layar Kelola, tetapi form tetap bisa disimpan. Buat satu pola bersama: (1) API menolak semua mutasi selama sesi support baca-saja (satu middleware/guard terpusat, bukan per route; jawaban 403 dengan kode yang jelas), (2) UI /kelola menonaktifkan form dan tombol simpan untuk sesi itu lewat satu hook/komponen bersama. API adalah pengamannya; UI hanya tampilan. Detail: `bd show legend-cg071`, `bd show legend-8cm4`.

## Kartu
`ghostex board associate legend-cg071`, `bd update legend-cg071 --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: middleware auth/sesi support, pendaftaran guard di router yang relevan, hook/komponen UI bersama untuk mode baca-saja, layar /kelola yang perlu memakai pola itu, test API (termasuk lintas tenant) dan test UI bila ada polanya. `app.ts` / `routes/index.ts` hanya bila guard terpusat wajib dipasang di sana (catat). Jangan: refund, pos-day, pos-shift, edge, `receipt_sequences`, payroll, auto-journal, `worker-main.ts`, skema/migrasi.

## Bukti selesai
Test reproduksi gagal dulu: mutasi (POST/PATCH/PUT/DELETE) di area /kelola dengan sesi support baca-saja ditolak; GET tetap jalan; sesi biasa tidak terpengaruh; endpoint keluar dari sesi support tetap bisa dipakai. Screenshot satu layar /kelola dalam mode baca-saja (lebar sempit dan lebar) di laporan. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan; test root hanya lewat `pnpm test`. tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh. Review K: reviewer Opus + architect paralel. Brief Codex `docs/briefs/193b-second-opinion-support-readonly.md` di folder utama (tidak di-commit).

## Laporan
Sekali: hasil, bukti, file berubah, SHA, path screenshot, risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
