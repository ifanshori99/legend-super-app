# Brief: merge train — batch57 ke milestone/m1

Baca `~/.agents/team/roles/merge-train.md` (gerbang tiga tahap: lint -> typecheck -> test). Prosedur sama dengan `docs/briefs/631-merge-train-batch56.md`.

## Repo
Worktree baru dari `milestone/m1` = a2234853d. Cabang `int/batch57`.

## Isi batch (urutan ini, `git merge --no-ff origin/<cabang>`; cek SHA terbaru di origin)
1. `fix/webhook-retry-guard` (7304b5180) — okrmg + gcdq0.
2. `fix/panic-relay-load` (003449e73) — FOR NO KEY UPDATE + retry + received setelah commit.
3. `fix/thr-gross-up` (3f37e056c) — dasar rantai payroll yang kini di m1.
4. `fix/petty-fund-required` (0abf250ce) — berisi `ws/cash-bank` (sudah di m1). Migrasi 0496-0498 (termasuk `0498_cash_limit_antisplit`).
5. `ws/brand-config` (3844c4f94) — berisi `ws/tenant-config-contracts`. Migrasi 0492-0493 bila ada.
6. `ws/menu-pdf` (f1da34fed) — berisi `ws/qr-menu`.
7. `ws/purchasing-posting` (SHA terbaru di origin) — berisi `ws/purchasing-apar`. Migrasi 0490-0491 dan 0494-0495.

JANGAN masukkan rantai QRIS (`ws/qris-dp-hold`, `ws/payment-link-cancel`, `fix/codex-money`, `fix/qris-hold-strict-amount`). Bila `ws/purchasing-posting` belum ada di origin atau belum lapor selesai, jalankan batch tanpa itu. Konflik isi tidak jelas: lapor CTO, jangan tebak.

## Migrasi
m1 terakhir 0329. Nomori ulang berurutan mulai **0330** sesuai urutan merge. `migration-renumber`, `when` monoton, journal + snapshot konsisten, `db:generate` kosong, registry + referensi test ikut diganti. Buktikan upgrade dari DB m1 (0329) sebagai pemilik biasa tanpa BYPASSRLS.

## Gerbang
Tiga tahap; `~/.claude/scripts/colima-up` dulu; satu run penuh test + `heavy pnpm run build`. Gagal: catat berkas, ulang per berkas; flake yang hijau sendirian dan sudah punya bead (`legend-gcdq0` panic-relay EM-19, `legend-x778h` audit-retention) boleh lanjut. Perbaikan mekanis boleh; logika: lapor CTO. Batas 1 worker tetap.

## Bukti selesai
Fast-forward `milestone/m1` ke `int/batch57`, push tanpa --force. `main` jangan disentuh. Hapus worktree + cabang yang tergabung dan bersih (cek dulu tidak ada thread lain memakainya). Tutup bead yang commit-nya kini ada di m1, hanya yang masih open dan pekerjaannya utuh. Lapor SHA m1, peta migrasi, hasil gate, durasi test penuh, bead yang ditutup.

## Batas
Jangan `pkill`/`killall`, jangan force push, jangan deploy. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
