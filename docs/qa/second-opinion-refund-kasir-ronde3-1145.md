# Second opinion refund kasir ronde 3 — brief 1145

Tanggal: 19 November 2026. Hasil: **2 temuan P1**. Dua skenario P1 ronde 2 tertutup secara statis, tetapi gabungan jalur refund ini belum bersih untuk gerbang rilis.

## Cakupan dan bukti

- `git fetch origin` selesai, exit 0. Head diperiksa: `3bf621e86947a54876648ee915d5c7dc98fd3aa7`, cabang `origin/ws/1095-void-refund-ganda-voucher`.
- Delta: `0b8b9d017..3bf621e86`; konteks: `0b4fe006c9f77244a6b4e518b663765ad18f51cc..3bf621e86`, merge-base dengan `origin/milestone/m1` (`494228f7b7fd3d52b27c81e1cc4f83dfc5e8c968`). Snapshot migrasi dikecualikan. Nomor baris merujuk head tersebut, bukan checkout utama.
- Tiga subagent dimulai paralel, puncak 3: anggaran/per baris/ORD-09; charge/finance/locking; jalur lain/tiga commit pasca-architect/test. Parent memverifikasi temuan melalui kode pemanggil, persetujuan, settlement, dan perhitungan nominal.
- Pemeriksaan memakai `git diff`, `git show`, dan pencarian statis. Tidak checkout, membuat worktree, mengubah kode, atau menjalankan layanan. Hanya laporan ini yang ditulis; tanpa commit, push, merge, atau mutasi Beads. Checkout utama tetap `ux/customer-order-benchmark`.

## Temuan

| Lokasi | Tingkat | Masalah dan skenario gagal | Perbaikan dan usul test |
| --- | --- | --- | --- |
| `apps/api/src/services/payment-admin.service.ts:309` | P1 | Voucher open bill dan refund finance tidak memakai kunci bersama. Order lunas Rp90.090: koneksi A membaca ruang lalu tertahan sebelum mint voucher Rp50.000; B mengajukan, menyetujui, dan menyelesaikan refund finance Rp50.000 ketika voucher A belum commit; A kemudian mint dan commit tanpa membaca ulang refund B. Total Rp100.000 dari pembayaran Rp90.090. | Serialkan pembacaan dan komitmen kedua jalur dengan kunci bersama dan urutan konsisten, termasuk persetujuan refund. Jangan sekadar menambah lock order setelah lock intent karena jalur lain memakai order → intent. Test dua koneksi dengan barrier sesudah A membaca ruang sebelum mint; jalankan request → approve → manual settle B sebelum melepas A. Assert refund hidup/selesai + voucher aktif/tertebus ≤ Rp90.090. Uji juga barrier pada persetujuan refund yang sudah pending. |
| `apps/api/src/services/order-given.ts:567` | P1 | Pengecualian `room >= share` meloloskan nominal replacement yang memakai bagian item lain, sementara refund charge hanya dibatasi anggaran seluruh order. Tanpa pajak/promo/DP: QR lunas A Rp10.000 + B Rp90.000; A ditukar ke replacement Rp100.000 dan charge Rp90.000 dibayar tunai. ORD-09 replacement mengajukan Rp100.000 dari intent asli. Refund charge Rp90.000 tetap dapat diminta/disetujui. Keluar Rp190.000 untuk chain A yang dibayar Rp100.000, sementara B Rp90.000 tetap diterima; invariant total keluar ≤ seluruh pembayaran Rp190.000 masih lulus. | Hitung bagian pembayaran dan seluruh pengembalian pada chain original/replacement yang sama, termasuk charge. Alternatif membatasi: refund ORD-09 dari intent asli hanya bagian original A, bagian charge lewat jalur charge. Pengecualian pembulatan tidak boleh mengizinkan nominal replacement tanpa batas. Test kedua urutan ORD-09 replacement ↔ refund charge, dengan persetujuan sah dan shift cukup kas; assert kompensasi chain A ≤ Rp100.000 dan uang untuk B tetap ≥ Rp90.000, selain batas seluruh order. |

## Jejak pembuktian

### P1 — race voucher dan finance open bill

- `payment-admin.service.ts:578–587` mengunci intent; `:623` membaca `refundableBalance`; `:295` menambahkan voucher melalui query baru `orderVouchersInUseOfIntent`. Query `:317–346` tidak mengunci order. Komentar `:309` menegaskan intent-first tanpa order lock.
- `apology-voucher.service.ts:805–822` mengunci issue; `:885–895` mengunci order melalui `assertLineNotManuallyRefunded` (`order-issue-manual-refund.ts:423–427`) lalu membaca ruang. `order-voucher-room.ts:55` membaca `orderGivenOf` tanpa mengunci intent. Mint `apology-voucher.service.ts:954` dan settlement issue tidak memeriksa ulang ruang.
- Gunakan voucher dengan approval sah yang sudah tersedia agar approval baru bukan penghalang transaksi A. B memakai pemohon dan penyetuju refund yang berbeda serta MFA untuk settlement.
- Approval refund memang memeriksa ulang cap (`payment-refund.service.ts:530`), tetapi voucher A masih belum commit. `payment-refund-approval-limits.ts:205–217` memakai advisory lock dan lock `pos_orders`; voucher tidak mengambil advisory lock itu, dan open bill non-POS tidak memiliki baris `pos_orders` untuk diserialkan.
- Settlement manual `payment-refund.service.ts:3734–3790` menerima refund approved dan memeriksa provider/bukti; tidak mengambil lock order atau membaca ulang anggaran voucher. B dapat selesai seluruhnya sebelum A commit. Mematikan pengiriman otomatis penyedia pada rilis 1 tidak menutup skenario ini.
- Fixture `refund-1131-order-budget.test.ts:1075–1129` sudah menyediakan open bill dengan intent lunas yang sesuai. Test `:1132` dan `:1145` hanya dua urutan serial; keduanya tidak membuktikan keselamatan transaksi bersamaan.

