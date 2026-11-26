# Review K F2 receipt F-series (ws/1271-f2 e637636fc vs 2903b86cf)

Reviewer: architect (Opus), 26 Nov. Hasil: **LULUS**, satu syarat untuk F3 (bukan perbaikan F2).
Bukti: `heavy` test terarah 7 file 203/203 (edge-failover-receipt, pos-receipt-provisioning, -kfix, -seq-edge, -restore-detect, edge-receipt-run-applier, pos-day-receipt-gaps). Gagal-dulu tidak diulang reviewer.

## Run C tetap ketemu (ralat F1 no. 2)
- `seriesOf("regular")` = `series <> 'failover'`, jadi `findSequenceRow`/`ensureSequence` melihat `cloud` dan `device`. `insertSequence` kini wajib `series` eksplisit; tiap pemanggil mengisi (`cloud` hanya di C, `device` di P, `failover` di F). Test "C-000001/C-000002 dengan dan tanpa window" lulus.

## Nomor F tanpa ganda/loncat
- Nomor naik lewat `UPDATE ... last_number+1 RETURNING` di transaksi order: kunci baris = urut, rollback = nomor ikut batal. Run F pertama dibuat di bawah `lockOutletSequences` + baca ulang, `prefixesOfOutlet` termasuk run pensiun, jadi dua terminal tak pernah ambil `F<n>` sama. Run F tidak dipensiunkan saat window tutup, jadi satu run per perangkat lintas gangguan. Test 2x50 konkuren lulus.

## Edge tidak pernah menerima F-run
- Dijaga tiga lapis: check F1 (`failover` tak boleh edge-bound), filter `regular` di claim/list/retire-unlisted/merge/backfill, dan `applyCloudDeviceReceiptSequence` menolak awalan `F<n>`. `edge-device-sync.ts` tidak perlu diubah: query run di sana berjalan di sisi edge (tidak ada F-run), `listDeviceReceiptSequences` memfilter `edgeNodeId` = edge.

## Race `returning` (syarat F3)
- `allocateReceipt` membaca window tanpa kunci. Penjualan yang membaca `active` sebelum F3 mengubah ke `returning` masih bisa commit nomor F sesudah start return. Nomor tidak bentrok (run F hanya di cloud), tapi pemeriksaan "tidak ada order failover belum bayar" dan daftar shift di event penutup bisa melewatkannya = selisih kas.
- F3 wajib: (a) gate D4 di `pos-edge-outlet.ts`, di transaksi yang sama dengan `allocateReceipt`, membaca window `FOR SHARE`; (b) start return `SELECT ... FOR UPDATE` baris window dulu, baru cek open work, lalu ubah status. Di READ COMMITTED penjualan yang menunggu akan membaca ulang `returning` dan ditolak. Test F3: sale tertahan + start return paralel, hasilnya salah satu saja.

## Nit (tidak menahan)
- Lewat `F9999` melempar `Error` biasa (500), bukan `PosError`. Tidak realistis; biarkan.
