# Rancangan WFC berbayar rilis 1 (read-only, tanpa test)

Path API relatif `legend-rc1/apps/api/src`. "Cabang" = a73998a99. Jam adalah perkiraan.

## Keputusan
1. **Potong cabang, jangan digabung utuh.** Ambil kursi dan reservasi; buang bukti tender kasir, bundel, min-spend, dan RevPASH.
2. **Satu klaim kursi untuk tiga produk.** Reservasi = satu slot, day pass = kursi sampai tutup hari, bulanan = kuota N kunjungan yang tiap kunjungannya memesan kursi. Constraint EXCLUDE cabang menolak jual ganda.
3. **Dijual online ke member lewat `createPaymentLink` + Duitku**, seperti DP reservasi (`services/reservation-deposit-payment.ts`). Di outlet, tamu memindai QR dan membayar di HP.
4. **Cloud pemilik kursi WFC.** Edge tidak menjual. Keputusan F nomor 4 (edge pemilik slot) hanya untuk shower.
5. **Uang tetap di `customer_deposit` sampai jasa dimulai.** Refund hanya sebelum itu.
6. **WFC tidak memakai `entitlement_ledger` dan `access_tickets`** (`redeemEntitlement` wajib tiket). Jadi gerbang tiket F0 boleh tetap global.

## 1. Keadaan
**Sudah di int/rc1**
- Zona `is_wfc` (`db/schema/floor.ts:72`), pengingat min-spend, RevPASH dan okupansi (`metric-sources/facility.ts:843-848`), kuota Wi-Fi, tipe `coworking`, konfigurasi produk dan paket.
- `ws09-wifi/components/wfc-products.tsx` hanya brosur; tombolnya ke `/f/$facility`.

**Hanya di cabang**
- `wfc_seats`, `wfc_seat_reservations`, day pass, bundel, `wfc_kind` + `duration_minutes`, 14 rute staf.

**Belum ada**
- Rute member, pembayaran online, sweep hold, check-in/no-show, kursi untuk day pass, langganan WFC, jurnal, payout refund, UI.
- Langganan yang ada terikat DOIT (`facility-subscription-quota.ts`). Kontrak `/facility/subscriptions` ada, route-nya tidak.

**Harga W4:** tidak ada di `docs/founder/`. Buktinya hanya alasan tutup legend-7pw8b: harga per produk, tidak dikali durasi. Angka harga (PRD A23, jatuh tempo 25 Nov) belum ditemukan.

## 2. Cabang
**Konflik (merge-tree):** snapshot 0250/0251, `_journal.json`, `db/schema/index.ts`, `pos-order-corrections.ts`, `wfc-min-spend.service.ts` (add/add), `events/catalog.ts`, `PROGRESS.md`. int/rc1 sudah punya 0250/0251 lain, terakhir 0523; 0524 dan 0525 milik E2 dan E1. Buat migrasi baru, nomor dari CTO.

**Ambil:** `wfc-seat.ts` + `.custom.sql`, `wfc-clock.ts`, kolom dan check produk, unique `floor_zones`, bagian kursi/reservasi dari `shared/wfc/seat.ts`, `wfc-seat.service.ts`, dan testnya.

**Temuan uang terbuka**
- U1: cek diskon hanya `pos_order_discounts`, sedangkan ingest edge menulis `orders.discount_idr` (`edge/order-ingest.ts:460`). Order edge berdiskon bisa membiayai pass penuh.
- U2: pencarian tender tidak menyaring metode; poin bisa membeli pass.
- U3: hold `pending_payment` tidak pernah lepas.
- U4: day pass tanpa batas kursi; reservasi tidak mengecek jam buka.
- U5: refund WFC hanya mengubah angka, tanpa payout; refund POS bisa menjadi payout kedua.
- U6: penjaga hanya di void/refund POS; `createRefund` (`payment-admin.service.ts:591`) tidak dijaga.
- U7: `/api/facility` terbuka di edge (`edge/mode.ts:106`), jadi `/facility/wfc` ikut dilayani DB edge. Pakai `/api/wfc`.

