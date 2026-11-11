# Bukti gagal-dulu dan hasil hijau: 24318 + d0ipm + 0mus6

Berkas: `apps/api/src/test/edge-catalog-sync.test.ts` (diperbarui), `edge-catalog-txid.test.ts`, `edge-catalog-loop.test.ts`, `menu-delete-item-price-list.test.ts` (baru), `helpers/catalog-cloud.ts` (helper baru, hanya tes).

Perintah (satu run per kondisi):
`LEGEND_TEST_FILES="src/test/edge-catalog-txid.test.ts src/test/edge-catalog-loop.test.ts src/test/menu-delete-item-price-list.test.ts src/test/edge-catalog-sync.test.ts" heavy pnpm test`

## 1. Gagal-dulu (basis 6343a727, worktree sementara, sudah dihapus)

Hasil: 4 berkas gagal, **80 gagal | 25 lulus (105)**. Sebab semua perilaku yang belum ada (bukan setup/422):

| Temuan | Tes yang gagal | Sebab di basis |
|---|---|---|
| kolom/trigger sync_txid (1+2) | txid: kolom bigint NOT NULL + indeks, insert/update/skip trigger, stations | `column "sync_txid" ... does not exist`, kolom tidak ada |
| 1+2 transaksi terbuka | txid: dua tes transaksi lama terbuka; sync: "row dari transaksi terbuka ditahan" | record tanpa `syncTxid`, batas aman-commit belum ada (`Cannot convert undefined to a BigInt`, baris tidak muncul sesudah commit) |
| 2 txid lama tak menimpa | txid: older page, price cannot go back, racing, tombstone; sync: lower txid | tidak ada `syncTxid` pada record |
| cursor cat2/cat1 | sync: cat1 ditolak, nextCursor `cat2`; HTTP cat1 | basis menerima/menolak dengan bentuk lama (HTTP 422 vs diharapkan 200 untuk stream baru) |
| 3 kunci unik | txid: price list A-hapus+B-buat (3 tes), stasiun | stream/kolom baru tidak ada, apply menabrak unik |
| 4 repair parent | txid: restart puller | belum durable |
| 5 backlog | txid: 1.150 halaman | stream/cursor lama |
| stream stations/inventory_items | sync: 10 stream, schema valid, stations, inventory (6 tes), HTTP | stream tidak dikenal di basis |
| resep updated_by | sync: apply + pull dengan user tak dikenal | basis menolak (CATALOG_MISSING_REF) |
| cat1 checkpoint = kosong | sync + txid | basis tidak mengenal |
| d0ipm deleteItem | menu-delete: 6 tes | harga item tidak ikut soft-delete, `price_lists.updated_at` tidak naik; (tes "kasir 403" dan "404" ikut gagal di basis karena membaca `sync_txid` yang belum ada) |
| 24318 loop | loop: 5 tes | `expected 0 >= 8/10`: tidak ada panggilan katalog |

## 2. Hijau (worktree 24318, kode A/B/C)

Run pertama: 10 gagal | 95 lulus. Lima gagal adalah salah tes, sudah dibetulkan (bukan dilemahkan):
- apply menolak halaman yang mengulang id (`Catalog page repeats a record`): tes mengirim `[old, fresh, old]`, dst. Diganti apply berurutan (3 tes).
- tes cat1 memeriksa watermark stream kosong: dibatasi ke stream yang berisi data.
- aturan apply baru (`syncTxid >` ATAU `updatedAt >`): tes "txid lama tak menimpa" tidak lagi memakai `updatedAt` lebih baru pada salinan lama; hanya txid yang lebih rendah.

Run kedua (sesudah perbaikan tes): **6 gagal | 99 lulus (105)**. Sisa gagal, diduga **kode salah**, tes tidak dilemahkan:

1. `edge-catalog-sync > 24318 the price of a deleted price list does not leak` (uang): setelah apply tombstone list, baris `price_list_items` masih ada di edge (`33333` terbaca). Dugaan: apply tombstone hanya menandai header `deleted_at` dan tidak menghapus anak. Asumsi tes (aturan jangan sampai rugi): list terhapus tidak boleh menyisakan harga yang terbaca.
2. `edge-catalog-loop` (5 tes: urutan stream, masters gagal tidak menghentikan katalog, katalog gagal, error jaringan katalog, stop): nol permintaan ke `/api/edge-sync/catalog` padahal `onError` hanya menerima error masters (`CLOUD_NETWORK` / `CLOUD_HTTP_500`). Dugaan: loop tidak menjalankan `pullCatalog` bila `syncEdgeMasters` melempar (desain: independen). Bila tes yang salah, sebabnya bisa fixture (mock `fetch` hanya untuk jalur masters/katalog); belum terbukti hijau dengan masters sukses, tes itu belum ditulis (butuh snapshot masters bertanda tangan).

## Asumsi tes (ringkas)
- Aturan apply: txid lebih besar ATAU updatedAt lebih besar; "lebih lama kalah" memakai updatedAt sama.
- Tombstone list harga tidak menyisakan harga terbaca; live bentrok kunci unik: cloud menang.
- `startEdgeMasterSyncLoop({config, intervalMs, onError})`.
- DELETE item menjawab 200/204; kasir 403; item tak dikenal 404.
- Keputusan skema untuk CTO: `recipes.updated_by` nullable; modifier per brand tidak diubah (butuh keputusan founder).
