# Pembersihan kartu bd basi vs milestone/m1 (2026-11-18, ronde 2)

Basis kode: `origin/milestone/m1` @ 68422e367 (fetch awal; ujung kini 0b4fe006c, semua bukti di bawah tetap ancestor). Kartu dinilai: 388 (isi `bd ready` non-epic, label epic dikecualikan). Ditutup: 6. Status review + komentar cabang: 36. Komentar saja (cabang sebagian): 2. Komentar sebagian (tetap terbuka): 28. Tetap terbuka tanpa perubahan: 314. Sudah ditutup CTO selagi dinilai: 2 (legend-g6ept, legend-ggv6d).

Metode: ronde 1 (`2026-11-09-bd-stale-cleanup.md`). 18 subagent Explore (22 kartu per batch, maks 8 bersamaan) menilai bukti lewat `git grep`/`git show origin/milestone/m1:<path>`; saya (qa) memverifikasi ulang tiap kandidat tutup di m1 (berkas, baris, nama test) dan menyilang semua id kartu dengan pesan commit m1 dan commit cabang belum landing (`git log --remotes --not origin/milestone/m1`). Default konservatif: ragu = tidak ditutup. Verdict OPEN dari Explore sering hanya berarti "tidak ada bukti di grep"; kartu OPEN belum tentu belum dikerjakan, hanya tidak terbukti selesai. Tidak ada test dijalankan.

## Ditutup

- legend-fnxl.10 (WS-07: tandai match basi saat jurnal yang dicocokkan dibalik): apps/api/drizzle/0438_bank_match_stale.sql; accounting-bank-recon-stale.service.ts:39, dipanggil accounting-journal.service.ts:1277; test apps/api/src/test/accounting-bank-recon-stale-match.test.ts:391-513; sha 044269815
- legend-l29ln (Recon 941 P3: migrasi 0433 lepas FORCE induk (journal_entries) dulu ba): apps/api/drizzle/0438_bank_match_stale.sql:10,12 (induk journal_entries dilepas dulu, lalu anak), restore :19,21; test apps/api/src/test/migration-0438-0439-owner-populated.test.ts:109,316,378; sha 046289063
- legend-of9kp (Daftar followup refund menampilkan refund dana parkir yang jatahnya ha): apps/api/src/services/system-refund-followup.ts; katalog packages/shared/src/i18n/messages/ws05-refund-followup.ts; test apps/api/src/test/qr-va-1029-of9kp-followup-list.test.ts:390-502; sha 499a9ca78
- legend-d769 (WS-05: take advisory lock tax:provisioning:<tenant> in createTaxRule/c): apps/api/src/services/tax.service.ts:500,582,636,824 lockTaxConfig; tenant-config-locks.ts; tax-provisioning.service.ts:155; test apps/api/src/test/tax-rule-overlap.test.ts:650-665 (advisory lock tax:provisioning:<tenant>)
- legend-hjpm2 (Kolom fee_idr polos supaya guard fee_posted membandingkan nominal jurn): apps/api/drizzle/0397_payout_posting_fee_idr.sql:20 (kolom fee_idr); 0409_payout_gl_insert_commit_check.sql:25 (guard fee_posted membandingkan fee_idr > 0); test payroll-payout-990-fee-commit.test.ts, payroll-payout-897-gl-fee-net.test.ts, payroll-payout-877-gl-fee-skipped.test.ts
- legend-arp35 (WS-03 UI: sambungkan split-panel ke API split bill sungguhan): apps/web/src/features/ws03-qr-order/components/bill/split-panel.tsx:34 useCreateSplits -> api.ts:118 createSplits (POST /splits), api.ts:165 bayar target split, api.ts:184 getSplitClaim; galat SPLIT_LOCKED/NOTHING_TO_SPLIT di split-panel.tsx:203, domain.ts:224-236; sha b6bb5348b

Tidak ditutup walau diusulkan: legend-hpze7 (allocatePickupCall dipanggil di pos-order.service.ts:991, test pickup.test.ts:43; butir "keputusan order ke-1000" tidak terbukti, diberi komentar), legend-316 (induk pengadaan; sebagian ada: drizzle/0173 goods_receipts, 0295 supplier_invoices, 0208 retur+petty; approval pembayaran dan test tidak diverifikasi, diberi komentar).

## Kerja ada di cabang belum landing (status review + komentar)

