# Brief: engineer — selesaikan fix review legend-18qw (worker event transport)

## Peran

Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian kerja berat dan definisi selesai), lalu ikuti.

## Repo

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/worker-transport`.
Worktree ini sedang detached HEAD di `5a6070d` (commit WIP). Cabang `ws/worker-transport` masih di `b22d549` (induk WIP). Langkah pertama: `git checkout ws/worker-transport && git merge --ff-only 5a6070d`. Kerja di cabang itu.

## Tujuan

Selesaikan 9 fix temuan review di `docs/briefs/06-fix-review-worker-transport.md` sampai semua test hijau. Konteks awal kerja: `docs/briefs/03-engineer-worker-transport.md`. Kode 9 fix dan test baru sudah ditulis di commit WIP, tapi belum pernah dijalankan.

## Kartu

`legend-18qw` (sudah closed oleh engineer lama; jangan buka ulang). Bead turunan `legend-3a0y`: tutup setelah semua hijau. Di awal: `ghostex board associate legend-18qw`.

## Sisa urutan

1. `heavy pnpm check` lewat subagent test-runner. Titik rawan yang sudah diketahui: insert `roles`/`tenants` untuk tenant C di test, dan regex `status (\d{3})`. Docker/Colima mungkin mati: `~/.claude/scripts/colima-up`; Postgres dev: `brew services start postgresql@16`. Matikan lagi setelah selesai.
2. Perbaiki yang gagal (akar masalah, bukan melemahkan test).
3. Subagent `reviewer` (konteks segar) cek diff `b22d549..HEAD`. Temuan nyata dibetulkan.
4. Buat 3 bead lanjutan: cloud-sync tenant-wide di edge, healthcheck worker, cek backfill sequence sebelum deploy pertama.
5. Tutup `legend-3a0y`.
6. Rapikan riwayat: ganti pesan commit WIP agar merujuk `legend-18qw` (amend atau squash commit WIP milikmu sendiri saja, jangan sentuh `b22d549`).

## Scope

- Boleh diubah: area worker/event transport/notifikasi yang disentuh `b22d549` dan `5a6070d`, plus test-nya.
- Jangan disentuh: `design/`, UI order pelanggan, cabang lain, `main`. Jangan push. Jangan merge.

## Bukti selesai

- `heavy pnpm check` hijau, `pnpm build` hijau, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs`, `pnpm format:check` lulus. `git status` bersih.

## Laporan

Hasil, bukti (perintah dan hasilnya), file berubah, hash commit akhir, id 3 bead baru, risiko tersisa, yang dibutuhkan dari CTO.
