# Brief: second-opinion Codex — area down-sync katalog cloud ke edge (harga, resep)

Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti. Read-only. Effort xhigh (harga = uang).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Basis `origin/milestone/m1` (3c7217b2).

## Cabang
- `origin/ws/97p-master-downsync` 6343a727 — `GET /api/edge-sync/catalog` (kursor keyset (updated_at,id) + settle window, tenant/outlet dari credential), `edge/catalog-puller.ts`, `services/edge-catalog-apply.ts`, migrasi 0250 `catalog_pull_checkpoints`.

## Fokus
Harga salah/basi di edge (urutan, kursor melewatkan baris dengan updated_at sama atau commit terlambat, settle window), daftar harga tanpa item, resep campur versi, kebocoran lintas tenant/brand/outlet, tombstone, checkpoint maju padahal apply gagal, replay/idempotensi, credential edge dicabut, migrasi 0250 di data lama. Sudah dikartu: wiring loop + stream inventory_items/stations (legend-24318), soft-delete price_list_items (legend-d0ipm).

## Laporan
Temuan P0..P3: file:baris, skenario (input -> hasil salah), saran. Sebut yang bersih. Angka subagent.