- legend-03jjx (Resolve refund hold: no-id and named-id counted_against_intent branche): origin/ghostex/1025-refund-provider-celah-uang 45f872029 (bukan ancestor m1)
- legend-5ab0l (Cloud: peringatan pemilik saat edge offline (tanpa heartbeat > N menit): lihat komentar kartu
- legend-6n4p3 (SO1032 #2: dua sesi memakai nilai bersih DP sumber yang sama (reservat): lihat komentar kartu
- legend-98etn (Supplier policy: baris supplier_payment lama tanpa tingkat dasar -> 42): origin/ghostex/backfill-policy-supplier-tingkat-dasar f55277c5c
- legend-9c76n (SO1064 R3-02 P2: door-check tertahan membuka tiket riil sesudah mode l): origin/ghostex/45769078 b8927ea90 (door-check kunci device mode)
- legend-9dzxc (SO1032 #1: refund transaksi utama menyembunyikan refund provider atas ): origin/ghostex/1025-refund-provider-celah-uang 164ca25b7
- legend-9s33i (refund.succeeded REFERENCE_MISMATCH dibuang diam-diam: refund dashboar): origin/ghostex/1025-refund-provider-celah-uang 6df769d5c, 1d5557b40
- legend-9uvvu (Pencatat refund provider tidak mengambil lock deposit-intent: refund b): origin/ghostex/1025-refund-provider-celah-uang e8db92138, a3d2340e2 (lock intent eksklusif)
- legend-a6aq6 (Rantai 1012: device-shared-mode.test.ts 6 gagal, revokeDevice/setDevic): origin/ghostex/1026-kelola-perangkat-acting-staf 432f2e6c2 (test 1026)
- legend-dgtz0 (Akses: preview customer-display tanpa token kasir bisa membaca bill ou): lihat komentar kartu
- legend-dsbqr (KDS websocket: pembawa token perangkat+kasir untuk browser di perangka): origin/ghostex/1018-kds-ws-subprotocol-keep-alive f854663f9; bukan ancestor m1
- legend-f1c7n (SO1036: recon tidak mendeteksi bila kedua attestation resolve hilang): lihat komentar kartu
- legend-hjwi7 (SO 1023 P2: penolakan perangkat ke-9 lewat websocket tidak menutup ses): e3cb158f2 di origin/ghostex/1026-kelola-perangkat-acting-staff dan 1027-guard-http-perangkat-bersama; bukan ancestor m1
- legend-hlmbk (Idle keep-alive POST /api/auth/sessions/current/activity ditolak untuk): f854663f9 di origin/ghostex/1018-kds-ws-subprotocol-keep-alive; bukan ancestor m1
- legend-hpwpt (SO1032 #4: ID pembayaran panjang + prefiks payment: membuat refund tra): acc78c3f4 di origin/ghostex/1025-refund-provider-celah-uang dan 1033-kredit-dp-pool-net-bersama; belum di m1
- legend-j2313 (Refund holds list: credit-used holds show no provider refund id (only ): credit_used_before_provider_refund hanya di origin/ghostex/1025-refund-provider-celah-uang 018ab5cab
- legend-jw2xt (Refund echo sebagian: selisih nominal R vs fact, hold saat ref datang ): refund-recon-hold.service.ts ada di origin/ghostex/1025-refund-provider-celah-uang 018ab5cab, tidak di m1
- legend-ksypc (holdNeedsIdentity menjalankan beberapa query per baris daftar hold (N+): holdNeedsIdentity hanya di cabang 1025 (refund-recon-hold.service.ts)
- legend-l83d2 (Edge offline SO1067: waktu buka keliru saat offset DST berubah): origin/ghostex/91956eff aa462cbf0 "fix(edge): 1067 offline alarm F1-F3"; edge-offline-sweep.ts belum ada di m1
- legend-lzydj (SO 1023 P1: perangkat dicabut bisa reconnect KDS websocket sebagai own): origin/ghostex/1026-kelola-perangkat-acting-staff e3cb158f2 (perangkat dicabut tak jadi owner di ws); belum di m1
- legend-n45mn (Integrasi ws/kai-edge-upsync (legend-kai e52264d4a: buildEdgeTxnDigest): origin/ghostex/bawa-kai-upsync-ke-m1 a915c9409 (migrasi 0684); belum di m1
- legend-qh11l (Payout recon: error baca bukti selain NOT_FOUND dianggap 'error' tanpa): origin/ghostex/legend-tiw2h-recon-clearance-restriktif 50e62920b (F1 saja), 091abd5cd; belum di m1
- legend-qwuqq (Edge offline SO1067: episode baru tidak mengirim notifikasi setelah pe): origin/ghostex/91956eff aa462cbf0 (fix 1067 F1-F3); edge-offline-sweep.ts tidak ada di m1
- legend-ra4lu (Refund fund lebih bayar: fundBlockedSql tidak memblokir bila refund pr): origin/ghostex/1025-refund-provider-celah-uang 3a2be7225 (null-evidence provider refund blocks fund); belum di m1
- legend-srg8w (SO 1023 P2: tablet bersama bisa hapus langganan push ponsel owner tanp): origin/ghostex/6acce68c e3cb158f2 (hapus push perangkat bersama hanya milik sendiri; juga ghostex/pin-kasir-tablet-bersama); belum di m1
- legend-t0m89 (KDS: pasang use-kds-realtime ke kds-page + reconnect sekali saat 1008 ): origin/ghostex/4b06e171 0069c8c59 (KDS realtime, reconnect 1008, tes cabut token)
- legend-t7xto (Akses: bila closeSessionsOfSharedDevice gagal (best-effort), tanda lap): origin/ghostex/1027-guard-http-perangkat-bersama a35b9cc9a (guard HTTP fail-closed)
- legend-t9g3i (Poller path pollPendingGatewayIntents/markProviderAnswered still write): origin/ghostex/1025-refund-provider-celah-uang f093d7d68 (poller records full refund); tidak ada di m1
- legend-tiw2h (SO1066 P1: wrapper payout_recon_evidence_observe menerima mismatch/mis): origin/ghostex/legend-tiw2h-recon-clearance-restriktif 422ac1321; payout_recon_evidence_observe tidak ada di m1
- legend-tiyce (1025 round 4: parked-fund own refund covering the whole transaction fi): origin/ghostex/1025-refund-provider-celah-uang f093d7d68 (hold + dedup refund_in_flight)
- legend-tj9y6 (Edge offline SO1067: outlet closed masih mendapat alarm berdasarkan ja): origin/ghostex/91956eff aa462cbf0 (fix F1-F3 1067); edge-offline-sweep.ts tidak ada di m1
- legend-ua9ja (Kredit DP terpakai sebelum refund provider susulan bisa melebihi net i): origin/ghostex/1033-kredit-dp-pool-net-bersama a3d2340e2 (juga 1025-refund-provider-celah-uang)
- legend-vp4ta (Finance resolve path for refund_recon_holds (set resolved_at after mat): origin/ghostex/1025-refund-provider-celah-uang 670d22f98, 712d120fc (bukan ancestor m1)
- legend-vzvok (Fail-closed bila tulis tanda perangkat bersama gagal; catat tanda di c): origin/ghostex/1027-guard-http-perangkat-bersama 195fcc31e (bukan ancestor m1)
- legend-wa9n7 (1012 lanjutan: websocket KDS (kds-realtime-auth.ts:88) dan /api/auth/*): origin/ghostex/34755844 a4fd0a639 (bukan ancestor m1)
- legend-xexts (SO1064 R3-01 P2: perangkat latihan outlet B bisa menjual tiket produks): origin/ghostex/45769078 b8927ea90 (1065 SO 936 ronde 3, device must belong to order); belum di m1

Komentar saja, status tidak diubah (kerja cabang sebagian):
- legend-sy98y (Refund holds tab: show payment reference + outlet name in rows (view D): origin/ghostex/1033-kredit-dp-pool-net-bersama a3d2340e2 (commit menyebut sy98y; hanya outlet name terlihat, payment reference belum dicek)
- legend-whg2 (Flaky: core-outbox-consumer 'holds every later sequence … until an ope): origin/fix/flake-outbox-replay-relay be44b2b17 (diagnosa saja; 42c01af2c di m1 bukan fix spesifik)

## Diberi komentar sebagian (tetap terbuka)

- legend-13vhb (Route uang di perangkat bersama: resolveActingStaff + guard (orderIssu): requireActingStaffOnSharedDevice ada di expo, open-bill, order-issues, order-recovery(-charge), pickup, servic; KURANG: apology-voucher, delivery-orders belum; test uang tidak dicek
- legend-2t69x (Pemindai dokumen produksi: terima bukti payout PDF (sekarang 503)): clamd-scanner.ts:53 acceptsDocuments=true; storage-api.routes.ts:105 menggerbangkan; KURANG: belum terbukti produksi memakai clamd dan terima PDF payout; tidak ada test
- legend-316 (WS-06 BE: Goods receipt (partial, QC) + supplier invoice + 3-way match): drizzle/0173 goods_receipts, 0295 supplier_invoices, purchasing.ts:36 ThreeWayMatch, 0208 petty+retur, supplie; KURANG: approval pembayaran dan test tidak diverifikasi
- legend-3a5m (WS-05: ledger impor settlement gateway + emit settlement.reconciled (p): accounting-auto-journal-amounts.ts:176,185,625,649 menangani event settlement; KURANG: emitter dan ledger impor settlement belum ada di luar amounts
- legend-4itg8 (POS refund: show and track the online (QRIS) part that is not paid out): apps/api/src/services/pos-refund-gateway.ts:140 mengaudit shortfall; KURANG: daftar WS-05, gatewayRefunds di respons, teks struk
- legend-edjgj (Impersonate: lookup tenant grant admin via fungsi SECURITY DEFINER (sc): app.support_access_grant_tenants platform-support.service.ts:1228; test platform-support-global-lookup.test.ts; KURANG: belum dicek: findImpersonationGrants auth.ts:457 sudah memakainya
- legend-eukn (WS-07 FE: show periodStatus/periodVersion on period close snapshot (ma): periodVersion di accounting-period-close.service.ts:485; test accounting-period-close.test.ts:908; KURANG: FE: web hanya mock.ts:644
- legend-fnxl.9 (WS-07: caseDueDays kasus rekonsiliasi jadi kebijakan tenant): 2a499d61e; migrasi 0437, accounting-bank-recon-cases.service.ts:285, shared/finance-policy.ts; KURANG: UI web nyata (hanya ws07-cash-bank/mock.ts:961)
- legend-gjt5q (Refund provider PENUH (958, markProviderRefunded) tidak menulis paymen): lihat komentar kartu
- legend-hmig6 (Ops UI: banner 'Sesi dukungan · Hanya baca' menutup konten dan tombol ): UI read-only ada: area-frame.tsx:259 supportReadOnly, button.tsx:77, i18n ws01-support-access.ts:146; KURANG: Penolakan tulis di server tidak diverifikasi; banner menutup konten tidak dicek
- legend-hpze7 (WS-04 BE: panggil allocatePickupCall dari alur order (POS takeaway/del): lihat komentar kartu
- legend-igclp (WS-07: validasi XML Coretax terhadap XSD resmi DJP): coretax-a1.ts:8 mengikuti XSD DJP BPA1; tes payroll-coretax-a1-export.test.ts:18; KURANG: Validasi XML terhadap XSD resmi untuk format lain (BPMP, faktur) belum jelas
- legend-kcwfy (Hide Owner-only permissions (pos.receipt.writeoff) in custom role pick): ws01-access/lib.ts:356,447 OWNER_TEMPLATE_ONLY di tempat lain; KURANG: permissionGroups() belum dikonfirmasi menyaring pos.receipt.writeoff
- legend-kty62 (Pool pg: listener error per koneksi di db/index.ts (koneksi dibunuh se): db/index.ts:16 pool.on("error"); server.ts:261 uncaughtException; KURANG: pool.on('connect') per koneksi listener dan test pg_terminate_backend
- legend-o4jd1 (Lembar QR meja: tombol 'Ganti QR' (rotate token) dengan konfirmasi, te): API POST qr/rotate ada floor.routes.ts:183; web qr-sheet-print.ts:12 hanya komentar; KURANG: tombol UI Ganti QR + dialog konfirmasi
- legend-obgj5 (SO1032 #3: kredit DP dipakai saat refund sumber masih dikarantina hold): lihat komentar kartu
- legend-oq39c (WS-10/WS-06: event duty meal + konsumen potong stok sesuai resep): endpoint duty-meals ada hris/endpoints.ts:802,816 (hanya catat); KURANG: event katalog shared + konsumen potong stok inventory
- legend-qi21 (Izin khusus hr.announcement.manage (sementara pakai hr.sop.manage)): hris-announcement.routes.ts:42 + service.ts:73 + migrasi 0171:21 + access-perm-backfill-migration.test.ts:27; KURANG: cek apakah test akses route (bukan backfill) ada
- legend-su6xp (Payout 1005 follow-up: stale open withdraw proposals, no cancel): withdraw proposal drizzle/0425_payout_proposal_withdraw.sql:1; KURANG: Belum dicek: auto-close saat claim confirmed dan sembunyi di claim terpakai
- legend-tt81 (Usage R18: emit usage_limit.reached at 80% + wire recordUsageCost call): event usage_limit.reached packages/shared/src/platform/events.ts:167; recordUsageCost platform-usage.service.t; KURANG: emit di 80%, caller wiring, no-op setTenantPackage
- legend-v5e1v (DB constraint: table_session_id hanya untuk service_type dine_in (orde): guard service pos-order.service.ts:624 ada; KURANG: KURANG CHECK constraint migrasi + perketat qrOrderPlacedEdgePayloadSchema
- legend-vbfy6 (WS-01: adapter kirim WhatsApp KirimDev + pasang sendReply di identity-): env KIRIMDEV API key env.ts:309; sendReply dep identity-wa-inbound.service.ts:214; KURANG: KURANG adapter kirim nyata + pasang di routes; kunci founder
- legend-vsw4q (UI write-off nomor struk hilang (owner)): API pos-receipt-writeoff.routes.ts:84,106; KURANG: KURANG UI owner (tak ada writtenOff di web); gerbang mockup
- legend-wxvt9 (Gerbang rilis: dry-run backfill piutang PPh21 di staging): skrip backfill apps/api/package.json:19, src/scripts/payroll-pph21-receivable-backfill.ts:7; KURANG: dry-run staging belum dijalankan (gerbang rilis)
- legend-y9y8y (Edge catalog: deteksi restore DB cloud (txid mundur) -> checkpoint ter): edge rewind setelah HTTP 400 ada: apps/api/src/test/edge-catalog-rewind.test.ts:1-20; KURANG: deteksi di cloud (epoch/generation) atau reset manual terdokumentasi
- legend-yf2b (WS-11 FE: report builder preview only knows sales metrics; other famil): mock-preview.ts:14-16 metrik tanpa sumber jadi null, hanya day-model; KURANG: cakupan family batch A/B
- legend-ytwlo (Jalur reservasi masih pakai waktu lokal sebagai bukti kode mati (reser): provider_final_at untuk QR/VA: drizzle/0405_payment_intent_provider_final.sql:6; KURANG: jalur reservasi (reservation-core, deposit-resend) belum memakainya
- legend-z2kaf (Pakai clientIpKey (IPv6 /64) di rute yang masih memakai IP mentah): clientIpKey: apps/api/src/lib/client-ip-key.ts:57, dipakai public-rate-limit.ts:225; KURANG: link-server, staff-pin-sync, edge-bootstrap, payment-webhook, mcp, Better Auth masih IP me

## Angka

- Dinilai 388. Verdict Explore sebelum verifikasi qa: OPEN 316, BRANCH 35, PARTIAL 26, DONE 8, GERBANG 3.
- Setelah verifikasi: ditutup 6 (fnxl.10, l29ln, of9kp, d769, hjpm2, arp35); 2 DONE sudah ditutup CTO selagi dinilai (g6ept, ggv6d); hpze7 diturunkan ke komentar sebagian.
- Status review + komentar cabang: 36 (termasuk hasil silang commit: dgtz0, 6n4p3, f1c7n, 5ab0l). Komentar saja untuk cabang sebagian: 2 (sy98y, whg2). Komentar sebagian: 28.
- `bd ready` non-epic: 393 -> 348.

## Yang tersisa benar-benar SIAP (usul workstream)

Syarat: verdict OPEN dengan bukti kode konkret (path:baris) bahwa belum dikerjakan, prasyarat ada di m1, tanpa label gerbang (needs-founder, external, human, release-gate, gate-ui), di luar area aktif: refund (ws/1072), kas (ghostex/cek-kas-1102-\*), edge (ws/1073-\*), int/batch89-90, dan di luar berkas yang disentuh cabang belum landing 1017/1018/1024/1026/1027 (acting-staff, KDS ws, customer-display preview) serta 1033 (kredit DP reservasi). Kartu tingkat K (uang, akses, migrasi) butuh satu architect.

Usul (tiap workstream 3-6 kartu, berkas tidak bertumpuk):

1. **Pengerasan provisioning DB dan RLS** (K akses/migrasi, architect): legend-e75zl (sisa FORCE RLS di tests/db-role-provisioning\*.mjs:668), legend-su9c (pgboss di allowlist, provision-roles.ts:986), legend-ecgfy (privtype `e`, provision-roles.ts:616,645), legend-eyscy (SECURITY DEFINER tanpa penjaga, provision-roles.ts:1086), legend-7jrh7 (customer_reviews tanpa app.enforce_member_rls, 0455_customer_reviews.sql:28,30).
2. **Payout: sisa pengerasan tanpa kas 1102** (K uang): legend-02nh0 (audit manual_resolved simpan ID item, payroll-payout-manual.service.ts:1098), legend-a68wk (lepas binding bukti saat withdraw, payroll-payout.ts:1158), legend-v0e0x (batch tetap partially_failed setelah koreksi), legend-6qp12 (jalur lepas payable_account_hold, baru kolom di 0390), lalu legend-48egz (layar finance, FE, sesudah 6qp12). Hindari area clearance 1038/1057 (cabang belum landing: legend-f1c7n, legend-yjxoi).
3. **HRIS kecil** (satu area web+API hris): legend-10tqi (kartu pesangon pakai API 955, final-settlement-card.tsx:93), legend-e6xi5 (duty meal bawahan langsung), legend-uese (cursorPair tolak \u0000, hris-access.ts:475), legend-aki7 (lampiran SOP dibatasi purpose, hris-sop.service.ts:312), legend-pl8hc (queue.ts:125,137 menelan error), legend-ec8t2 (media brand_logo di hris-sop, core-storage-access.ts:134).
4. **UI ponsel kecil** (ui-engineer, tanpa mockup baru): legend-96pb8 (celah 16px footer PosPanel 360px, pos-panel.tsx:42), legend-jwpbp (judul terpotong 390, operations-shell.tsx:136), legend-huz8 (stations-page.tsx:188), legend-gyq04 (KELOLA_OUTLET_SCOPED_PREFIXES, outlet-selection.ts:28), legend-n5s1j (support serverNow), legend-ibvy3 (dua queryKey storage-capabilities).
5. **POS/EDC kecil** (peringatan: EDC agent ada di apps/api/src/edge, cek tabrakan dengan ws/1073 dulu): legend-puzmg (alasan void + pill Dikembalikan, queue-list.tsx:100), legend-2l4s8 (banner antrean terpotong, edc-reconciliation/queries.ts:17), legend-xb20o (void QRIS dua tender, pos-order-payment.ts:141), legend-376ob (reprice mode pajak, pos-order-support.ts:1167), legend-2z04 (sisa pola PAN di test).
6. **Pembersihan P3-P4 sekali jalan** (kartu S, Codex): legend-ahgg (quiet hours lintas DST, notification/delivery.ts:86), legend-gatdy (`outletId as never` x3, loyalty-earn-consumer.ts), legend-rfsqf (format Rp di escpos.ts:128), legend-9zc3 (readyAt recall di mock KDS), legend-vv3nc (foto fixture website), legend-jwd5k (hash menu PDF), legend-bvxs3 (S3Client timeout), legend-uqnv (error resolver tenant), legend-t5ujz.
7. **Layar Super Admin dan email** (butuh mockup lebih dulu): legend-0orff (panel gateway platform, API ada), legend-b2kq3 (tindak lanjut layar AI), legend-m0mch (domain email per brand).

Tahan sampai cabang landing: akses perangkat bersama (legend-wr14s, xn98y, 1pz5e, btne, v8dfx: acting-staff.ts disentuh 1026/1027), kredit DP reservasi (legend-ei9ot, c738z: 1033), semua kartu refund/hold (1072, 1025, 1033, ghostex/1016-1020).

## Catatan keterbatasan

- Pencarian cabang oleh batch 06, 14, 17 tidak selesai per kartu (timeout). Sudah disilang dengan pesan commit semua cabang belum landing, tetapi kerja di cabang yang tidak menyebut id kartu bisa lolos.
- Batch 05: satu dari 22 kartu tidak dapat verdict di balasan pertama; semua 388 kartu akhirnya punya verdict.
- legend-316 punya banyak butir; hanya sebagian terbukti. Tidak ditutup.
- Verdict OPEN "tidak ada bukti" berarti tidak ditemukan lewat grep, bukan terbukti belum dikerjakan.
