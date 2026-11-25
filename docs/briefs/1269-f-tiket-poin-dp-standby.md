# F. Tiket, poin, voucher, DP, standby di edge

Dibaca statis di `legend-rc1` f9dea5f98; tidak ada test dijalankan. Path relatif `/Users/ifanshori99/Projects/legend super app/legend-rc1/apps/api/src` kecuali disebut. Jam adalah perkiraan.

## Keputusan
1. **Satu jalur perintah edge->cloud.** Inti proksi dikeluarkan dari E9 menjadi F1; `edge/payment-proxy.ts` (E9) tinggal jenis `payment.*`, F menambah `member.*`, `points.*`, `promo.*`, `deposit.*`.
   - Edge menyimpan perintah (ULID, isi beku) dan mengunci tagihan sebelum kirim. Cloud mengeksekusi sekali per ID.
   - Tanpa jawaban: tagihan terkunci, edge hanya boleh tanya status ID itu. Status "tidak ada" menulis nisan, jadi POST telat ditolak.
   - Cloud hanya menerima node primary aktif dengan instance cocok.
2. **Poin/voucher/kode: cloud memotong dulu, edge memakai hasilnya.** Offline ditolak.
   - Satu jalan keluar saat putus: supervisor (PIN) "batalkan potongan", tercatat permanen di edge sebagai batal. Tamu membayar penuh; cloud mengembalikan poin/kuota setelah event edge tiba. Aman karena belum ada uang masuk. Tidak berlaku untuk QRIS/VA/e-wallet.
3. **DP diklaim online saat tamu duduk, lalu eksklusif milik sesi edge.** Sesudah klaim boleh dipakai offline; refund DP di cloud ditolak selama klaim terbuka. Klaim baru saat offline ditolak.
4. **Tiket: edge satu-satunya pemilik slot outlet beredge, online dan offline. Tidak ada kuota cloud/edge.** `holdFacilitySlot` hanya dipanggil penjualan kasir (`facility-pos-ticket-sale.ts:180`); booking tamu belum ada (legend-bzih ditunda). Cloud menolak menjual slot outlet beredge. Booking tamu kelak diteruskan ke edge dan ditolak saat edge putus. Ini membatalkan baris "tiket ditolak/proksi" di matriks E.
5. **Standby: replikasi streaming PostgreSQL di LAN + snapshot 15 menit sebagai cadangan.** Snapshot saja bisa kehilangan 15 menit penjualan, melanggar EDG-04. Standby tidak menjalankan aplikasi; promosi manual oleh manajer.
   - Commit sinkron. Standby mati >10 detik: turun ke async dengan alarm. Promosi dari masa async: tagihan terbuka terkunci sampai dicocokkan dengan cloud.

## Celah terbukti
- `EDGE_API_PREFIXES` (`edge/mode.ts:82`) tidak memuat `/api/pos/orders/:id/{customer,points,tickets}`: 404 di edge.
- `edge/order-ingest.ts` menerima tender `points` dan `paidDepositIdr` tanpa mencocokkan potongan atau klaim cloud, dan tidak menyimpan `tableSessionId`. DP terpakai tak terhitung, jadi bisa dipakai atau direfund dua kali. `tenderLineSchema` (`packages/shared/src/pos/events.ts:78`) tanpa ID tender.
- Efek ingest hanya jurnal dan earn (`deliverSaleEffects`); konsumen hak fasilitas ada di worker outbox (`worker-main.ts:418`). Paket dan minimum belanja dari sale edge tampaknya tidak terbit; buktikan dengan test.
- QR poin terikat tagihan yang ada di cloud (`member-points-redeem.service.ts` `loadBills`); tagihan terbuka edge tidak ada di sana. Kunci QR = secret cloud, jadi verifikasi tetap di cloud.
- Promo edge dengan kuota/anggaran sudah aman (`crm-promo-engine.ts:641`). `promotion_order_applications` tidak terlihat ber-FK ke `orders`, jadi redeem/release bisa dipakai dengan ID order edge (implementer cek trigger).
- Tabel sisa/kredit DP ber-FK ke `table_sessions` (`reservation-deposit-remainder.ts:67,132`); cloud belum punya applier sesi meja.
- Tabel fasilitas tidak ikut stream katalog. Kasir hanya menjual produk `single`. `customer_profile_id` tiket NOT NULL.
- Standby: role dari env (`edge/config.ts:45`), tanpa drain. Baris primary aktif hasil replika bentrok `edge_nodes_active_role_key`. Nomor struk terikat node+instance; run baru hanya dibuat cloud, jadi promosi offline tak bisa menjual.
- Job cetak menyimpan QR+PIN; trigger melarang isi diubah (`edge-print.custom.sql:30`).

