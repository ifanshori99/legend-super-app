# PROGRESS — Legend Super App

Diperbarui 2026-11-08 oleh CTO (coordinator Ghostex, sesi "CTO legend"). Founder menghentikan semua kerja untuk dilanjutkan di sesi baru.

## legend-eadm + legend-niq9 klasifikasi event edge ke cloud (engineer, cabang `ws/edge-event-class`, 2026-11-09)

- Reproduksi: di integ/m1-batch5 batch campuran tidak macet; legend-9fhs sudah memarkir event tak dikenal. Klaim stall legend-eadm tidak terbukti di basis ini.
- Sudah: `pos_override.*` dan `staff_pin.*` diparkir `deferred` (`registerAccessDeferredEdgeApplier`, runtime.ts blok registrasi saja). Event `unclassified` (termasuk `stock.*` selain `stock.moved`, niq9) kini memberi alarm ke supervisor outlet: sekali per nama event per outlet per 24 jam, dihitung dari `notification_outbox`, dalam savepoint (gagal alarm tidak menggagalkan batch).
- Test: `apps/api/src/test/edge-event-class.test.ts` (R, A, B, C, D). Semua 23 file `edge-*` lulus.
- Review K: reviewer Opus dan architect, dua kali re-review; temuan nyata dibetulkan.
- Berikut: legend-kyie (P1, cloud menerapkan event PIN dan override), legend-vw3d (kategori alarm sendiri), legend-tbl4 (index outbox, test tanpa supervisor). Brief second opinion: `docs/briefs/158-second-opinion-edge-event-class.md` (tidak di-commit).

## legend-9fhs event edge tidak lagi menghentikan sinkron ke cloud (engineer, cabang `ws/fix-9fhs`, 2026-11-09)

- Akar masalah: edge mengirim semua baris outbox `cloud-sync` ke cloud; cloud tidak mengenal aggregate POS (`order`, `cashier_shift`, `day`, `table_session`, `pos_override`, ...) sehingga `applyInbound` melempar `EdgeEventUnclassifiedError`, seluruh batch rollback, kursor tidak maju, `stock.moved` ikut tertahan selamanya. Direproduksi dengan test.
- Sudah: inbox cloud `edge_deferred_events` (migrasi `0103_edge_deferred_events`, `0104_edge_deferred_events_rls`). Aggregate WS-04 diparkir `deferred`; event edge->cloud lain yang tidak punya handler diparkir `unclassified` + log warn (fallback hanya arah edge->cloud, dipasang di cloud). Tidak ada outbox cloud, tidak ada potong stok, tidak ada jurnal. Idempoten per (tenant, event id).
- Test: `src/test/edge-order-deferred.test.ts` (15 kasus); 103/103 di 6 file edge.
- Lanjutan: legend-078n (applier pesanan POS isi ulang dari inbox, urut `aggregate_id, aggregate_sequence`, tanpa potong resep lagi), legend-3owf (transport edge dan event tanpa outlet), legend-niq9 (stock.* diparkir tanpa alarm).

## Sudah

- Benchmark order pelanggan ESB + Richeese vs Legend: `design/benchmark/REPORT.md` (14 celah), `design/REFERENCES.md`. Cabang `ux/customer-order-benchmark`.
- Keputusan founder:
  - Q3: "Bayar di kasir" boleh (kode ke kasir, pesanan masuk dapur setelah kasir terima uang).
  - Q4: arah A (katalog foto).
  - Q5: jumlah tamu inline di bar atas menu, wajib sebelum item pertama, tanpa jendela sambutan.
  - Founder minta gaya liquid glass; menilai versi lama "AI slop dan jadul".
- Mockup final arah A + liquid glass: `design/mockups/final-a-*.png` (9 mobile + 1 desktop), README berisi usulan perubahan `DESIGN.md`. Commit `b52b03b`.
- legend-18qw (worker event transport, gap replay, adapter notifikasi Brevo): commit `b22d549` di `ws/worker-transport` (worktree `.worktrees/worker-transport`). pnpm check hijau. Bead sudah di-close engineer.
- Review legend-18qw: reviewer Claude (tanpa blocker) + second-opinion Codex (2 major). Semua temuan: `docs/briefs/06-fix-review-worker-transport.md`.

## Fix edge Codex 108 (engineer, cabang `ws/fix-edge-codex`, worktree `.worktrees/fix-edge-codex`, 2026-11-09)

- legend-ddoy (P1): klaim source stok edge atomik. `lockStockSource` (advisory xact lock per tenant, source_type, source_id) diambil sebelum lock lokasi, lalu cek outlet lain membaca baris ledger dan dokumen sumber cloud (5 tabel, Drizzle bertipe). Test race PG deterministik via `pg_locks` (`inventory-edge-source-race.test.ts`).
- legend-12ku (P2): link-server mereservasi slot gagal-auth per IP sebelum `await authenticate` (`fixed-window-counter.reserve/release`); sukses, error cloud, dan 429 mengembalikan slot.
- legend-aor4 (P2): limiter bootstrap edge per IP (30) dan per credential (10) sebelum verifikasi credential (`createEdgeBootstrapRouter`).
- Tingkat K: reviewer Opus + architect, temuan dibetulkan. Second-opinion Codex belum (brief `docs/briefs/second-opinion-fix-edge-codex.md`, antrean CTO).
- Follow-up bd: posting stok cloud-local tanpa klaim source; koneksi kedua saat lock dipegang (pool).

## Brief 88 persiapan deploy (engineer, cabang `ws/deploy-prep`, worktree `.worktrees/deploy-prep`)

- legend-jtnd: peran migrator production `legend_migrator_<16 hex>` (NOSUPERUSER, BYPASSRLS, CREATEROLE, pemilik database), dibuat sekali oleh superuser bootstrap lewat `deploy/single-vm/provision-roles.sh --env-file ... --migrator` (`apps/api/src/db/migrator-role.ts`). Peran aplikasi dan queue tidak berubah (NOBYPASSRLS).
- legend-k1np: cek pra-deploy `node dist/predeploy-check.js` (`apps/api/src/db/predeploy-check.ts`), jalan sebelum migrate di `deploy.sh` dan provisioning first boot. Gagal bila migrator tidak bisa migrasi atau ada stream outbox yang sekuensnya bukan 1..N per tujuan.
- Runbook: `docs/deployment.md` ("Create the migrator login", "Pre-deploy check").
- Review: reviewer Opus + architect, semua temuan nyata sudah dibetulkan. Follow-up pra-ada: issue bd backup login `postgres`.
- Belum: test DB terakhir dan `heavy pnpm check` belum hijau karena forwarding port Colima untuk container baru mati (ECONNREFUSED), bukan karena kode. Jalankan ulang setelah Colima dipulihkan. Second-opinion Codex (tingkat K) masih perlu diantre CTO.

## legend-9w46 HPP penjualan POS ke stok (engineer, cabang `ws/hpp-pos`, 2026-11-09)

- Sudah: ws/recipe-bom (legend-db6) digabung ke cabang ini di atas m1 fb46602d; migrasi resep diregenerasi jadi 0103_recipe_bom + 0104_recipe_bom_rls. Penjualan POS lunas (`order.paid`) memotong stok lewat resep → `stock.moved` → jurnal HPP (Dr HPP / Cr persediaan).
- Sudah: void final setelah bayar membalik potongan stok sekali (gerakan `return/order` pada biaya asli per baris, jurnal HPP terbalik persis). Refund (penuh maupun sebagian) tidak menggerakkan stok (keputusan CTO 9 Nov 2026: makanan sudah dikonsumsi). Void sebelum pembayaran: tidak ada. Pembalikan yang ditolak aturan stok diparkir (`reversal_failed_at`) dan dicoba ulang saat `day.closed`.
- Test: `src/test/recipe-pos-hpp.test.ts` 10 kasus (jalur POS asli, replay, biaya asli, refund tidak menggerakkan stok, void final, tutup hari, tombstone, remake tidak ikut, parkir+ulang).
- Keputusan: hanya void yang membalik stok (CTO, 9 Nov 2026). Lanjutan: legend-078n, legend-9fhs.

## legend-5gub PAN lama di data EDC (engineer, cabang `ws/edc-pan-scrub`, 2026-11-09)

- Sudah: migrasi data `0113_edc_pan_scrub` menyamarkan nomor kartu di baris lama `edc_transactions` (card_type, rrn, invoice_no, batch_no, dispatch_batch_no, message, masked_pan), ambang sama dengan filter tulis; idempoten, baris bersih dan jumlah/status tidak berubah; `lock_timeout` 5 detik. `message` juga disamarkan saat dibaca. Log EDC diperiksa: tidak ada data kartu. Runbook `docs/runbooks/edc-pan-scrub.md`.
- DB dev lokal baru 54 migrasi (tabel EDC belum ada): 0 baris terdeteksi, tidak membuktikan apa-apa. Deteksi perlu dijalankan di staging, pilot, dan tiap node edge.
- Review K: reviewer Opus 2x dan architect, temuan sudah dibetulkan. Second opinion Codex: antre, brief 150.
- Berikut: merge train meregenerasi nomor migrasi.

## Sedang

- (kosong selain thread di bawah)

## Sesi CTO baru (2026-11-08, lanjutan)

- SELESAI fix review legend-18qw (brief 07): `ws/worker-transport` = `262d012` (amend WIP). 9 fix + 3 temuan reviewer subagent dibetulkan. `heavy pnpm check` hijau (1192 test), build hijau, format/color/tenant-hardcode lulus. `legend-3a0y` ditutup. Bead baru: `legend-7h5s` (edge tanpa cloud-sync tenant-wide), `legend-z649` (healthcheck worker), `legend-k1np` P1 (cek backfill sequence sebelum deploy), `legend-j75w` P2 (alert terthrottle auth Brevo). Sisa risiko: dedup Brevo belum dites ke Brevo asli (tunggu `legend-wwuc`); at-least-once bila retry >30 menit. Biaya sesi engineer: ~933k (Opus 668k, Haiku 151k, Sonnet 114k).
- SELESAI riset warna (brief 08, Codex): `design/COLOR-RESEARCH.md`, 10 `final-a-*` ditimpa, palet CTA #A83A17 / canvas #FAF6F0 / tinta #2B211B, upsell croissant opsional, 87 pasangan kontras lolos AA. Commit `13606fe` (sebagian artefak ikut tersapu commit CTO `b76fc75`; riwayat dibiarkan). Dikirim ke founder sebagai Q3 (setuju / ubah).
- Founder Q2: merge disetujui. `main` = `b0695ba` (merge --no-ff `ws/worker-transport`, tree identik `262d012` yang sudah hijau). Cabang + worktree worker dihapus.
- Founder Q3: mockup warna baru DISETUJUI.
- Thread "UI order pelanggan QR" (brief 09, `legend-2re1`): worktree `.worktrees/customer-order-ui`, cabang `ui/customer-order` (ux/customer-order-benchmark + main).
- Thread "Provisioning role DB first boot" (brief 10, `legend-zoqc`): worktree `.worktrees/db-role-provisioning`, cabang `ws/db-role-provisioning` dari main. Review: reviewer Opus tanpa blocker; second-opinion Codex 5 Tinggi (override identitas via query URL pg, override env file Compose, pg_default_acl, grant per kolom, rahasia bocor di error Compose). Fix: brief 12, engineer sama.
- Founder: metode bayar web = QRIS, VA, E-wallet, Kartu kredit/debit (+ bayar di kasir); kasir = semua + EDC. Diteruskan ke thread UI.
- Founder: minta lebih banyak agent paralel. Mulai 3 engineer: legend-6c0 shift (`ws/pos-shift`, brief 13), legend-93a struk (`ws/pos-receipt`, brief 14), legend-zinn+wg5t edge (`ws/edge-hardening`, brief 15). Migration bisa bentrok nomor: merge berurutan, generate ulang di cabang belakangan.

- Mockup POS kasir 21 layar (`design/mockups/pos/`, commit `3e09560`, brief 17) DISETUJUI founder Q10. Q7 DP lebih jadi saldo; Q8 blind count per pecahan; Q9 tutup hari manajer outlet, cutoff 04.00. Diteruskan ke thread shift dan fix pembayaran.
- zoqc: second-opinion putaran 2 = 3 Tinggi + 2 Sedang baru (PUBLIC baseline katalog, BOM/NBSP env, RLS tabel tenant tak diaudit, sequence ACL, docs ganti login queue). Fix: brief 18.
- Berikutnya saat slot Claude kosong: ui-engineer POS kasir dari `design/mockups/pos/`, engineer KDS legend-4d5, engineer EDC legend-m0k.

## legend-hggk cuti, saldo, libur, lembur (engineer, cabang `ws/hris-leave`)

- Selesai (BE, PRD §3 "29. Cuti, Izin & Lembur", F27): 7 tabel baru (`leave_types`, `leave_balances`, `leave_accruals`, `leave_requests`, `holidays`, `overtime_formulas`, `overtime_requests`), migrasi `0063`/`0064` (RLS tenant semua tabel, RLS outlet untuk `leave_requests`/`overtime_requests`). Service + route `/api/hris/leave/*`, `/api/hris/holidays*`, `/api/hris/overtime-*`.
- Keputusan: saldo dikunci per baris (`FOR UPDATE`) + advisory lock per karyawan, saldo minus hanya sampai `policy.negativeAllowanceDays`; akrual/carry-over/kedaluwarsa idempoten lewat buku `leave_accruals`; persetujuan lewat matriks (`openApprovalRequest`, consumer `approval.resolved` di worker, settle idempoten); hari libur tidak memotong saldo; rumus lembur berversi (`overtime_formulas`, dipin per pengajuan), upah lembur integer IDR via `computeOvertimePay`, batas 720 menit/hari; kontrak saldo boleh minus, keputusan sistem (kedaluwarsa) `decidedBy` null.
- Bukti: `heavy pnpm check` 1284 lulus / 1 skip (138 berkas), `heavy pnpm build`, `pnpm format:check`, color, tenant-hardcode lulus. 3 putaran reviewer subagent, temuan nyata dibetulkan (urutan lock, idempotensi, batas lembur 720 menit/hari, tarif hari dipilih karyawan tampil di inbox, tanggal WIB, keputusan sistem tanpa pemutus).
- Biaya sesi engineer (d11154ca, 12:23–13:07 UTC, 0 compact, 22 subagent): Opus utama 2016k, Sonnet 5084k, Haiku 106k; total 7205k unit biaya. Vendor: Claude saja (8 implementer/test-writer paralel di gelombang 1).
- Lanjutan: `legend-arj.1` (jadwal job akrual), `legend-arj.2` (jenis hari lembur dari jadwal), `legend-arj.3` (batal cuti setelah carry-over kedaluwarsa), `legend-arj.4` (URL lampiran + event `leave.approved`).

### legend-arj.1 / .3 / .4 + keputusan founder Q7 cuti bersama (engineer, `ws/hris-leave`)

