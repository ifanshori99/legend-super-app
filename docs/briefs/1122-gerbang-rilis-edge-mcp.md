# 1122 Gerbang rilis: edge sharedMode, katalog strict, MCP paket (tingkat S, 3 kartu)
Peran: engineer kartu S (`~/.agents/team/roles/engineer.md`). Codex. Langkah pertama: spawn subagent paralel, satu per kartu (file tidak bertumpuk), plus satu reviewer.
Base: `origin/ws/1100-gerbang-deploy` (abc71bfbb; runner `apps/api/src/db/release-gates.ts` + `scripts/preflight/rilis1-*.sql`). Cabang `ws/1122-gerbang-rilis-edge-mcp`. Landing SESUDAH 1100. Push tanpa `--force`. Tanpa migrasi.
Kartu (baca `bd show <id>` lewat CTO bila perlu; ringkasan di bawah):
- legend-ir8n8 (P1): gerbang rilis = edge harus upgrade sebelum cloud mengirim `sharedMode` (984 f586w). Gate data/versi read-only atau langkah runbook yang memblok bila ada edge node aktif di versi lama.
- legend-zn3wl (P2): `catalog_record.updated` strict, edge lama menolak event katalog dengan field baru dari cloud. Tambah ke gate/runbook rilis yang sama (urutan upgrade edge dulu).
- legend-176r3 (P2): tenant pemakai MCP tanpa paket mcp kehilangan MCP saat deploy. Gate read-only menghitung tenant tersebut (mode block atau info + resolve jelas).
Aturan gate: satu SELECT per berkas, read-only, ragu = block, header `-- resolve:` jelas; N/A hanya bila tabel benar-benar tidak ada (kolom hilang = block). Runbook di `docs/deployment.md`.
Bukti: test per gate (lolos tanpa baris, block dengan 1 baris, N/A tanpa tabel) merah-dulu, hijau lewat `heavy` terarah. Prettier/eslint. Tanpa suite penuh.
Laporan: per kartu commit + head SHA. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.