## Kartu (migrasi: nomor dibagi CTO; perubahan skema, cloud dideploy sebelum edge)
- **F1 inti perintah** (Opus xhigh, 10; sesudah E2, sebelum E9; E9 14 -> sekitar 9). Baru: `packages/shared/src/edge/cloud-command.ts`, `db/schema/edge-cloud-command.ts`, `edge/cloud-command-{store,client}.ts`, `services/edge-cloud-command.service.ts`, `routes/edge-cloud-command.routes.ts`; ubah `edge/cloud-http.ts`, `routes/index.ts`.
- **F2 kontrak + ingest** (Opus xhigh, 8; sesudah B2, E3). `packages/shared/src/pos/events.ts`, `edge/order-ingest.ts`, emit di `pos-order.service.ts`. ID tender, sesi meja, cocokkan potongan/klaim; tak cocok = sale tetap masuk, potongan ditandai, alarm finance, tanpa potong kedua. Hak paket/minimum belanja sekali.
- **F3 member + poin** (Opus xhigh, 12; sesudah F1, F2, E9). `pos-points.service.ts`, `pos-points-restore.ts`, `pos-order-customer.service.ts`, `member-points-redeem.service.ts`, baru `db/schema/edge-open-bill.ts`, `edge/benefit/points.ts`; allowlist `edge/mode.ts`; gerbang tender `pos-order-payment.ts`.
- **F4 voucher/kode** (Opus xhigh, 12; sesudah F2, F3). `order-promo.ts`, `order-promo-port.ts`, `crm-promo-engine.ts`, `edge/promo-gate.ts`, baru `edge/benefit/promo.ts`. Item terkunci selama potongan aktif; ubah item = lepas lalu hitung ulang.
- **F5 DP** (Opus xhigh, 14; sesudah E1, F2, F3). `reservation-lifecycle.ts`, `reservation-deposit-{credit,remainder}.ts`, `reservation-refunds.ts`, `qr-order-ports.ts`, baru `edge/table-session-applier.ts`, `edge/benefit/deposit.ts`. Sisa DP dilepas hanya setelah event sesi tutup.
- **F6a iojd1 uang** (Opus xhigh, 6; mulai sekarang, sebelum E6). `pos-order-corrections.ts`, `facility-pos-tickets.ts`, `facility-door-check.ts`, `order-issues.service.ts`. Refund sesudah mulai ditolak; refund tiket wajib nilai penuh baris; tukar item dan tagihan campuran memakai hook tiket; PIN memakai HMAC.
- **F6b iojd1 cetak** (Sonnet, 4; sesudah A3). `edge/print/store.ts`, `db/schema/edge-print.custom.sql`, migrasi. Tiket: isi disegel, dihapus setelah selesai/gagal final; cetak ulang = kredensial baru.
- **F7 stream fasilitas** (Opus K, 8; sesudah E1, berkas sama). `packages/shared/src/edge/catalog-sync.ts`, `edge-catalog-{sync,apply}.ts`, `edge/catalog-puller.ts`. Fasilitas, area, unit, produk, jam. Status unit milik edge, tidak ditimpa.
- **F8 jual tiket di edge** (Opus xhigh, 12; sesudah F6a, F7, E2, F3 karena `edge/mode.ts`). `facility-pos-ticket-{sale,catalog}.ts`, `facility-{slots,units,config}.service.ts`, `facility-queue.service.ts`, `facility-door-check.ts`. Gerbang cloud untuk outlet beredge; tiket terbit hanya saat lunas.
- **F9 sinkron + refund tiket** (Opus xhigh, 12; sesudah F8, F2). Baru `edge/facility-ticket-applier.ts`, `edge/ticket-revoke-applier.ts`. Refund: edge mencabut kredensial dan membuktikan belum dipakai, baru cloud membayar; edge putus = refund menunggu. **E6 menolak tagihan bertiket sampai F9.**
- **F10 UI** (Opus ui, 8; mockup; sesudah E10, W2, F3-F8). Potongan terkunci, batalkan potongan, klaim DP, tiket offline.
- **F11a replikasi host** (Sonnet, 8; sesudah E8): `deploy/edge/**`.
- **F11b promosi** (Opus xhigh, 14; sesudah E3, F1). `edge/{config,runtime,db-link-store}.ts`, `edge-node.service.ts`, `edge-queue.service.ts`, baru `edge/promotion.ts`. Cabut baris primary lama, pindahkan outbox dengan ID event sama, term naik; EDC pending = `unknown`, cetak tak diulang. Boot wajib cek term ke unit lain atau cloud, atau PIN manajer "unit lain mati".
- **F11c nomor struk cadangan** (Opus K, 8; sesudah 1162). `pos-receipt.service.ts`, `edge-device-sync.ts`. Prefix per perangkat disiapkan online, terikat node+instance standby, tersimpan di DB yang direplikasi, sekali pakai.
- **F11d 49e8n** (Sonnet, 3; sesudah F11b): `edge-reconciliation.service.ts`, `edge-txn-ledger.service.ts`. **F11e drill <=15 menit** (Sonnet, 6). **F12 e2e offline tiket/poin/DP** (Sonnet, 8, terakhir).