- arj.1: `services/hris-leave-jobs.ts` `runScheduledLeaveJobs` dipanggil dari sweep worker tiap tenant. Urutan: potong cuti bersama, akrual bulan berjalan, carry-over tahun lalu, kedaluwarsa carry-over, semua tanggal WIB. Penanda harian `hris_idempotency` `leave-jobs/YYYY-MM-DD` (tanda `/` agar tidak bisa dipalsukan lewat Idempotency-Key pengguna), ditulis hanya bila semua langkah sukses. Aktor sistem (audit `system`, ledger `createdBy` null); jalur HTTP tetap sama.
- arj.3: melepas hari (tolak/batal/kedaluwarsa) setelah tanggal kedaluwarsa carry-over memotong carry-over ke sisa terpakai, audit `hris.leave_carry_over.forfeited`.
- arj.4: event `leave.approved` ke outbox `cloud-sync` saja (adapter notifikasi menolak nama tak dikenal), dalam transaksi yang sama, sekali per pengajuan, tanpa alasan/lampiran. Lampiran: `attachmentUploadRef` = objek `core_storage_objects` purpose `document`, outlet rumah pemohon, umur ≤ 24 jam, belum dipakai dokumen karyawan atau pengajuan lain (indeks unik `leave_requests_tenant_attachment_key`). URL bertanda tangan lewat `HrisFileSigner` (`createHrisLeaveRouter({ fileSigner })`), hanya untuk pemohon/HR/penyetuju, audit `hris.leave_request.attachment_url_issued`.
- Q7 (founder): tabel `hris_leave_settings` per tenant (`collective_leave_deducts_annual` default true, `annual_leave_type_id`, `collective_leave_effective_from`), `GET/PUT /api/hris/leave/settings`. Cuti bersama memotong 1 hari saldo cuti tahunan (ledger `collective_leave`, unik per karyawan+tanggal, tidak dipotong ulang bila jenis cuti tahunan diganti), dilewati bila tanggal itu juga libur nasional/perusahaan. Lembur di hari cuti bersama = tarif hari kerja; libur nasional/perusahaan tetap tarif hari istirahat.
- Default aman, menunggu founder: potongan cuti bersama berlaku untuk tanggal ≥ 2027-01-01 (tidak mundur ke 2026). HR bisa mengubah lewat setelan.
- Migrasi putaran ini sudah diganti di brief 85 (lihat bawah).
- Review: reviewer (4 temuan) + architect (2 temuan + 1 keputusan founder) dibetulkan; review ulang bersih.
- Bead baru: `legend-fgob` (migrasi vs main), `legend-ei32` (balik potongan cuti bersama), `legend-2ect` (signer storage produksi), `legend-0pth` (pengunggah objek storage), `legend-qmte` (cuti bersama vs absensi).
- Biaya putaran ini (d11154ca, 13:07–14:14 UTC, 1 compact, 14 subagent): sekitar 5951k unit biaya (total sesi 13156k). Vendor: Claude saja.

### Brief 85: perbaikan review Opus (engineer, `ws/hris-leave`)

- Item 1: job cuti bersama melewati pasangan karyawan+tanggal yang sudah dihitung pengajuan cuti pending/disetujui (jenis apa pun). Pengajuan menyimpan `excluded_holiday_dates` saat diajukan, sehingga job tahu hari mana yang sudah dihitung walau kalender berubah sesudahnya.
- Item 2: lewat tanggal kedaluwarsa, carry-over yang tidak dipegang hari terpakai/pending tidak bisa dipakai (`usableCarriedOverDays`), job kedaluwarsa menghanguskan `carried − (used+pending)` walau ada pending. Pengajuan baru menghanguskan carry kedaluwarsa di saldo terkunci sebelum cek sisa. Job cuti bersama menghanguskan carry dulu untuk hari pada/sesudah tanggal kedaluwarsa, lalu menambah hari terpakai. Test skenario 30 Mar / 1 Apr / 2 Apr.
- Item 3: hapus/pindah/ubah jenis libur cuti bersama membalik potongan (idempoten, diaudit, kunci per tanggal). Lewat tanggal kedaluwarsa, pembalikan memotong carry ke yang masih terpakai dan mengaudit `hris.leave_carry_over.forfeited`. Bead `legend-ei32` ditutup.
- Item 4: membuat/memindah cuti bersama ke tahun yang carry-over-nya sudah jalan ditolak 422 `LEAVE_YEAR_CARRIED_OVER`.
- Item 5: `milestone/m1` digabung. Migrasi cabang lama dibuang (`0063_workable_shard` 1794141116246, `0064_hris_leave_rls` 1794141117464, `0065_hris_leave_settings` 1794143913551, `0066_hris_leave_settings_rls` 1794143923628, `0067_hris_leave_attachment_unique` 1794145347324, `0068_pink_bug` 1794145819981) dan dibuat ulang lewat drizzle-kit: `0072_hris_leave` 1794151260820, `0073_hris_leave_rls` (custom) 1794151270783, `0074_hris_leave_excluded_holidays` 1794151613858. Semua di atas kepala milestone `0071_stock_count_rls` 1794149399815. `0072` memasang cakupan tenant kosong + outlet `*` lokal transaksi di sekitar foreign key, karena pemeriksaan FK menjalankan kebijakan RLS saat pemilik tabel NOBYPASSRLS (test edge non-superuser). Bead `legend-fgob` ditutup.
- Bukti: migrasi lulus di DB kosong (75 migrasi) dan DB di kepala milestone (72 → 75), RLS aktif+paksa di 8 tabel HRIS. Gerbang penuh di `dbab69a2`: format, color, tenant-hardcode, `heavy pnpm check` 162 berkas / 1645 lulus / 1 skip, `heavy pnpm build` lulus. Reviewer konteks segar 2 putaran (3 temuan dibetulkan, review ulang bersih).
- Masih menunggu founder: potongan cuti bersama mundur ke 2026 atau mulai 2027-01-01 (default sekarang 2027-01-01, bisa diubah HR).
- Biaya putaran ini (d11154ca, 14:14–15:52 UTC, 2 compact, 45 subagent total sesi): sekitar 5239k unit biaya (total sesi 18395k). Vendor: Claude saja.

## legend-9yz procurement: perbaikan second-opinion architect (engineer, cabang `ws/procurement`, 2026-11-08)

- Sudah:
  - Tanpa policy approval, submit PR/PO sekarang 409 `APPROVAL_POLICY_MISSING`. Tidak ada lagi approve manual satu orang.
  - Revoke link, close, dan cancel PO menggagalkan email supplier yang masih antre.
  - Worker email kirim hanya untuk PO `sent`/`partially_received`. Retry memakai link yang sama. Provider dipanggil di luar transaksi DB, dengan lease 10 menit dari jam dinding.
  - Order dibaca dengan `FOR SHARE NOWAIT`, supaya worker tidak deadlock dengan revoke.
  - PDF publik menolak PO `closed`.
  - Kolom nominal PDF muat 10 digit.
  - Test 42501 untuk UPDATE/DELETE riwayat harga oleh `legend_app`.
  - Keputusan Q11: batal/tutup PO dan batal PR hanya pembuat atau pemegang `purchasing.order.approve` di outlet. Gerbang route menerima create ATAU approve; service tetap memutuskan.
- Keputusan teknis: PO `received` tidak lagi mengirim email antre (sesuai brief). Dedupe `reference` bergantung adapter Brevo (30 menit).

## legend-2re1 UI order pelanggan (ui-engineer, cabang `ui/customer-order`)

- Selesai di worktree `.worktrees/customer-order-ui`: semua layar `/t/$token/*` dibangun ulang ke tema QR (`[data-surface="qr"]`, palet Q6, kaca hanya di lapisan mengambang, maks 2 blur), jumlah tamu inline (Q5), "Bayar di kasir" (Q3) via route `/t/$token/kasir/$orderId`, satu saran pendamping. `DESIGN.md` §9 baru.
- Bukti: screenshot 390/1440 + axe di `docs/qa/customer-order/` (0 serious/critical, tanpa overflow, fallback kontras tinggi / tanpa transparansi = 0 blur). Review diff + ui-auditor + finish-reviewer: temuan dibetulkan.
- Pra-merge (founder setuju UI, Q11): checkout dengan kode promo/voucher kini menampilkan rincian dan total dari quote tanpa kode (yang benar-benar dibayar) dan menahan tombol bayar sampai quote itu ada (pesan + "Coba lagi" bila gagal), test baru `e2e/legend-2re1.mock.spec.ts`; lebar hero h16t per viewport (36 px di bawah lg karena padding sheet 16 px, 52 px dari lg); `QrFrameNotices` dipindah ke `glass/qr-frame-notices.tsx`, madge tanpa siklus; `design/**` diabaikan eslint dan prettier. Gate: `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, color, tenant-hardcode hijau; e2e `/t/` 35/35 (spec baru diulang 3x stabil).
- Koreksi founder 2026-11-08: metode bayar = QRIS, Virtual Account, E-wallet, Kartu kredit/debit, Bayar di kasir. VA dan Kartu ditambahkan di checkout + layar `/t/$token/bayar/$orderId?metode=va|kartu` (instruksi VA dengan nomor contoh, alih ke halaman kartu penyedia tanpa form kartu). Kontrak meja hanya menerima QRIS/e-wallet, jadi VA/Kartu hanya jalan di mode mock; dengan API asli barisnya nonaktif dan layarnya menampilkan "belum tersedia".
- Bukti akhir: `heavy pnpm build` lulus; e2e mock `/t/` 33/33; suite mock penuh 739 lulus, 4 gagal di luar `/t/` (d6g5, er32, oye8, uq2; diff cabang ini di luar QR hanya tambahan); capture 52 state, 0 serious/critical kecuali 1 artefak posisi scroll (target-size link tertutup bar atas saat capture), tanpa overflow, maks 2 blur.
- Biaya sesi ui-engineer (transkrip fe7d1815, 07:57–09:41 UTC, 2 compact, 19 subagent): Opus utama 6128k, Sonnet 5723k, Opus subagent 257k, Haiku 114k; total 12223k unit biaya.
- Kebutuhan kontrak (belum dikerjakan): metode bayar kasir / kode bayar eksplisit + POS terima pembayaran order tertahan; ubah pax sesi; foto cover outlet; patch opsi baris keranjang; kode promo/voucher ikut `placeOrder`; metode guest `va` dan `card` (nomor VA + channel + kedaluwarsa, URL halaman kartu penyedia di `guestPaymentSchema`).

## legend-b9i DOIT PaymentProvider (engineer, cabang `ws/doit-provider`)

- Adapter DOIT di belakang `PaymentGatewayPort`: QRIS, VA, transfer bank kode unik, daftar metode dari endpoint DOIT (cache 60 dtk), Bearer + `Idempotency-Key` di tiap POST, kredensial per tenant/outlet dari `tenant_integrations` (terenkripsi), gagal tertutup bila tidak ada. Port diperluas `ewallet`/`card` + `methods()` opsional, jadi gateway lain bisa menambah tanpa ubah kontrak.
- Webhook `POST /api/webhooks/payments/doit/:tenantId`: verifikasi `PayBridge-Signature` atas byte mentah, simpan dulu ke `gateway_webhook_events` (migration 0068-0069 setelah merge main 1f0b6d2, RLS), dedupe per event id, status payload sebagai kebenaran, terikat ke intent (provider ref + reference + nominal + integrasi penanda tangan). Uang yang tidak bisa dilunasi (intent gagal, nominal beda) dicatat sebagai dana belum teralokasi. Limiter hanya menghitung verifikasi gagal per IP.
- Polling cadangan + ulang event tersimpan: job worker `payment-gateway-poll.job.ts` (per outlet, anggaran 20 dtk, backoff waktu, window 24 jam), purge baris ditolak > 30 hari.
- Format wire DOIT (path, payload, header tanda tangan `t=,v1=`) masih ASUMSI di `payment-doit-wire.ts` sampai dokumen sandbox DOIT ada (legend-saov, legend-s5c).
- Brief subagent: `docs/briefs/sub-doit-provider.md`. Smoke test sandbox opsional `apps/api/src/test/payment-doit-sandbox.test.ts` (dilewati tanpa `DOIT_API_KEY` + `DOIT_SANDBOX_BASE_URL`).
- Metrik gelombang (17.22-18.03): biaya* sesi 6064k (Opus utama 1819k, Opus subagent 238k, Sonnet subagent 4007k), 20 subagent (Claude saja, 0 Codex), puncak konteks 228k, 0 compact. Satu review lagi menemukan 5 temuan setelah fix wave 1; dua gelombang perbaikan.
- Gate akhir (setelah merge `main` c9e0c62): vitest API 1436 lulus / 0 gagal; test root 1384 lulus (gabungan dua run, satu kegagalan `api-client` akibat symlink `node_modules` ke checkout utama, sudah dibuktikan lulus); build, format, color, tenant-hardcode lulus. Status: review CTO.
- Perbaikan review K (reviewer Opus + architect, 2026-11-08): kredensial DOIT dipilih dari outlet tagihan/intent (bukan cakupan pemanggil, termasuk cek DP reservasi); polling mencatat dana kurang/lebih bayar (409 AMOUNT_MISMATCH) sebelum expire, lewat `recordUnsettledGatewayFunds` bersama webhook; poller urut `gateway_polled_at` (kolom baru) supaya intent yang error tidak menahan yang lain; poller juga cek intent yang di-supersede tapi kodenya masih bisa dibayar di DOIT (dulu uang hilang bila webhook hilang); webhook gagal proses dijawab 500 agar DOIT kirim ulang; `readPaidAt` pakai `now`; cache secret webhook dikosongkan saat integrasi diubah; tanda tangan tidak sah dicatat satu baris penghitung per tenant per menit.
- Format wire DOIT kini mengikuti dokumen resmi https://doit.id/docs/en/ dan adapter 119connect yang sudah dipakai: base `https://pay.doit.id` (sandbox lewat key `pb_test_`), `POST /v1/payments` {amount, rail, va_bank, reference, expires_in}, `GET /v1/methods`, status pending/paid/refunded/expired/failed, nominal lunas = `amount` (tanpa `paid_amount`), hanya event `payment.paid`/`payment.expired` yang menggerakkan intent, toleransi tanda tangan 25 jam ke belakang / 5 menit ke depan (retry DOIT sampai 24 jam). Transfer bank kode unik dimatikan: API DOIT tidak mengembalikan rekening tujuan.
- Review ronde 2 (konteks segar): intent menyimpan `gateway_integration_id` (akun DOIT pembuat) untuk cek status dan pengikatan webhook; kiriman bertanda tangan sah tapi tak terbaca dijawab 500; kunci refresh memuat sisa tagihan; limiter per IP + tenant; cache secret dengan penghitung generasi. Review ronde 3: tidak ada bug jalur uang. Migration 0068 mengangkat FORCE RLS sementara (pola 0065) supaya pemilik tabel non-superuser bisa memvalidasi FK.
- Gate (2026-11-08): `heavy pnpm check` 1608 lulus, 3 gagal di test migrasi 0065 (FK 0068 di bawah FORCE RLS), lalu diperbaiki dan file terdampak diulang 136/136 lulus; `heavy pnpm build` dan `pnpm format:check` lulus; 3 warning eslint di kode web dari main. DB dev cabang ini yang pernah menjalankan 0063-0065 lama harus di-reset.
- Metrik sesi engineer (403a3ca9, 2 akun, 0 compact, 20+ subagent): Opus utama 2051k, Opus subagent 2961k, Sonnet 1534k, Haiku 96k; total biaya* 6641k (bagian setelah pindah akun).
- Brief 95 (second-opinion Codex atas 8fed84ef, 2026-11-09): P1 id intent deterministik UUIDv5(tenant + idempotency key), jadi retry setelah jawaban DOIT hilang atau insert lokal gagal memakai pembayaran DOIT yang sama (tanpa migrasi; 9a2a9fe8). P2 lewat kedaluwarsa, error gateway, DOIT masih `pending`, atau gagal simpan non-409 tidak lagi meng-expire intent: tetap `pending` (tamu melihat expired), ditanya ulang dengan backoff sampai 1 jam, tutup setelah 24 jam dengan audit `payment.reconciliation_timed_out` (858f2284, b80001ff). P3 `paid_at` DOIT ikut lewat polling, jadi bayar tepat waktu tidak ditandai `late_payment`.
- Review brief 95 (reviewer Opus + architect): `cancelPaymentLinkInTx` (kasir ganti tunai) tidak lagi meng-expire kode DOIT yang sudah lewat waktu dan menunggu jawaban; `paid_at` DOIT wajib ISO berzona (spasi diterima) dan dicek masuk akal (dibuat-5 menit sampai sekarang+5 menit, kalau tidak pakai waktu poll) di poll dan webhook (3416231a, f410ea27). Test lifecycle QRIS POS: gateway palsu kini menjawab `expired` saat kode lewat waktu, seperti DOIT asli yang menerima `expires_in` kita.
- Sisa dicatat sebagai kartu legend-3wpf (P2); `updated_at` sebagai penanda disetujui CTO sampai migrasi berikut; transfer bank DOIT tetap mati (keputusan founder). Gate penuh 96df32a8 diambil merge train. Sisa: `expireDueIntents` belum dipanggil di produksi tapi meng-expire kode DOIT tanpa bertanya; kode yang di-supersede dan habis 24 jam tidak menulis audit; status DOIT `refunded` dipetakan `pending` (label audit `gateway_unconfirmed` keliru); `updated_at` dipakai penanda "provider sudah menjawab" untuk kode yang di-supersede, sebaiknya kolom sendiri di migrasi berikut; perilaku replay Idempotency-Key DOIT (sidik body, jendela replay) belum dicek di sandbox.

