# Second opinion refund kasir 1095 — ronde 2, brief 1129

Tanggal: 19 November 2026. Hasil: **2 temuan P1 dan 1 temuan P2 pada bukti test**. Dua P1 ronde pertama dan skenario P1 1127 tertutup secara statis, tetapi area ini belum bersih untuk gerbang rilis.

## Cakupan dan bukti

- `git fetch origin` selesai dengan exit 0. Head diperiksa: `0b8b9d017f7fc3ec4006146b6cef683b034e09fa`, cabang `origin/ws/1095-void-refund-ganda-voucher`. `origin/milestone/m1` saat fetch: `e2a63062e0630f8078291038198e49fe79e1aacc`; merge-base: `0b4fe006c9f77244a6b4e518b663765ad18f51cc`.
- Delta: `a8885a91f..0b8b9d017`. Konteks: `0b4fe006c..0b8b9d017`, snapshot migrasi dikecualikan. Nomor baris merujuk head tersebut, bukan checkout folder utama.
- Tiga subagent dimulai paralel, puncak 3: uang/voucher, lock/replay/ORD-09, dan test. Satu pemeriksa berhenti karena batas kuota setelah mengirim kandidat ORD-09; parent menuntaskan pemeriksaan kandidat melalui kode pemanggil, pencatatan refund, dan guard persetujuannya.
- Pemeriksaan statis melalui `git diff`, `git show`, dan `git grep`. Tidak checkout, membuat worktree, mengubah kode, menjalankan test/build/typecheck, atau mengakses rahasia. Hanya laporan ini yang ditulis; tanpa commit, push, merge, atau perubahan Beads. Checkout utama tetap `ux/customer-order-benchmark`.

## Temuan

| Lokasi | Tingkat | Masalah dan skenario gagal | Perbaikan dan usul test |
| --- | --- | --- | --- |
| `apps/api/src/services/order-recovery-refund.ts:363` | P1 | ORD-09 tidak mengurangi voucher yang sudah diterbitkan. QR pay-first lunas Rp100.000, satu item Rp100.000, tanpa DP/promo: buat complaint kitchen dengan resolution null, terbitkan voucher staf Rp100.000, lalu buat laporan recovery `unfulfillable` pada item yang sama dan selesaikan sebagai `manual_refund` dengan approval sah. Consumer menghitung released hanya dari refund issue lain, sehingga mengajukan Rp100.000 lagi. Approval pembayaran juga tidak melihat voucher. Voucher Rp100.000 + refund ORD-09 Rp100.000 = Rp200.000 dari pembayaran Rp100.000. | Di bawah lock order, batasi ORD-09 dengan anggaran kompensasi bersama dan tolak kompensasi item yang sudah diberikan lewat issue lain, termasuk complaint kitchen. Test melalui rute asli dengan dua issue berbeda; sesudah voucher penuh harus tidak ada refund baru yang dapat disetujui/dibayar. Tambahkan voucher sebagian dan dua koneksi yang berlomba menerbitkan voucher serta memproses event ORD-09; total voucher aktif/tertebus + seluruh refund tidak boleh melebihi pembayaran. |
| `apps/api/src/services/order-given.ts:258` | P1 | Uang charge swap mendukung voucher, tetapi jalur refund charge tidak mengurangi voucher tersebut. QR lunas Rp100.000 ditukar ke item Rp120.000; charge Rp20.000 dibayar tunai di kasir. Penyedia kemudian mengembalikan Rp100.000 pembayaran QR dan fakta refund sudah dicatat, tanpa void order. `paidIdr` menjadi Rp20.000 dari charge; complaint pada replacement line bisa menerima voucher Rp20.000. Sesudah itu request dan approve refund manual charge Rp20.000 tetap lolos karena batasnya hanya nilai charge dikurangi refund charge terdahulu. Total kembali Rp100.000 + voucher Rp20.000 + tunai Rp20.000 = Rp140.000 dari pembayaran Rp120.000. | Refund charge dan voucher harus memakai anggaran bersama di bawah lock order, termasuk reservasi refund yang belum selesai. Pilihan membatasi untuk rilis 1: jangan jadikan charge yang masih dapat direfund sebagai dana pendukung voucher sebelum guard kedua jalurnya konsisten. Test QR → swap lebih mahal → bayar charge tunai → catat refund penyedia atas base → voucher → request/approve refund charge, juga urutan terbalik dan dua koneksi. Assert nominal cash_out serta voucher aktif/tertebus dan refund penyedia bersama-sama <= Rp120.000. |
| `apps/api/src/test/refund-1116-paid-basis.test.ts:1062` | P2 | Baris property pembayaran telat memasang refund Rp25.000 pada intent penjualan sendiri (`:1037`), tetapi nominal itu tidak ditambahkan ke `totalOut`. Fixture hanya menerima Rp49.665; tidak ada pembayaran parkir terpisah. Bila guard `latePaid` cabang POS mengalami regresi, voucher Rp20.000 + refund kasir Rp20.000 + late refund Rp25.000 = Rp65.000, tetapi assertion hanya melihat Rp40.000 dan tetap lulus. Ini celah bukti test, bukan pembayaran berlebih yang terbukti terjadi pada produksi saat ini. | Hitung late refund dalam total keluar fixture tersebut dan assert `paidIdr === 0`, voucher/refund kasir kosong, serta tidak ada void. Realisasikan `it.todo` POS di `refund-1127-late-payment.test.ts:392`; alasannya sudah tertinggal karena fixture `pos-refund-ceilings.test.ts:654` kini memakai late intent terpisah dengan evidence tambahan. |

## Jejak pembuktian P1

