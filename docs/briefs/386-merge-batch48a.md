# Merge train batch48a ke milestone/m1

Peran: merge train (baca `~/.agents/team/roles/engineer.md` dan "Paralel dulu" di `~/.agents/team/TEAM.md`). Tidak mereview ulang isi cabang (sudah direview architect + Codex fix).
Basis: `git worktree add .worktrees/merge-batch48a -b ws/merge-batch48a milestone/m1` (1b1e96eb). Jangan checkout folder utama.
Remote: origin GitHub privat. Push `ws/merge-batch48a` dan `milestone/m1` setelah gate hijau. Jangan push `main`, jangan `--force`.

## Cabang (urutan merge, `--no-ff`; lewati tip yang sudah ancestor tip lain: `git merge-base --is-ancestor`)
1. ws/i83ls-fix 88ce89d2 (charge kasir + forward migration 0244; 0229 dikembalikan ke teks asli)
2. ws/r3i8w-tax-reports bdfeb6a9 (revisi laporan pajak, basis gmww; migrasi 0242)
3. ws/94q2l-impl 3b94e7ad (fix Codex refund recovery; b78f169c sudah di m1)
4. ws/aruta-pos-pin 0fb10745 (kasir aktif + fix Codex; migrasi 0243)
5. ws/tct8-config-codecs 2c2c45c6
6. ws/omp4-mfa-recovery 1c06b972 (migrasi 0239-0240)
7. ws/ie6m-uom-write dde6124b (migrasi 0245-0246)

Tidak ikut (batch48b, masih dikerjakan atau rantai HRIS): bod/j6cyb, u7g9w, jmsdx, arch-357, kxoyf, cpq2/n1mp, udu47+ec6fa, duitku-codex-fix, ptn11, 8s992 fix.

## Migrasi
- Semua nomor sementara di cabang (0239-0246) dinomori ulang rapat melanjutkan m1 (tertinggi sekarang 0228), urut merge, `when` naik monoton. Rename SQL, snapshot, tag jurnal; sambung ulang `prevId`; `db:generate` kosong sesudah tiap merge. Ganti rujukan nomor lama di kode/komentar/docs/test (mis. test i83ls-fix yang menyebut 0229/0244).
- 0229 pada i83ls-fix: di m1 apa nomornya sekarang? Cek `docs/release-notes-m1-migrations.md`. m1 belum pernah diterapkan ke DB bersama (lihat `docs/deployment.md`): forward migration dari i83ls-fix tetap dipakai apa adanya (jangan gabung ke migrasi lama).
- Pola FK legend-436yt: FK inline di `CREATE TABLE` untuk tabel baru.
- Bukti: `edge-received-events-migration.test.ts` dan `order-issue-charge-cash-migration.test.ts` hijau.
- Satu subagent architect review diff migrasi saja (tingkat K).

## Gate
`heavy pnpm test` dari root sekali, typecheck semua, e2e (aruta mengubah client web dan sign-in). Flake dikenal: legend-0lyzf (member-signin AUTH-01, menu-print-db), TEN-06, az-r-whitelabel, PAY-02: ulang file itu saja dan catat. Setelah merge i83ls-fix jalankan ulang `order-recovery-swap-bill`.
Edit pakai tool Edit, bukan sed. Jangan pkill proses lain. Jangan hapus worktree thread lain. Stempel waktu pakai `date`. Variabel loop jangan bernama `path`.

## Akhir
Maju-kan m1, push, hapus worktree dan cabang lokal yang sudah ancestor m1 (tanpa --force, lewati yang kotor atau dipakai thread), update `docs/PROGRESS.md`, catatan rilis `docs/release-notes-m1-migrations.md`.
Laporan sekali: SHA m1, tabel penomoran, hasil gate, temuan architect.