## legend-vmyg jurnal manual & berulang (engineer, cabang `ws/journals`)

- Selesai di worktree `.worktrees/journals`: tabel `manual_journals`, `recurring_journals`, `recurring_journal_runs` (migrasi 0063 + RLS FORCE 0064), service manual (draf, ajukan, setujui, tolak, tarik, batal), service berulang + job `runDueRecurringJournals` (satu transaksi per bulan, kunci unik template+periode), route `/api/accounting/manual-journals` dan `/recurring-journals`, consumer `approval.resolved`, job di `worker-main.ts`.
- Persetujuan lewat `approval_requests` (aksi `manual_journal`); pembuat tidak bisa menyetujui (service, state machine, check constraint DB). Ledger hanya ditulis setelah disetujui.
- Titik cek periode tunggal: `apps/api/src/services/accounting-journal-period-gate.ts` (disambung ke kunci `ws/fiscal-close-lock` saat merge).
- Kontrak: `manualJournalSchema` dilonggarkan, penolakan sistem (rantai kedaluwarsa) boleh tanpa `decidedBy`.
- Keputusan founder legend-j4ko (Q5/Q6) dikerjakan: template yang dilanjutkan setelah jeda melewati bulan selama jeda (mulai bulan berjalan); aksi operator `POST /api/accounting/recurring-journals/:id/skip-period` melewati bulan tutup buku (izin `accounting.journal.post`, audit, idempoten, migrasi 0065).
- Fix keamanan: efek persetujuan dari inbox mengecek ulang bahwa penyetuju memegang `accounting.journal.post` atas outlet header dan semua outlet baris; bila tidak, jurnal/template ditolak dan tidak ada yang diposting (`accounting-journal-approver.ts`).
- Perbaikan review K (2026-11-08): merge `main`; migration cabang 0063–0065 dibuat ulang jadi 0068 (tabel, FORCE RLS dilepas sementara saat validasi FK seperti 0065 main) dan 0069 (RLS), lulus test migrasi owner non-superuser. Jurnal manual yang rantainya sudah disetujui tapi postingnya ditolak (periode tutup, akun nonaktif) kini jadi `rejected` oleh sistem + audit, consumer tidak macet. Template berulang: `paused_at` (resume hanya melewati bulan setelah jeda, tunggakan tetap diposting, tiap bulan dilewati dicatat di `recurring_journal_runs` + audit); skip-period diizinkan bila posting ke bulan itu akan ditolak karena bulan sesudahnya tutup; `last_error`/`failed_at` untuk kegagalan job (dibersihkan saat sukses atau skip); penolakan sistem diaudit.

## legend-mjmm UI POS kasir (ui-engineer, cabang `ui/pos-kasir`)

- Selesai di worktree `.worktrees/pos-kasir-ui`: 21 layar dari mockup POS (Q10) di `/pos/bayar/$orderId` (QRIS, VA, e-wallet, kartu, tunai, EDC: pilih terminal, menunggu, status belum pasti dengan cek status dulu, berhasil, standalone dengan PIN supervisor; split tender; DP reservasi), `/pos/kode` (kode "Bayar di kasir"), `/pos/shift` (buka, aktif, pergerakan kas), `/pos/shift/tutup` (blind count per pecahan, Q8), `/pos/supervisor/shift/$shiftId` (persetujuan, `overrideId`), `/pos/tutup-hari` (manajer outlet, cutoff 04.00, Q9). Fitur `apps/web/src/features/ws04-pos-kasir/`, katalog `pos-kasir-*.ts`.
- Mode mock: mesin mock di browser (sessionStorage) + seed `?demo=`. Kontrak yang belum ada dicatat di `apps/web/src/features/ws04-pos-kasir/CONTRACT-GAPS.md` (EDC ECR, bank VA, e-wallet, kartu online, cari kode kasir, alokasi DP dan sisa DP jadi saldo, rencana split, settlement tutup hari, `closePosShiftInputSchema` masih `approvalRequestId`, persetujuan `edc_standalone`/`cash_shift_close`).
- Keputusan: modal awal Rp0 boleh tetapi perlu konfirmasi "Ya, laci kosong, buka shift" (sama dengan blind count); supervisor standalone tidak dipilih otomatis; persetujuan supervisor yang belum terpakai dipakai ulang bila pencatatan ditolak; mesin mock menolak pencatatan bila sisa tagihan berbeda dari nominal yang disetujui.
- Bukti: e2e mock `e2e/legend-mjmm-pos-kasir.mock.spec.ts` 32/32; screenshot 1280x800 di `docs/qa/pos-kasir/` (21, nama sama dengan mockup; banner sesi akses dukungan dari mock WS-01 disembunyikan hanya di screenshot). Gate setelah `node_modules` dipasang ulang di worktree (bukan symlink): `heavy pnpm check` (1393 test), `heavy pnpm build`, `pnpm format:check`, color, tenant-hardcode hijau. Review diff konteks segar + ui-auditor: temuan berat dibetulkan.
- Biaya sesi ui-engineer (transkrip 5d27428b, 1 compact, 40+ subagent): Opus utama 3694k, Sonnet 8474k, Haiku 223k; total sekitar 12391k unit biaya (sebelum gelombang audit terakhir).
- Sisa (saran): tab terpilih "Kas keluar" masih hitam pekat (ui-auditor: pakai gaya netral), chip, ikon dan perataan kecil vs mockup, header shell tanpa nama kasir.

## legend-apt EDC agent: perbaikan review K (engineer, cabang `ws/edc-framework`)

- `main` di-merge; migrasi EDC lama 0063/0064 dibuang, dibuat ulang dengan drizzle-kit dari 0067 jadi `0068_edc_transactions.sql` + `0069_edc_rls.sql`. 0068 melepas FORCE RLS di outlets, payment_edc_terminals, payment_intents selama validasi FK (pola 0065, migrator owner non-superuser).
- Agent: retry ditolak `EDC_NEEDS_RECONCILIATION` bila ada baris referensi itu yang ditandai rekonsiliasi (approved late), `EDC_STATUS_UNKNOWN` bila masih in-flight; `not_found` dipercaya hanya 15 menit sejak dispatch (`notFoundTrustWindowMs`); cancel lewat antrean terminal kecuali sale-nya sendiri sedang memegang kunci, ditolak saat terminal stuck; jawaban trace salah: inquiry tidak menulis hasil, sale/cancel simpan bukti + tandai rekonsiliasi; recoverPending hanya outlet yang baru diambil.
- Outbox: `edc_transaction.created/approved/declined/failed/cancelled/flagged` ditulis di transaksi yang sama (EDC-05). `settled` disisakan untuk settlement bank (EDC-06).
- Skema: kolom `type`, `mode`, `payment_intent_id`; `EdcProvider.void` + simulator; registry menolak simulator di production. Unique approved per referensi kini hanya `type = 'sale'`.
- Batch check (lanjutan CTO): `dispatch_batch_no` (migrasi 0070) = batch terakhir terminal saat dispatch; `not_found` hanya jadi `failed` bila batch di jawaban sama dengan batch saat dispatch, selain itu `unknown` + rekonsiliasi (bank tutup batch dalam 15 menit tidak lagi memicu tagih dobel). Kontrak `EdcProvider`: frame sale terkirim sinkron saat `sale()` dipanggil; `not_found` wajib membawa `batchNo`.
- Sisa risiko: sale pertama di terminal (batch belum diketahui) atau sesudah settlement malam selalu masuk rekonsiliasi manual bila hasilnya tak pasti; race kecil di `recoverInFlight` publik (baris yang dispatch di tick yang sama bisa sempat `unknown`, jawaban akhir tetap tercatat).

## Keputusan founder Q6 (mockup final): UBAH DULU

- Catatan founder apa adanya: "Coba riset warna termasuk warna button secara psikologis yang mendorong pembelian serta membuat orang memesan banyak".
- Langkah: riset psikologi warna untuk F&B order (warna CTA/tombol, warna yang mendorong nafsu makan dan nilai pesanan lebih besar, bukti dari sumber kredibel, bedakan mitos vs bukti, tetap lolos kontras WCAG), tulis `design/COLOR-RESEARCH.md`, lalu designer (Codex) ulang `final-a-*` dengan palet baru, review founder lagi. Pola upsell/menambah pesanan (rekomendasi "tambah minuman", bundling) boleh diusulkan bersama.

## Brief 94 WS-03 menu dan QR order (engineer, cabang `ws/ws03-menu` + `ws/ws03-menu-w2`)

- Gelombang 1 (`ws/ws03-menu`, daf21029, 11b9b775, 0eb3adc2, e20d52ee): konteks tamu QR per outlet + limiter tamu (7csf, 6ipw, fpi9, khiv), gabung sesi rombongan dari meja sekunder + tutup sesi membatalkan panggilan (rml8), API zone waiter + `resolved_by` (xlzl, migrasi 0086), pajak/inklusif/`unavailable_until` menu tamu (lf8g, nx3f, 49pw), sweep 86 + seed ketersediaan outlet baru (1am2, 2nb9), event bayar QR + skema realtime ke shared (8pye), kartu online dibuang dari checkout QR (vbzu, keputusan founder 9 Nov). n1p1 ditutup (43/43 endpoint sudah dilayani).
- Perbaikan gate 1: 0086 mengangkat FORCE RLS `roles` untuk migrator non-superuser; helper tes floor menulis `created_by` UUID (daftar tenant platform 422 di suite penuh).
- Gelombang 2 (`ws/ws03-menu-w2`): link modifier + media per outlet (un0j, dcz0), kontrak import di shared + XLSX lewat parser server (l8zb, az32), saran menu tamu (bagian cpq2), tes RBAC stasiun + batas body media (ra7s, ogzf), perbaikan back-office (ujkf, afig), sampel QR di subpath `qr-order/sample` (33uj), kontrol open-bill + migrasi 0087 (cqrw). 9pes dan 6ohy terverifikasi tanpa perubahan.
- Keputusan: batas open-bill default Rp 3.000.000 sisa tagihan belum dibayar, 45 menit tanpa aktivitas, SLO minta tagihan 180 s (sweep lama); pelanggaran 409 `QR_ORDER_OPEN_BILL_LIMIT`, diaudit maks 1/menit/sesi. Media menu tingkat outlet, `outletId` opsional.
- Kartu lanjutan: 4qls, n1mp, 541h (sisa read model tamu), iuvq (consumer cetak menu), n64n (fixture modul lain di bundle), tny6 (rute + layar kebijakan open-bill), zmc2 (order QR inklusif).
- Review: semua slice K lewat reviewer Opus + architect; temuan nyata dibetulkan (0087 FORCE, pool/lock, banjir audit, eksposur kasir). Second-opinion Codex antre untuk slice K kedua gelombang.
- Metrik sesi 9e42e731 (06:27, 159 menit): biaya* 21022k (utama Opus 4395k, subagent Sonnet 12721k, Opus 3835k, Haiku 72k); 45 subagent, puncak 9, rata 1,65 berjalan.
- Gate: gelombang 1 `pnpm check` di 11b9b775 gagal 4 tes (0086 migrator non-superuser, daftar tenant 422), dibetulkan. Gelombang 2 di fc692f1d: lint + typecheck lolos, tes 2244 lolos / 1 gagal (`guest-menu-api.test.ts:261`, kategori bocor dari `ws03-menu-link.test.ts`), dibetulkan; tes terarah 2 file 14/14. Gate penuh berikut oleh merge train (aturan CTO 9 Nov).
- Gelombang 3 (`ws/ws03-pay` dari `ws/ws03-menu` d06b163c, keputusan CTO 9 Nov): e-wallet dihapus dari checkout QR, online hanya QRIS + VA (01556e36); tes pengunci scan meja sekunder ke sesi meja utama (7972ec4c); pesanan QR harga nett legend-zmc2 (2837a486, 85e8e35d, 9137504c: migrasi 0088 `orders.prices_include_tax`, `orders_total_check` per mode, helper `orderNetSubtotalIdr`, 409 `QR_ORDER_PRICING_MODE_MIXED`, tagihan tamu menampilkan "termasuk"); VA nyata legend-3160 dipersempit ke VA (1f898989, 8335c60f, f1b721e7: `bankCode` dicek ke `channels("va")`, GET payment-options, ganti bank menggantikan VA lama + `cancel?()` di port, bayar setelah meja tutup tidak masuk dapur dan diajukan refund, bayar dobel diajukan refund, `outletId` ke channels/health); layar VA web (e1ef54d3, ac66014f); seed mock nett memakai `cartLineId` UUID (61ec7f62, sebelumnya semua halaman mock 500 dan webServer e2e tidak pernah siap).
- Keputusan: model nett = subtotal gross + pajak/layanan dipisah + flag (architect: pertahankan, POS nanti ikut bentuk ini). Satu sesi satu mode harga. Kode bank pakai kode DOIT (`bmri`, `bnia`, `brin`, `permata`). Provider DOIT ada di `milestone/m1`; cabang ini memakai port gateway + gateway test, sambung DOIT saat merge (teruskan `outletId`, nomor migrasi 0086-0088 dinomori ulang di atas m1).
- Kartu lanjutan: npnh (POS nett + cek mode di POS), v9fh (basis min spend nett), jwn6 (rekap PBJT campur), kej3 (penjualan QR tidak masuk jurnal, P1), 1vm1 (cancel VA DOIT + jendela poll). legend-g7bg (arti harga nett = termasuk layanan + pajak) masih menunggu konfirmasi pemilik.
- Review: zmc2 dan 3160 lewat reviewer Opus + architect + re-review; layar VA lewat ui-auditor + reviewer. Second-opinion Codex antre untuk zmc2 dan 3160.
- Gate handoff (aturan baru) di 61ec7f62: typecheck api/shared/web lolos, eslint semua file berubah bersih, tes terarah api 11 file 123/123, `db:generate` kosong, e2e mock QR 10 spec 36/36 (`LEGEND_MOCK_PORT=3245`).
- Metrik sesi 9e42e731 (06:27-11:11, 283 menit): biaya* 31887k (utama Opus 7686k, subagent Sonnet 13855k, Opus 10110k, Haiku 236k); 67 subagent, puncak 9, rata 1,19 berjalan.

## Langkah berikut

1. (selesai) fix brief 06.
2. (selesai, menunggu founder Q3) riset warna + ulang mockup.
3. Setelah mockup disetujui: ui-engineer bangun UI order pelanggan dari `final-a-*`, update `DESIGN.md` sesuai usulan README mockup. Jangan sentuh area worker.
4. Merge `ws/worker-transport` dan `ux/customer-order-benchmark` ke `main`: menunggu gerbang founder.
5. Penghalang rilis lain (HANDOFF.md §7): legend-zoqc, legend-91i (layar ke API asli), POS FE, dsb.

## Catatan teknis

- Coordinator Ghostex dijalankan di folder `legend super app` (bukan repo git): `start-thread --worktree` gagal. Buat worktree manual di `legend/.worktrees/<nama>` + `.claude/settings.local.json` pematik claude-mem, tulis path di brief.
- Brief tim: `docs/briefs/01..06`.

## Vendor (gelombang ini)

- Claude: benchmark, engineer, reviewer (3 tugas). Codex: designer (2 putaran), second-opinion (3 tugas).

## legend-4d5 KDS backend (engineer, cabang `ws/kds`)

