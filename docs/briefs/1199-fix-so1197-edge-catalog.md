# 1199 Fix SO 1197 edge catalog (engineer Sonnet, 19 Nov)

Peran: `~/.agents/team/roles/engineer.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Template kerja: `docs/briefs/_TEMPLATE-workstream.md`. Langkah 0 worktree: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`.
Base: `ws/1190-edge-catalog-hardening` (acf1edca3). Cabang: `ws/1199-edge-catalog-so1197`. Tingkat K (sync offline, harga): architect high. Tanpa migrasi bila bisa; bila perlu, 0726 saja.
Kartu: `legend-7r7q6`. Temuan: `git show ux/customer-order-benchmark:docs/qa/second-opinion-edge-catalog-1197.md`.

## Keputusan CTO
- P1: sesudah rewind/restore, receipt versi lama tidak boleh menahan penerapan katalog; freshness baru dilaporkan sukses sesudah katalog benar-benar diterapkan. Harga/menu edge tidak boleh tertinggal diam-diam.
- P2 item hilang: sesudah restore, item yang tidak ada di snapshot cloud dinonaktifkan di edge (bukan dihapus; transaksi offline yang sudah mereferensikan item tetap sah).
- P2 notifikasi ulang: dedupe tahan restart cloud (kunci stabil per edge + himpunan stream; boleh pakai notifikasi yang sudah ada sebagai penanda).

## Bukti selesai
Fail-first per temuan (skenario laporan merah di acf1edca3, hijau sesudah). Test edge-catalog-* + link-heartbeat hijau (terarah lewat heavy). Typecheck api sekali lewat heavy, prettier + eslint. Architect. Commit, push, tutup kartu. Tunggu job heavy dengan Bash run_in_background satu notifikasi; tanpa Monitor/loop foreground; tanpa laporan antara.

## Laporan
SHA, kartu ditutup, subagent total dan puncak, gate, yang belum teruji. Lapor sekali.