U1, U2, dan U5 gugur bersama jalur tender. tz4dg dan c8gsw ditutup "tidak berlaku"; penggantinya W3.

## 3. Aturan jual
- **Kanal:** member online. Tunai/EDC kasir dan offline ditolak. EDG-01 tidak menyebut WFC.
- **Hold:** link 30 menit, hold 45 menit. Hold commit dulu, lalu link, karena `createPaymentLink` memakai transaksi sendiri.
- **Bayar telat:** tidak menghidupkan kursi; ajukan refund penuh (pola `refundLateDeposit`, `reservation-consumers.ts`).
- **Kursi:** hanya kursi khusus WFC, bukan meja kasir/reservasi. Internet putus: staf memakai daftar terakhir; check-in tidak mengubah uang.
- **Bulanan:** prabayar satu periode, perpanjang manual. Periode baru mulai setelah yang lama, satu kunjungan per hari, sisa hangus.
- **Pengakuan:** reservasi/day pass saat slot mulai, bulanan di akhir periode. Waktu terutang pajak menunggu akuntan.
- **Tanpa** poin, voucher, dan promo. Refund Duitku lewat layar manual 1259.
- **Wi-Fi:** production tanpa vendor = provider null (`edge/wifi/registry.ts`). Pass hanya menaikkan kuota tercatat; layar dilarang menjanjikan kecepatan.

## 4. Kartu
| Kartu | Model, jam | Berkas | Sesudah |
|---|---|---|---|
| W1 skema, kursi, produk, flag `WFC_SALES_ENABLED` (default false) | Opus K, 8 | `db/schema/wfc-*`, `facility.ts`, `floor.ts`, migrasi, `shared/src/wfc`, `wfc-seat.service.ts`, `config/env.ts` | F0, nomor migrasi |
| W2 jual, hold, lunas, sweep, bayar telat | Opus xhigh, 14 | `wfc-sale.service.ts`, `wfc-payment-consumer.ts`, `routes/wfc.routes.ts`, `worker-main.ts` | W1 |
| W3 batal, refund, penjaga, jurnal | Opus xhigh, 14 | `wfc-refund.service.ts`, `payment-admin.service.ts:89-110,591`, `accounting-auto-journal-{amounts,consumer,guards}.ts`, `events/catalog.ts` | W2 |
| W4 bulanan + perpanjang | Opus xhigh, 8 | `wfc-membership.service.ts`, skema, migrasi | W2 |
| W5 check-in, daftar hari ini | Sonnet, 5 | `wfc-checkin.service.ts`, `routes/wfc-staff.routes.ts` | W2 |
| W6 kuota Wi-Fi | Sonnet, 4 | `wifi-quota.service.ts:125` | W2 |
| W7 mockup | Codex high, 5 | `design/mockups/wfc/` | sekarang |
| W8 UI member | Opus ui, 12 | `features/ws09-wfc/**`, `_customer/wfc.*`, `wfc-products.tsx` | W7 disetujui, kontrak W1 |
| W9 UI staf + konfigurasi | Opus ui, 10 | `features/wfc-staff/**`, `facility-admin/components/products-tab.tsx` | W7 disetujui, W1, F0 |
| W10 e2e, dokumen, laporan | Sonnet, 6 | `e2e/wfc.spec.ts`, `docs/` | terakhir |

Total 86 jam, di luar review architect xhigh untuk W2, W3, dan W4.

**Urutan:** W1+W7 → W2+W8+W9 → W3+W4+W5+W6 → W10. W2 tidak menyentuh `payment.service.ts` (milik C2a) atau `pos-order*` (E/F), jadi paralel dengan E/F. Berkas bersama satu penulis: `worker-main.ts`, `routes/index.ts`, `schema/index.ts`, `events/catalog.ts`. Jual nyata menunggu C0, C1, C2a/b dan Duitku production.

**Mockup:** katalog, pilih kursi/jam, bayar/menunggu/telat, pass saya + batal, bulanan + perpanjang, daftar check-in, konfigurasi kursi. Masing-masing dengan kosong, error, dan penuh; 390 dan 1280.