- Selesai: routing tiket POS/QR ke stasiun, siklus tiket + jejak status, feed per stasiun + WebSocket resync (migrasi 0063/0064).
- Keputusan CTO 2026-11-08 dikerjakan: QR masuk KDS (QR tidak pernah gagal karena stasiun kosong; baris tanpa stasiun diaudit `kitchen_ticket.unrouted`); menu menyimpan tipe stasiun per brand, diselesaikan per outlet, `station_id` hanya override di outletnya (legend-s2dh, migrasi 0065 + backfill); void di KDS tetap hanya dapur, kasir dapat order event `order.kitchen_voided`.
- Bukti: `heavy pnpm check` 138 file / 1246 test lulus, build lulus, format/color/tenant-hardcode lulus, 2 reviewer konteks segar (1 temuan High dibetulkan).
- Lanjutan (bead): legend-0ixe (UI POS tampilkan void KDS), legend-0frf (UI admin menu tipe stasiun), legend-078b (alert baris QR tanpa stasiun + notifikasi void untuk order QR).
- Menunggu: review CTO, merge ke `main` oleh gerbang founder.
- 2026-11-08 malam, perbaikan second-opinion architect (8 butir): merge `main` (1f0b6d2) = `2e56c5a8`, migrasi KDS di-renumber 0068_lame_tusk (generate, SQL identik) / 0069_kds_rls (custom) / 0070_menu_station_type_backfill (custom). Fix = `a9897e90` + `792a08aa` (temuan reviewer).
  - Keputusan: `after` klien tidak dipercaya; lebih maju dari cursor, tertinggal > 2000 (`KITCHEN_FEED_MAX_LAG`), atau baris sesudahnya sudah dipangkas: HTTP 409 `KDS_RESYNC_REQUIRED`, WebSocket frame `resync` lalu close 4409. Klien: muat ulang snapshot, sambung ulang dengan `after = snapshot.sequence`.
  - Feed dipangkas tiap sequence ke-500: hanya baris > 24 jam DAN > 2000 di belakang cursor; trigger DB hanya mengizinkan delete itu (legend_app dapat DELETE lagi di tabel feed saja).
  - POS fire tidak pernah gagal karena stasiun kosong (skip + audit `kitchen_ticket.unrouted` + warn).
  - Bukti: test per bagian lulus (kds + kds-realtime 63/63, menu-api 17/17). Gerbang penuh pertama gagal lint saja (helper tak terpakai, dibetulkan). Gerbang penuh setelah commit terakhir BELUM selesai: dihentikan sistem karena memori Mac kritis.

## legend-6c0 shift kasir, putaran 2 (engineer, cabang `ws/pos-shift`)

- Fix 3 P1 + 2 P2 second-opinion (brief `docs/briefs/46-fix-pos-shift-round2.md`) plus 2 temuan reviewer konteks segar (variance bocor ke kasir lewat approval; jam kas sebelum shift dibuka).
- Hari usaha tertutup: `assertBusinessDayOpen` (kunci advisory bersama, kunci sama dengan tutup hari) di buat/ubah/bayar/selesai/void/refund. Kas wajib shift kasir terbuka (`lockCashierShiftForCash`, FOR SHARE vs FOR UPDATE di tutup shift). Tutup shift dua langkah: hitungan kas disimpan permanen (`pos_shift_counts`), approval terikat ke hitungan dan nilai |selisih| dari server, tingkat matriks dicek saat dipakai. Tutup hari diblokir shift terbuka lintas jam 04.00.
- Migrasi baru 0066/0067 (bernomor setelah 0063-0065 putaran 1; perlu dinomori ulang bila `main` lebih dulu memakai nomor itu).
- Status bead: review. Belum merge, belum push.

## legend-6c0 shift kasir, perbaikan review K (engineer, cabang `ws/pos-shift`, 2026-11-08)

- `main` digabung (c87fb5e). Migrasi cabang lama 0063-0067 dihapus, dibuat ulang setelah 0067 milik main: `0068_pos_shift` (skema), `0069_pos_shift_rls` (SQL custom dari `pos-shift.custom.sql`), `0070_pos_day_close_permission` (backfill izin, terpisah supaya bisa dijalankan ulang di test).
- Tunai per perangkat: tender/refund/void tunai wajib `X-Device-Token` dan shift kasir yang terbuka di perangkat itu, selain itu `SHIFT_NOT_OPEN`. Baris tunai menyimpan `shift_id`; angka shift dijumlah per `shift_id`.
- Refund/void tunai melebihi isi laci: 409 dengan pesan umum, tidak ada yang tersimpan.
- Hitung buta: penolakan kas keluar diaudit dengan pesan umum, maksimal 3 hitungan kasir (`SHIFT_COUNT_LIMIT`), pesan persetujuan dibuat umum.
- Tutup paksa (U9): pemegang `shift.cash.approve_close` mengirim hitungan paksa, saksi menyetujui lewat PIN, lalu `POST /shifts/:id/force-close`.
- DB: FK `count_id`, open check mewajibkan `count_id IS NULL`, trigger mencocokkan hitungan penutup.
- Kontrak berubah untuk UI `ui/pos-kasir-shift`: header perangkat wajib untuk tunai, endpoint force-close, error `SHIFT_COUNT_LIMIT`.
- Putaran 2 (reviewer konteks segar): setelah 2 kali kas keluar/setor ditolak, semua kas keluar/setor di shift itu ditolak, supaya kasir tidak bisa menebak isi laci; `approved_by` diambil dari override yang terverifikasi; batas 3 hitungan hanya menghitung hitungan kasir sendiri (bukan hitungan paksa).
- Akibat merge main: mock web POS kasir mengikuti alur hitung lalu tutup (`countId`); test QRIS dan rekap main membuka shift dan mengirim token perangkat; 0068 melepas FORCE RLS sementara (pola 0065) supaya bisa dijalankan pemilik tabel tanpa BYPASSRLS.
- Commit: c87fb5e (merge), a67d4cb, 5db5f47, 788e32e, 4195d5c, 78a274a, e1674b1. Gerbang penuh hijau di e1674b1: API 1411 lulus (1 skip), root 1414 lulus, lint 0 error (3 warning), build lulus.
- Sisa: second-opinion Codex (tingkat K) sebelum gerbang rilis; celah ULID/UUID `approvalRequestId` di body tutup; trigger DB belum mengecek `expected_idr`/`recorded_by` (layanan sudah).
- Belum merge, belum push.

## legend-5cnk + legend-y4wp PPh 21 round 2 (engineer, cabang `ws/payroll-pph21-tests`)

- Selesai: engine PPh 21 v2 (`apps/api/src/services/payroll-pph21.ts`) membetulkan 3 P1 + 3 P2 temuan Codex, ditambah 2 bug dari reviewer (Desember tanpa bayaran, gross_first menagih karyawan atas kurang bayar riwayat net). Kebijakan PPh 21 per tenant: kontrak `packages/shared/src/hris/payroll/pph21-policy.ts`, tabel `payroll_pph21_policies` (migrasi 0068/0069 setelah dinomori ulang, RLS FORCE, append-only), service + route `/api/hris/payroll/pph21-policies` (payroll.view / payroll.run, idempotency, audit).
- Test: 108 test engine PPh 21 (R01-R65 + guard) + 5 kontrak kebijakan + test DB + test API. Gerbang penuh hijau setelah perubahan terakhir (141 file, 1332 test; build; format; color; tenant-hardcode).
- Berikut: `legend-oo3q` (pin versi kebijakan di snapshot run + sambung engine ke payslip builder). Migrasi 0063/0064 bentrok nomor dengan cabang lain: nomori ulang saat merge.

## legend-oo3q + legend-iwgb engine PPh 21 tersambung ke slip gaji dan payroll run (engineer, cabang `ws/payroll-pph21-tests`)

- Selesai: engine pindah ke `packages/shared/src/hris/payroll/pph21.ts`; satu langkah pajak slip `payslip-tax.ts` (`computePayslipTax`) dipakai builder slip mock (`fixtures.ts`) dan service run API (`payroll-run-pph21.service.ts`). Snapshot run menyimpan `pph21Policy` (id, versi, tanggal berlaku; null = default); `pph21PolicyForRun` memakai versi tersimpan setelah lock, beda versi = PAYROLL_SNAPSHOT_MISMATCH. `annualTaxableIncome` dihapus. Tabel TER fixture diganti tabel PP 58 lengkap (bukan hanya kategori B 1,5%).
- Test: run end-to-end di test DB (`payroll-run-pph21-db.test.ts`: 5 karyawan + Desember, v1 down / v2 half_up, lock, tamper, tenant lain). Gerbang penuh hijau (142 file, 1340 test; build; format; color; tenant-hardcode) + 6 spec e2e mock payroll (66 lulus).
- Belum: tabel `payroll_runs` belum ada (legend-gfcr / legend-07eg); run belum disimpan, service menerima data run dari pemanggil.

## Perbaikan review K PPh 21 (engineer, cabang `ws/payroll-pph21-tests`, 2026-11-08)

- Selesai: main di-merge; migrasi 0063/0064 lama (bentrok dengan `fiscal_close_lock`, `when` lebih tua dari 0067) dihapus dan di-generate ulang jadi `0068_payroll_pph21_policy` + `0069_payroll_pph21_policy_rls` (RLS + REVOKE disalin). Engine: `gross_first` dengan `priorTax = 0` membagi kekurangan Jan–Nov menurut campuran skema (R69–R71). Keputusan founder 2026-11-08: pajak atas BPJS pemberi kerja untuk karyawan net/gross-up ditanggung perusahaan (R66–R68); karyawan campuran yang punya baris gross tetap seperti R17b. Lock: `lockPayrollRunTax` membaca kebijakan di transaksi lock dan menolak `PAYROLL_SNAPSHOT_MISMATCH` bila beda dari ref saat approve. `Pph21PolicyRef.parametersHash` (SHA-256 JSON kanonik) dibandingkan di `pph21PolicyForRun`.
- Test: upgrade migrasi (DB baru + DB di 0067), test ref/hash, 4 test DB lock.
- Belum: pemanggil lock belum ada (tabel `payroll_runs` belum dibangun) — run service wajib memanggil `lockPayrollRunTax` dengan ref saat approve.
- Lanjutan (keputusan CTO 2026-11-08): karyawan campuran — pajak atas BPJS pemberi kerja dibagi menurut porsi gross per skema bulan itu (basis karyawan = baris gross + floor(benefit x gross / semua baris)); di mode `proportional` seluruh T, termasuk kekurangan Jan–Nov, mengikuti porsi itu. Baris gross Rp1 hanya memindahkan porsinya. R17b diubah; test batas R77–R82 + R62b. Commit 1bda9807.

## legend-hvvn + legend-rbjw persetujuan refund dan refund ke provider (engineer, cabang `ws/refund-approval`)

- Refund (biasa, dana tak teralokasi, refund sistem reservasi/POS) disetujui atau ditolak lewat `approval_requests` (matriks approval, dibuka saat keputusan pertama). Approver bukan peminta, rantai sekali pakai dan terikat ke refund + nominal. Refund sistem: orang pertama mengajukan, orang lain menyetujui; tolak langsung oleh pemegang `payment.reconcile`.
- Status: `pending` → `approved` → `completed` | `failed` (`failure_reason`: rejected, approval_expired, provider_declined, cap_exceeded, source_document, approver_unauthorized). Enum status tidak diubah (web memakai Record lengkap).
- Port baru `PaymentRefundPort` (`payment-refund-gateway.ts`), terpisah dari `PaymentGatewayPort` supaya fake lama dan cabang DOIT tidak rusak. Kunci idempotensi `refund:<id>`, klaim berlease + token, timeout 30 detik, cek status sebelum kirim ulang, sweep worker `sweepApprovedRefundPayouts` (backoff, berhenti di 8 percobaan → `MANUAL_RECONCILIATION`). `applyRefundProviderUpdate` siap untuk webhook DOIT.
- Migrasi `0068_refund_approval_payout` (dulu 0063, digenerate ulang setelah merge main 0063–0067).
- Bead lanjutan: `legend-0ogy` (adapter + webhook DOIT), `legend-kfkt` (UI tolak/ulangi + alasan gagal), `legend-n9kn` (refund pending yang tak pernah diputuskan).
- Perbaikan review K (8 Nov 2026): main digabung, migration lama 0063 dihapus dan digenerate ulang jadi `0068_refund_approval_payout`. Refund admin atas pembayaran yang terikat dokumen penjualan (`orderId`, `accessTicketId`, `subscriptionInvoiceId`) ditolak 409 `REFUND_SOURCE_DOCUMENT`; refund penjualan lewat modul pemilik (`order.refunded`, yang memposting jurnal). Pengecualian: peminta `system:*` (dana telat/DP yang tidak pernah dijurnal) dan dana tak teralokasi. Refund lama yang terlanjur pending gagal `source_document`. Approve/tolak idempoten per kunci di transaksi langkah pertama (`refund.approved` / `refund.rejected` di `payment_admin_idempotency`). Approver rantai tanpa `payment.reconcile` di outlet → refund `failed` `approver_unauthorized`, tidak dibayar. Sweep payout keluar dari tick relay ke loop sendiri (30 detik, anggaran 20 detik per tenant, berhenti saat shutdown). Jawaban provider `pending` tidak menghabiskan 8 percobaan (`payout_pending_polls`); tandai manual hanya bila pending lebih dari 72 jam. Refund dana memakai evidence milik dana (`payment_unallocated_funds.evidence_id`, baris lama memakai perilaku lama).
- Perbaikan second-opinion Codex (brief 92, 9 Nov 2026, tingkat K):
  - Temuan 1 (otorisasi): PRD §3.6 `docs/PRD.md:541` ("refund ... memerlukan PIN supervisor atau approval dari ponsel supervisor") dan D14 (`:260`) mewajibkan supervisor. Kewenangan supervisor = `pos.refund.approve` di outlet refund.
    - Jalur satu penyetuju (di bawah semua tier matriks) sekarang butuh `payment.reconcile` DAN `pos.refund.approve`. Tanpa keduanya: 403 `PERMISSION_DENIED`, dan refund tetap pending.
    - Rantai: tiap penyetuju butuh `payment.reconcile` ATAU `pos.refund.approve` di outlet, dan minimal satu `pos.refund.approve`. Bila tidak: `failed` `approver_unauthorized` dengan catatan `supervisor_required`.
    - Finance sesama finance tidak lagi bisa membayar refund.
  - Temuan 2 (evidence): payout dana tak teralokasi tidak pernah jatuh ke evidence terbaru atau ke `intent.providerRef`.
    - Dana ber-`evidence_id` memakai evidence itu saja.
    - Dana NULL hanya otomatis bila intent punya tepat 1 evidence, tidak dimiliki dana lain, dan tidak ada dana NULL lain di intent itu.
    - Selain itu payout ditahan: `last_payout_error = EVIDENCE_MAPPING_REQUIRED`, tanpa klaim, tanpa panggilan gateway, percobaan tidak bertambah.
    - Retry menerima `sourceEvidenceId` untuk memetakan evidence asal sekali, tanpa remap. Retry mengunci intent, menolak evidence intent lain atau evidence milik dana lain dengan 409, dan mencatat audit `payment.refund_fund_evidence_mapped`. Retry tanpa pemetaan menjawab 409 `EVIDENCE_MAPPING_REQUIRED`.
  - Migration `0069_refund_fund_evidence_unique`: unique index parsial `(tenant_id, evidence_id) WHERE evidence_id IS NOT NULL`. Diregenerasi saat merge.
  - Test: `payment-refund-codex-fix.test.ts` (11 skenario baru). Test approval dan review-fix disesuaikan: penyetuju finance diberi role supervisor di outlet. Review F diubah ke aturan baru, ditambah kasus negatif outlet lain.
  - Dampak operasional: refund di bawah tier kini hanya bisa disetujui owner (atau finance yang juga supervisor). Saran kartu: tier matriks refund mulai Rp0 dengan langkah supervisor lewat inbox.

## legend-165 registri perangkat + mode latihan (engineer, cabang `ws/device-registry`)

- Selesai: tabel `devices` + `device_training_periods` (RLS tenant + outlet, trigger pencabutan final), migration `0068_closed_tiger_shark` (semula `0063_slim_nekra`, di-renumber di `ws/edge-registry-pull` setelah main; ditambah angkat FORCE RLS sementara untuk migrator pemilik tabel biasa). Route cloud `/api/devices` (daftar, daftarkan + token sekali tampil, terbit ulang token, cabut, mode latihan, heartbeat), edge `/api/edge/devices` (daftar, heartbeat), `/api/edge-sync/device-records` (ekspor replika untuk edge).
- Temuan keamanan ditutup: `deviceTenantCredential` dan `deviceReader` edge kini cek registri (perangkat aktif, tidak dicabut, tenant cocok, outlet node di edge, token tidak lebih tua dari terbit ulang terakhir). Token hanya diterbitkan service setelah cek registri.
- Review architect (2 medium, 3 low) dan reviewer (1 bug heartbeat domain ber-brand) dibetulkan.
- Lanjutan: `legend-2lp.7` P1 (jadwal tarik replika di runtime edge; sebelum itu semua token perangkat di edge ditolak), `legend-2lp.8` (cap `is_training` di pesanan POS + laporan), `legend-2lp.9` (panel ke `/api/devices/*`), `legend-2lp.10` (heartbeat edge ke cloud).

