# Brief: merge train — batch55 ke milestone/m1

Baca `~/.agents/team/roles/merge-train.md` (gerbang tiga tahap: lint -> typecheck -> test). Prosedur sama dengan `docs/briefs/600-merge-train-batch54.md`.

## Langkah 0 (ringan, sebelum gate)
Ruang SSD 13 GiB (< 30 GB): jalankan `~/.claude/scripts/cleanup-ssd` (laporan), lalu `--apply`. Jangan hapus worktree dengan sesi aktif atau berkas belum di-commit. Laporkan ruang yang kembali.

## Repo
Worktree baru dari `milestone/m1` = d56eafb4. Cabang `int/batch55`.

## Isi batch (urutan ini, `git merge --no-ff origin/<cabang>`)
1. `fix/flaky-restore-window` (cc68d2c3) — vitest dipaksa 1 worker (akar flaky platform/hris). Catat durasi test penuh sebelum/sesudah di PROGRESS.
2. `ws/infra-security-small` (2d2ebbd2)
3. `ws/platform-tenant-wizard` (e5247f6d)
4. `fix/ai-owner-recheck` (9c726ae9)
5. `fix/codex-edge-emergency` (e2010de4) — berisi `ws/edge-emergency-impl`; test panic sudah memakai tenant sendiri. Migrasi panic 0400-0402.
6. `ws/settlement-recon` (52346c44) — migrasi idx 440.
7. `fix/kirimdev-sender-mapping` (c61845cb) — berisi `ws/kirim-whatsapp`; migrasi 0470.

Konflik isi yang tidak jelas: lapor CTO, jangan tebak. JANGAN masukkan rantai QRIS (`ws/qris-dp-hold`, `ws/payment-link-cancel`, `fix/codex-money`, `fix/qris-hold-strict-amount`; tertahan sandbox S1) maupun payroll (masih dikerjakan).

## Migrasi
m1 terakhir 0315. Nomori ulang berurutan mulai **0316** sesuai urutan merge (panic 0400-0402, settlement, kirimdev). `migration-renumber`, `when` monoton, journal + snapshot konsisten (snapshot 0470 berantai dari 0313: regenerasi), `db:generate` kosong, registry + referensi test ikut diganti. Buktikan upgrade dari DB m1 (0315) sebagai pemilik biasa tanpa BYPASSRLS.

## Gerbang
Gerbang tiga tahap; satu run penuh test + `heavy pnpm build`. Gagal: catat nama berkas, ulang per berkas, lalu satu run penuh akhir. Error tsc identik 2x: baca `~/.claude/state/heavy-fail/<terbaru>` sampai habis. Perbaikan mekanis boleh; logika: lapor CTO. test-runner tanpa loop sleep (run_in_background + Monitor); periksa sendiri EXIT dan hitungan test.

## Bukti selesai
Fast-forward `milestone/m1` ke `int/batch55`, push tanpa --force. `main` jangan disentuh. Hapus worktree + cabang yang tergabung dan bersih (termasuk `int/batch54`, `int/batch54-with-panic` bila sudah tercakup). Lapor SHA m1, peta migrasi, hasil gate, durasi test penuh, ruang SSD.

## Batas
Jangan `pkill`/`killall`, jangan force push, jangan deploy. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
