# Second opinion refund kasir 1095 — brief 1114

Tanggal: 19 November 2026. Hasil: **2 temuan P1**; belum dapat dinyatakan bersih untuk gerbang rilis. Tidak ada temuan P0/P2/P3 baru yang terkonfirmasi dalam cakupan pemeriksaan.

## Cakupan dan bukti pemeriksaan

- Brief: `docs/briefs/1114-second-opinion-refund-kasir-1095.md`; brief implementasi dibaca melalui `git show origin/ws/1095-void-refund-ganda-voucher:docs/briefs/sub-1095.md`.
- `git fetch origin` selesai dengan exit 0. Head yang diperiksa dibekukan pada `a8885a91f364f8ae5ae8ecc8e7f1d9d1302ff8f6`; `origin/milestone/m1` saat fetch adalah `4418628e0dd002d2fb5af07a6bc15f74390af162`; merge-base `0b4fe006c9f77244a6b4e518b663765ad18f51cc`.
- Rentang: `git diff origin/milestone/m1...origin/ws/1095-void-refund-ganda-voucher -- ':!**/meta/*snapshot.json'`, lalu `git diff`/`git show` memakai hash tetap tersebut. Seluruh nomor baris di bawah merujuk head yang diperiksa, bukan checkout folder utama.
- Tiga subagent berjalan paralel (puncak 3): refund kasir/DP/promo, voucher/checkout/void, dan edge/replay/ORD-09. Kandidat akhir diperiksa silang sebelum digabungkan.
- Pemeriksaan statis saja. Tidak checkout, membuat worktree, mengubah kode, menjalankan test/build/typecheck, atau mengakses rahasia. Hanya berkas laporan ini yang ditulis; tidak commit, push, atau merge.

## Temuan

| Lokasi | Tingkat | Masalah dan skenario gagal | Perbaikan dan usul test |
| --- | --- | --- | --- |
| `apps/api/src/services/order-given.ts:92` | P1 | Cabang non-POS menghitung `paidIdr` dari `orders.total_idr - deposit_applied_idr` tanpa bukti pembayaran. QR `open_bill` dengan tagihan Rp100.000, DP Rp0, dan pembayaran aktual Rp0 dapat menerima laporan staf `type: "complaint", resolution: null` lewat rute kitchen, lalu voucher maaf Rp10.000 melalui rute staf. Laporan hanya perlu berstatus `open`; room menjadi positif dari nilai tagihan. Voucher dapat ditebus meskipun pesanan sumber belum membayar. | Hitung pembayaran QR dari fakta pembayaran terverifikasi di dalam transaksi/kunci yang sesuai; belum dibayar harus memiliki room 0. Test: Buat QR `open_bill` tanpa membayar, buat laporan lewat `POST /api/outlets/:outletId/orders/:orderId/issues` (bukan rute recovery yang sudah memiliki paid guard), lalu minta voucher staf dengan izin dan approval yang sah bila diperlukan. Harus `422 APOLOGY_VOUCHER_NOTHING_DUE`, tanpa baris voucher/apology baru. Tambahkan pembanding setelah pembayaran terverifikasi. |
| `apps/api/src/services/order-given.ts:84` | P1 | Dasar pembayaran dan `givenIdr` mengabaikan pengembalian eksternal penyedia di `payment_provider_refunds`, termasuk flag `providerRefundedAfterPaidAt`. QR dibayar Rp100.000, lalu penyedia mengembalikan Rp100.000 dan fakta tersebut sudah dicatat; laporan kitchen baru dan voucher staf Rp100.000 tetap lolos. Helper tetap melihat `paidIdr = 100.000`, tanpa refund POS/ORD-09/voucher sebelumnya, sehingga total kembali Rp200.000 dari pembayaran Rp100.000. Cabang tender POS juga membaca nilai captured bruto tanpa koreksi ini. | Gunakan pembayaran net per instrumen, deduplikasi pengembalian penyedia yang cocok dengan refund internal, dan tolak status pengembalian yang belum pasti. Pola net/guard sudah ada pada `manualRefundAmountIdr` melalui `providerRefundedForeignIdrSql`. Test: Catat refund penyedia penuh/sebagian melalui jalur pencatat aslinya, kemudian terbitkan voucher melalui API staf; penuh harus ditolak tanpa voucher baru, sebagian membatasi nilai ke sisa. Assert refund penyedia + voucher + pengembalian lain tidak melebihi pembayaran aktual. Sertakan flag pengembalian tanpa nominal pasti yang harus ditolak. |

