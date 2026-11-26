# Review K 1270 W2 (uang + migrasi), konteks segar

Cabang `ws/1270-w2` 6e5526874 vs db8f4b391. Reviewer: architect subagent, 26 Nov. Kode dan test dibaca, test tidak dijalankan. Path relatif `apps/api/src`.

## Putusan: TIDAK LULUS, 0 P1, 2 P2, 3 P3
Penjualan masih mati, jadi belum ada uang yang hilang. Jalur uangnya benar: lunas dibuktikan trigger (link penuh, belum batal), bayar telat selalu jadi refund (tidak pernah jadi kursi), refund dibatasi saldo kode dan harga dikurangi refund yang sudah ada, kunci link -> klaim konsisten, dan bayar dobel diparkir. Test brief §4 untuk W2 ada (balapan kursi, kuota, telat, sweep, flag mati, edge).

## Temuan
1. **P2: refund gagal membuat klaim macet dan event mati.** Bila `handleWfcPaymentPaid` (`services/wfc-payment-consumer.ts:287-379`) melempar error terus (misalnya insert refund ditolak guard W3 nanti), pg-boss mencoba 5x (`worker/runtime.ts:69`) lalu menandai event mati. Antrean global tidak tertahan, tetapi (a) `payment.paid` kode itu tidak diterima consumer lain di pengiriman yang sama (`worker-main.ts:385` jalan sebelum `deliverOrderPaymentEvent`/`deliverEvent`, termasuk jurnal), dan event kode itu berikutnya ikut tertahan per aggregate sampai di-replay; (b) sweep melewati hold yang kodenya sudah dibayar (`:418-431`) selamanya, jadi klaim tetap `pending_payment`: member terkunci oleh index satu-hold, kursi dan kuota terpakai, refund tidak pernah diajukan.
   Perbaikan: pisahkan `settleWfcIntent(tx, ctx, claimId, intentId, now)` dan pakai di consumer dan sweep. Ajukan refund di savepoint; bila gagal, catat log (claimId, intentId, kode) lalu return tanpa throw. Klaim tetap `cancelled` dengan paid = harga. Sweep (i) menyelesaikan hold yang kodenya sudah dibayar dan lewat hold lebih dari 15 menit lewat fungsi yang sama, (ii) mencoba ulang klaim `cancelled` yang paid > 0 tetapi belum punya baris idempotensi `wfc-late-refund:` untuk kode yang dibayar. Error kunci (55P03 atau lock timeout) tetap boleh dilempar supaya di-retry.
2. **P2: route HTTP dan wiring worker belum punya test.** Buat `test/wfc-routes.test.ts` untuk: 401 tanpa sesi; 403 POST dari origin tak dipercaya; bukan member ditolak; body ketat menolak `amountIdr`/`method`/`customerProfileId`; klaim member lain 404; id tidak valid 400. Tambah `/api/wfc` sebagai path yang ditolak di `test/edge-mode-guard.test.ts`, dan `sweepWfcHolds` + `handleWfcPaymentPaid` di `test/edge-worker-cloud-sweeps-gate.test.ts`.
3. **P3:** pengulangan day pass hari ini tidak pernah dikenali sebagai replay karena `startsAt` = sekarang dan berubah tiap menit (`services/wfc-sale.service.ts:869-878`), jadi retry mendapat 409 `WFC_HOLD_OPEN`. Untuk day pass, cocokkan produk + `businessDate`.
4. **P3:** test `test/wfc-sale.test.ts:860-869` terlalu longgar (`not.toBe`, `<=`). Ganti dengan nilai pasti: status `cancelled`, satu refund PRICE-1.
5. **P3:** komentar `services/wfc-sale.service.ts:15` masih menyebut "migration 0529". Ubah sesudah nomor migrasi diganti.

## Migrasi
`0529_wfc_sale_hold`: aditif (kolom nullable + unique index parsial pada tabel yang belum terisi penjualan), aman. Nomor ulang ke 0530: hapus `drizzle/0529_wfc_sale_hold.sql`, `drizzle/meta/0529_snapshot.json`, dan entri di `_journal.json`; gabung base yang sudah memuat 0529 failover; jalankan `pnpm db:generate` (hasilnya 0530, `prevId` = snapshot failover); pastikan SQL-nya sama persis (2 statement) dan generate berikutnya kosong. Jangan sunting snapshot dengan tangan.

## Di luar W2 (gerbang sebelum `WFC_SALES_ENABLED`)
- Aturan GM/Owner silang (default no. 4 di §7) belum ada. `services/wfc-settings.service.ts` tidak mengecek peran. Perlu kartu kecil K akses: penyetuju harus Owner bila GM yang mengusulkan, dan sebaliknya. Gerbang jual juga menolak versi yang tidak disetujui silang. Test di `test/wfc-settings.test.ts`.
- W3 wajib menolak `createRefund` untuk tautan WFC, menjurnal ke `customer_deposit`, dan memindah `cancelled` -> `refunded` saat refund dieksekusi. Tanpa itu, refund dari staf bisa terjadi saat pass tetap terbit.
- Tabel migrasi di brief sudah usang (0527-0529 terpakai). CTO perlu menomori ulang W4, W11, dan W13.

