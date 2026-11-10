# Brief: engineer (Sonnet) — failover otomatis "bayar di kasir" dari GatewayHealth (legend-8vgid)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/gateway-failover-cashier` dari `milestone/m1` 4c818489. Worktree `.worktrees/gateway-failover-cashier`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-8vgid` (P2, WS-05 BE). Baca `bd show legend-8vgid`, kartu induknya, dan PRD bagian yang disebut kartu. Langkah 1: dua `Explore` paralel untuk memetakan `GatewayHealth` dan alur pembayaran gateway yang sudah ada. Bangun yang belum ada saja.

## Kartu
Di awal: `bd update legend-8vgid --status in_progress`. Saat melapor: `--status review` + `bd comment`. Sisa kerja: kartu baru `-l payment`.

## Scope
Boleh: service/route pembayaran gateway dan kesehatan gateway, notifikasi supervisor, kontrak shared terkait, test. Jangan: refund (thread lain), migrasi (butuh tabel baru: berhenti dan lapor dulu), Better Auth/akses, edge, pajak, UI.

## Bukti selesai
- Test: gateway sehat tetap jalur normal; gateway tidak sehat memindahkan order ke "bayar di kasir" tanpa uang ganda; supervisor diberi peringatan sekali per kejadian; gateway pulih kembali normal.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file.
- tsc lewat `heavy` sekali per perbaikan, eslint, prettier. Jangan `pnpm check` penuh.
- Review kuat (aturan baru Q48): satu subagent `architect` saja (tingkat K: alur uang). Temuan nyata dibetulkan.
- Brief Codex `docs/briefs/241b-second-opinion-gateway-failover.md` (tidak di-commit).

## Laporan
Sekali: yang sudah ada vs dibangun, bukti, file berubah, SHA, kartu sisa, risiko, jumlah subagent. Butuh desain baru di luar kartu: berhenti dan lapor.