## legend-2lp.7 tarik registri perangkat berkala di edge (engineer, cabang `ws/edge-registry-pull`)

- Cabang ini = `ws/edge-hardening` + merge `ws/device-registry` + tarik berkala, supaya ketiganya di-merge sekali dengan aman.
- Tarik pertama saat boot (tidak memblokir boot), lalu tiap `EDGE_DEVICE_SYNC_INTERVAL_SECONDS` (default 60). Satu tarik sekaligus, backoff eksponensial sampai 5 menit saat cloud mati, berhenti bersih saat shutdown.
- Watermark disimpan di tabel baru `edge_pull_checkpoints` (migration `0069_hesitant_smiling_tiger`, RLS tenant + outlet), bukan dari replika: heartbeat edge menaikkan `updated_at` lokal.
- Gagal tarik: replika lama tetap dipakai, tidak ada akses device yang dibuka. Basi bila tarik sukses terakhir lebih tua dari `EDGE_DEVICE_SYNC_STALE_SECONDS` (default 900): log error, `deviceRegistry.stale` di `/api/edge/status` dan `/api/edge/health` (status HTTP health tidak berubah).
- Kontrak: `edgeStatusSchema.deviceRegistry` opsional (edge lama tidak mengirimnya). Lanjutan web: tampilkan status basi di panel edge dan isi mock `apps/web/src/features/ws02-edge/mock.ts`.

## WS-13 alur bisnis A–Z (qa/test-writer, cabang `ws/e2e-az`, brief 91, 2026-11-09)

- Sudah: 7 berkas tes integrasi `apps/api/src/test/e2e-az/` (A/Y, E/W, D, J, K+cuti, H, R) + `e2e/az-whitelabel.spec.ts`. API: 57 lulus, 64 skip (`PENDING-BRANCH`/`PENDING-CARD`/`PENDING-DECISION`), 0 gagal. Laporan: `docs/qa/2026-11-09-e2e-az.md`.
- Bug P1 dibuat: legend-vj37 (bundel API crash di boot karena `sharp`, `pnpm test:e2e` m1 merah), legend-ozud (manifest PWA nama platform), legend-ww29 (`/design-system` nama platform).
- Langkah berikut: tiap merge train menggabungkan cabang di daftar `PENDING-BRANCH`, ganti `describeUntilMerged` → `describe` di berkas terkait lalu jalankan. Spec Playwright jalan setelah legend-vj37 fix.
- Merge train m1 (`prep/e2e-az`, setelah unskip 6 cabang): 83 lulus, 38 skip, 0 gagal (run gabungan lewat `heavy`). Perbaikan tes 263ce1ec: polling PAY-02 pakai `GET` status intent; refund PAY-04 diajukan keuangan, disetujui supervisor, kebijakan approval di-seed.
- Keputusan CTO: legend-dahk (port tender EDC) disambung; legend-m4fv aksi `edc_standalone` izin `pos.edc_standalone.approve`. Dikerjakan G106p; EDC-01/02/04 tetap skip sampai masuk.
- Keputusan perlu CTO: kartu online (PRD 223: P1 Duitku, bukan DOIT); teks transfer bank di PRD 223/257/680/1754.
- Biaya sesi: utama Opus 95 req, subagent Sonnet 443 req, total biaya* 8008k; 18 subagent, maks ~8 bersamaan.

## WS-12 Tanya AI + MCP backend (engineer, cabang `ws/ws12-ai`, 2026-11-09)

- Basis: `ws/ai-tool-catalog` (d15542a8, belum di-merge) + merge `milestone/m1` (4a040820). Merge train harus membawa katalog dulu.
- Mockup WS-12 belum disetujui founder: kartu FE `legend-hi82`, `legend-jk6s`, `legend-mlnu` hanya dapat kontrak API (`docs/contracts/ws12-ai-fe.md`), tanpa UI.
- Selesai (BE): skema 13 tabel AI + RLS (migration 0086-0089, di-regenerate saat merge), provider Anthropic (`claude-opus-5-5`, env `AI_MODEL`) + OpenAI-compatible + fake, pemindai PII (NIK, NPWP, gaji, kode login), gateway (kuota per peran per hari, batas biaya bulanan IDR default 0 = AI mati sampai owner mengisi, kill switch, cache), alat baca TL-01..08, TL-10..12, TL-20, alat tulis TL-14, 15, 17, 18 lewat action request + kotak persetujuan, orchestrator Tanya AI + riwayat, server MCP (Streamable HTTP, OAuth 2.1 + PKCE S256, consent wajib lewat POST bersesi), route tata kelola, halaman pedoman AI.
- Review K: R1 (MCP/OAuth), R2 (otorisasi alat), R3 (gateway), architect, lalu re-review Opus dua bagian. Semua temuan nyata dibetulkan: kebocoran cache antar outlet (P0, kunci kini user + jangkauan per template + status MFA + versi setelan, validasi ulang alat saat cache hit), cache melewati gerbang MFA (P0), shareholder melihat periode terbuka (P0), cek override peran per template (`allowsVia`/`permissionsVia`), kode OAuth tanpa consent, user banned tetap akses MCP, AI tidak lebih lemah dari jalur manual (pakai kebijakan persetujuan modul bila ada), eksekutor promo/harga atomik dengan kompensasi, cek ulang izin + saklar AI/MCP saat eksekusi.
- Keputusan teknis: MCP butuh `ai.ask` dan mengikuti saklar AI utama; alat HRIS/keuangan (TL-05, 06, 08, 09, 12) butuh sesi terverifikasi MFA dan tidak tampil di MCP untuk peran wajib-MFA; TL-10 SOP bukan data pribadi (tidak digerbang MFA); alat hanya untuk pemegang template peran (peran kustom saja tidak dapat alat AI).
- Belum ada: TL-09 slip gaji (tabel slip belum ada), TL-05 biaya tenaga kerja = 0 (belum ada absensi/payroll aktual), TL-13 PO dan TL-16 tulis jadwal shift (modul belum ada, alat dimatikan), halaman web `/mcp/consent` (MCP belum bisa dipakai sampai UI consent ada), rate limit MCP masih in-memory, penanda `[ai:<id>]` di deskripsi promo (perlu kolom kunci di modul promo).
- Langkah berikut: second opinion Codex (tingkat K: auth, uang, data pribadi), keputusan founder soal model/anggaran AI, UI setelah mockup disetujui.
- Gelombang 3 (legend-hkd4, legend-lely): tabel `forecasts`, `ai_anomaly_alerts`, `ai_daily_summaries` + RLS tenant/outlet (migration 0090-0091). AI-07 forecast aturan (rata-rata hari+jam yang sama 8 minggu), AI-08 saran beli dari par level, AI-13 input roster (jumlah staf per jam dari forecast), AI-09 alarm anomali void/diskon/refund/waste (≥2x baseline 28 hari = warn, ≥3x = high, notifikasi lewat outbox `ai_insight.anomaly_detected`, kategori baru "Anomali operasional"), AI-10 ringkasan harian (LLM lewat gateway bila lolos preflight, kalau tidak templat Indonesia; dihitung cutoff + 3 jam, dihitung ulang 2 hari; outbox `ai_insight.daily_summary_ready`), AI-12 draf copy promo/menu dan AI-14 saran akun biaya (label "Dibantu AI", kode akun di luar daftar dibuang, scan PII, dibatasi brand dan badan hukum). Route `/api/ai/forecasts|purchase-suggestions|roster-inputs|anomalies|daily-summaries|drafts/*`, tiga job worker di relay tick.
- Celah data (kartu bd legend-39d.5-.7): AI-11 (belum ada tabel ulasan), AI-06 + pemakaian bahan berbasis forecast (belum ada resep, legend-db6), AI-14 rekonsiliasi + AI-09 selisih kas (belum ada tabel mutasi bank/selisih kas).
- Gelombang 4 (legend-9kkj): suite evaluasi AI `apps/api/src/test/ai-eval*` (362 kasus, ≥60 per kelompok peran: owner, shareholder, manager, employee, kitchen; termasuk tanpa jawaban, akses terlarang, prompt injection, PII). Test kebocoran deterministik dengan model tiruan lulus 366/366. Runner akurasi live `apps/api/scripts/ai-eval-live.ts` (hanya dengan `AI_EVAL_LIVE=1`, berbiaya, belum dijalankan), panduan `docs/ai-eval.md`.
- Gate handoff (aturan baru, tanpa suite penuh): tsc api/web/shared lulus, eslint lulus, 29 file test terkait 817/817 lulus, kontrak node lulus, `db:generate` kosong. Perbaikan test (fixture `ai-chat-api` tanpa setelan anggaran AI, tenant terisolasi dengan `created_by` bukan UUID merusak `/api/platform/tenants`), tipe id bermerek di forecast.
- Metrik sesi engineer (2726916d, 06:27-09:15, ±164 menit): 50 subagent (Sonnet 1246 req, Opus 340 req, Haiku 35 req), puncak 6 berjalan bersamaan, rata-rata 1,13; biaya* total 34.442k (satuan `session-usage.py`). Semua tugas di vendor Claude; second opinion Codex belum dijalankan.

### Handoff merge train WS-12

- Cabang `ws/ws12-ai`, basis `ws/ai-tool-catalog` d15542a8 + `milestone/m1` 4a040820. Katalog harus masuk lebih dulu.
- Migration (semua di-regenerate nomornya saat merge, isi SQL kustom dipertahankan): `0086_ai_tables`, `0087_ai_rls`, `0088_ai_role_templates_data`, `0089_ai_approval_policies_data`, `0090_ai_insights_tables`, `0091_ai_insights_rls`. 0086/0088/0089 memakai `NO FORCE` sementara saat seed lalu memulihkan RLS.
- Env baru (nama dari `.env.example`): `AI_MODEL` (default `claude-opus-5-5`) dan kunci provider. Anggaran bulanan default 0 = AI mati sampai owner mengisi.
- Belum siap pakai sampai: halaman consent MCP web (legend-39d.1) dan UI WS-12 (mockup belum disetujui).

## WS-02 edge hardening (engineer, cabang `ws/ws02-edge`, kartu legend-x3lv, 0835, wqc6, khu5, 2lp.8, 2lp.9, s4r6)

- Sudah: rotasi kredensial edge + masa tenggang (`graceHours`, `force`), lockout per alamat + bypass kredensial dikenal, revoke via LISTEN, prune antrean ack (simpan baris terbaru per agregat); QR order diteruskan ke edge, edge putus = 503 "Silakan pesan melalui waiter."; layar konflik sinkron + replay berurutan (kunci kursor, tolak bila konflik lebih rendah masih terbuka) + notifikasi `edge_sync_conflict`; event yang ditolak applier jadi konflik `applier_refused`, batch lanjut; bootstrap bundel tenant/outlet ke edge baru (HMAC hanya deteksi korupsi, autentisitas dari TLS); `pos_orders.is_training`; UI perangkat pakai kontrak shared (dialog daftar, terbitkan ulang token); applier `stock.moved` edge→cloud (allowlist sumber, tolak tabrakan ledger id dan dokumen beda outlet).
- Migrasi 0079/0080 dibuat dari merge-base e4938167; `milestone/m1` sudah sampai 0085, jadi merge train perlu regenerasi nomor.
- Keputusan: NPWP dan regionId kosong di edge setelah bootstrap; link "up" = heartbeat < 45 dtk; izin konflik = `device.registry.manage`, rotasi = `device.registry.revoke`; cek outlet lintas dokumen di s4r6 baca transaksi tenant-wide (hanya baris committed).
- Review: reviewer 2 putaran + architect (tingkat K). Second-opinion Codex wajib sebelum gerbang rilis.
- Hasil: `heavy pnpm check` 1828 lulus, 3 gagal (migrasi 0079 FK lewat outlets FORCE RLS untuk migrator NOBYPASSRLS) → FK dipindah inline, test migrasi 11/11. Test edge gabungan lulus setelah perbaikan test (bigint/ULID). Kartu ditutup. Berikut: second-opinion Codex (tingkat K), regenerasi nomor migrasi saat merge ke m1 (FK 0079 tetap inline).
- Gelombang (05:30–06:31, 61 menit): 21 subagent (Claude saja: Opus 295 req, Sonnet 313 req, Haiku 8 req), maks 8 berjalan sekaligus, rata-rata 1,1. Biaya* 14.242k (utama 3.288k, subagent 10.954k). 1 compact.

## legend-w1vo jembatan inventori ke GL (brief 87, engineer, 2026-11-09)

- Sudah: konsumen `stock.moved` → jurnal (opname `stock.adjusted#count`, waste `stock.adjusted#waste`, HPP `stock.deducted`) di `apps/api/src/services/inventory-gl-consumer.ts`, dipasang di worker cloud. Migration 0075 (`inventory_gl_postings`, `inventory_gl_blocked`, indeks sumber `stock_ledger`) dan 0076 (RLS). Periode tutup / pemetaan akun hilang: savepoint, sumber diparkir, sweep worker coba ulang dengan jeda 10 menit; cloud-sync tidak ikut tertahan.
- Diperiksa: typecheck, lint, `heavy pnpm build`, `pnpm format:check` hijau. Reviewer Opus 2 putaran + architect; temuan dibetulkan.
- Test: `src/test/inventory-gl.test.ts` 18/18 lulus; `heavy pnpm check` hijau (156 file, 1545 lulus, 1 skip). Sisa tanpa test: gerbang edge di worker-main, jalur `consumeOutbox` sungguhan.
- Keputusan: satu jurnal per dokumen sumber per tanggal bisnis; nilai dari baris ledger, bukan harga rata-rata saat ini.

## Brief 101 retry webhook DOIT (engineer, cabang `ws/fix-doit-webhook`, 2026-11-09)

- Bug: retry webhook dengan eventId sama memakai identitas integrasi row lama tetapi payload baru; integrasi lain bisa menyelesaikan intent milik integrasi pertama.
- Fix (`payment-webhook.service.ts`): row tersimpan diproses memakai payload tersimpan. Bila integrasi penanda tangan tidak sama dengan row (atau row tanpa integrasi): tolak, audit `payment.webhook.integration_mismatch`, jawab 200 `ignored`. Pengisian row MALFORMED dijaga `payload IS NULL AND integration_id = penanda tangan` dengan `RETURNING`.
- Test: `src/test/payment-webhook-retry-integration.test.ts` 7 test (4 dari 5 awal merah di kode lama). Webhook: retry 7/7, `payment-webhook-api.test.ts` 89/89 (rerun sendiri; timeout PAY-02 sebelumnya karena beban). Typecheck api lulus, eslint + prettier berkas berubah bersih, `db:generate` kosong.
- Review: reviewer Opus + architect; temuan (null integrasi fail-open, UPDATE MALFORMED tanpa guard, celah test) dibetulkan.
- Beads: legend-srf6 (kunci dedupe tanpa integrasi, risiko diterima), legend-dnkm (callback refund tanpa ikatan integrasi), legend-f03o (secret dipakai bersama antar integrasi).
- Gate penuh: oleh merge train. Second opinion Codex: antre.

## Brief 102 temuan Codex EDC + tender port + override edc_standalone (engineer, cabang `ws/fix-edc-codex`, 2026-11-09)

