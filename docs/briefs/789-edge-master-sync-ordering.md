# 789 Edge master sync: urutan dependensi, UOM, brand switch (legend-3k41y)

Worktree: legend-5da946c7, cabang ws/edge-master-data-publisher (WIP 7fcee5211 di atas bc7b75556). Tingkat K (migrasi). Review: architect xhigh.

## Masalah yang terbukti dari kode
- `CatalogMissingRefError` (edge-catalog-apply.ts:138) adalah `Error` biasa, dan FK 23503 juga bukan `isDomainRefusal` (db-link-store.ts:122). Satu event item yang tiba sebelum kategori/station membatalkan SELURUH batch; link stop-and-wait mengirim ulang batch yang sama selamanya. Dependensinya diantre SESUDAHNYA (link_seq lebih tinggi), jadi macet permanen.
- Urutan stream di publisher tidak bisa menjamin parent dulu: tiap stream memakai batas xmin sendiri, dan baris parent hanya punya versi terbaru (full-state). Parent yang diubah setelah child dibuat bisa berada di atas batas, sementara child sudah lolos. Multi-instance cloud juga bisa mempublikasi stream berbeda bersamaan.
- `inventory_items.base_uom_id` bergantung pada `uoms` dari master-sync (snapshot), bukan dari stream katalog. Publisher tidak bisa mengurutkannya.
- Brand: publisher membaca brand outlet sekali, lalu scan membaca ulang di statement lain (READ COMMITTED). Mismatch melempar CONFLICT tiap 5 detik tanpa jalan keluar. Tidak ada jalur aplikasi yang mengubah `outlets.brand_id` (org.service.ts:911), jadi ini kejadian operasi manual saja.
- 0373: tag `0373_...` tercatat di journal idx 366, tanpa kolom status, dan belum menyentuh CHECK outcome inbound.

## Keputusan
Referensi tertunda di PENERIMA, tanpa menyimpan payload. HTTP pull katalog menjadi jalur pemulihan yang sudah terurut (masters/UOM dulu, lalu stream sesuai urutannya).
1. Event master_data yang kekurangan referensi wajib tidak menahan antrean: receipt dicatat `outcome='deferred'`, cursor inbound tetap maju, tidak ada konflik supervisor.
2. `deferred` BUKAN held receipt: versi link yang lebih baru tetap berlaku, dan HTTP pull boleh menulis dokumen itu (`filterCatalogRecordsAfterEvents`, `resetCatalogSyncTxid` tidak berubah).
3. Setelah commit, edge membangunkan loop master-sync (`syncEdgeMasters` lalu `pullCatalog`). Ini sekaligus menyelesaikan UOM. Wake di-debounce: paling cepat 30 detik, digabung saat ada run berjalan. Fallback tetap tick 5 menit. Bila HTTP pull juga gagal, `CATALOG_MISSING_REF` sudah muncul di freshness tracker sebagai alarm.
4. Publisher tetap memakai urutan `CATALOG_SYNC_STREAMS` (best effort, mengurangi deferral) tanpa urutan topologis. Kebenaran tidak bergantung padanya.
5. Brand: tutup rapat (fail closed). Brand outlet dicek SEBELUM dan SESUDAH scan di transaksi yang sama; bila berbeda dari cursor, rollback. Mismatch yang menetap menandai cursor `blocked_at` (log sekali, sweep melewati node itu) dan semua stream node itu berhenti. Pemulihan: daftarkan ulang edge node (id baru berarti cursor baru dan publikasi penuh). Tidak ada reset otomatis.
6. Migrasi tetap diperlukan (satu file, nomor bebas berikutnya saat rebase; idx journal = nomor tag).

## Skema minimal migrasi
- `edge_catalog_publisher_cursors` seperti 0373 ditambah `updated_at timestamptz NOT NULL DEFAULT now()` dan `blocked_at timestamptz NULL`. Tanpa CHECK pada stream (validasi di app). RLS tenant dan outlet tetap.
- `ALTER TABLE edge_inbound_events DROP CONSTRAINT edge_inbound_events_outcome_check, ADD CONSTRAINT ... CHECK (outcome IN ('applied','superseded','conflict','deferred'))`. Schema TS edge-node.ts:349 disamakan.

## Langkah implementasi
1. `apps/api/src/edge/ports.ts`: tambah `EdgeApplyDeferredError` (code `EDGE_APPLY_DEFERRED`), netral domain agar tidak ada import siklik.
2. `apps/api/src/edge/master-data-applier.ts`: bungkus `ensureCatalogStreamInitialized` + `applyCatalogRecords` + `repairPendingLinks` dalam savepoint. Tangkap `CatalogMissingRefError` dan pg `23503` yang constraint-nya milik tabel `STREAM_TABLES`/uoms, lalu lempar `EdgeApplyDeferredError`. Error lain tetap dilempar. `item` hilang pada `menuItemId` (baris 157) juga menjadi deferred.
3. `apps/api/src/edge/db-link-store.ts`: `applyOrRefuse` mengembalikan `"deferred"` untuk error itu (hanya bila `kind === "master_data"` dan arah cloud_to_edge). Outcome receipt `deferred`. Kumpulkan stream yang tertunda, lalu panggil opsi baru `onDeferred(streams)` SETELAH transaksi commit.
4. `apps/api/src/edge/master-sync.ts`: `startEdgeMasterSyncLoop` mengembalikan `requestRun()` (debounce 30 detik, digabung dengan inFlight, aman saat stop). `apps/api/src/edge/runtime.ts`: sambungkan `onDeferred` ke `requestRun`.
5. `apps/api/src/services/edge-master-data-publisher.ts`: (a) cek brand sebelum dan sesudah scan; (b) `blocked_at` + skip di sweep; (c) lewati record yang versinya <= aggregate_sequence terakhir di antrean node (cegah `queueOrderViolation` setelah reset cursor); (d) `updated_at = now()` saat watermark bergerak.
6. Migrasi + `apps/api/src/db/schema/edge-node.ts`, lalu `pnpm db:generate` harus kosong. Hapus 0373 lama dan regenerasi snapshot dengan nomor yang benar.
7. Grep konsumen `outcome` (status, dasbor, prune) agar `deferred` ditangani.