### P1 — ORD-09 replacement dan refund charge mengambil uang item B

- `order-recovery-swap-kitchen.ts:245–262` menyimpan harga replacement Rp100.000 pada order yang belum completed; subtotal/total order asli tetap Rp100.000. Charge menambahkan pembayaran Rp90.000 terpisah.
- `order-recovery.service.ts:675–694` menerima laporan replacement yang belum void; approval `:1428` mengharuskan nominal line replacement, sehingga approval Rp100.000 sah untuk jalur ini.
- Resolve gate `order-recovery-refund.ts:149–155` dan consumer `:629–635` memasukkan line total replacement Rp100.000 ke pembagi subtotal asli Rp100.000. Tanpa komponen tambahan, `recoveryRefundSplit` menghasilkan refund Rp100.000.
- `order-given.ts:309–315` memetakan replacement ke original A. `lineRoomIdr` memberikan share original A Rp10.000. Karena belum ada kompensasi, room = share = Rp10.000; `lineFitsIdr:567` menerima wanted Rp100.000. Anggaran seluruh order juga menerima: dibayar Rp190.000, given Rp100.000.
- Request/approval refund charge `order-recovery-charge-manual-refund.ts:196–225,344–357` mengecek sisa charge dan anggaran seluruh order, tanpa batas chain. Refund charge Rp90.000 menurunkan `paidIdr` menjadi Rp100.000 (`order-given.ts:261–265`), sementara given ORD-09 tetap Rp100.000: post-check lulus. Kas dari charge memenuhi guard laci; approval mencatat `cash_out` pada `:408–415`.
- ORD-09 Rp100.000 melepaskan hold intent asli Rp100.000 (`payment-admin.service.ts:263–273`), sehingga approval refundnya juga tidak menahan uang untuk B. Urutan charge-refund dahulu menghasilkan paid Rp100.000 dan room original A yang sama; ORD-09 replacement tetap lolos. Tidak memerlukan race atau bypass otorisasi.

## Penutupan temuan lama dan pengecualian

- P1 ronde 2 voucher → ORD-09: resolve/consumer kini memeriksa anggaran order; tambahan guard per baris menutup skenario voucher pada line yang sama. Reverse order juga membaca refund hidup sebagai given. Ini penutupan statis atas skenario lama, bukan klaim test dijalankan.
- P1 ronde 2 voucher → refund charge: request/approval manual dan request online kini menjalankan `assertOrderBudget` di bawah lock order. Skenario lama dengan base sudah direfund penyedia dan hanya uang charge yang tersisa ditolak.
- P2 tabel late-payment: `refund-1116-paid-basis.test.ts:1062–1081` kini menghitung late refund dalam total keluar dan memeriksa paid 0, tanpa voucher/refund kasir/void. Todo POS direalisasikan memakai intent late terpisah. Perubahan fixture four-eyes dan rereport tidak menghapus assertion pencegah refund ganda yang diperiksa.
- Tiga commit pasca-architect diperiksa: `d363659cc` terkait temuan race pertama; `5b45ec4ad` dan `a3cc37c85` menambah guard per baris yang masih memiliki celah replacement pada temuan kedua.
- Tidak melaporkan ulang `legend-jhbee`, `legend-byws7`, `legend-fntrm`, `legend-glu4e`, void charge ikut anggaran, atau penahanan finance ketat split bill. Tidak ada temuan tambahan terkonfirmasi pada jalur provider, deposit, payout, poin, dan open bill yang ditelusuri dalam cakupan brief.

## Batas verifikasi

- Bukti berupa penelusuran statis atas kode dan nominal. Test database, barrier dua koneksi, build, dan typecheck belum dijalankan; tidak ada klaim test hijau atau perbaikan selesai. Engineer perlu membuktikan dua skenario gagal-dulu dan menjalankan regresi terarah lewat `heavy`.
- `pnpm exec prettier --check docs/qa/second-opinion-refund-kasir-ronde3-1145.md` dan `pnpm exec eslint docs/qa/second-opinion-refund-kasir-ronde3-1145.md` dicoba; keduanya exit 1, `MODULE_NOT_FOUND`, karena executable dependency lokal (`node_modules/prettier/bin/prettier.cjs` dan `node_modules/eslint/bin/eslint.js`) tidak tersedia. Format/lint belum terverifikasi; tidak memasang dependency atau mengubah lingkungan untuk audit ini.