- Temuan 1 (`agent.ts` not_found): trace dicek sebelum outcome diterapkan; not_found tanpa trace jadi unknown. Simulator mengembalikan trace.
- Temuan 2 (ownership/stop): ownership dicek sebelum tiap panggilan terminal (sale, inquiry, guardRetry, cancel); tiap panggilan dilacak per outlet; `stop()`/`releaseOutlet` menunggu semuanya. `writeAhead` membaca ulang terminal `FOR KEY SHARE`.
- Temuan 3 (config terminal berubah): ubah bank/TID/MID/koneksi/IP ditolak `EDC_TERMINAL_BUSY` selama ada row pending/unknown. Tanpa migration.
- Temuan 4 (PAN): cardType allowlist; rrn/invoiceNo/batchNo/approvalCode dengan deret 13-19 digit jadi null saat tulis dan baca. `bankRef` standalone dan reference tender juga disaring.
- legend-dahk: `setPosEdcTenderPort(edcTenderSettlement)` di `app.ts`; reference EDC = nomor order.
- legend-m4fv: action override `edc_standalone`, permission `pos.edc_standalone.approve`, PIN supervisor + nomor referensi bank; row `edc_transactions` mode standalone, `needs_reconciliation=true`; override sekali pakai; nominal = sisa tagihan.
- Migration `0103_pos_override_edc_standalone`, `0104_edc_standalone_permission` (sebelumnya 0099/0100, direnomor di prep m1 726515a4). `db:generate` kosong.
- Test terarah: 19 file (edc-_, pos-edc-_, pos-order*, device-pin-service, payment-admin-api, staff-override*) 227/227 lulus. Typecheck shared/api/web lulus; eslint + prettier berkas berubah bersih.
- Review: reviewer Opus 3 putaran + architect; semua temuan High/Medium dibetulkan. Sisa Low: `stop()` tanpa batas waktu (bead baru).
- Tidak diubah: skip e2e EDC-01/02/04 di `prep/e2e-az` (merge train). Data PAN lama: legend-5gub. Gate penuh: merge train. Second opinion Codex: antre.

## legend-s5c1 PPh 21 prior-year builder (engineer, cabang `ws/pph21-prior`, 2026-11-09)

- Sudah: `buildPph21Prior` (payslip-tax.ts) mengisi semua field `prior`, termasuk tunjangan pajak gross-up dan basis skema. `PayslipTax` kini menyimpan `grossSchemeBaseIdr`/`employerSchemeBaseIdr`. Run service menerima `priorPeriods` (payslip masa kerja berjalan), bukan jumlah mentah.
- Bukti: 231 test terarah lulus (11 file payroll/PPh 21), typecheck shared/api/web dan eslint bersih. Reviewer Opus 2x (fuzz 40k + 30k tahun) tanpa temuan, architect: arah benar, saran simpan basis diterapkan.
- Sisa: sambungan lock ke `lockPayrollRunTax` menunggu run service (legend-07eg). Bug engine pembagian shortfall: legend-6q7o (K, P1). Merge BPA1 rehire: legend-70dm.

## Brief 100: race expiry approval (9 Nov 2026, ws/fix-journals-expiry)

- Sudah: `resolveApprovalChainOutcome` di `platform-approval.service.ts` (kunci chain head, expire bersyarat `status='pending'`, emit `approval.resolved` + audit sekali, helper bersama dengan sweep). Dipakai settle jurnal manual, jurnal berulang, POS override, dan stock count (cancel lokal dibuang; multi-level aman).
- Bukti: test race baru 10/10 GAGAL di kode lama (13425b65), lulus di kode baru. `heavy pnpm check` hijau (1432 test). Reviewer Opus 2 putaran + architect; temuan multi-level stock count dibetulkan.
- Bead: legend-2tcj (jalur reject stock count masih baca outcome tanpa lock, lama).
- Keputusan: expiry lewat deadline kini tercatat `expired` di layanan approval (bukan override lokal); stock count yang lewat deadline tercatat `expired`, bukan `cancelled`.

## legend-yw90 + legend-lrsx sapu container test PG bocor (engineer, cabang `ws/testdb-cleanup`, 2026-11-09)

- Sudah: label `legend.test.owner=<pid>.<start>.<namespace>` di container dan jaringan test PG (`compose.test.yaml`); `scripts/test.mjs` menyapu proyek `starter-pg-test-*` yang pemiliknya mati di awal run (`scripts/test-sweep.mjs`), menangani SIGHUP, dan menghapus paksa per proyek bila `compose down` gagal. Manual: `node scripts/test-sweep.mjs [--dry-run] [--legacy-older-than-min=N, N >= 1]`.
- Keputusan: pemilik dianggap mati hanya bila PID tidak ada atau waktu start beda (Linux `/proc/<pid>/stat`; lainnya `ps lstart`, toleransi 5 dtk); label dari namespace lain atau format lama tidak pernah disapu; sumber daya tanpa label (skrip lama) tidak disapu otomatis.
- Diperiksa: `tests/test-sweep.test.mjs` 15/15; eslint + prettier bersih; simulasi `kill -9` lalu run ulang menyapu sisa tanpa menyentuh run lain.
- Belum diuji: `mem_limit` 512m (`STARTER_TEST_PG_MEM` mengganti) hanya dicoba dengan satu file DB, belum suite penuh. Naikkan default ke 768m bila gate merge train kena `connection terminated`.

## legend-6q7o + legend-6p71 PPh 21 pembagian kekurangan Jan-Nov (engineer, cabang `ws/fix-6q7o`, 2026-11-09)

- Sudah: periode terakhir membagi kekurangan Jan-Nov (H) dulu, baru pajak bulan ini. proportional: H dibagi per basis skema dikurangi yang sudah dibayar tiap pihak; gross_first: bagian karyawan = pajak tahunan atas basis gross saja dikurangi pajak karyawan. Periode tanpa bayar: karyawan hanya menanggung bagiannya atas H. 6p71: pajak perusahaan terdahulu eksak (borne + allowance); allowance wajib bila riwayat campur; kedua basis skema harus menjumlah ke bruto.
- Bukti: reproduksi di engine 10051952 gagal 9/20 test baru. Kini 186 test terarah lulus (8 file), db:generate kosong. Angka referensi hitung tangan (python big-int) oleh 3 test-writer. Architect: A/C/D benar, B gross_first diganti (diterapkan). Reviewer Opus: fuzz 200k + replay 6k tanpa pelanggaran invarian; 1 temuan pra-ada dicatat legend-m9gx.
- Sisa: legend-u1xq (H<0 kredit perusahaan, K), legend-m9gx (bulan hanya-BPJS), legend-wtpf tetap terbuka (sumber DJP belum pasti). Keputusan CTO 2026-11-08 R62b (seluruh T mengikuti mix) digantikan aturan C. Second-opinion Codex antre (K).
- legend-m9gx (keputusan CTO 2026-11-09): bulan yang hanya punya BPJS perusahaan mengikuti skema perjanjian kerja lewat input baru `contractTaxScheme` (wajib bila baris kena pajak berjumlah 0). gross_up → tunjangan, net → borne, basis tersimpan G* = 0. Repro reviewer W 297.609 → 0 (T 7.219.600 seluruhnya tunjangan). 9/14 test baru gagal di HEAD sebelumnya; kini 200 test terarah lulus, typecheck shared/api/web, eslint, dan prettier bersih. Reviewer Opus: tanpa bug, 5.786 kasus dengan baris identik dengan HEAD. Sumber data skema kontrak belum ada: legend-rhq5 (kolom employment_contracts, memblokir legend-07eg).

## legend-rhq5 skema pajak di employment_contracts (engineer, cabang `ws/contract-tax-scheme`, 2026-11-09)

- Sudah: kolom `tax_scheme` (gross | gross_up | net) NOT NULL + CHECK. Migrasi 0103 (diregen jadi 0118 di batch3): kontrak lama di-backfill 'gross' lewat ADD COLUMN DEFAULT (tanpa UPDATE per baris, aman di bawah FORCE RLS tanpa BYPASSRLS), lalu DROP DEFAULT, jadi kontrak baru wajib menyebut skema. DTO `employmentContractSchema.taxScheme`; `createEmploymentContract` mewajibkan taxScheme dan mencatatnya di audit; tab kontrak di web menampilkan "Skema PPh 21".
- Bukti: typecheck shared/api/web, eslint, dan prettier bersih; db:generate kosong. Test terarah lulus: 50 (hris-db, migrasi 0103, migrasi edge tanpa BYPASSRLS, migrasi policy PPh 21) + 16 (guard katalog RLS). Architect: rencana benar, DROP DEFAULT disetujui, renewal tidak menyalin skema. Reviewer Opus: tanpa temuan.
- Sisa: legend-07eg memilih kontrak yang berlaku di periode, lalu mengisi `contractTaxScheme` ke `computePayslipTax`. Belum ada form atau route create kontrak, sehingga skema hanya diisi lewat service. Second-opinion Codex antre (migrasi, tingkat K).

## WS-08 website brand + pelanggan + delivery (brief 99, cabang `ws/ws08-site`, worktree `.worktrees/ws08-site`)

Diperbarui 2026-11-09 oleh engineer WS-08. Commit lokal saja, belum push/merge.

- legend-qgr6: `GET /api/public/site` + staff `GET/PUT /api/website/brands/:brandId/content` (tabel `brand_websites`, restrictive policy `tenant_wide_only`, `assertTenantWide` di semua jalur staff; syarat CTO terpenuhi: test 403 outlet-scope, tanpa kolom internal, reviewer Opus + architect: semua jalur terjaga).
- legend-o9fc + a8up (kontrak CRM: hash WhatsApp HMAC, referral + anti-fraud), gbkw (kirim ulang tautan DP), u0q8 (admin kebijakan reservasi), nloi + jh27 (Idempotency-Key promo, allowlist outlet promo).
- legend-5bn3 delivery: channel + sinkron menu/86, webhook ingest HMAC + idempoten, suntik ke POS/KDS, API pesanan, rekonsiliasi komisi, test penerimaan. Review Opus 3x + architect; semua blocker dibetulkan (void POS saat platform batal + event `order.voided`, kunci race KDS, indeks toko lewat fungsi SECURITY DEFINER).
- Kontrak berubah: `orderVoidedPayloadSchema.approvedBy` nullable (void sistem). Event baru `delivery_order.updated`.
- milestone/m1 sudah di-merge ke cabang (`a2dfc4ea`); migration WS-08 di-regen di atas 0098 m1.
- Tabel `delivery_store_index` masuk daftar pengecualian TEN-02 (`provision-roles.ts`, `rls.test.ts`): menunggu persetujuan CTO.
- Follow-up: legend-cbd0 (celah channel), legend-bk99 (panggilan platform setelah commit), legend-5d76 (selesaikan needs_review), kriteria keamanan di legend-im8n (penautan store id).
- Parkir (keputusan owner): legend-q1e0 + 9be7 (recompute promo saat refund parsial).
- Biaya sesi: ~21,5M token tertimbang (Opus utama 4,6M; subagent Opus 5,8M, Sonnet 11,0M, Haiku 0,2M); 54 subagent, puncak 7 bersamaan, rata-rata 1,65.

## Codex 68 struk: legend-3yqy, v3vo, 9wbc, ain0 (engineer, cabang `ws/fix-receipt-codex`, 2026-11-09)

- Basis `milestone/m1` dab1d592 (receipt 39296fae sudah di m1). Worktree `.worktrees/fix-receipt`. Sub-brief `docs/briefs/sub-fix-receipt-codex.md`.
- legend-9wbc: cherry-pick fix PO absolute-form (7c98db8f, legend-qni9; konflik digabung dengan redaksi struk) + test redaksi token struk JSON/PDF absolute-form. Merge train: cabang `ws/fix-codex-procurement` membawa commit yang sama, konflik `app.ts` diselesaikan dengan versi cabang ini.
- legend-v3vo: job email e-receipt didaftarkan di sweep tenant `worker-main.ts`, hanya di cloud (token link hanya ada di DB edge). Provider null: baris tetap queued.
- legend-3yqy: cloud memberi urutan `P<n>` saat enroll perangkat pos/kds/waiter_phone, backfill saat pull, edge menerima lewat `?receiptSequences=1`. Edge menolak urutan yang di cloud sudah > 0 (terminal di-enroll ulang). Cloud menolak penjualan perangkat di outlet yang punya edge aktif (`RECEIPT_DEVICE_ON_EDGE`). Standby tidak menerapkan urutan.
- legend-ain0: port celah nomor (POS-06) disambungkan di `app.ts`: Tutup Hari menolak `RECEIPT_SEQUENCE_GAP`, laporan shift menampilkan nomor hilang. Bagian edge sync merge dipisah ke legend-ol6v (terblokir legend-kai, legend-9fhs).
- Kartu lanjutan: legend-ol6v (applier run struk), legend-zsdd (urutan terikat satu edge node, release-gate), legend-19gb (e-receipt dari edge).
- Urutan rilis: cloud dulu, baru edge (edge baru selalu kirim `receiptSequences=1`; cloud lama menolak dengan 400 sehingga pull registri berhenti).

## legend-db6 resep/BOM + potong stok otomatis (engineer, cabang `ws/recipe-bom`)

- Selesai di worktree `.worktrees/recipe-bom`: tabel `recipes`, `recipe_lines`, `modifier_recipe_rules`, `outlet_inventory_settings`, `recipe_deductions`, `recipe_deduction_lines` (migration 0063 + RLS 0064; nomor dirapikan saat merge). Mesin ledakan resep bertingkat (sub-resep tanpa output diledakkan, sub-resep dengan output item diambil dari stok semi-finished), varian, modifier add/replace/remove, konversi satuan, waste gross-up. Mode real-time / tutup hari per outlet (override atas setelan tenant). Consumer `order.paid`, `day.closed`, `order_issue.recorded` (event baru) lewat worker cloud-sync; idempoten per order/issue/kunci. Duty meal via `POST /api/inventory/duty-meals`. CRUD resep memakai kontrak yang sudah ada (`/api/inventory/recipes`, `/versions`).
- Keputusan: semua bahan diambil dari `sale_location_id` outlet; konfigurasi kurang (tanpa resep, tanpa lokasi, resep nonaktif) dicatat `skipped`, tidak melempar error (supaya outbox tidak macet). Comp = barang gratis yang tidak ada di baris tertagih.
- Bead lanjutan: `legend-p4z1` (KDS emit order_issue.recorded), `legend-fbms` (order total 0 tidak emit order.paid), `legend-q55i` (repost skipped), `legend-3kdd` (FK menu → recipes), `legend-89zm` (rute lokasi per item).
- Berikut: review CTO, merge ke `main` (rapikan nomor migration).

## legend-0ogy refund DOIT lewat PaymentRefundPort (engineer, cabang `ws/doit-refund`, 2026-11-09)

- Dasar: `ws/fix-refund-quarantine-ops` (84a89e35) + merge `milestone/m1` (dab1d592, provider DOIT). Merge bersih, journal migrasi tanpa duplikat, tanpa migrasi baru.
- Kontrak DOIT (docs resmi): hanya `POST /v1/payments/{id}/refunds` + Idempotency-Key. Bentuk respons refund, GET refund, dan isi webhook `refund.*` tidak didokumentasikan. Desain fail-safe: `getRefundStatus` tidak pernah `not_found` (refund hanya dikirim sekali), bentuk tak dikenal = hasil tak diketahui, `failed` hanya untuk penolakan definitif kiriman pertama (409 `payment_not_refundable`, 400 `invalid_refund_amount`, 502 `provider_refund_failed`).
- Adapter: `createDoitGateway` juga `PaymentRefundPort` (kredensial integrasi pencetak intent). Webhook `refund.succeeded/failed` ke `applyRefundProviderUpdate` lewat idempotency key, refund id, atau objek payment (hanya refund penuh, tepat satu kandidat, bukan refund dana). Integrasi penanda tangan wajib sama dengan pencetak intent (menutup legend-dnkm). Poll: sweep `sweepApprovedRefundPayouts` yang sudah ada.
- Kill switch `DOIT_REFUNDS_ENABLED` (default off). Saat off, sweep dan payout tidak meng-claim (tidak menaikkan `payoutAttempts`).
- Review K: reviewer Opus (3 bug refund dana tak teralokasi + intent manual + kebocoran kill switch) dan architect (kill switch, `pending` saat payment masih `paid`, cek reference) dibetulkan semua.
- Sebelum switch dinyalakan: verifikasi sandbox DOIT (bentuk respons, payload webhook, masa simpan kunci) dan putuskan reset satu kali `payout_attempts` refund lama yang sempat di-claim gateway kosong.
- Gate penuh: oleh merge train. Second opinion Codex: antre.

