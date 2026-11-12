# Brief: merge train (Codex) — batch53 ke milestone/m1

## Peran
Baca `~/.agents/team/roles/merge-train.md` (bila tidak ada: `engineer.md`) dan bagian "Paralel dulu", "Kerja berat" di `~/.agents/team/TEAM.md`. Prosedur sama dengan `docs/briefs/581-merge-train-batch52.md`.

## Repo
Worktree dari Ghostex basis `milestone/m1` = 5cbe2a1e. Cabang `int/batch53`.

## Isi batch (urutan ini)
1. ws/dheu-m1 (c0401d94) — rotasi kunci rahasia + satu jalur cabut akses dukungan (Owner + MFA, satu audit). Sudah diselaraskan dengan m1, architect xhigh tanpa temuan.
2. ws/loyalty-dp-m1 (67457c4b) — poin per PT, refund DP retur, sisa DP, race reversal + perbaikan deadlock klaim. Sudah diselaraskan dengan m1, architect xhigh CLEAR.
Keduanya sudah berbasis m1 5cbe2a1e; konflik antar keduanya seharusnya kecil. Merge train tidak mereview ulang isi. Konflik isi yang tidak jelas, terutama jurnal akuntansi/refund/support access: lapor ke CTO, jangan tebak.

## Migrasi
m1 terakhir 0308. Nomori ulang berurutan mulai **0309**: dheu 0287 (journal sementara idx309) → 0309; loyalty 0403, 0404, 0405, 0411 → 0310-0313 (urutan asli dipertahankan). `migration-renumber`, `when` monoton, journal + snapshot konsisten, `db:generate` kosong, registry + referensi test ikut diganti. Snapshot m1 0287/0308 jangan rusak. Buktikan upgrade dari DB m1 sebagai pemilik biasa tanpa BYPASSRLS.

## Syarat khusus (founder Q58)
Setelah gabung, buktikan dengan test bahwa endpoint klaim poin menolak jalur edge. Bila tidak ada test yang membuktikan: tambahkan satu test, jangan ubah logika.

## Bukti selesai
- Satu `heavy pnpm check` penuh + `heavy pnpm build`. Perbaikan integrasi mekanis (format, lint, katalog teks dengan kata yang sama, referensi nomor migrasi) boleh langsung; selain itu lapor.
- Hijau: fast-forward `milestone/m1` ke `int/batch53`, push tanpa --force. `main` jangan disentuh.
- Hapus worktree + cabang tergabung dan bersih (cek untracked dulu).
- Lapor SHA m1, peta nomor migrasi, hasil gate, angka subagent, catat singkat di `docs/PROGRESS.md`.

## Batas
Jangan `pkill`/`killall`, jangan force push, jangan deploy. `legend-tetyr` (pensiun kunci lama) tetap terbuka.