## Test wajib (gagal dulu sebelum fix)
- `apps/api/src/test/edge-master-data-publisher.test.ts`: item diantre sebelum station/kategori-nya. Batch link commit, receipt `deferred`, cursor maju, event station sesudahnya diterapkan, `onDeferred` dipanggil sekali.
- Race antartransaksi: tx A dibiarkan terbuka (menahan xmin); kategori dibuat lalu diubah di atas batas; item dibuat; dua `publishCatalogForNode` (menu_categories, menu_items) berjalan paralel di dua koneksi. Tidak ada deadlock, dan setelah antrean + satu HTTP pull edge konvergen (item ada, kategori benar).
- UOM: inventory_item dengan uom baru, jadi deferred. Setelah wake (`syncEdgeMasters` lalu `pullCatalog`) baris ada dengan uom benar.
- Versi: deferred v1 lalu link v2 diterapkan; HTTP v1 tidak menimpa v2; deferred tidak dihitung held (`lastSequence`).
- Tombstone yang tertunda akhirnya diterapkan oleh HTTP pull.
- Error non-referensi (mis. bentuk rusak, DB down) tetap membatalkan batch (regresi legend-wqc6).
- Brand: brand diubah di antara cek dan scan, jadi rollback dan watermark tidak bergerak. Mismatch menetap: `blocked_at` terisi, satu log, node lain tetap jalan, node baru setelah reprovision mendapat publikasi penuh.
- Isolasi: node tenant B tidak pernah menerima record tenant A; node outlet lain (brand sama) tidak menerima station/printer/price_list outlet lain; node brand lain tidak menerima menu_items brand A; receipt `deferred` hanya milik node-nya (RLS outlet).
- Republikasi setelah reset cursor tidak melempar `queueOrderViolation`.

## Risiko
- Deferral menambah HTTP pull, tetapi di-debounce 30 detik dan checkpoint sudah dekat head.
- Event yang tertunda terlambat sampai satu HTTP round, maksimal sekitar 30 detik (online).
- Pemulihan brand switch butuh tindakan operator (reprovision), disengaja.

## Review architect atas a2538fc4d (14 Nov 20:4x): lolos dengan catatan
- P1 (gerbang merge train, bukan untuk engineer): 0373 `when` 1794661468925 lebih besar dari 0366-0372 di cabang lain; migrator melewati migrasi yang `when`-nya lebih kecil. Jangan merge sebelum 0366-0372 masuk m1; saat rebase beri nomor bebas berikut, `when` = sebelumnya + 1000, regenerasi snapshot.
- P2 `edge-master-data-publisher.ts:51`: `FOR NO KEY UPDATE OF n` pada edge_nodes bentrok dengan UPDATE edge_nodes di applyInbound (`db-link-store.ts:641`) dan `edge-node.service.ts`. Ganti dengan `pg_try_advisory_xact_lock` per node (atau kunci di tabel publisher sendiri) dan lewati node yang terkunci.
- P2 `0373_edge_catalog_publisher.sql:18-20`: ADD CONSTRAINT CHECK memindai edge_inbound_events di bawah ACCESS EXCLUSIVE. Tambah `NOT VALID` (nilai lama tercakup).
- P2 `edge-master-data-publisher.ts:149-171`: sweep tiap 5 detik membuka transaksi tulis per tenant x node x 13 stream walau tanpa perubahan. Lewati stream tanpa baris di atas watermark sebelum INSERT/FOR UPDATE, dan/atau satu instance via advisory lock leader.

## Second opinion Codex atas 3875a8056 (14 Nov): 2 P1, keputusan CTO
1. `edge-master-data-publisher.ts:149` + `db-link-store.ts:375`: blokir brand tidak menghentikan antrean lama; node offline bisa menerima event brand A setelah outlet pindah ke B. Keputusan: pengiriman antrean cloud_to_edge dan jalur pull menolak (fail-closed) node dengan `blocked_at` terisi, dan event yang brand-nya tidak sama dengan brand outlet saat kirim tidak dikirim. Penandaan blokir dan penghentian kirim dalam satu transaksi. Test: outlet pindah brand saat node offline, node online kembali -> tidak menerima satu pun event brand lama, lewat antrean maupun pull.
2. `edge-catalog-apply.ts:1441`: tombstone printer dari HTTP tidak menyimpan versi penghapusan; event live versi lebih lama bisa menghidupkan printer lagi. Keputusan: simpan versi tombstone secara durabel (baris dipertahankan atau tabel tombstone) dan pakai di jalur event maupun HTTP; versi <= tombstone ditolak. Test: hapus via HTTP lalu event live versi lama datang -> printer tetap terhapus, untuk baris yang dihapus maupun yang dipertahankan untuk print job.
