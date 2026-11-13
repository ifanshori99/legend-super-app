# Brief: merge train — batch54 ke milestone/m1

## Peran
Baca `~/.agents/team/roles/merge-train.md` (bila tidak ada: `engineer.md`) dan bagian "Paralel dulu", "Kerja berat" di `~/.agents/team/TEAM.md` (Grep, Read sempit). Prosedur sama dengan `docs/briefs/585-merge-train-batch53.md`.

## Repo
Worktree dari Ghostex basis `milestone/m1` = 1202164d. Buat cabang `int/batch54`.

## Isi batch (urutan ini, `git merge --no-ff origin/<cabang>`)
1. `fix/money-journal-refund` (c660fd6b) — refund tidak dibukukan ke akun pajak/service charge (legend-48ft7). Architect xhigh lolos. Tanpa migrasi.
2. `fix/ai-login-review` (3ba2911a) — backend Tanya AI A+B (`ws/ai-login-autodetect` eb1df93a) + perbaikan review architect. Migrasi 0417-0418.
3. `ghostex/sambung-layar-pengaturan-ai` (3c4a5c73) — layar admin AI tersambung API (berisi `ui/ai-settings` + eb1df93a). Konflik `docs/PROGRESS.md`: simpan semua bagian urut tanggal.
4. `ui/tenant-config` (8c596b8a) — layar konfigurasi tenant (lolos review UI).

Merge train tidak mereview ulang isi. Konflik isi yang tidak jelas (jurnal/refund, auth AI, kontrak shared): lapor ke CTO, jangan tebak. JANGAN masukkan `ws/qris-dp-hold` (tertahan sandbox S1) atau `ws/edge-emergency-impl` (masih dikerjakan).

## Migrasi
m1 terakhir 0313 (cek `_journal.json`). Nomori ulang berurutan mulai **0314**: AI 0417, 0418 -> 0314, 0315 (urutan asli). Bila `ui/tenant-config` membawa migrasi: lanjutkan nomornya setelah itu. `migration-renumber`, `when` monoton, journal + snapshot konsisten, `db:generate` kosong, registry + referensi test ikut diganti. Buktikan upgrade dari DB m1 sebagai pemilik biasa tanpa BYPASSRLS.

## Aturan gerbang (CTO, Retro 21/22)
- Satu `heavy pnpm check` penuh + `heavy pnpm build`.
- Bila gagal: catat NAMA berkas gagal di `docs/PROGRESS.md`, ulang hanya berkas itu lewat `LEGEND_TEST_FILES="..." heavy pnpm test` sampai hijau, lalu satu run penuh akhir.
- Error tsc identik 2 kali: berhenti, baca `~/.claude/state/heavy-fail/<terbaru>` sampai habis, betulkan semua sekaligus.
- Perbaikan integrasi mekanis (format, lint, katalog teks kata sama, referensi nomor migrasi) boleh langsung; perubahan logika: lapor CTO.

## Bukti selesai
- Hijau: fast-forward `milestone/m1` ke `int/batch54`, push tanpa --force. `main` jangan disentuh.
- Hapus worktree + cabang yang sudah tergabung dan bersih (cek untracked dulu), termasuk `legend-d2353023` (int/batch53, sudah di m1) bila tidak ada sesi aktif di sana.
- Lapor SHA m1, peta nomor migrasi, hasil gate, file gagal (bila ada), angka subagent; catat singkat di `docs/PROGRESS.md`.

## Batas
Jangan `pkill`/`killall`, jangan force push, jangan deploy. Jam dari `date '+%H:%M'`.

## Laporan
Wajib satu baris: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
