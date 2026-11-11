# 482 Edge katalog: kesegaran, protokol, audit timeout

Peran: engineer (`~/.agents/team/roles/engineer.md`). Cabang `ws/edge-catalog-followups` (lanjut dari 327888e3). Tanpa migrasi kecuali perlu; bila perlu, nomor sementara 0299.

Kartu (selesaikan semua, lalu lapor):
1. legend-10nex (P1): `apps/api/src/edge/master-sync.ts:590` kegagalan stream katalog hanya dilog. Tambah status kesegaran per stream kritis (harga, status produk): `lastSuccessAt`, umur, alasan gagal. Kasir melihat peringatan "katalog belum diperbarui sejak HH:MM"; owner dapat alarm bila basi > 30 menit saat edge online tapi sinkron gagal. Kebijakan jual saat basi dibuat bisa disetel per tenant, default SEMENTARA = tetap jual + peringatan (menunggu keputusan founder W17; jangan blok penjualan offline). Test: sinkron gagal berkepanjangan, offline murni (tanpa alarm palsu), pulih.
2. legend-2dlxq (P3): `catalog-puller.ts:448` versi protokol eksplisit di tiap respons (termasuk halaman kosong); tolak versi lama sebelum checkpoint diperbarui -> `CATALOG_CLOUD_OUTDATED`.
3. legend-sdqni (P2): `provision-roles.ts` `--audit` (deploy.sh:37) wajib menemukan `idle_in_transaction_session_timeout` di login app/queue; test audit gagal tanpa timeout.

Paralel: Explore 1, test-writer 1 (test gagal-dulu tiap kartu), implementer per kartu (3, file terpisah), reviewer sonnet akhir. Test terarah lewat `heavy`. Laporan: commit, test, angka subagent (total, puncak).

Catatan: kerja di worktree sendiri dari origin/ws/edge-catalog-followups (git worktree add .worktrees/ecf-482 ...), push ke cabang yang sama.