Urutan: F6a -> (F1, F7, F11a, F11c) -> F2 + F11b -> E9 -> F3 -> F8 -> F9 -> E6; F4, F5 sesudah F3; lalu F10, F11d/e, F12. Satu agent per `edge/mode.ts` dan `pos-order-payment.ts` pada satu waktu. Total 153 jam, sekitar 148 bersih setelah E9 mengecil.

## Test wajib
- Jawaban hilang/ganda/telat di tiap hop poin/kode/DP: satu potongan, satu tender; nisan menolak POST telat.
- Dua outlet memakai saldo/kuota terakhir bersamaan: satu menang. Batal lalu jawaban telat: poin kembali sekali, tender tidak hidup lagi. Void: kembali sekali.
- `order.paid` ganda atau tender poin/DP palsu: tanpa potong kedua, alarm. DP terklaim tak bisa direfund; sisa DP + terpakai = DP.
- Dua kasir, satu slot, offline: satu tiket. Cloud ditolak menjual. Tanpa stream fasilitas/harga cocok: ditolak. Belum lunas = pintu ditolak.
- Refund vs scan bersamaan: salah satu menang, tak pernah dipakai dan dibayar kembali. Edge putus: refund menunggu. Tenant/outlet lain dan node dicabut ditolak.
- Cabut listrik primary di tengah tunai/EDC/poin: tak ada sale lunas hilang, nomor unik, event ganda dilewati, primary lama kembali tak bisa menjual, <=15 menit.

## Risiko
- Dua unit hidup tanpa LAN dan internet: pagar terakhir hanya konfirmasi manusia. Wajib latihan.
- Kehilangan data pada masa async; ditahan oleh kunci tagihan dan alarm.
- Node rusak permanen: potongan poin/DP yang belum ditutup tertahan sampai rekonsiliasi Owner/Finance.
- Waktu kurang: potong F4, lalu F3. F8, F9, F11 jangan dipotong (PRD P0).

