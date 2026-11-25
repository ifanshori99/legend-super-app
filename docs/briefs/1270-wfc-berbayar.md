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

# Revisi keputusan 28 (brief 1270)

Bukti API relatif ke `/Users/ifanshori99/Projects/legend super app/legend-rc1/apps/api/src`. Hanya dibaca, tanpa test. Jam adalah estimasi.

**Rekomendasi:** rilis 1 berisi kredit sebagai tender baru, config dan harga terendah, kuota per jam, jam sepi/sepanjang hari, no-show, dan laporan mingguan. Alat usulan AI (W13) menyusul. Total 86 → **135 jam**, atau 145 dengan AI, belum termasuk review K. Penjualan tetap mati sampai W1b, W11, dan W12 masuk serta jawaban pajak ada.

## 1. Kredit makan/minum
- Harga = `seat_fee_idr` + `credit_idr`, dikunci di penjualan (CHECK jumlah). Seluruh pembayaran masuk `customer_deposit`. Biaya kursi diakui saat slot mulai.
- Kredit adalah ledger append-only (`grant/redeem/restore/expire`). Aktif setelah check-in. Syarat: member, outlet, dan hari bisnis sama; hanya F&B; boleh beberapa order. Tanpa uang tunai, kembalian, atau poin dari porsi kredit.
- Pemakaian lewat tender **`wfc_credit`**: Dr `customer_deposit`, order dipajaki harga penuh. Kredit tidak dipajaki saat pass dijual, jadi tidak dobel (menunggu konsultan).
- Potong di cloud dulu, pola F1/F3 (`services/pos-points.service.ts`, `edge/benefit/points.ts`). Timeout = bill terkunci sampai status jelas.
- Offline: kredit ditolak, tamu bayar biasa. Gagal karena gangguan: catatan Finance, tanpa uang otomatis.
- Hangus: tidak diakui pendapatan di rilis 1. Tetap di `customer_deposit`, ditahan dari refund.
- Refund pass hanya sebelum mulai (kredit utuh, penuh). Salah outlet setelah mulai: Finance manual, maksimal total − kredit terpakai. Tahan di `refundableBalance` (`services/payment-admin.service.ts:89`) dan `createRefund` (:591).
- Void order: kredit kembali sekali, hanya hari itu; lewat hari ditahan Finance. Chargeback/refund provider membekukan pass dan sisa kredit.
- Ditolak: voucher F4 (`services/crm-promo-engine.ts:262-281`) karena diskon menurunkan omset dan pajak, dan F4 calon dipotong. DP F5 ditolak karena terikat reservasi/sesi meja.

## 2. Config dan harga terendah
- `wfc_business_settings`: per outlet, berversi, append-only, `effective_from`, pengusul ≠ penyetuju, izin khusus. Isi: kursi total/WFC, jam buka, biaya tetap, target omset/laba/okupansi, belanja per orang dan % modal, lama duduk (default 1 jam).
- Angka awal dari `tables.capacity` (`db/schema/floor.ts:127`), `avg_ticket`, `avg_dwell_minutes`, dan `hpp-report` hanya saran; tetap harus disetujui.
- Belum lengkap: 409 `WFC_CONFIG_INCOMPLETE`.
- Simbol: F biaya tetap, L target laba, R target omset, c modal bahan, S kursi, H jam buka/bulan, o okupansi, A belanja/orang, d lama duduk.
```
M  = max(F + L, R × (1 − c))
B1 = M / (S × H × o)          B2 = A × (1 − c) / d
lantai ramai = max(B1, B2)    lantai sepi = max(B1, B2 × o)
kontribusi per jam = (kursi bersih pajak + kredit × (1 − c) − biaya gateway) / jam
```
- BigInt, lantai dibulatkan ke atas ke Rp1.000. Kasus terburuk: kredit habis, semua jam dipakai, semua kunjungan bulanan dipakai. Slot campuran: lantai ditimbang per jam.
- Contoh rekaan: F+L 150 jt, S 60, H 420, o 50% → B1 ±Rp11.905. A 60 rb, c 35%, d 1 → B2 Rp39.000. Dengan d=1, day pass 12 jam penuh perlu kontribusi ±Rp468 rb, jadi praktis tak terjual. Lama duduk nyata perlu diisi.
- Ditegakkan oleh satu fungsi `packages/shared/src/wfc/pricing.ts`: simpan/aktifkan produk (422), hold (baca ulang versi), eksekutor AI. Penjualan menyimpan `settings_version_id`, lantai, kursi, dan kredit. Pass terjual tidak berubah.

## 3. Kuota, jenis, no-show
- Kuota per hari dan jam, kosong = 0, ≤ kursi WFC. Dicek di bawah advisory lock outlet+tanggal untuk tiap jam slot, menghitung ketiga produk. EXCLUDE per kursi tetap.
- `off_peak` harus seluruhnya di luar `wifi_policies.peak_schedule` (`isPeakAt`, `packages/shared/src/facility/wifi.ts:36`). `all_day` bebas. Bulanan hanya sepi, kredit per kunjungan.
- No-show 30 menit (config): status `no_show`, kursi lepas dari EXCLUDE, uang tidak kembali. Datang telat: tanpa jaminan kursi, kredit hari itu masih berlaku. Tak dijual ulang bila sisa waktu < durasi produk.
- Lepas otomatis hanya bila tautan edge sehat sepanjang 30 menit; selain itu staf menekan lepas. `last_heartbeat_at` (`db/schema/edge-node.ts:102`) hanya nilai terakhir, jadi sweep harus mencatat celah. Check-in vs lepas: row lock.
- Minimum belanja tetap untuk tamu tanpa pass. Pemegang pass aktif dikecualikan dari pengingat (`services/wfc-min-spend.service.ts`).