## Urutan
No. 1 + test gagal-dulu, lalu no. 2, no. 3-5, nomor ulang migrasi. Sesudah itu review ulang delta consumer/sweep oleh satu architect.

## Keputusan CTO 27 Nov
1. Kerjakan urutan reviewer: no. 1 (settle bersama consumer + sweep, refund dalam savepoint, gagal = log tanpa throw, sweep ulang refund dan hold lunas yang belum diproses) dengan test gagal-dulu; no. 3 test route/worker; P3; nomor migrasi ulang lewat `db:generate` sesudah merge `origin/int/rc2` (nomor final 0530). Lalu re-review architect yang sama.
2. Aturan silang GM/Owner: kartu kecil terpisah, wajib sebelum saklar jual WFC dinyalakan.
3. Sebelum saklar jual: W3 blokir `createRefund` atas link WFC dan bukukan ke `customer_deposit`. Nomor migrasi W4/W11/W13 di brief diperbarui saat kartunya mulai.

## Re-review 27 Nov (30c7f1127): TIDAK LULUS, 0 P1, 1 P2 baru, 1 P3. Kelima temuan lama tutup

Delta WFC: 243bd1d68, 130af9d40, 88e33d8ad, 30c7f1127. Reviewer membaca kode dan test, tidak menjalankan test.

- **No. 1 tutup.** `settleWfcIntent` dipakai consumer dan sweep. Refund diajukan di savepoint: bila gagal, error dicatat di log dan klaim tetap `cancelled` dengan paid = harga. Index satu-hold tidak lagi mengunci member, dan yang dilempar hanya 55P03/40P01. Sweep menyelesaikan hold lunas yang lewat 15 menit, lalu mengajukan ulang refund yang tertinggal. Kunci idempotensi dengan refundId null mencegah pengulangan tanpa akhir. Ketiga test (refund gagal, event hilang bayar tepat waktu, event hilang bayar telat) membuktikan satu kursi atau satu refund.
- **No. 2, 3, 5 tutup.** Test route (401, origin, bukan member, body ketat, member lain, id), penolakan `/api/wfc` di edge, dan gerbang cloud di worker sudah ada. Replay day pass kini memakai tanggal. Migrasi diregenerasi (`prevId` = snapshot 0529 failover, SQL sama persis).
- **No. 4: aman untuk uang.** Kurang bayar ditolak di lapisan pembayaran. Di Duitku nyata, uang yang selisih diparkir (`services/payment-duitku-webhook.service.ts:255`, `recordUnsettledGatewayFunds`) dan kode ditutup. Klaim tidak mendapat kode lunas, jadi sweep melepas kursinya saat hold habis. Uang kembali lewat alur dana parkir Finance. Tidak ada kursi, tidak ada refund WFC, tidak ada refund ganda. Test memanggil `confirmPayment` langsung, jadi jalur parkir webhook tidak ikut diuji. Itu sudah dijaga test pembayaran (SO-896).
- **P2 baru: kode yang sudah mengesahkan kursi masih bisa di-refund penuh otomatis.** Jalur lunas (`services/wfc-payment-consumer.ts:339-354`) tidak mencatat apa-apa. Bila klaim `confirmed` nanti jadi `cancelled` tanpa refund (W3: batal kurang dari 24 jam = hangus, guard mengizinkan `confirmed -> cancelled` sebelum mulai), sweep (`:529-545`) atau replay `payment.paid` menganggapnya bayar telat dan mengajukan refund penuh. Hari ini belum ada jalur batal, tetapi W3 akan membuatnya. Perbaikan: di cabang lunas, dalam transaksi yang sama, tulis kunci `wfc-late-refund:<intentId>` (`idempotentPaymentAdminWrite`, respons `{ refundId: null }`) supaya kode pengesah tidak pernah masuk jalur telat. Test gagal-dulu: lunas, ubah status ke `cancelled` sebelum mulai, replay event + sweep sesudah 15 menit, hasilnya nol refund `system:wfc`.
- **P3:** refund yang terus gagal dicoba ulang setiap tick hanya dengan log. Urutan `updated_at` tidak bergeser, jadi lebih dari 100 klaim macet akan menahan klaim baru. Tambah audit atau metrik dan geser `updated_at`. Boleh menyusul.

Sesudah P2 dibetulkan: CTO cek diff dan test, tanpa review architect ulang. Nomor 0531: regenerasi dengan cara yang sama.
