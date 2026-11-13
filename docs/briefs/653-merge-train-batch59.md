# Brief: merge train — batch59 ke milestone/m1

Baca `~/.agents/team/roles/merge-train.md` (gerbang lint -> typecheck -> test -> build; bagian "Flake di tahap test"). Prosedur sama dengan `docs/briefs/646-merge-train-batch58.md`.

## Repo
Worktree baru dari `milestone/m1` = ea399bb4d. Cabang `int/batch59`.

## Isi batch (urutan ini, `git merge --no-ff origin/<cabang>`; cek SHA terbaru di origin)
1. `fix/cash-antisplit-cross-outlet` (037fac4c0) — legend-fcali. Migrasi 0518.
2. `ws/edge-sync-appliers` (456b4dff1) — pd9t, 7h5s. Dibangun di atas `fix/edge-order-reemit` yang sudah masuk batch58 (0508 -> 0339); migrasi 0508 bawaannya JANGAN diterapkan dua kali: pakai 0339 yang ada di m1, lalu nomori 0510 dst. Migrasi 0510-0513.
3. `ws/payroll-disbursement-manual` (5c73da044) — wnkep.1/.2/.4. Migrasi 0514-0517.
4. `fix/employee-bank-code` (ee6e5e38a) — 86he4, di atas no. 3.
5. `fix/employee-bank-code-ui` (9904fbbeb) — jazlx, di atas no. 4.

Konflik isi yang menyentuh logika uang atau tidak jelas: lapor CTO, jangan tebak. Konflik payroll di batch58 (`payroll-run-simulate.service.ts`) sedang direview CTO; jangan ubah aturannya.

## Migrasi
m1 terakhir 0340. Nomori ulang berurutan mulai **0341** sesuai urutan merge. `migration-renumber`, `when` monoton, journal + snapshot konsisten, `db:generate` kosong, registry + referensi test ikut diganti. Buktikan upgrade dari DB m1 (0340) sebagai pemilik biasa tanpa BYPASSRLS (FK ke tabel lain: pola inline 0312/0324/0336).

## Gerbang
`~/.claude/scripts/colima-up` dulu. Tes root (`node --test`, termasuk `data-import-registry`, `access-i18n`, `legend-g6d`, `text-contract`) sebelum run penuh. Satu run penuh test + `heavy pnpm run build`. Flake berkartu (`legend-1jxh8`, `legend-gcdq0`) boleh lanjut sesuai merge-train.md. e2e `legend-zueb.mock.spec.ts:55` sudah merah di base (`legend-rr0x1`), bukan penghalang. Perbaikan mekanis boleh; logika: lapor CTO.

## Pelajaran batch58
- Satu run penuh saja: jangan `&` di dalam perintah background, jangan hapus container Postgres yang dipakai run lain.
- Bead berstatus `review` yang commit-nya kini di m1 boleh ditutup.

## Bukti selesai
Fast-forward `milestone/m1` ke `int/batch59`, push tanpa --force. `main` jangan disentuh. Hapus worktree + cabang lokal yang tergabung dan bersih. Tutup bead yang pekerjaannya utuh di m1 (bukan `legend-zy43`, bukan `legend-771dl`). Lapor SHA m1, peta migrasi, hasil gate, durasi test penuh, bead yang ditutup.

## Batas
Jangan `pkill`/`killall`, jangan force push, jangan deploy. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
