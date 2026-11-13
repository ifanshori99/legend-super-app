# Brief: merge train — batch56 ke milestone/m1

Baca `~/.agents/team/roles/merge-train.md` (gerbang tiga tahap: lint -> typecheck -> test). Prosedur sama dengan `docs/briefs/623-merge-train-batch55.md`.

## Repo
Worktree baru dari `milestone/m1` = 4d299ba5e. Cabang `int/batch56`.

## Isi batch (urutan ini, `git merge --no-ff origin/<cabang>`; cek SHA terbaru di origin)
1. `fix/test-isolation` (44d6876d2) — dibuat dari int/batch55; isolasi test platform_admins + hris leave.
2. `fix/kirimdev-inbound-routing` (314cf4ab8) — sender-mapping sudah di m1.
3. `ws/payment-hardening` — srf6 dedupe DOIT per integration, gjf1 refund void QR parsial, j75w alert Brevo. Migrasi 0482-0483.
4. `ws/edge-device-security` — pepper PIN per tenant, CRUD printer. Migrasi 0480-0481 (bila ada).
5. `ws/ops-menu-small` — migrasi 0476-0477 (masuk bersama).
6. `ws/cash-bank` (d54f4f71) — dibuat dari ws/settlement-recon (sudah di m1). Migrasi 0484-0485.
7. `ws/payroll-followups` (72fd67d5e) — berisi rantai ws/payroll-bank-coretax -> fix/payroll-money -> ws/payroll-run-lock. Migrasi 0472-0473, 0478-0479, 0486-0487.

JANGAN masukkan rantai QRIS (`ws/qris-dp-hold`, `ws/payment-link-cancel`, `fix/codex-money`, `fix/qris-hold-strict-amount`), `ws/tenant-config-contracts`, `ws/qr-menu`, `ws/brand-config`, `ws/menu-pdf`, `ws/purchasing-apar` (batch57). Konflik isi tidak jelas: lapor CTO, jangan tebak.

## Migrasi
m1 terakhir 0320. Nomori ulang berurutan mulai **0321** sesuai urutan merge. `migration-renumber`, `when` monoton, journal + snapshot konsisten, `db:generate` kosong, registry + referensi test ikut diganti. Buktikan upgrade dari DB m1 (0320) sebagai pemilik biasa tanpa BYPASSRLS.

## Gerbang
Tiga tahap; satu run penuh test + `heavy pnpm build`. Gagal: catat berkas, ulang per berkas; flake yang hijau sendirian dan sudah punya bead boleh lanjut (aturan batch54/55). Perbaikan mekanis boleh; logika: lapor CTO. Setelah `fix/test-isolation` masuk: batas 1 worker tetap (jangan dicabut di batch ini).

## Bukti selesai
Fast-forward `milestone/m1` ke `int/batch56`, push tanpa --force. `main` jangan disentuh. Hapus worktree + cabang yang tergabung dan bersih. Tutup bead yang commit-nya kini ada di m1 (`git branch -r --contains` / `git log milestone/m1 --grep <id>`), hanya yang statusnya masih open dan pekerjaannya utuh. Lapor SHA m1, peta migrasi, hasil gate, durasi test penuh, bead yang ditutup.

## Batas
Jangan `pkill`/`killall`, jangan force push, jangan deploy. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