### Voucher kemudian ORD-09

- `apology-voucher.service.ts:875` menerima issue open; `:892` memeriksa room, `:954` mint, dan `:656` hanya menyelesaikan issue sebagai voucher, tanpa mem-void item.
- `order-recovery.service.ts:652` memakai idempotency key recovery tersendiri; `:688` hanya memanggil `assertLineNotManuallyRefunded`. Helper `order-issue-manual-refund.ts:435` mencari resolution manual_refund, sehingga complaint yang sudah diberi voucher tidak menghalangi laporan recovery baru.
- `order-recovery.service.ts:1575` memeriksa approval ORD-09, lalu `:964` melewati guard item pada settlement manual_refund. Indeks `kds-issues.ts:104` hanya membatasi satu resolved unfulfillable; complaint voucher dan unfulfillable refund tidak berbenturan. Indeks manual_refund juga tidak mencakup voucher.
- `order-recovery-refund.ts:239` menolak lane void/refund kasir, bukan voucher. `:345` menjumlahkan payment_refunds saja; pada pay-first tidak ada koreksi `refundableBalance` di `:365`. `:637` dan `:705` menyimpan refund penuh.
- `payment-admin.service.ts:263` mengurangi sale-in-use dengan refund ORD-09, bukan voucher. Pada contoh, paid Rp100.000, reserved Rp100.000, sale-in-use 0, sehingga pemeriksaan `payment-refund.service.ts:530` menerima cap Rp100.000. Jalur finance manual `:3734` menerima refund approved dan tidak memeriksa voucher. Menonaktifkan kirim otomatis penyedia (Q45) tidak menutup pengajuan/persetujuan berlebih ini.
- Lock order menserialkan jalur, tetapi tidak memperbaiki penghitungan tersebut: urutan voucher selesai dahulu lalu consumer ORD-09 tetap salah. Urutan sebaliknya membatasi voucher melalui given/guard manual_refund, sehingga test harus mencakup kedua arah.

### Voucher kemudian refund charge swap

- `order-recovery-charge-pos.ts:251` mencatat cash_in charge, `:273` menandainya paid dan `:278` mengosongkan paymentIntentId; ini tidak membuat base QR menjadi pesanan POS.
- `order-given.ts:258` menambahkan charge tunai penuh pada paidIdr, terpisah dari base intent yang sudah dikurangi refund penyedia. Replacement dipetakan ke original pada perhitungan line room. Pada contoh, order room Rp20.000 dan original line room Rp100.000, sehingga voucher Rp20.000 lolos `order-voucher-room.ts:98`.
- `order-recovery-charge-manual-refund.ts:195` membatasi request hanya dengan refund charge sebelumnya; `:349` memeriksa nominal terhadap charge, lalu `:401` membuat cash_out. Tidak ada pemeriksaan voucher/anggaran order pada request atau approval. Shift terbuka yang memegang Rp20.000 hasil penerimaan charge memenuhi guard laci kas.
- `order-recovery-charge.ts:559` mengunci issue → order → charge, sehingga skenario tidak memerlukan race. Urutan refund charge dahulu mengurangi paidIdr dan membatasi voucher; urutan voucher dahulu tetap membayar ganda. Jalur refund charge online (`order-recovery-charge-refund.ts:144`) memiliki pemisahan batas yang sama, tetapi contoh tunai sudah membuktikan relevansi untuk rilis 1 tanpa kirim refund otomatis penyedia.

## Penutupan temuan lama dan area lain

- P1 QR belum bayar: `order-given.ts:239` mensyaratkan status intent final dan paid_at; allocated memakai evidence dikurangi dana parkir (`:136`). Tagihan saja tidak lagi menghasilkan paidIdr.
- P1 refund penyedia: provider refund, gateway refund yang belum dihitung di jalur lain, dan flag tanpa nominal mengurangi/menolkan paidIdr pada base QR maupun tender POS. P1 baru di atas menyangkut arah pengeluaran berikutnya setelah voucher, bukan pengulangan temuan lama.
- P1 1127: `latePaid` dicocokkan dengan ID intent, dipakai pada cabang POS, non-POS, dan charge swap. `order-voucher-room.ts:52` menolak order voided. Refund unallocated tidak dikurangi dua kali pada charge swap. Pilihan restriktif `excessOffBill=false` dipertahankan sesuai brief.
- Guard void cloud/edge/replay, voucher yang sudah ditebus, DP, promo dan scope tenant/outlet yang ditelaah tidak menghasilkan temuan baru terkonfirmasi. Tidak mengulang pengecualian yang sudah diterima CTO.
- Delta fixture test lama menambah intent/evidence pembayaran yang sesuai; tidak ditemukan assertion uang lama yang dilonggarkan. P2 di atas adalah blind spot pada baris tabel baru.

## Batas verifikasi

- Skenario dan nominal di atas dibuktikan secara statis; test database, barrier dua koneksi, build dan typecheck belum dijalankan pada audit ini. Tidak ada klaim test hijau atau patch selesai. Engineer perlu membuat bukti gagal-dulu dan regresi lewat `heavy`.
- `pnpm exec prettier --check docs/qa/second-opinion-refund-kasir-1095-1129.md` dan `pnpm exec eslint docs/qa/second-opinion-refund-kasir-1095-1129.md` dicoba; keduanya exit 1 karena executable dependency lokal tidak tersedia (`node_modules/prettier/bin/prettier.cjs` dan `node_modules/eslint/bin/eslint.js`, MODULE_NOT_FOUND). Format/lint belum terverifikasi; tidak memasang dependency atau mengubah lingkungan untuk audit ini.