## legend-a7x7 + legend-4ryw provisioning default (engineer, cabang `ws/provisioning-default`, 2026-11-09)

- Entitas legal baru (`createLegalEntity`) langsung mendapat bagan akun standar F&B (58 akun) + 39 mapping default dalam transaksi yang sama, satu audit `accounting.chart.provisioned`. Entitas yang sudah punya akun tidak disentuh (`already_present`); jumlah role tanpa mapping dilaporkan sebagai `missingRoles`.
- Outlet baru (`createOutlet`) mendapat enam lokasi stok (Gudang Utama, Chiller, Freezer, Bar, Dapur, Pastry) + katalog UOM standar tenant (12 satuan, `STANDARD_UOM_CATALOG` di `@starter/shared/inventory`). Tenant baru (`createTenant`) mendapat katalog UOM. Semua idempoten, tidak mengubah baris lama; lokasi yang namanya bentrok dilewati. Kunci per outlet sama dengan route lokasi.
- Backfill: `pnpm db:backfill-defaults [--tenant <uuid>]` (`apps/api/src/db/backfill-tenant-defaults.ts`). Jalankan di luar jam operasional, satu tenant sekali jalan: backfill bersamaan dengan admin membuat akun pertama di entitas kosong bisa mencampur template dan akun custom (catatan reviewer, diterima brief).
- Tanpa migrasi (`db:generate` kosong). Test: `apps/api/src/test/provisioning-defaults.test.ts`.
- Follow-up: legend-9ppw (lokasi, UOM, CoA belum ikut ke edge node; celah sudah ada sebelumnya).
- Belum: second-opinion Codex (tingkat K) diantre CTO sebelum gerbang rilis.

## Brief 131 tiga bug kecil POS dan stok (engineer, cabang `ws/small-bugs-pos-stock`)

- Sudah: `legend-2tcj` reject stock count kini mengunci kepala chain (`resolveApprovalChainOutcome`) sebelum membaca hasil approval; test balapan di `approval-expiry-race-modules.test.ts` (pg_locks, merah tanpa fix). `legend-t8xt` urutan outbox di `pos-shift.test.ts` kini `ORDER BY created_at, sequence, id` (sequence per agregat bisa sama); 3 run 62/62.
- Ditahan: `legend-fbms` (order.paid total 0) butuh ubah skema `packages/shared` dan keputusan desain (A: order.paid total 0 tanpa tender, atau B: event baru `order.settled` plus konsumen recipe-deduction yang hanya ada di `integ/m1-batch3`). Menunggu CTO.

## legend-2qz7 service charge default 5% (engineer, cabang `ws/service-charge-default`, 2026-11-09)

- Keputusan founder Q25: tenant baru (panel Platform) mendapat aturan `SC-DINE-IN` tenant-wide, 5%, `dine_in` dan `reservation` (QR dine-in ikut; keputusan CTO legend-9flj), kelas F&B, v1 published, berlaku sejak 2024-01-01, dalam transaksi `createTenant`. Outlet baru (`createOutlet`) mendapat aturan outlet-scoped yang sama, KECUALI tenant sudah punya aturan service tenant-wide apa pun (kode apa pun): aturan outlet akan mengalahkan aturan owner dan mengubah tagihan diam-diam. Seed: `provisionDefaultServiceChargeRule` di `tax-provisioning.service.ts`. Idempoten, kunci advisory per tenant, audit `tax.service_charge.provisioned` (outlet id tercatat untuk aturan outlet).
- Tenant dan outlet lama TIDAK di-backfill; `backfillTenantTaxDefaults` tidak menyentuh service. Mesin hitung tidak diubah. Takeaway dan delivery tanpa service.
- Dampak: preview dine-in tenant baru Rp 100.000 menjadi service 5.000, pajak 10.500 (PBJT menghitung service dalam dasar), total 115.500. Test lama di `tax-provisioning`, `platform-org-api`, `platform-admin-provision` diperbarui.
- Tanpa migrasi (`db:generate` kosong). Test: `apps/api/src/test/tax-service-default.test.ts` (14).
- Review K reservasi: order POS `channel: reservation` dengan `serviceType` takeaway/delivery tidak ditolak dan kini kena service 5% (belum ada pemanggil di kode; jalur POS di luar scope): diperbaiki di legend-6u81: `createPosOrder` menolak `reservation` selain `dine_in` (VALIDATION_ERROR). `posPriceChannel` dan `order.paid` tidak diubah. Review K: tidak ada jalur lain yang membuat order reservation.
- Follow-up: legend-mdh0 (publish boleh membuat tie aturan, `TAX_RULE_AMBIGUOUS` memblokir checkout; lock seed di `createServiceChargeRule`; actor `createOutlet`), legend-9flj (pertanyaan founder: channel reservation).
- Belum: second-opinion Codex (tingkat K) diantre CTO sebelum gerbang rilis.

## Brief 129 reset refund lama + persiapan sandbox DOIT (engineer, cabang `ws/doit-sandbox`, 2026-11-09)

- Sudah: legend-d21p `pnpm db:reset-preswitch-refunds` (`apps/api/src/db/reset-preswitch-refund-payouts.ts`). Default dry-run; `--apply` wajib `--touched-before <waktu deploy 5316426a>` dan `--ids <file yang ditinjau finance>`. Reset `payout_attempts=0`, `last_payout_error` NULL kecuali `PAYOUT_QUARANTINED`, satu audit `payment.refund_payout_preswitch_reset` per baris dalam transaksi yang sama. Guard: flag di env script, jejak kiriman DOIT (provider_ref, polls, `DOIT_%`, provider_declined). Test 11/11.
- Keputusan: baris quarantined ikut di-reset tapi tetap `PAYOUT_QUARANTINED` (bisa di-release/re-open ops). Cutoff `updated_at` menutup jalur bayar ganda dari timeout DOIT nyata (temuan reviewer Opus + architect).
- Sudah: legend-0yd1 harness `docs/qa/doit-sandbox-refund.md`; bukti mentah di `docs/qa/evidence/doit-sandbox/` (gitignore lokal, hanya `*.redacted.*`).
- Berikut: CTO minta rahasia sandbox (apiKey, webhookSecret); legend-8cf3 runner production; legend-xd2q refund yang dikecualikan finance.
- Sudah (legend-8cf3): runner production `node dist/reset-preswitch-refunds.js` lewat wrapper host `deploy/single-vm/reset-preswitch-refunds.sh` (baca switch dari api/worker/migrator env dan container berjalan, tolak `--apply` bila menyala, bila container api/worker tidak ada, atau `COMPOSE_PROJECT_NAME` diekspor; mount `--ids` read-only; marker `LEGEND_RESET_WRAPPER=1`). Job tanpa wrapper atau tanpa nilai switch: exit 2. Langkah di `docs/deployment.md`. Cutoff = start worker PERTAMA dari 5316426a atau sesudahnya. Review K 2 putaran (Opus + architect) selesai.
- Sudah (legend-0yd1): host sandbox = `https://pay.doit.id`, lingkungan dipilih prefix kunci `pb_test_`. Integrasi DOIT dev tenant aktif di DB lokal worktree; API lokal port 4610 + quick tunnel cloudflared. 3 payment sandbox dibuat; refund payment `pending` = 409 `payment_not_refundable`; replay create = 200 body sama.
- Berikut: founder daftarkan URL webhook + Simulate paid, lalu uji refund parsial/penuh/replay/webhook.
- Sudah (legend-xd2q, 9 Nov): refund yang dibayar finance manual ditutup tanpa payout lewat `POST /api/payments/admin/refunds/:refundId/settle-manually` (`settleRefundManually`): status `completed`, marker `SETTLED_OUTSIDE_PROVIDER`, audit `payment.refund_settled_manually` dengan bukti (paidAt, channel, externalReference, amountIdr, catatan), payment dan fund berubah seperti penyelesaian provider. Syarat: approved, provider_ref NULL, polls 0, lease bebas (lease yang habis tetapi belum dibersihkan ditunggu 10 menit), nominal sama; aktor payment.reconcile + pos.refund.approve, bukan peminta, MFA wajib. Tripwire: refund yang mungkin terkirim tidak pernah di-POST ulang; `not_found` memberi flag `PAYOUT_NOT_FOUND_MAYBE_SENT` + audit; cek lease tepat sebelum POST. Sukses atau pending dari provider pada refund yang di-settle manual = konflik (worker dan webhook, termasuk webhook tanpa idempotency key lewat payment object). Review K: Opus 2 putaran + architect, temuan diperbaiki. Test 202/202 (8 berkas). Lanjutan: legend-17ml (refund macet di provider), legend-6s94 (persetujuan dua orang untuk settle manual).
- Sedang: legend-0yd1 uji sandbox menunggu founder mendaftarkan URL webhook tunnel baru (tunnel lama mati setelah sesi restart).

## legend-mdh0 publish tidak boleh membuat tabrakan aturan service (engineer, cabang `ws/service-charge-default`, 2026-11-09)

- `publishServiceChargeRule` memanggil `assertNoServiceChargeOverlap` (`tax.service.ts`): versi aktif yang akan terbit dibandingkan satu per satu dengan tiap aturan service yang sedang berlaku (memakai `resolveServiceChargeRule` dan `effectiveRuleVersions` engine yang sama, engine tidak diubah), pada tanggal efektifnya dan tiap tanggal mulai aturan lain sesudahnya. Bila sama peringkat dan cakupan beririsan: `TAX_RULE_AMBIGUOUS` (409), pesan Indonesia menyebut kode aturan lawan, publish di-rollback. Pasangan satu per satu (bukan terhadap seluruh himpunan) supaya tabrakan tidak bisa bersembunyi di bawah aturan yang lebih kuat. Versi tidak aktif tidak dicek: untuk mengganti `SC-DINE-IN`, terbitkan dulu versi tidak aktifnya.
- Kunci advisory seed dipakai juga oleh `createServiceChargeRule` dan `publishServiceChargeRule` (`lockServiceChargeConfig`, kunci pertama di publish sebelum kunci baris). Dua publish bersamaan yang bertabrakan: satu lolos, satu 409.
- `createOutlet` membawa user pembuat (`routes/org.routes.ts` meneruskan `getAuth(req).user.id`): audit `tax.service_charge.provisioned` dan `publishedBy` memakai owner, bukan sistem.
- Tidak dicek: tabrakan yang sudah ada sebelum guard ini; seed dev `seed-dev-tenant.ts` melewati guard.
- Test: `apps/api/src/test/tax-service-overlap.test.ts` (15). Tanpa migrasi.

## Brief 145 kasir menebak isi laci lewat kas keluar (engineer, cabang `ws/pos-drawer-guess`, 2026-11-09)

- Sudah: kas keluar/setoran di atas saldo laci yang diharapkan tidak lagi ditolak (409 + batas 2 penolakan M1 dihapus). Dicatat 201 dengan bentuk respons sama, ditandai `cash_movements.needs_approval`, dikeluarkan dari angka laci, diaudit `pos_shift.cash_movement_held`. Supervisor melihat `needsApproval` di daftar kas dan `heldCashOutIdr` di jejak hitungan; tutup shift (kasir dan paksa) basi bila jumlah yang ditahan berubah setelah hitungan. Total kas keluar + setoran per shift dibatasi safe integer.
- Basis: `ws/small-bugs-pos-stock` belum berisi M1, jadi `milestone/m1` digabung ke cabang (`a4e12810`).
- Migrasi: `0113_little_random.sql` (diregen jadi `0134_icy_synch.sql` di merge train batch6).
- Keputusan: tabel `cash_movement_refusals` dipertahankan sebagai riwayat; kunci lama yang pernah ditolak kini mencatat bila body sama. `noteRequired` tetap hanya dari variance (bukan dari jumlah ditahan) supaya tidak jadi oracle. Baris ditahan tidak boleh diposting ke pembukuan; uang yang benar keluar masuk lewat variance shift.
- Lanjutan: `legend-pspy` (UI supervisor/kasir), `legend-utqr` (refund/void tunai masih menolak di atas saldo laci, oracle serupa).

- Sudah (legend-0yd1, 9 Nov): uji sandbox DOIT. Webhook `webhook.test` dan `payment.paid` tersimpan dengan signature sah. Refund: create 201 sinkron `succeeded`; replay 200 dengan `amount` string; kunci dipakai ulang dengan body lain mengembalikan refund asli; payment `refunded` hanya setelah satu refund penuh, refund parsial tetap `paid`; sandbox tidak membatasi total refund parsial (Legend membatasi sendiri lewat `refundableBalance`). Webhook refund nyata berbentuk flat `{amount, refund_id, payment_id}`: parser diperbaiki agar cocok lewat `refund_id`, replay `amount` string diterima, `payment_id` dicek. `refund.failed` tidak bisa dipicu di sandbox. Hasil: `docs/qa/doit-sandbox-refund.md` bagian 9, bukti `docs/qa/evidence/doit-sandbox/0yd1-results.redacted.json`. Review K Opus + architect: tanpa temuan nyata, dua hardening rendah dikerjakan.
- Sudah (legend-0yd1, 9 Nov): bukti webhook DOIT nyata dengan API di ff4dac27. Refund 1000 di `pay_3N-1K5igG03DWXKD` lewat `runRefundPayout` asli: `completed`, `rf_UptAadAvh77BHLEh`. Webhook `refund.succeeded` signature sah, `processed`, cocok ke refund Legend. `pay_k5xyzGW_UZgCwbDh` sudah refund penuh (409), jadi tidak dipakai. Setelah itu API 4610 dan tunnel dimatikan; webhook didaftarkan ulang ke domain VPS nanti. `DOIT_REFUNDS_ENABLED` tetap off sampai jawaban tertulis DOIT dan Codex brief 134.
- Berikut: pertanyaan tertulis ke DOIT (finalitas `refund.failed`, arti 502, retensi idempotency key, batas refund kumulatif di production).

## legend-utqr refund dan void tunai tanpa membocorkan isi laci (engineer, cabang `ws/pos-drawer-guess`, 2026-11-09)

- Sudah: refund dan void tunai di atas saldo laci tidak lagi ditolak 409 "Tunai di laci tidak cukup". Dicatat 201 dengan bentuk respons, event, dan audit biasa yang sama, ditandai `pos_order_refunds.needs_approval` / `pos_order_voids.needs_approval`, dikeluarkan dari angka laci, masuk `heldCashOutIdr` jejak hitungan supervisor, diaudit `pos_order.cash_refund_held` / `pos_order.cash_void_held` tanpa angka expected. Tutup shift basi bila jumlah ditahan berubah setelah hitungan. Approval yang sudah dipakai tidak bisa diulang: tidak ada lagi penolakan yang bergantung pada laci setelah `consumeApproval`.
- Selisih buku = counted − expected + held. Dipakai untuk `noteRequired`, aturan catatan tutup shift (`closeShift`, check DB `pos_shifts_closed_check`) dan `differenceIdr` event `cashier_shift.closed` (refund ditahan sudah dikredit lewat `order.refunded`, jadi tidak dibukukan dua kali). `pos_shifts.variance_idr` tetap counted − expected; nilai approval tutup shift tetap |counted − expected|. Ini mengganti keputusan brief 145 ("noteRequired hanya dari variance").
- `pos_shifts.held_cash_out_idr` diisi saat tutup dari hitungan yang dipakai (trigger `app.pos_shifts_guard` memastikan sama). Refine catatan U9 dihapus dari `posShiftSchema` (DTO kasir tidak membawa held).
- Migrasi: `0136_public_turbo.sql` (kolom `needs_approval`, `held_cash_out_idr`, check) dan `0137_pos_shifts_guard_held_cash.sql` (trigger `app.pos_shifts_guard`), diregen dari `0114_brave_golden_guardian` + `0115_daily_stone_men` di merge train batch7.
- Lanjutan: `legend-nib1` (P1, approval tutup shift via HP membocorkan selisih lewat ambang matriks), `legend-ifnb` (P1, rekap tutup hari menghitung kas ditahan dua kali dan selisihnya tidak cocok dengan jurnal), `legend-89pn` (tidak ada aturan posting `cash_movement.recorded`), `legend-pspy` (UI).