## Jejak pembuktian

Kedua skenario mencapai rute normal dengan staf yang memiliki izin; tidak memerlukan pelanggaran tenant/outlet atau pemalsuan status di database:

- `apps/api/src/routes/order-issues.routes.ts:47`: Rute kitchen menerima laporan staf. `packages/shared/src/kitchen/schemas.ts:1053` menerima laporan complaint dengan resolution null. `apps/api/src/services/order-issues.service.ts:488` memeriksa keberadaan order dan item dalam tenant/outlet, tanpa memeriksa pembayaran; `:690` menyimpan status open bila resolution null.
- `apps/api/src/routes/apology-voucher.routes.ts:75`: Rute penerbitan voucher staf. `apps/api/src/services/apology-voucher.service.ts:875` memeriksa issue open, `:885` memanggil guard dan room, lalu `:954` mint setelah pemeriksaan approval. `apps/api/src/services/order-issue-manual-refund.ts:417` hanya mengunci order dan menolak manual refund pada line; helper ini tidak memeriksa pembayaran atau refund penyedia.
- `apps/api/src/services/order-voucher-room.ts:39` menolak lane void, lalu `:48` membaca orderGiven. `:49` menghitung room dari paid minus given. `apps/api/src/services/order-given.ts:72` menghitung refund POS, `:76` refund ORD-09, `:84` captured tender POS, dan `:92` nilai tagihan QR. Tidak ada pembacaan refund penyedia atau flag intent pada dasar pembayaran order tersebut.
- `apps/api/src/services/payment-provider-partial-refund.ts:254` mencatat pengembalian eksternal dalam payment_provider_refunds; `:334` mengevaluasi pengembalian penuh dan `:357` memberi flag intent. Jalur ini tidak mengubah status order atau membuat refund ORD-09 yang akan dibaca orderGiven. `apps/api/src/services/order-issue-manual-refund.ts:170` menunjukkan guard net penyedia yang sudah diterapkan pada jalur refund manual lainnya. Temuan ini menyangkut penerbitan voucher setelah pengembalian penyedia tercatat, berbeda dari `createRefund` gateway/legend-v6is2 yang dikecualikan brief.

## Area tanpa temuan baru

- Cap refund kasir, promo, serta bagian DP diperiksa bersama alokasi refund DP terdahulu; tidak ditemukan skenario konkret baru yang membayar melebihi batas pada jalur tersebut.
- Guard ORD-09 terhadap void cloud/edge, replay dan event void diparkir, serta scope tenant/outlet tidak menghasilkan temuan baru. Retry ORD-09 yang diperiksa mengubah status gagal dan membuat pengganti dalam transaksi yang sama, sehingga dugaan race pembacaan lane tidak dilaporkan.
- Mint voucher mengunci issue lalu order; void mengunci order lalu voucher; checkout mengunci order tujuan lalu voucher. Tidak ditemukan siklus deadlock konkret atau keberhasilan void bersamaan dengan redeem yang melewati kunci voucher pada jalur yang ditelaah.
- Perubahan fixture test lama menambahkan pembayaran captured dan nilai line yang sesuai; tidak ditemukan pelemahan assertion uang pada perubahan tersebut. Kasus baru di atas tetap memerlukan test runtime.

## Batas verifikasi dan tindak lanjut

- Kedua temuan dibuktikan melalui alur kode dan perhitungan nominal, bukan reproduksi runtime. Tidak ada klaim test hijau atau perbaikan selesai.
- `pnpm exec prettier --check docs/qa/second-opinion-refund-kasir-1095-1114.md` dicoba, tetapi gagal karena instalasi lokal tidak memiliki `node_modules/prettier/bin/prettier.cjs` (`MODULE_NOT_FOUND`); format Prettier belum terverifikasi. Tidak memasang dependency atau mengubah lingkungan pada tugas read-only ini.
- CTO perlu meneruskan dua temuan P1 ke engineer pemilik area untuk perbaikan dan bukti regresi melalui `heavy`; laporan ini tidak mengubah status Beads atau keputusan bisnis yang sudah diterima.
