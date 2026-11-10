# Brief: merge train — gate batch33, lalu batch34 (Sonnet, tanpa review ulang)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md`. Handover thread sebelumnya: `docs/PROGRESS.md` commit b4df9214 (aturan migrasi, hazard, release notes). Baca itu dulu.

## Aturan baru (keputusan founder Q48, 9 Nov)
- Kamu hanya menggabung, menyelesaikan konflik, dan menjalankan gate. Jangan mereview ulang isi cabang: tiap cabang sudah lewat review kuatnya.
- Review hanya hunk hasil resolusi konflik dan rechain migrasi: satu subagent `reviewer` (sonnet).
- Konflik semantik (bukan mekanis): jangan ditebak. Lapor ke CTO dengan berkas dan dua sisi.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Folder utama di cabang `ux/customer-order-benchmark`: jangan checkout di sana, jangan push, jangan merge ke `main`. Kerja di worktree `.worktrees/integ-b33`, `.worktrees/integ-b34`. m1 = `milestone/m1` 4c818489.

## Langkah
1. Gate batch33 (`integ/m1-batch33` 73af1bd0, umzos f3e0fb54, migrasi 0165): `pnpm test` penuh API + root lewat `heavy`, satu `test-runner`. Lulus: fast-forward m1 ke 73af1bd0.
2. `integ/m1-batch34` dari m1 baru. `git merge --no-ff` berurutan:
   - 04d2836a (gn17x; sudah memuat 814bc779 imdzn+8bvin dan 6b2fedbf atwse)
   - 4e100246 (a9iby)
   - f3e4108d (drzaf, migrasi 0166): rechain `prevId` snapshot 0166 ke id 0165 `dba5d106-97e4-4e96-8e2c-e5619d4a7272`; `when` 1794245000000 tetap. `db:generate` harus kosong.
   - 3b90a9bd (ghgei), 4fe23687 (usw3), dac509f3 (76azz), 0c959539 (EDC fixtures)
3. tsc lewat `heavy` sekali. Lalu gate: `pnpm test` penuh API + root lewat `heavy`, plus `pnpm test:e2e` lewat `heavy` (gn17x mengubah auth dan CORS). Gagal: cari commit penyebab (test terarah), lapor ke CTO dengan pemiliknya; jangan perbaiki logika produk sendiri kecuali perbaikan mekanis hasil merge.
4. Lulus: fast-forward m1 ke batch34. Hapus worktree dan cabang yang sudah di m1 (cek ancestor dulu), `git worktree prune`.
5. Update `docs/PROGRESS.md` di folder utama (commit lokal, path-scoped): isi m1, antrean, nomor migrasi berikut.

## Antrean berikut (dikirim CTO sebagai pesan, jangan menunggu)
ktc4d chain dari G04ur (lalu hapus `hold/ktc4d-qr1uv-b33`), 0167 payroll (gfcr), 0168 expo pickup tables (aiksz).

## Laporan
Sekali per batch: hasil gate (angka), SHA m1, konflik dan cara selesai, yang gagal dan pemiliknya, jumlah subagent. Jangan loop sleep; tunggu job `heavy` di background. Bila sesimu sudah compact 2 kali: tulis handover di PROGRESS dan lapor.