## Perlu founder
1. Tiket offline untuk tamu tanpa akun member? Usul: boleh, tanpa nama (profil sistem "Tamu kasir", di luar CRM/poin). Jika tidak, hanya member yang sudah dilampirkan saat online.
2. PRD 637 juga meminta paket dan langganan di kasir; itu belum ada dan **tidak** masuk 148 jam. Usul: rilis 1 tiket sekali masuk saja.
3. Vendor smart lock (legend-3dm8, 2ke) ditunda: bukti "membuka pintu" FAC-03 belum mungkin; sementara staf cek QR/PIN dan kunci mekanik.
4. Unit kedua mini PC + UPS harus tersedia sebelum F11e.

## Catatan CTO (25 Nov)

- Rancangan diterima. Jalan paling membatasi dipakai sampai founder menjawab: tiket offline hanya untuk member yang sudah dilampirkan; paket dan langganan tidak masuk rilis 1; kunci pintu diperiksa staf.
- Nomor migrasi dibagi CTO saat kartu mulai. `edge/mode.ts` dan `pos-order-payment.ts`: satu agent pada satu waktu.
- Tiap kartu Opus xhigh direview satu architect. F6a boleh mulai sekarang, tidak bergantung kartu lain.
- Bead: lihat anak legend-osqou.33.

## Perubahan 25 Nov malam (keputusan founder 26)

- Kamar mandi berbayar ditunda sesudah rilis 1: F6a (WIP diparkir di `ws/1269-f6a`), F6b, F7, F8, F9 deferred; bagian tiket di F2, F10, F12 dan penolakan tiket di E6 gugur (cukup: edge dan cloud menolak tiket).
- Kartu baru **F0** (legend-osqou.33.18, Sonnet, 4 jam, mulai sekarang dari int/rc1 b61b245db): `FACILITY_TICKETS_ENABLED` default false di `config/env.ts` + `.env.example` + `deploy/single-vm/runtime.env.example`; server menolak (gagal tertutup, kode error jelas) jual tiket POS, hold slot, langganan, klaim/penukaran hak dan penerbitan hak dari paket/minimum belanja/tier/promo, sarapan tiket, antrean bilik; perangkat edge juga. Promo berhadiah shower tidak boleh aktif. Refund/pembatalan transaksi lama dan tombol darurat staf tetap jalan. Test lama mengaktifkan flag; test baru membuktikan mati = tak ada baris tertulis dan tak ada uang diterima. Web: satu konstanta bersama menyembunyikan menu dan menjadikan rute shower notFound (POS tiket, member fasilitas, /f, website fasilitas, papan bilik, kebersihan, insiden, laporan dan pengaturan fasilitas shower). Wi-Fi tamu dan kebijakan WFC jangan tersentuh.

## Keputusan CTO untuk F11b (dari review F11a)

- Standby tidak bisa tahu apakah primary sempat async sebelum mati (penandanya tidak mungkin tereplikasi). Karena itu setiap promosi dianggap "mungkin async": tagihan terbuka hasil replika terkunci sampai dicocokkan dengan cloud; penjualan baru boleh dengan nomor cadangan (F11c). Penanda di primary hanya untuk alarm.
- Pagar split-brain wajib di F11b: primary yang turun ke async memeriksa term di cloud (bila internet ada) dan unit lain (bila LAN ada) sebelum terus menjual; term lebih tinggi = berhenti menjual. Boot juga memeriksa. Tanpa keduanya: konfirmasi PIN manajer.
- Alarm async, slot WAL, dan primary lama masuk notifikasi pemilik.

- **Keputusan founder 27:** WFC berbayar wajib rilis 1. F0 hanya menutup fasilitas `type = 'shower'` (dan produk, rencana langganan, slot, hak, sarapan tiketnya); `coworking` tetap terbuka. Rancangan WFC menyusul (backend lama di `ws/bz9h-wfc-products` a73998a99).