## 4. Saran AI (W13)
- Tambah TL-22 `draft_wfc_scheme` di `packages/shared/src/ai/{ids,tools,tool-io,schemas}.ts` dan `proposer("TL-22")` di `services/ai-tools/write/index.ts` (handler hanya mengusulkan).
- Di `services/ai-action-request.service.ts`, tambah kasus `moduleAction: "price_change"` seperti TL-17. `pickApprovalAction` (:356) memilih kebijakannya.
- Eksekutor baru `services/ai-action-executors/wfc-scheme.ts` memanggil service yang sama dengan perubahan manual, tanggal depan, sekali per actionRequestId. Cek juga CHECK `tool_code` di `db/schema/ai.ts`.
- Baca okupansi: perluas `ai-tools/read-b/tl-20-facility-utilization.ts`. AI tidak mengubah lima angka; itu manual + orang kedua.

## 5. Kartu dan urutan
| Kartu | Jam | Isi/perubahan |
|---|---|---|
| W1 (0526) | 8→11 | kursi/kredit, jenis, kuota, tabel config |
| W1b baru, K | 8 | rumus, `services/wfc-settings.service.ts`, `routes/wfc-admin.routes.ts`, approval |
| W2 | 14→16 | kuota, cek lantai, snapshot |
| W3 | 14→16 | tahan kredit di refund |
| W4 (0527) | 8→9 | sepi saja, kredit per kunjungan |
| W5 | 5→7 | no-show, kesehatan edge |
| W6 | 4→6 | + pengecualian minimum belanja |
| W7 | 5→7 | mockup: kredit, config, kuota |
| W8 / W9 | 12→13 / 10→13 | pelanggan / admin |
| W10 | 6→8 | e2e, laporan mingguan |
| W11 baru, K (0528*) | 16 | ledger, tender, command F1, jurnal, restore |
| W12 baru | 5 | UI kasir (bareng F10) |
| W13 baru, K (0529*) | 10 | AI; potongan pertama |

*Nomor diusulkan, konfirmasi CTO.

W11 menyentuh `db/schema/pos-order.ts:299`, `packages/shared/src/pos/{events,schemas,calculations}.ts`, `packages/shared/src/payment/index.ts`, `edge/order-ingest.ts` (:404, :609), dan di `services/`: `pos-order-payment.ts`, `pos-order-corrections.ts`, `pos-order-ports.ts`, `order-issue-manual-refund.ts`, `missions.service.ts`, `point-ledger.service.ts`, `accounting-auto-journal-{amounts,consumer,guards}.ts`. Satu penulis per file bersama F1/F3/E9.

Urutan: F0 → W1 + W7 → W1b → W2 → W3, W4, W5, W6, W8, W9 (UI setelah W7 disetujui) → W11 (setelah F1, F2, F3, E9) → W12 → W10. W13 boleh setelah W1b, paling akhir.
Potong bila telat: W13, otomasi laporan, W6 (kecuali pengecualian minimum belanja), lalu W4 (izin founder). Jangan potong W1b, W2, W3, W11, W12.

**Risiko:** +49 jam di atas ±500 jam tersisa, sedangkan perkiraan sudah lewat freeze 6 Des. W11 tertahan F1/F2/F3/E9. Salah input config menggeser lantai (perlu orang kedua).

## 6. Test wajib
- Kredit: dua kasir/timeout/retry = satu potong; POST telat ditolak; non-F&B, outlet/hari/member lain, belum check-in, hangus, offline ditolak.
- Uang: void kembali sekali, bukan tunai; diterima = refund + kursi (diakui/ditangguhkan) + kredit terpakai/sisa/hangus; pajak = order tunai; tanpa poin; chargeback membekukan.
- Lantai: kurang Rp1 ditolak di simpan, hold, eksekutor AI; config kosong; balapan ubah config vs hold; pass lama tetap.
- Kursi: kursi terakhir diperebutkan tiga produk; batas sepi dan tengah malam; check-in vs no-show; edge mati tak lepas otomatis; jual ulang tak dobel.
- AI: pengusul tak bisa menyetujui; ditolak/kedaluwarsa tak jalan; replay sekali; akses dicabut gagal; tak menembus config kosong.
- Minimum belanja: pemegang pass tidak diingatkan, tamu lain diingatkan.

## 7. Pertanyaan founder
1. Ke konsultan pajak (1 Des): pajak biaya kursi dan kredit hangus? Default: penjualan mati, hangus tidak diakui.
2. Bila F3/E9 telat, boleh jual pass tanpa kredit? Default: tidak.
3. Bulanan berisi kredit kecil per kunjungan? Default: ya, hangus hari itu.
4. Siapa penyetuju kedua harga/skema? Default: GM bila Owner mengusulkan, Owner bila GM.

### Keputusan CTO atas revisi (26 Nov)

- Diterima. Bagian ini mengalahkan bagian 1-6 bila berbeda. Rilis 1 = W1-W12 tanpa W13 (founder: "nantinya"); W13 sesudah rilis kecuali founder minta.
- Migrasi: 0526 W1, 0527 W4, 0528 W11, 0529 W13. Default pertanyaan 2 (tidak jual tanpa kredit), 3 (ya), 4 (GM/Owner silang) dipakai sampai founder mengubah.
- Rumus: lama duduk `d` wajib diisi nyata; default 1 jam membuat day pass ramai praktis tak terjual (aman, sengaja).
