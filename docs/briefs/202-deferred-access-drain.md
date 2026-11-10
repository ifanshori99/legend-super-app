# Brief: engineer — sweep worker untuk baris akses edge yang diparkir (legend-0q3r)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/deferred-access-drain` dari ujung `milestone/m1` terbaru, worktree `.worktrees/deferred-access-drain`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-0q3r` (P3). Baris `edge_deferred_events` jenis staff_pin/pos_override yang diparkir sebelum applier ada hanya diterapkan secara lazy saat event akses berikutnya dari outlet yang sama tiba (maks 25 per event). Outlet yang tidak pernah mengirim event akses lagi tidak pernah di-drain. Tambah sweep berkala di worker yang men-drain baris parkir itu per outlet dengan batas batch, idempoten, aman dijalankan bersamaan dengan drain lazy (kunci baris yang sama, tidak dobel terapkan). Izin mengubah `apps/api/src/worker-main.ts` diberikan CTO untuk mendaftarkan sweep ini saja. Detail: `bd show legend-0q3r`, `bd show legend-kyie`.

## Kartu
`ghostex board associate legend-0q3r`, `bd update legend-0q3r --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: applier akses edge dan helper drain-nya, job/sweep worker baru, pendaftaran di `worker-main.ts`, test. Jangan: skema/migrasi, protokol edge pull/push, edge PIN pull, `receipt_sequences`, refund, payroll, pos-day, auth.

## Bukti selesai
Test reproduksi gagal dulu: baris parkir dari outlet tanpa event akses baru tetap parkir di base; sesudah sweep jalan, baris diterapkan sekali; sweep dan drain lazy bersamaan tidak menerapkan dobel; batas batch dihormati; lintas tenant tidak bocor. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan; test root hanya lewat `pnpm test`. tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh. Review: satu `reviewer` (tingkat S).

## Laporan
Sekali: hasil, bukti, file berubah, SHA, risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
