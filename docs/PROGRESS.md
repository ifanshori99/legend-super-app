# PROGRESS — Legend Super App

Diperbarui 2026-11-08 oleh CTO (coordinator Ghostex, sesi "CTO legend"). Founder menghentikan semua kerja untuk dilanjutkan di sesi baru.

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

## Brief 88 persiapan deploy (engineer, cabang `ws/deploy-prep`, worktree `.worktrees/deploy-prep`)

- legend-jtnd: peran migrator production `legend_migrator_<16 hex>` (NOSUPERUSER, BYPASSRLS, CREATEROLE, pemilik database), dibuat sekali oleh superuser bootstrap lewat `deploy/single-vm/provision-roles.sh --env-file ... --migrator` (`apps/api/src/db/migrator-role.ts`). Peran aplikasi dan queue tidak berubah (NOBYPASSRLS).
- legend-k1np: cek pra-deploy `node dist/predeploy-check.js` (`apps/api/src/db/predeploy-check.ts`), jalan sebelum migrate di `deploy.sh` dan provisioning first boot. Gagal bila migrator tidak bisa migrasi atau ada stream outbox yang sekuensnya bukan 1..N per tujuan.
- Runbook: `docs/deployment.md` ("Create the migrator login", "Pre-deploy check").
- Review: reviewer Opus + architect, semua temuan nyata sudah dibetulkan. Follow-up pra-ada: issue bd backup login `postgres`.
- Belum: test DB terakhir dan `heavy pnpm check` belum hijau karena forwarding port Colima untuk container baru mati (ECONNREFUSED), bukan karena kode. Jalankan ulang setelah Colima dipulihkan. Second-opinion Codex (tingkat K) masih perlu diantre CTO.

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
