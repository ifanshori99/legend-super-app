# Brief: engineer (Sonnet) — dua penghambat gate merge train

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti. Bug: reproduksi dulu, cari akar masalah, baru perbaiki.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Jangan checkout di folder utama. Jangan push, jangan merge. Tanpa migrasi. Dua kartu, berkas tidak bertumpuk: dua `implementer` paralel sesudah reproduksi.

## Kartu
1. `legend-se8dl` (P0). Cabang `ws/ktc4d-test-cleanup` dari `ws/grant-role-lock-b33` (783e3bbf), worktree `.worktrees/ktc4d-test-cleanup`. Baca deskripsi kartu: 76 tes di 8 file gagal bila dijalankan bersama, lulus sendiri-sendiri; galat pertama `identity-login.test.ts:169` FK `role_assignments_assigned_by_user_id_fk`. Reproduksi dengan menjalankan 8 file itu plus `platform-tenant-owner.test.ts` dalam satu `LEGEND_TEST_FILES`. Buktikan sumber pencemaran (dugaan: `platform-tenant-owner.test.ts` menyisipkan `role_assignments.assigned_by` tanpa cleanup). Perbaikan di test (cleanup atau data unik per file); ubah kode produk hanya bila akar masalah ada di sana, dan sebut alasannya. Satu commit di atas 783e3bbf supaya merge train menaruhnya tepat sesudah rantai ktc4d.
2. `legend-240kd` (P1). Cabang `ws/public-brand-leak` dari `milestone/m1` (d8ea5e0b), worktree `.worktrees/public-brand-leak`. `e2e/az-whitelabel.spec.ts:80` TEN-08: nama starter dari `starter.config.json` tampil di /sign-in, /sign-up, /karyawan, /kelola lewat `siteConfig.name` (`components/brand.tsx`, title sign-in/sign-up). Layar publik memakai brand tenant bila host tenant dikenali, selain itu nama platform Legend; nama starter tidak pernah tampil. Jangan ubah desain layar, hanya teks brand dan title.

Awal tiap kartu: `ghostex board associate <id>`, `bd update <id> --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Bukti selesai
- se8dl: gabungan 9 file yang tadi gagal kini lulus dalam satu run (sebut jumlah file dan tes), dan file yang sama tetap lulus sendiri-sendiri. Bukti sebelum/sesudah dari reproduksi.
- 240kd: `heavy pnpm test:e2e` hanya untuk spec `e2e/az-whitelabel.spec.ts` bila skrip mendukung filter (cek `package.json`); bila tidak, satu run `heavy pnpm test:e2e` penuh di akhir. Test unit brand bila ada.
- Typecheck paket yang berubah lewat `heavy` sekali di akhir; eslint + prettier berkas berubah.
- Review (Q48, tingkat S): satu `reviewer` sonnet untuk kedua diff.

## Laporan
Sekali di akhir: per kartu (akar masalah, cabang, SHA), bukti, file berubah, risiko, jumlah subagent dan puncak bersamaan.
