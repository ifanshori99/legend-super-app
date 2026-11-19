# 1197 Second opinion edge catalog sync hardening (1190)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex high. Read-only, tanpa worktree: `git diff`/`git show` dari folder utama, jangan checkout. Selesaikan dan lapor dalam SATU giliran.

Fokus: `git fetch origin`, lalu `git diff origin/milestone/m1...origin/ws/1190-edge-catalog-hardening -- apps/api docs/deployment.md` (head acf1edca3; tanpa migrasi).
Isi: legend-75kly (reset sync_txid hanya pada 400 bermarker X-Edge-Error: CATALOG_CURSOR_REJECTED; 400 tanpa marker probe sekali), y9y8y (tolak cursor txid > pg_snapshot_xmax -> edge rewind; runbook restore manual), ssnf9 (satu notifikasi basi per edge per heartbeat), n6mkr (heartbeat buang field tak dikenal; edge tahan catalogStale 1 jam sesudah close 1008).
Cari: edge macet tanpa pulih, rewind berulang (loop) atau kehilangan perubahan katalog, header marker bisa dipalsukan oleh proxy/klien, kompatibilitas edge lama vs cloud baru dan sebaliknya, notifikasi hilang, lintas tenant/outlet, wraparound txid.
Hasil: tulis `docs/qa/second-opinion-edge-catalog-1197.md` di folder utama (P0-P3, berkas:baris, skenario, usul test). JANGAN commit, JANGAN edit file lain.
