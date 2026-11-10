# Brief 88: persiapan deploy, peran migrator production dan cek outbox (legend-jtnd, legend-k1np)

Peran: engineer. Baca `~/.agents/team/roles/engineer.md` dulu. Tingkat K (migrasi, auth DB).

## Tujuan
1. legend-jtnd: migration lama 0000–0062 gagal bila dijalankan owner non-superuser tanpa BYPASSRLS (validasi FK di bawah FORCE RLS: "tenant context is required"). Tetapkan peran migrator production: owner tabel dengan BYPASSRLS atau superuser terpisah dari peran aplikasi. Peran aplikasi tetap tanpa BYPASSRLS. Tulis di `provision-roles.sh` (cari dengan grep) dan dokumen deploy.
2. legend-k1np: sekuens outbox kini per tujuan tanpa backfill. Buat cek pra-deploy (skrip atau langkah runbook) yang gagal bila `domain_event_outbox` berisi baris skema lama. Belum ada data production.

## Basis
Worktree `.worktrees/deploy-prep`, cabang `ws/deploy-prep` dari `milestone/m1` (head 8e2e7bc0). Jangan sentuh migration yang sudah ada.

## Bukti selesai
- Test: jalankan seluruh migration dari nol dengan peran migrator baru di DB scratch (pakai pola test `edge-received-events-migration.test.ts`), dan peran aplikasi tetap terkena RLS.
- `heavy pnpm check`, `pnpm format:check` hijau. Reviewer Opus konteks segar atas diff.
- Commit lokal, jangan push, jangan merge. Jangan baca atau cetak `.env*`.

## Laporan
SHA, peran yang dibuat dan hak aksesnya, langkah runbook baru, hasil test, temuan review.