## legend-ifnb dan legend-nib1: rekap tutup hari dan approval tutup shift lewat HP (engineer, cabang `ws/pos-drawer-guess`, 2026-11-09)

- legend-ifnb: rekap tutup hari menjumlahkan selisih buku per shift (`variance_idr + held_cash_out_idr`, sama dengan `differenceIdr` event `cashier_shift.closed`). Kas refund yang ditahan tidak lagi dihitung dua kali, dan `totalVarianceIdr` cocok dengan jurnal.
- legend-nib1: permintaan approval tutup shift lewat HP dibuka tanpa nominal (`amountIdr` null), jadi routing selalu tier tertinggi matriks. Penutupan dicek terhadap tier tertinggi dan `payload.valueIdr` (angka, sama dengan selisih). Chain lama yang punya nominal ditolak; kasir minta ulang. Respons ke kasir (pending, requiredLevels, 403 PIN) tidak lagi bergantung pada selisih.
- Keputusan bisnis terbuka (untuk founder lewat CTO): setiap tutup shift, termasuk selisih 0, sekarang butuh penyetuju tier tertinggi `cash_shift_close`. Bila tier tertinggi 2 level, PIN tidak pernah cukup dan semua tutup shift lewat HP.
- Lanjutan: `legend-6om3` (UI inbox membaca `payload.valueIdr`), `legend-o0w6` (event `pos_override.recorded` membawa selisih ke cloud-sync).

## legend-9pz9 jurnal otomatis F19 (o9q9 di dalamnya), cabang `ws/dp-late-journal` (2026-11-09)

- Sudah: desain `docs/design/auto-journals.md` (5fc862cb); slice 1 (fondasi, penjualan POS, penerimaan gateway, dana tak teralokasi, payout, DP, bayar telat, parkir + sweep) b6ca419d..a9c8ca14. Migrasi 0113 (DDL) + 0114 (RLS + backfill 2107/7103), wajib diberi nomor ulang di merge train (batch4 memakai 0113-0132).
- Review K: Opus + architect tiga putaran. Temuan nyata dibetulkan: dana tak teralokasi tanpa receipt, FK outlet, error non-akuntansi, kunci receipt per intent, EDC fail-closed, guard backfill, fingerprint, guard cutover/urutan (order.paid sebelum payment.paid sekarang parkir AUTO_JOURNAL_RECEIPT_PENDING; urutan baca outbox, parked, jurnal), event tanpa outlet tidak melempar (audit `accounting.auto_journal.unparkable`).
- Patch wiring worker: `docs/briefs/141-auto-journals-wiring.patch` (main checkout), dipasang setelah batch 3 masuk m1. Brief Codex: `docs/briefs/142-second-opinion-auto-journals.md` (3 run, maks 800 baris).
- Bead turunan: legend-2jyr (refund dipecah per intent), legend-3a5m (bukti settlement nol), legend-tgb3 (GL persediaan parkir PERIOD_CLOSED), legend-27mt (payout uang pra-cutover).
- Slice 2 (DP dipakai, DP hangus, tutup shift): 9fd84d0d (ACC-01, kontrak rule order.paid, terpisah), 42ef352d (label web customer_deposit), 21a289e7 (fitur), 5fc189b5 (fix review K: intent persis, cek DP yang masih ditahan, void penjualan DP ditolak), 226f1155 (refund DP setelah penjualan diparkir, pesan void ke admin). order.paid membawa paidDepositIdr, DTO order membawa depositAppliedIdr: API dan web wajib deploy bersama. Brief 142 ditambah run D (a9c8ca14..226f1155). Gate: tsc api/shared/web, eslint, 33 file test API (accounting*, RLS, payment-support, pos-order*, qr-order*, reservation*, pos-shift*) 432 lulus 1 skip, kontrak node 149 lulus.
- Biaya sesi ee66d9 sampai 07:24 UTC: total biaya* 14453k (utama Opus 5307k, subagent Opus 6588k, Sonnet 2355k, Haiku 203k), 41 subagent, maks 4 paralel, rata 1.1 berjalan.
- Bead slice 2: legend-z13t (tampilan finance RECEIPT_PENDING >1 hari), legend-3r6r (batas parkir saat payment.paid dead letter), legend-p7lx (sisa bayar POS web belum kurangi DP), legend-e7zj (P1, blocker gerbang rilis: modul refund harus menolak refund DP yang sudah dipakai).
- Migrasi: `0138_panoramic_star_brand.sql` (DDL) dan `0139_auto_journals_backfill_rls.sql` (RLS + backfill), diregen dari `0113_auto_journals` + `0114_auto_journals_backfill_rls` di merge train batch7; 0138 dibungkus NO FORCE/FORCE `outlets`, 0139 `legal_entities`, `chart_of_accounts`, `account_mappings` (migrator tanpa BYPASSRLS, legend-wg5t).
- Berikut: tunggu CTO. Slice 3 setelah batch 3/4 (QR kej3, total 0 fbms), slice 4 settlement + MDR, slice 5 setoran kas.
- Biaya sesi ee66d9 (05:55-06:42 UTC): total biaya* 9262k (utama Opus 3374k, subagent Opus 3582k, Sonnet 2187k, Haiku 119k), 28 subagent, maks 4 paralel, rata 1.34 berjalan.

## legend-o0w6: selisih tutup shift tidak lagi ikut event pos_override.recorded (engineer, cabang `ws/pos-drawer-guess`, 2026-11-09)

- Bukti jalur: hari ini event ini tidak sampai ke perangkat kasir. Di cloud `cloud-sync` hanya sink lokal; di edge hanya diantre `edge_to_cloud`; cloud→edge hanya `qr_order.placed` (tes routing di `worker-transport.test.ts`).
- Pertahanan berlapis: untuk `cash_shift_close`, `valueIdr` di payload event null (refine kontrak shared menolak angka). Audit supervisor dan baris override tetap menyimpan nilainya. Aksi lain tidak berubah. Tanpa bump versi: ingest edge→cloud hanya memeriksa envelope generik, jadi event lama tetap tersinkron.
- Lanjutan: `legend-eadm` (P1, edge→cloud melempar `EdgeEventUnclassifiedError` untuk `pos_override.*`/`staff_pin.*`, terkait `legend-niq9`; event lama masih menyimpan angka di tabel outbox/antrean, hanya akses DB).

## legend-e7zj refund DP yang sudah dipakai ditolak (engineer, cabang `ws/dp-refund-guard` dari `integ/m1-batch5`, 2026-11-09)

- Sudah: 72e4f973. Refund admin (WS-05) atas DP reservasi tidak boleh melebihi DP yang belum dipakai tagihan meja (409 REFUND_DEPOSIT_IN_USE); kredit DP sesi berkurang begitu refund diajukan (pending), kembali bila refund gagal. Aturan bersama di `apps/api/src/services/reservation-deposit-credit.ts`; `refundableBalance` memakainya, jadi approval dan daftar refund ikut.
- DP terpakai = maksimum dari DP yang diterapkan order dan tagihan yang tidak tertutup link pembayaran atau tender POS (meja open-bill ikut), sesudah DP lain di sesi, dibatasi alokasi bruto.
- Balapan: advisory lock per intent DP (shared di pembaca kredit, exclusive di refund, semua DP sesi berurutan naik). Urutan lock legend-94qt tidak berubah.
- Review K: Opus + architect, 3 putaran. Temuan nyata dibetulkan: approval tidak pernah menolak (in-use dihitung bersih), dua DP satu sesi tidak serial, meja open-bill tidak terhitung, tagihan POS tunai terhitung DP. Sisa (Low, diterima): order yang dibuat sesudah refund diajukan tetap dihitung, approval refund itu bisa gagal cap_exceeded, manajer mengajukan ulang lebih kecil.
- Gate: tsc api, eslint, prettier, 34 file test API (reservation*, payment-admin*, payment-refund*, qr-order*, pos-order*, table-session*, RLS) 478 lulus 8 skip, kontrak node 39 lulus.
- Brief Codex: `docs/briefs/157-second-opinion-dp-refund-guard.md` (main checkout, tidak di-commit).
- Berikut: tunggu CTO. Guard sementara di consumer jurnal otomatis (legend-9pz9, 226f1155) tetap dipakai sebagai pengaman kedua.

## legend-e087 + legend-qqvf: printer station dan 404 tiket KDS (engineer, cabang `ws/station-printer`, 2026-11-09)

- Basis `integ/m1-batch7` 6f3063c7. `ws/print-agent` belum masuk batch integ mana pun; tabel `devices` (tipe `printer`) sudah ada di batch7, jadi validasi tidak menunggu print-agent.
- legend-e087 (8663be44, 5864a36c): `printerDeviceId` station harus device `printer` aktif (tidak revoked) di tenant dan outlet station. Semua kasus tidak valid (outlet lain, tenant lain, bukan printer, revoked, UUID acak) menjawab 422 yang sama. Nilai yang tidak berubah (echo, beda huruf besar-kecil) tidak divalidasi dan tidak ditulis, jadi form lama tidak menimpa perubahan manager. Baris device dibaca `FOR SHARE`.
- legend-qqvf (91db56eb): tiket dan item dari station lain menjawab 404 `NOT_FOUND`, sama dengan tiket yang tidak ada (detail, aksi tiket, prioritas, aksi item). Perubahan kontrak 403 ke 404 di `kds.test.ts` dan `e2e-az/az-d-kds.test.ts`. List dan feed station tidak berubah (sudah 403 untuk station asing maupun tidak ada).
- Review: reviewer Opus (5 Low, 3 dibetulkan, 2 diterima) dan architect (qqvf disetujui, 1 Medium e087 race echo dibetulkan dengan test yang gagal di kode lama).
- Gate: 8 file test 131 lulus 8 skip; setelah fix review station-printer, station-scope, kds 66/66; tsc api, eslint, prettier bersih. Suite penuh belum.
- Bead baru: `legend-z76q` (P2, dispatcher print cek ulang printer saat cetak), `legend-4qon` (P3, oracle 404 vs 422 station brand lain di `menu.service`).
- Biaya sesi 8d51c681 (06:43-07:53 UTC, termasuk akhir dak5): total biaya* 9922k (utama Opus 4869k, subagent Opus 2089k, Sonnet 2865k, Haiku 99k), 37 subagent sesi, task ini 6 subagent, maks 2 paralel.
- Berikut: verifikasi CTO, second opinion Codex rentang 6f3063c7..5864a36c sebelum gerbang rilis, merge train.

## legend-tjwb perbaikan temuan Codex 150 EDC PAN scrub (engineer, cabang `ws/edc-pan-fix` dari `milestone/m1` a8c90378, 2026-11-09)

- Masalah: pola PAN hanya menerima satu pemisah, jadi `4111  1111  1111  1111` atau `4111 - 1111-1111 1111` lolos di migrasi 0135, query deteksi runbook, dan scrub JS. Oracle test memakai ambang 13+ global, jadi PAN 12 digit di kolom teks bebas tidak tertangkap.
- Keputusan migrasi (dengan architect): migrasi baru `0141_edc_pan_scrub_separators.sql`, 0135 tidak diubah. Migrator drizzle hanya menjalankan file dengan `when` di atas migrasi terakhir yang tercatat dan tidak memeriksa hash; 0135 yang diedit tidak akan jalan ulang di dev/staging yang sudah menerapkannya, dan AGENTS.md melarang menulis ulang migrasi yang sudah diterapkan. 0141 mengulang scrub penuh; DB baru menjalankan 0135 lalu 0141 dalam satu batch.
- Pola: digit dengan spasi, tab, atau strip berulang/campuran (`[ \t-]*`). Titik tidak (nominal Rp). Ambang tetap: 13+ di rrn/invoice_no/batch_no/dispatch_batch_no, 12+ di card_type/message/masked_pan. 0141 juga melipat digit yang menempel ke `[disamarkan]` (sisa 0135 bisa menyisakan sampai 7 digit kartu).
- 0141 satu blok DO: NO FORCE, UPDATE, FORCE berhasil atau gagal bersama walau dijalankan autocommit, jadi FORCE RLS tidak bisa tertinggal mati. `lock_timeout` 5s lokal, dikembalikan.
- JS `packages/shared/src/edc/index.ts`: `cardNumberLike` (message tulis dan baca) dan `panLikeReference` (rrn/invoice/batch saat baca) memakai pola baru. `hasPanLengthDigits` (guard tender POS) sengaja tetap 13-19 digit beruntun: pola lebar menandai nomor order sendiri (`P261109-12345678`).
- Runbook: deteksi pola baru per kolom, eksekusi manual wajib `psql -v ON_ERROR_STOP=1 --single-transaction`, jangan jalankan 0135 manual, run manual akan diulang migrator (lock lagi), cek read-only `pos_order_tenders.reference`, catatan nomor ulang 0141.
- Test reproduksi gagal dulu: patterns 5/10 gagal, logs 10/10 gagal, migrasi 7/14 gagal (0141 kosong), lipatan sisa 0135 2 gagal sebelum fix.
- Review K: reviewer Opus 2 putaran + architect. Dibetulkan: sisa 7 digit dari 0135, false positive nomor order di guard tender, snapshot 0141 ikut di-commit, catatan runbook run ulang. Diterima: newline/NBSP sebagai pemisah tidak ditangkap; read path tidak melipat (migrator jalan sebelum API).
- Gate: tsc api dan shared, eslint, prettier lulus; 14 file test EDC/POS EDC 186 lulus; kontrak `edc-contract` 6/6; `node --test tests/*.test.mjs` 1661 lulus, 3 gagal karena butuh DB `pnpm test` (database, db-role-provisioning; jalan di merge train); `db:generate` kosong.
- Bead baru: `legend-2z04` (P3, oracle satu pemisah di edc-agent, edc-simulator, edc-contract).
- Biaya sesi a311d4dc (15:34-15:53 UTC+7 sebagian): total biaya* 3357k (utama Opus 1617k, subagent Opus 1269k, Sonnet 292k, Haiku 180k); parallel-report: 13 spawn, maks 3, rata 1,34 subagent berjalan.
- Berikut: CTO tentukan urutan merge (0141 bentrok nomor dengan `ws/shift-close-fix`), second opinion Codex brief 150b, merge train.

## legend-ymhh 0141 tidak lagi menghapus kode respons sah (engineer, cabang `ws/edc-pan-fix` di atas 36599100, 2026-11-09)

- Masalah (Codex 150b P2): 0141 melipat semua digit yang menempel ke `[disamarkan]`, jadi baris bersih `Kartu [disamarkan] - 51` kehilangan kode respons.
- Aturan baru, sama di SQL 0141, JS `maskCardNumbers` (tulis dan baca), dan query deteksi runbook: digit di samping mask dilipat hanya bila (a) disambung pemisah yang tidak bisa dilewati pola lama 0135 (2+ spasi/strip atau tab) dan (b) melebihi aturan struk: 7+ digit sebelum mask atau 5+ sesudah. `[disamarkan] - 51`, `[disamarkan] 05`, `- 1111`, `4111 - [disamarkan]` tetap.
- Efek yang diterima dan dicatat di runbook: angka sah 5+ digit sesudah mask dengan ` - ` (mis. kode approval `- 123456`) ikut terhapus, tidak bisa dikembalikan.
- Review K: reviewer Opus + architect paralel, keduanya setuju aturan lengkap (fuzz 300k-500k PAN, paritas SQL Postgres vs JS 3000 input, idempoten). Dibetulkan: catatan "tidak bisa dikembalikan" dikembalikan ke runbook dan header SQL, fixture `- 123456`.
- Gate: test gagal dulu (migrasi 2/14, pola 1/20), lalu 3 file `edc-pan*` 44/44; 14 file EDC/POS EDC 189/189; `edc-contract` 6/6; tsc api dan shared lewat heavy, eslint, prettier lulus.
- Bead baru: `legend-lg45` (P2, sisa PAN di pesan yang terpotong 200 karakter oleh jalur tulis lama; celah lama, bukan dari diff ini).
- Berikut: second opinion Codex run 2 (brief 150b, bagian Run 2), urutan merge 0141 vs `ws/shift-close-fix`.
