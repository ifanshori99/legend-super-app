# 481 Second opinion Codex: sinkron katalog edge (area)

Peran: second-opinion (`~/.agents/team/roles/second-opinion.md`). Read-only. Jangan edit, jangan commit.

Repo: `/Users/ifanshori99/Projects/legend super app/legend`. Baca AGENTS.md.

Cakupan (gabungan cabang, satu review per area):
- `git diff origin/milestone/m1...origin/ws/edge-catalog-followups` (berisi 97p 6343a727, 24318 88419ea8, followups 327888e3).
- Fokus: kursor `sync_txid`/`pg_snapshot_xmin` (tidak ada baris terlewat saat transaksi panjang, rewind sah, txid mundur setelah restore), isolasi tenant/outlet (FORCE RLS, `app.require_tenant_id()`), urutan deploy edge vs cloud (`CATALOG_CLOUD_OUTDATED`), `idle_in_transaction_session_timeout` di `apps/api/src/db/provision-roles.ts`, harga/produk basi di kasir edge (uang: kasir menjual dengan harga lama atau produk nonaktif).

Sudah diketahui (jangan dilaporkan ulang): audit deploy tidak mewajibkan timeout (P2, akan dibetulkan); legend-75kly (semua HTTP_400 memicu resync penuh); legend-y9y8y (restore cloud txid mundur).

Laporan: temuan P0..P3, masing-masing file:line, skenario gagal konkret, usul perbaikan. Maks 12 temuan, urut keparahan. Tidak ada temuan: tulis "bersih" plus apa saja yang dicek.
