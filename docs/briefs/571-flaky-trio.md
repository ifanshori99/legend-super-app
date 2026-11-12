# Brief: engineer (Codex) — tiga test flaky dari gate batch49

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu", "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit).

## Kartu
`bd show legend-3zp8b legend-hopta legend-jz0tl`. Ketiganya gagal di `pnpm check` penuh batch49 (12 Nov) tapi lulus 2x terarah. Log gate: `/tmp/batch49-check-final.log` (bila masih ada).
- legend-3zp8b edge-catalog-sync: ID inventory hilang dari 100 hasil. Dugaan paginasi + data tenant bersama antar test.
- legend-hopta hris-leave-db: QUOTA_EXCEEDED. Dugaan kuota tenant bersama antar test.
- legend-jz0tl pos-shift-approval-device-bind: 401. Dugaan masa berlaku token perangkat di bawah beban.

## Tujuan
Reproduksi dulu (mis. jalankan file bersama file lain yang berbagi fixture, atau ulang dengan seed/urutan acak), buktikan akar, lalu perbaiki isolasi fixture di test (tenant/ID unik per test, waktu dipalsukan). Jangan ubah perilaku produk kecuali akar memang bug produk: bila begitu, lapor dulu ke CTO.

## Repo
Worktree dari Ghostex basis `milestone/m1` (facdf39d). Cabang `fix/flaky-batch49`. Commit lokal, push cabang boleh.

## Bukti selesai
- Per kartu: cara reproduksi, akar, perbaikan, test terarah lulus 3x berturut (`LEGEND_TEST_FILES=... heavy pnpm test`).
- Jangan jalankan `pnpm check` penuh (merge train sedang memakainya).
- Tutup kartu yang terbukti, komentar di kartu yang tidak bisa direproduksi.

## Batas
Jangan `pkill`/`killall`, jangan force push, jangan sentuh `milestone/m1` atau `main`.
