# Brief: merge train (Codex) — batch52 ke milestone/m1

## Peran
Baca `~/.agents/team/roles/merge-train.md` (bila tidak ada: `engineer.md`) dan bagian "Paralel dulu", "Kerja berat" di `~/.agents/team/TEAM.md`. Prosedur sama dengan `docs/briefs/575-merge-train-batch51.md`.

## Repo
Worktree dari Ghostex basis `milestone/m1` = 1f8c345e. Cabang `int/batch52`.

## Isi batch (urutan ini)
1. fix/web-root-500 (b5888e30) — setup lokal + halaman 404 situs.
2. ws/edge-catalog-fresh (2fe8d215) — race promo snapshot parsial edge.
3. ws/dheu-secrets-support (46fe0375) — rotasi kunci rahasia, temuan Codex sudah diperbaiki.
4. ws/loyalty-dp-race (31643526) — poin per PT, refund DP retur, sisa DP, race reversal; architect xhigh + second opinion selesai.
Merge train tidak mereview ulang isi. Konflik isi yang tidak jelas, terutama di jurnal akuntansi/refund: lapor ke CTO, jangan tebak.

## Migrasi
m1 terakhir 0308. Nomori ulang berurutan mulai **0309**: dheu 0287 → 0309; loyalty 0403, 0404, 0405, 0411 → 0310-0313 (urutan asli dipertahankan). `migration-renumber`, `when` monoton, journal + snapshot konsisten, `db:generate` kosong, registry + referensi test ikut diganti. Buktikan upgrade dari DB m1 sebagai pemilik biasa tanpa BYPASSRLS.

## Syarat khusus (founder Q58)
Setelah gabung, buktikan dengan test bahwa endpoint klaim poin menolak jalur edge (pengaman f1381404 sudah di m1; loyalty dibangun sebelum itu). Bila tidak ada test yang membuktikan: tambahkan satu test, jangan ubah logika.

## Bukti selesai
- Satu `heavy pnpm check` penuh + `heavy pnpm build`. Perbaikan integrasi mekanis (format, lint, katalog teks dengan kata yang sama, referensi nomor migrasi) boleh langsung; selain itu lapor.
- Hijau: fast-forward `milestone/m1` ke `int/batch52`, push tanpa --force. `main` jangan disentuh.
- Hapus worktree + cabang tergabung dan bersih (cek untracked dulu, termasuk `.worktrees/dheu`).
- Lapor SHA m1, peta nomor migrasi, hasil gate, catat singkat di `docs/PROGRESS.md`.

## Batas
Jangan `pkill`/`killall`, jangan force push, jangan deploy.
