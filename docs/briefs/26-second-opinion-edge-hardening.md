# Brief: second-opinion — hardening edge (legend-zinn, legend-wg5t)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`. Read-only: jangan ubah kode, jangan commit. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Cabang `ws/edge-hardening` (HEAD `6f00090`). Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/edge-hardening` bila ada; bila tidak, baca lewat `git show`/`git diff main...ws/edge-hardening` dari checkout utama tanpa checkout cabang. Diff: `git diff main...ws/edge-hardening`.

## Fokus (area keamanan)
- Allowlist route auth/outlets di mode edge: hanya path yang memang perlu; tidak ada route cloud lain yang bocor lewat prefix, trailing slash, case, atau query.
- Path traversal: `%2e%2e`, `%252e`, backslash, `//`, segmen titik; normalisasi dilakukan sebelum cek allowlist dan konsisten dengan router Express.
- `guardEdgeUpgrades` untuk WebSocket: upgrade ke path di luar allowlist ditolak sebelum handler; auth berlaku untuk WS.
- Rate limit dijalankan sebelum cek kredensial (brute force PIN/token); kunci rate limit dengan `TRUST_PROXY`: IP tidak bisa dipalsukan lewat `X-Forwarded-For` saat proxy tidak dipercaya; default aman.
- Dedupe migration 0063: tidak ada migration ganda atau hilang; aman untuk data lama. Nomor yang bentrok dengan cabang lain dirapikan saat merge; itu bukan temuan.
- Retry 4403 (WS close code): klien tidak retry tanpa henti setelah ditolak; tidak ada kebocoran kredensial di log.
- Test benar-benar membuktikan klaim. Boleh reproduksi dengan server lokal atau DB sementara (`~/.claude/scripts/colima-up`), bersihkan sesudahnya.

## Laporan
Temuan urut paling berat: file:baris, masalah, skenario gagal konkret, fix. "Tidak ada blocker" bila memang tidak ada.