**Test wajib (gagal dulu)**
- Dua member satu kursi; day pass vs reservasi vs bulanan bertumpuk: satu menang.
- Webhook ganda, dua kode dibayar, nominal beda: satu pass, sisanya dana parkir.
- Bayar sesudah hold lepas: nol pass, satu refund penuh.
- Refund vs slot mulai bersamaan: satu menang. `createRefund` langsung ditolak. Refund dari dashboard penyedia mencabut pass.
- Diterima = refund + diakui + sisa deposit; pengakuan ulang tidak ganda.
- Bulanan: dua perpanjangan bersamaan tidak tumpang tindih; kuota dan batas harian tahan serentak.
- Tenant/outlet/member lain ditolak; flag mati atau di edge = nol baris, nol uang. Link dibuat sebelum flag mati lalu dibayar = refund penuh.

## 5. Perubahan F
- **F0 (c64892f8a + WIP):** `issueEntitlement`, `redeemEntitlement`, dan slot di server ditolak untuk semua tipe. Biarkan. Catat sebagai pengecualian keputusan 27: hak coworking dari paket, promo, dan tier ikut tutup di rilis 1.
- F0 web salah tutup: `reports.facility.revpash` (`showerOnly`) dan `facility-report/lib.ts` hanya menyisakan Wi-Fi. Buka RevPASH.
- `/f/$facility` boleh tetap tutup; W8 memindah tombol WFC ke `/wfc`. Sebelum itu sembunyikan tombolnya agar tidak 404.
- **F2:** tanpa hak WFC dari order. **F7, F8, F9:** tetap deferred; tambahkan `coworking` dikecualikan dari pemilik edge dan stream.

## 6. Pertanyaan founder (default paling membatasi)
1. Harga, jumlah kursi, kuota bulanan, dan pajak (dengan akuntan)? **Default: penjualan tetap mati sampai terisi.**
2. Day pass termasuk minuman (PRD 873)? **Default: tidak di rilis 1, ditulis jelas; menyusul lewat voucher (F4).**
3. Kasir menerima tunai/EDC untuk WFC? **Default: tidak, bayar lewat QR di HP.** Bila ya: kartu W11 (Opus xhigh, sekitar 14 jam) sesudah F1, F2, E9; offline tetap ditolak.
4. Pembatalan: **default refund penuh sampai 24 jam sebelum mulai, lalu hangus; bulanan tanpa refund setelah kunjungan pertama; outlet membatalkan = refund penuh.**

**Batas potong:** W6, lalu W4 (bulanan "Segera hadir"; perlu izin founder karena keputusan 27), lalu konfigurasi di W9 (diganti seed). W1, W2, W3, W5 jangan dipotong. "Pagi Produktif" gugur karena shower ditutup.

**Risiko:** gerbang Duitku production di luar kendali kode; refund manual membebani finance; kursi khusus dipakai tamu walk-in; `accounting-auto-journal-*` besar dan sensitif (satu agent saja).

## Catatan CTO (25 Nov)

- Rancangan diterima. W7 dikerjakan Claude (bukan Codex). Default paling membatasi di bagian 6 dipakai sampai founder menjawab; `WFC_SALES_ENABLED` tetap false.
- W1 mulai sesudah F0 mendarat (berkas `env.ts`, `facility.ts`). Migrasi W1: 0526, W4: 0527 (konfirmasi ke CTO saat mulai).
- Kursi WFC hanya diterbitkan sesudah lunas terkonfirmasi; tidak ada jalur tender kasir di rilis 1.
- Founder (25 Nov malam): WFC harus menjaga penjualan makanan/minuman, biaya, dan target okupansi. Default bagian 6 no. 2 (tanpa minuman) DITANGGUHKAN: PRD 871 memuat minuman. Usulan CTO yang dikirim: kredit makan/minum hangus hari itu (lewat voucher F4), jam sepi vs sepanjang hari, kuota kursi per jam, no-show melepas kursi, pagar laba kotor per jam-kursi. Menunggu jawaban founder dan angka bisnis; W1 jangan mulai skema produk sebelum dijawab, lalu architect menghitung ulang jam.
