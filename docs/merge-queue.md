# Antrean merge train (serah terima, 17 Nov 2026)

Ditulis oleh merge train batch64g. Sumber: pesan CTO G6evw, G6w9t, G4j04. Tip SHA di bawah dicatat saat pesan CTO; ambil tip terbaru (`git fetch`, lalu `git rev-parse origin/<cabang>`) sebelum menyusun batch, karena banyak cabang dipin ulang.

## Sudah mendarat 16–17 Nov

- Batch73 -> m1 719171d33. Batch74 -> m1 40f6f3c95: payout-so895-897 (migrasi 0395-0400), qris-hold-so-879 (0401-0406), seat-reservation-lock-order-f7rnw, kecil-859 (0407), print-alert-supervisor, print-agent-kds-retry (0408). Jangan antre ulang.

- Batch75 -> m1 2cd7c7564: `ghostex/911-payout-905-perbaikan-p1-p2` 3cfecb901, `ghostex/ajakan-wa-poin-grid-qr-meja` bcfbdf011, `ui/ops-statusbar-mobile` ca0b1bf0a (memuat 780 + ops-statusbar-contrast), `ui/member-whatsapp-link` c3e616ddb, `ghostex/52c30e92` 9fc198918, `ghostex/19eebc7a` 738731095. Migrasi 0643-0657 -> 0409-0423. Gate akhir Retro37 hijau; fullrun ketiga tidak dimulai sesuai ralat CTO. Jangan antre ulang.

- Batch76 -> m1 650ef5c7879ccb8ee8bfc0ffef0408e455f0d691: `fix/guest-active-code-916` 1fec4716d, memuat QR/VA `c35d1c794` + VA906 `73eb73dc3` + queue908 + 912. Migrasi `0631_payment_va_releases` -> `0424_payment_va_releases`; snapshot berbasis0423 menjaga seluruh tabel m1. Fast282file, lint, typecheck, e2e18pass/1skip+build, db:generate kosong, fullrun#1 API20721/root3460/web92 hijau. Tanpa perbaikan test. Jangan antre QR/VA atau staff-exit906 terpisah. Kartu154wr tetapopen; sisa idempotensi yehnr ke legend-gp3fw(P3).

- Batch77 -> m1 7b7cc52dfc95020dcefa8777a557ac84e7f274f5: `ghostex/923-payout-deadlock-lock-order` d289f5255, memuat rantai 915 cbc98a31f + 918 ffd47408f + 920 d06e5a269 + 923; 911 sudah di m1 lewat batch75. Migrasi sementara 0658-0663 -> 0425-0430; snapshot direchain, `db:generate` kosong. Semua gate hijau: fast, lint, typecheck, e2e 18 lulus/1 skip, build, dan full run 24414 lulus (20854 API + 3468 root + 92 web). Perbaikan train: perapian lint enam berkas, fixture grantor, dan jam test F5 (3x hijau terarah). Jangan antre 915/918/920/923 ulang. `legend-xp8mc` dan `legend-ijaxi` tetap terbuka; tindak lanjut Lighthouse `legend-kj50i` tetap terbuka.

- Batch78 -> m1 a8e6036abf3a609557eb3fae03c00ed3e37368c0 (merge pendaratan `792577ef5`): `fix/925-ci-grantor-withdraw-flake` 953effb41 dan `fix/e2e-m1-858-r2` c12914ea6. Tanpa migrasi; ujung tetap 0430. Gate hijau: fast scanner root/API + seluruh pemakai fixture payout, lint, typecheck, e2e produksi 18 lulus/1 skip, mock 35 lulus/1 skip, build, full run pertama 24.418 lulus (20.855 API + 3.471 root + 92 web), tanpa rerun atau pengecualian flake. Ditutup: `legend-kj50i`, `legend-61umg`, `legend-y4f3l`, `legend-42v4v`. Jangan antre kedua cabang atau `fix/e2e-m1-858` lama ulang.

- Batch79 -> m1 70bba542dbb6cc1110b929d724130e74c34326ce (merge pendaratan `b132b71ff`): `ws/928-edge-print-alert` b158f09c2, `fix/844-ui-delivery-r2` 40d434c3a, `fix/0y8tf-zvz-port` 84c48ca1d. Tanpa migrasi; ujung tetap 0430. Fast383 berkas termasuk67 kontrak pemindai, lint, typecheck, e2e produksi18 lulus/1 skip+mock25/25, build dan full gabungan24474 lulus/47 skip/16 todo hijau. Full dipulihkan dari bind mount Colima /private/tmp dengan relokasi ke /Users dan rerun hanya berkas gagal, tanpa patch; seluruh web/API dilanjutkan. Ditutup: `legend-2lp.2`, `legend-2lp.4`, `legend-2lp.5`, `legend-4lm6`, `legend-0y8tf`, `legend-sgvw0`, `legend-xz3ll`. `legend-d6d1` tetap parsial. Jangan antre ulang tiga cabang ini. Rilis cloud dulu, lalu edge.

- Batch80 -> m1 c17c60df7ca80f4dc4af8de06faae4e43d40ac80: `ws/edge-kds-stations-r2` 91c7f9d8b, satu cabang (audit ancestry: tidak ada tambahan SIAP). Migrasi `0431_device_scanner_status` -> `0431_device_scanner_status`; snapshot0431 berantai ke0430, db:generate kosong/check-journal hijau. Gate hijau: fast307 (seluruh68 pemindai) root913+API4029, lint, typecheck, e2e produksi18 lulus/1 skip, build; full pertama24527 lulus/47 skip/16 todo (API20932+root3503+web92), tanpa rerun/patch/pengecualian flake. Ditutup: `legend-i78o6`, `legend-40nvj`, `legend-qhsex`. Jangan antre ulang r2 atau cabang sumber lama. Rilis cloud dulu, lalu edge; shell eksternal dan mock web tetap batas integrasi.

- Batch81 -> m1 0c31ff40eb85efa24100e2d1be868f5c69397007: `ghostex/bf531619` 784facadd, `fix/938-loyalty-current-metrics` 7d173a189, `ghostex/935-foto-penerimaan-stale-edge` 8a661cd90, `ghostex/160d3d37` 825123713, plus chore `7e0b4b056` (stub useNowMs di tests/platform-offline-banner). Tanpa migrasi; ujung tetap 0431. Gate hijau: fast383 berkas, lint, typecheck, e2e produksi 18 lulus/1 skip, build, full run (root3513, web92, API20976; 14 gagal di 6 berkas = lingkungan DB, rerun terarah 103/103). e2e mock: 38 gagal sudah ada di m1 murni (23nc, 5k0, 9bh, diq, g6d, ik9g dll), belum ada kartu. Ditutup: `legend-0cnqt`, `legend-eqdcd`, `legend-2lgu` (alert cloud di `legend-uvnll`). Jangan antre ulang keempat cabang. Deploy API+web bersamaan (935 akses); second-opinion akses sebelum rilis.

- Batch82 -> m1 1c185edc04f213ed495080a3456e44c2f6cd57b4: `ghostex/947-payout-934-followups` aca164ca5 (memuat 934), `ghostex/a46177dd` a3f7af1a1, `ghostex/ws-01-pengerasan-akses-951` b4f260a98, `ghostex/ba6c8a6b` cdec4ae29, `ghostex/940-qr-va-sisa-p3` d79767788 (tanpa 9vmit). Migrasi 0432-0433 (947), 0473 -> 0434, 0460 -> 0435; ujung m1 0435. Perbaikan train: panic-review-e dan panic-sync (enrollDevice di withEdgeModeEnv). Gate hijau: fast, lint, typecheck, e2e produksi 18/1 skip, build, full 21194 lulus; mock 38 baseline + 2 flake (lulus rerun). Jangan antre ulang kelima cabang. TERSISA: `ghostex/940-qr-va-sisa-p3` tip baru fbd0235e7 (legend-9vmit) belum ikut; `ghostex/952-recon-so-fix` tetap TAHAN. Second-opinion akses (946+951) dan payroll sebelum rilis.

## Antrean tersisa setelah batch80

- `ghostex/ebc31074` fa79bcdd2 SIAP batch83, setelah 951 (K akses: legend-ra1k0 reseal snapshot voucher di promo_command_idempotency.response; di atas `ghostex/ws-01-pengerasan-akses-951`, hanya 2 commit tambahan; tanpa migrasi baru (0473 milik 951); architect xhigh tanpa P1/P2; 138 test terarah). Tutup legend-ra1k0 saat mendarat. P3 test di kartu baru.
- `ghostex/baca-brief-flaky-created-at` aea2aa3b6 SIAP batch83 (S test saja legend-0l3v4: 5 berkas test pilih ID tanpa bergantung created_at; 102 test x2 lulus; tanpa migrasi). Tutup legend-0l3v4 saat mendarat.
- `ghostex/baca-brief-memori-pg` 9203d4648 SIAP batch83, taruh paling depan (S infra legend-3id81: compose.test PG 1536m full/e2e, 1024m jalur terarah, tuning 64MB/2MB/50 koneksi; `pnpm worktree:remove` tanpa hapus volume, tolak .env* kecuali --discard-env; 68 root + 21 API; reviewer 2 P2 dibetulkan). Full run batch83 = bukti memori 1536m; bila OOM, kembalikan ke 963. Tutup legend-3id81 saat mendarat.
- `fix/966-scanner-suggestion` d8785fcbe SIAP batch83 (S legend-julap: filter kekurangan stok AI purchasing di SQL, limit 25/maks 100, zod shared; 36 API + 9 kontrak root; tanpa migrasi; reviewer PASS). Tutup legend-julap saat mendarat.
- `ghostex/0967e46a` 2be7cfd8d SIAP batch83 (S mock e2e legend-dq4y3: 36/38 pulih, tanpa migrasi; gate root terakhir terhalang PG putus, ulang di train; 2 g6d sisa di kartu baru).
- `ghostex/1a1b16fe` c6ab51bbc SIAP batch84 (K uang/migrasi WS-10 955: legend-8tfvr, legend-y6w4q; memuat ba6c8a6b yang sudah di m1; penulis potongan pinjaman + ledger trigger migrasi kerja 0461_payroll_loan_ledger (nomori ulang dari ujung m1), BPA1 A1 resmi, satu cicilan per pinjaman per bulan, pesangon `pendingPayrollDeductions`, offboarding 409 `PAYROLL_DEDUCTION_PENDING`, simulate lewati pinjaman karyawan offboarding completed; architect xhigh, P1 dibetulkan; 19 file 503 test). Full run wajib. SO Codex payroll 971 sebelum gerbang rilis.
- `ghostex/965-doit-cegah-tagih-dobel` 3793464f1 SIAP batch84 (K uang/migrasi DOIT recurring 965: legend-ycb85, yqne1, lch2o, 145n0; migrasi kerja 0500_recurring_unresolved_start_key (preflight RAISE + unique partial index), nomori ulang dari ujung m1; architect xhigh, 3 temuan dibetulkan; menyentuh packages/shared/src/payment/recurring.ts dan platform-integration.service.ts (logger.warn)). Full run wajib (typecheck API belum diulang setelah edit test terakhir). Gerbang rilis: legend-etov3 data ganda, legend-bcb4p kontrak GET DOIT. SO Codex 973 sebelum gerbang rilis.
- `ghostex/964-ws-12-tanya-ai-be-tersisa` ccf30ab9d SIAP batch84 (K akses/PII/migrasi WS-12 964: legend-39d.2 TL-09, 39d.3 TL-13/TL-16, 39d.4 pengerasan; migrasi kerja 0495 promotions.ai_action_request_id + 0496 ai_tool_calls.mcp_token_id, nomori ulang dari ujung m1, registry data-import ikut; menyentuh packages/shared/src/ai/tools.ts dan hris-scheduling-roster.service.ts; architect xhigh tanpa P1, bukti gagal-dulu di base, rollback TL-16 atomik draft-only + reviewer bersih). Full run wajib. Gerbang rilis legend-47rgt (promo ganda lama). SO Codex 975 sebelum gerbang rilis.
- `ghostex/969-duitku-e-wallet-kartu-be` ad0507789 SIAP batch84, setelah 940 fbd0235e7 mendarat (K uang WS-05 969: legend-kt3t1 e-wallet/kartu Duitku untuk tamu; basis 940 tip; tanpa migrasi; menyentuh packages/shared (GUEST_PAYMENT_METHODS, DTO redirect) dan apps/web tipe saja: labels.ts, payment-code.tsx, payment-result.tsx; architect xhigh + delta, F3 aman; 17 berkas 296 test; ws03-guest-va kini 4 metode). Full run wajib. Harus mendarat sebelum atau bersama `ghostex/duitku-fe-ws05` (legend-6xf7x). SO Codex QR/VA 968 mencakup cabang ini. Gerbang rilis legend-7tqe8.
- `ghostex/duitku-fe-ws05` 1e133c584 TAHAN sampai review UI founder Q24/Q25 (UI WS-05: legend-mp44v routing, vntqt kredensial Duitku, 6xf7x dialog bayar tamu; web saja, tanpa migrasi; screenshot docs/screenshots/945/).
- `ghostex/4badcac8` cf9428b5a SIAP batch83 (S tooling legend-1ek1l: test:e2e:mock menerima daftar berkas; tanpa migrasi).
- `ghostex/954-payout-so950-followups` f1a512f44 SIAP batch83, setelah 947 (K uang/migrasi: legend-628t9 grant kedaluwarsa dicek setelah lock, legend-e3m8d audit reopen/stop, legend-lf0oj test lock baris grant; migrasi kerja 0440_payout_grant_expiry_after_lock, nomori ulang dan atur `when` (bentrok 1795000000049 dengan 0434 cabang 952); architect xhigh tanpa P1; area payout 811 lulus).
- `ghostex/940-qr-va-sisa-p3` d79767788 MENDARAT batch82; tip baru (K uang: legend-gp3fw, 154wr, 24ogm; tanpa migrasi; architect xhigh 4 ronde bersih; 4 test lama diubah ke orphan non-final, dinilai lebih ketat). Lanjutan legend-9vmit di cabang yang sama: tip `fbd0235e7` SIAP batch83 (K uang/migrasi, founder Q15: tamu ganti metode, kode VA lama di-void dulu, bayar telat diparkir lalu refund; migrasi kerja 0450_payment_va_release_guest_kind + 0450_snapshot.json, nomori ulang lewat scripts/migration-renumber.mjs; architect xhigh 2 ronde tanpa P1; 49 test baru; 5 test lama diubah ke perilaku Q15). Full run wajib; jalankan juga `qr-va-*`, `ws03-guest-va`, `qris-hold-so879-a-*` (test cabang lain yang mengharapkan 409 untuk pilihan berbeda akan gagal). SO Codex QR/VA 968 berjalan; tidak menahan merge, wajib sebelum gerbang rilis. Tutup legend-9vmit saat mendarat.
- `ghostex/60a93dca` d26caed3c SIAP batch83, MENGGANTIKAN `ghostex/rekonsiliasi-sisa-bank-dan-doit` 5e1f9d9fc (sudah termuat; ambil 60a93dca saja). K uang/migrasi 958: legend-7uqbs P1 refund provider setelah lunas (stamp atomik, satu audit + satu alert, alokasi/refund/approve/payout 409 PROVIDER_REFUNDED, payout antre dikarantina), legend-3wwme; migrasi kerja 0436 (kolom nullable, nomori ulang dari ujung m1); architect xhigh 2 putaran, P1 dibetulkan; 376 test grup terkait. Full run wajib. SO Codex recon ronde 2 (958) sebelum gerbang rilis. Celah baru: legend-30hfs P1 refund parsial, legend-wourt P2, legend-eia9f P3.
- (lama, sudah termuat di 60a93dca) `ghostex/rekonsiliasi-sisa-bank-dan-doit` 5e1f9d9fc (perbaikan 952 atas SO 948 selesai: P1 refunded lalu paid ditolak, P2 urutan lock, P3 legend-l29ln; architect xhigh ronde 2 tanpa P1; migrasi kerja 0435 payment_intents.provider_refunded_at; kontrak: payment.refunded masuk DOIT_PAYMENT_EVENT_TYPES) (K uang/migrasi: legend-fnxl.9, fnxl.10, 3wpf; migrasi sementara 0432-0434 bentrok dengan 934 0432: nomori ulang dari ujung m1; architect xhigh P1 FORCE RLS dibetulkan, re-review architect CTO bersih (P3 di legend-l29ln)). Full run wajib.
- `ghostex/pos-panel-bayar-sisa-5w6` 48c1788ef TAHAN sampai founder menyetujui UI 936 (Q19). Web saja, tanpa migrasi, mode mock; jual tiket dikunci di luar mock.
- `ghostex/160d3d37` 825123713 SIAP batch berikut (legend-xtj5t test 923 saja; mutasi 5/5; 35/35 x5).
- `ghostex/935-foto-penerimaan-stale-edge` 8a661cd90 SIAP batch berikut (K akses: iy5l0 foto + 5v7oq purpose/umur + 2lgu batas basi edge; tanpa migrasi; architect xhigh P1 dibetulkan; deploy API+web bersamaan; second-opinion akses sebelum rilis).
- `fix/938-loyalty-current-metrics` 7d173a189 SIAP batch berikut (legend-eqdcd active_members; tanpa migrasi; 115 test).
- `ghostex/bf531619` 784facadd SIAP batch berikut (legend-0cnqt outbox ekspor pajak + i18n; tanpa migrasi; 272 API + 35 root).
- Tidak ada cabang SIAP tambahan yang belum menjadi ancestor m1 pada audit batch80. Periksa ancestry lagi bila ada tip baru.
- `ws/edge-kds-stations` 6e393095c: jangan diambil; sudah digantikan port r2 batch80, bukan cabang SIAP baru.
- `ghostex/5ce165c2` 2f62ed4be: jangan diambil; port UI/delivery sudah batch79, sisa zona/waitlist tetap legend-d6d1.
- Rujukan cabang lain pada “Urutan prioritas” sudah menjadi ancestor m1 saat audit batch78; periksa ancestry sebelum mengantre ulang.
- `legend-whd5c` tetap terbuka untuk adapter kredit tamu (`test.fixme`).

## Aturan tetap

- Maks 7 cabang per batch. Gate: `node scripts/check-workspace-links.mjs`, `heavy pnpm run lint`, `heavy pnpm run typecheck`, `heavy pnpm run test`. Maks 2 run penuh gagal per batch, lalu berhenti dan lapor.
- Push `int/batchNN`, fast-forward `milestone/m1`. Jangan `main`, jangan force-push. Remote `int/batch64f` basi (b407f0c2b dari cron backup), jangan ditimpa.
- Merge hanya cabang ujung (tip). Cek keterlibatan dengan `git merge-base --is-ancestor`.
- Migrasi: nomori ulang dari ujung m1 (`apps/api/drizzle/NNNN_*.sql`, `meta/_journal.json`, snapshot). `when` harus naik monoton. Setelah itu: `pnpm db:generate` harus "No schema changes", `node ~/.agents/team/check-journal.mjs origin/milestone/m1`, `data-import-registry.test.ts` (kunci per nama berkas), perbarui komentar kode yang menyebut nomor lama. Resep: skrip `renum.py` di scratchpad sesi c906292d (ambil journal kita, tambah entri mereka dinomori ulang, ubah nama SQL, buang snapshot mereka, tulis ulang referensi tag, lalu bangun ulang snapshot terakhir).
- Gerbang cepat sebelum run penuh (CTO Retro 30): jalankan `LEGEND_TEST_FILES="..." heavy pnpm test` (jalur ringan, 10-15 menit) berisi keluarga tes `edge-*`, `*migration*`, `notification*`, dan semua berkas tes yang disentuh cabang batch (`git diff --name-only <m1>..HEAD -- 'apps/api/src/test/*'`). Merah: perbaiki atau keluarkan cabang dulu, baru run penuh. Nomori migrasi sekali di awal batch.
- Migrasi FK pada tabel lama yang FORCE RLS: dilarang `NOT VALID` (`docs/plan/contracts.md` baris ~161, `migration-force-rls-guard.test.ts`). Pakai Pattern 2: lepas FORCE di anak dan induk, tambah FK tervalidasi, pasang FORCE lagi di berkas yang sama, `lock_timeout` disimpan dan dipulihkan (pola 0135). Pelajaran 64g run 1 (0369).
- Konflik berkas uang: berhenti dan lapor. `docs/PROGRESS.md`: simpan keduanya. Jangan `git add -A docs` sebelum cek penanda konflik.
- Worktree baru: `pnpm install --frozen-lockfile --prefer-offline`; install ulang setelah merge cabang yang menambah dependensi (contoh `web-push`).
- `heavy` menolak rerun identik yang baru gagal (exit 73). `HEAVY_ALLOW_RETRY=1` hanya untuk kegagalan lingkungan, dan beri tahu CTO.
- Tes `it.fails` (AIG-02, EDC-01): bila perbaikan membuatnya lulus, mereka berubah jadi gagal. Laporkan, jangan longgarkan.
- Flake yang diterima: kartu flake sudah ada + 3x lulus terarah. Kelas dikenal: replay-migration race (legend-edxtt, fixed), db-role baseline (fixed di 64e), device-registry F5 timing.
- Rilis: cloud dulu, baru edge. Second opinion Codex wajib sebelum gerbang rilis (area uang/payout).
- Akhir batch: entri `docs/PROGRESS.md` (durasi per tahap, penomoran ulang, `session-usage.py`, `parallel-report`), tutup hanya bead yang terbukti, hapus worktree bersih, lapor singkat ke CTO.

## Sudah di m1

64a, 64b, 64d, 64c, 64e (7aacd9f68), 64f (e38e43b4b). 64g (lihat bagian status 64g di bawah): panic chain (fix/panic-device-cross-tenant), ui/staff-subnav-tablet-44, ws/traceability-strict, fix/edc-so-829 (seluruh rantai EDC). Migrasi 0369-0372 (0372_edc_sale_wire_open). Tip m1 setelah 64g: d1ad35802 (gerbang penuh run 3 hijau; 0369 memakai Pattern 2). Batch72 (m1 42f349c36) dan batch73 (m1 719171d33): 891 + 890 (migrasi 0389-0394), selfie-scanner, edge-node-domain-rate + tenant-domain-audit, metrics-daily-backfill, esnvi-859, 5v8sm-859, flake 887/543rh.

## Urutan prioritas (otoritas G4j04)

### 1. Rantai edge

Induk lebih dulu. Migrasi dinomori ulang dari ujung m1 saat batch disusun.

1. `fix/edge-so-816` 797cd58d6. Memuat `ws/edge-master-data-publisher` (eee030082, migrasi 0373) dan `ws/tax-menu-keyrotation` (87284cbb7: `0374_menu_recipe_fk`, `0377_recipes_resync_edges` data saja; `when` migrasi sebelumnya harus dinaikkan agar monoton). Bawa bead 2uqcd dan cgduz.
2. `fix/edge-snapshot-tolerant` 92accc51e (pin baru; menggantikan 49dea22d4 yang dijatuhkan di 64f karena merusak EDG-02). EDG-02 tetap ketat. Jika tes edge-people-snapshot-pull / edge-uom-compatibility gagal lagi, jangan longgarkan; lapor.
3. `ws/edge-reliability` af66b0d36.
4. `ghostex/fc38212e` 45d1f1b41.
5. `fix/edge-proof-854` 50818b5f6 (induk untuk 855).
6. `fix/edge-slot-855` 0100f11d9 (migrasi 0440 `edge_link_slots`, backfill idempoten; setelah 854; tidak memuat tax-menu-keyrotation).
7. `fix/edge-uom-issystem`: sudah dibawa di 64f kecuali dijatuhkan; cek `merge-base` sebelum menambah.

### 1b. Uang/edge: struk EDC (prioritas 3, CTO G4j04)

- `fix/receipt-run-861` c5fe91cc3 (base ce90d9b1b = tip rantai EDC `fix/edc-so-829`, sudah di 64g; architect xhigh, gagal-dulu). Masuk setelah 64g.
- `fix/edc-failover-861` e688b53bd (prioritas 2, CTO G4j04; base ce90d9b1b; fail-stop saat kunci hilang; architect xhigh 2 putaran). Masuk setelah 64g, satu batch dengan `fix/receipt-run-861` (sama-sama basis rantai EDC). Cabang uang: bukti tes tak ada pihak dibayar lebih tetap berlaku. Kedua cabang bercabang dari ce90d9b1b, bukan saling induk; cek konflik berkas EDC saat merge.

- Flake gerbang (taruh di depan batch berikut): `fix/flake-station-printer-887` 3ab003ad9 (test saja, legend-ea9sf). Lalu `fix/flake-guest-menu-543rh` 30e4177a9 (test saja, legend-543rh, 3x hijau).
- Payout SO-895 (setelah batch73 memuat 891): `fix/payout-so895-897` a06c6bdd4 (16 Nov: memuat perbaikan 900, kode d252a28ef; di atas 891; migrasi sementara 0637-0642 = journal idx 395-400, 0643 tidak dipakai; 900 architect xhigh 0 P1/P2, 751 test 49 berkas; kartu p2v4s; architect xhigh tanpa P1; kartu klr99, v2dco). Batas diterima CTO: baris fee/settle historis NULL tidak dicek nominal (belum ada data production). Rilis: job backfill bukti harus selesai sebelum return/overpaid/koreksi dibuka (409 PENDING sampai itu). Second opinion Codex 897 jalan paralel.

### 2. Uang dan data pribadi

- Rantai PII (setelah `ws/traceability-strict`, sudah di m1): `fix/ai-tool-result-pii` de5af1cf8, lalu `fix/mcp-tool-result-pii` 60f8cd7f4, lalu `fix/pii-salary-false-positive` 2012b53b2 (harus setelah mcp-tool-result-pii).
- HRIS: `ghostex/hris-payroll-followups-4-kartu` 0f517d933, delta 309c541b8 (jangan lewati), `ghostex/hris-koreksi-absen-ditolak-tampil` 0ac8e3b7c, `fix/hris-so-852` 2473fc84b, `fix/hris-koreksi-so-852` 408336d1c (menambah `apps/web/vitest.config.mjs`).
- HPP: `ws/hpp-stock-followups` f6315f99f (migrasi sementara 0383 index stock_ledger, 0384 akun 5106; nomori ulang), lalu `fix/hpp-return-rounding-853` c7bf59d19.
- Keuangan: `ghostex/845-finance-view-access` 43e9824fa, `fix/finance-exc-tender-intent-853` 704a8919a, `ws/finance-followups` f1279c2b6.
- `fix/domain-verify-limiter-shared` 66cbfb78b (migrasi 0382; stempel ulang `when`).
- Cash-out: `ws/cash-out-approval` 049d5e65c (migrasi `0385_cash_movement_approval` + `pos-shift.custom.sql`; JANGAN ambil 950317cf7), lalu `ghostex/0c60597d` c31f83405 (setelah cash-out-approval).
- `ghostex/851-reset-pin-wa-alasan-409-429` 7ed8145d7, `ghostex/alarm-ops-refund-struk` 55fdd1936.
- Refund: `fix/refund-journal-pin-capacity` 976def851. `fix/payout-approval-confirm-binding` a9657bd37.
- Akses/PII (prioritas 4, CTO G4j04): `fix/koreksi-identitas-860` e27706496 (dari m1, tanpa migrasi; 409 `ATTENDANCE_CORRECTION_IDENTITY_MISMATCH`; architect xhigh). Satu batch dengan rantai HRIS bila tidak tumpang tindih di berkas koreksi absen.
- Akses: `fix/leave-attachment-active-permission` f161bcca7 (legend-qu04u, architect xhigh). Sudah ada di bagian 3 (cuti), diangkat ke prioritas 4 karena akses. Setelahnya `fix/leave-create-outlet-permission` 043a8cb23.
- Uang/akuntansi (prioritas 4, CTO G4j04; architect xhigh + perbaikan P2 sesuai resep): `fix/inv-acct-857` 203814737 (setelah induk `fix/hpp-return-rounding-853`); `fix/finance-dp-857` 4b3bbe148 (setelah induk `fix/finance-exc-tender-intent-853`). Cabang uang: bukti tes tak ada pihak dibayar lebih dan outlet tak rugi tetap berlaku.
- Uang (prioritas 4, CTO G4j04): `fix/s3ex8-859` 8b5050243 (setelah induk `ghostex/845-finance-view-access` 43e9824fa; architect xhigh + perbaikan P2 sesuai resep, evidenceMismatch).
- Akses/migrasi (prioritas 4, CTO G4j04, 15 Nov): `fix/ai-modul-otomatis-864` b6483d4ea (dari m1 d1ad35802). Migrasi data `0451_ai_assistant_auto_enable` (sementara; nomori ulang dari ujung m1, snapshot ada). Architect xhigh. Antre setelah batch65.
- Akses (prioritas 3, CTO G4j04, 15 Nov; wajib rilis legend-xdlxa): `fix/push-reregister-863` 355abf918 (dari m1 d1ad35802). Migrasi 0373 (fungsi SECURITY DEFINER `app.push_endpoint_owned_by_other`) BENTROK nomor dengan rantai edge: nomori ulang dari ujung batch (journal + snapshot). Architect high. Antre setelah batch65.
- Test uang (CTO G471b, 15 Nov; tanpa migrasi): `fix/flake-866` 5c9d29ec4 (flake uang 866, oracle lebih ketat + afterAll try/finally; review sonnet OK). Setelah merge tutup legend-5tu68, legend-8p74m.
- Uang/migrasi (prioritas 3, CTO G471b, 15 Nov; temuan second opinion payout): `fix/payout-second-opinion-870` 0173623ed (873 selesai, architect xhigh OK, 35/35 test 870; migrasi tambahan 0369 nomori ulang), setelah induk `ghostex/pemindai-bersama-bukti-payout-m6` 53b0db393. Migrasi `0368_payout_pending_settle_return_claims` (nomori ulang; FK inline, FORCE RLS, tanpa NOT VALID). Architect xhigh 2 putaran OK. Setelah merge: legend-2aspe, legend-yjbjb, legend-w3691, legend-cnpap ke closed. Lalu `fix/ui-payroll-bank-export-871` 8f2373c2c (legend-66xzn, web saja, basis 870; e2e legend-zn4g 10/10). Lalu `fix/payout-gl-877` 69d3d32ea (perbaikan 883: 2 P1 + 4 P2 second opinion 882, 433 test, architect xhigh OK; migrasi sementara 0620, 0626, 0627 dinomori ulang; tutup juga legend-la22h, legend-6ae7e, legend-hblpg, legend-qq68t, legend-i612a, legend-5vb7y) (perbaikan 881: 2 P1 + 1 P2 second opinion 880, 392 test, architect xhigh + reviewer OK; migrasi sementara 0620 dan 0626; tutup juga legend-pfk3q, legend-zlcsd, legend-63qhw) (basis 0173623ed; tutup legend-1t65x, legend-vvzij setelah merge).
- Flake (CTO G471b, 15 Nov, test saja, reviewer OK; PRIORITAS pertama batch69): `fix/flake-874` 316c9509b (ygty4 blind-index, 9jhvz rotasi kunci, ju62a promo edge, mjh1y edc-agent). Setelah merge tutup keempatnya. Catatan: diff mengubah satu baris lama PROGRESS (prettier `edge-*` jadi `edge-_`); saat konflik ambil versi m1 untuk baris itu.
- Test infra (CTO G471b, 15 Nov, reviewer OK; prioritas batch69 bersama flake-874): `fix/full-run-teardown-876` 48b8ba427 (4ge79 teardown 57P01, 38g0t 26 DROP, 4m357 PC-22 identik 60684dc11). Konflik hanya PROGRESS (simpan keduanya). Setelah merge tutup legend-4ge79, legend-4m357; legend-38g0t tutup juga (sisa FORCE di tests/db-role-provisioning*.mjs -> kartu baru).
- Semua cabang uang: bukti tes tak ada pihak dibayar lebih dan outlet tak rugi; sebelum merge baca ringkasan architect di kartu bead.

### 3. Sisanya (cabang tanpa migrasi boleh digabung ke batch yang sama bila tidak tumpang tindih)

- Rantai scanner (satu batch, urut): `ws/storage-scanner-pdf` 53b0db393 (bila migrasi: nomori ulang dari 0380) -> `fix/clamd-scan-limit` 5e19187b1 -> `fix/clamd-scan-tenant-images` cefbdf1d1 -> `fix/leave-form-pdf-capabilities` 50ea9b5c3 (harus setelah atau satu batch dengan storage-scanner-pdf) -> `fix/edge-selfie-scanner` 4c0b5a6c9 (setelah rantai scanner). Juga `fix/storage-scanner-typed-error` d4c02fa0a.
- Rantai AI: `ws/ai-eval-missing-metric` e7668d647 -> `fix/ai-sources-tl07-08-12` fb00a4c24 -> `fix/ai-eval-anomaly-year` 64cfad39e.
- EDC lain: `fix/edc-bill-lock` 8185a7ebd (konflik `docs/PROGRESS.md`: simpan keduanya), `fix/edc-followups` bdae5b4a2, `fix/edc-qris-confirm-lock` 7e32d2707 (cek `merge-base`; 64g sudah memuat rantai sampai fix/edc-so-829).
- QRIS: `ghostex/775-qris-hold-c1` (sebelum `ws/edge-kds-stations`), `fix/outbox-dead-alert-fairness`.
- QRIS hold sudah masuk batch74 (catatan sumber lama, 16 Nov: 896 + SO akhir 902 [2 P1] + perbaikan 903, architect xhigh 2 ronde 0 P1, 543 test area; tip 785b3b453, tanpa migrasi baru sejak 896; kartu 896 ad95t/xg6qk/5h8ob/o6q8i/la1yk tutup setelah merge): `fix/qris-hold-so-879` (memuat C1+C2/C3+m1; menggantikan `ghostex/775-qris-hold-c1` dan `ghostex/qris-hold-dp-c2-c3`, jangan merge keduanya terpisah). Tip fd4427fd1 (7 temuan 878 + void order refund penuh; 180 berkas test, architect xhigh; sudah memuat m1 2bf32cd92). Migrasi 0381-0383 bentrok dengan batch69 (0381/0382): nomori ulang setelah batch69 masuk. Beberapa test m1 disesuaikan ke aturan hold (QR→VA), assertion uang tidak dilemahkan. Tutup legend-yhia9.2/.3/.4, zff37, ota0l, w0ows, 9ho2v, kf104, eqeu7, 5ailc setelah merge. Catatan lama: `ghostex/qris-hold-dp-c2-c3` 6cfe64ba6 tepat setelah `ghostex/775-qris-hold-c1` 1275f0123 (architect xhigh 2 ronde OK, 260/260 test, tanpa migrasi baru). Saat merge: tambahkan guard hold (409 `QRIS_HOLD_ACTIVE`) ke penulisan orders di `qr-order.service.ts` m1 setelah 5dcc1cfd9 (sekitar baris 1629, 2128, 2569; kartu `legend-5ailc`), supaya bukan 500. Tutup `legend-yhia9.2/.3/.4` setelah merge.
- Cuti/fasilitas/pemasok: `fix/leave-attachment-active-permission` f161bcca7 -> `fix/leave-create-outlet-permission` 043a8cb23 (setelah leave-attachment); `fix/facility-evidence-bind-source` ca9a7c0f4 dan `fix/supplier-invoice-invoiced-qty` 5cccfd4b9 (setelah induknya); `ghostex/upload-foto-fasilitas-sungguhan` b961fdcc7 (migrasi 0376; nomori ulang); `ghostex/layar-input-faktur-pemasok` 882900f6a.
- UI: `ghostex/846-delivery-needs-review-layar` 66d1fbf35; `ghostex/5ce165c2` 2f62ed4be.
- `ws/doit-refund-hardening` 72805cd6f (tanpa migrasi). `ws/criteria-*`: pakai `ws/traceability-strict` ce9337bf4 (sudah di m1), jangan ambil `criteria-pph21`, `criteria-pay-edc`, `criteria-ai-mcp` lama.
- Prioritas rendah, tingkat S: `fix/esnvi-859` dan `fix/5v8sm-859` sudah di m1 (batch73). `fix/s3ex8-859` sudah diantre di bagian uang.
- Prioritas rendah selesai: `fix/kecil-859` sudah batch74; `fix/e2e-m1-858-r2` sudah batch78. Jangan ambil cabang 858 lama. Kredit tamu tetap `test.fixme` pada `legend-whd5c`.

## Cabang yang ditahan atau dijatuhkan

- `fix/edge-snapshot-tolerant` tip lama 49dea22d4: dijatuhkan (CTO opsi a). Pakai 92accc51e.
- `fix/panic-device-cross-tenant` lama dan tip panic lain: sudah di m1 lewat 495c88b45 (migrasi dinomori ulang 0369-0371). Rantai panic selesai; jangan masukkan lagi.
- 950317cf7 (cash-out lama): jangan diambil.
- Bead di REVIEW milik CTO: legend-oan3p, jztb7, kmjax, kpzmi, alovk. Jangan tutup `legend-d6d1` (parsial) dan `56mo2` (parsial, belum ada konsumen).

## Catatan migrasi

- Nomor terakhir di m1 setelah batch80: 0431 (`0431_device_scanner_status`); nomor berikut 0432. Entri sementara dari brief CTO (0373-0385, 0440, 0448) hanyalah nomor kerja; nomor akhir mengikuti ujung m1 saat merge.
- Migrasi data (`0377_recipes_resync_edges` dll.) dikunci per nama berkas di `data-import-registry.test.ts`.
- Peringatan check-journal terbuka: migrasi 0369 menambah FK `push_subscriptions_device_fk` pada tabel lama tanpa NOT VALID. Catat untuk review sebelum rilis.

## Item rilis yang harus diangkat ulang

- Second opinion Codex wajib sebelum gerbang rilis (area uang dan payout).
- `legend-xp8mc` (persetujuan utama payout lewat grant) dan `legend-ijaxi` (review architect Claude atas 923) tetap terbuka setelah batch77. Tindak lanjut Lighthouse `legend-kj50i` ditutup setelah batch78.
- Remote `int/batch64f` basi (jangan ditimpa).
- `fix/edc-agent-867` 569a56005 (base 46f9d1bca = batch65; tanpa migrasi; architect xhigh, 5 temuan dibetulkan; gagal-dulu 8/14). Cabang uang EDC: bukti tanpa sale kedua tetap berlaku. Tes root kontrak belum diulang setelah ronde 2 (server.ts, unit systemd, deployment.md) — fast gate wajib memuatnya.
- `ghostex/4eda746b` 4db4c178e (868 API antrean rekonsiliasi EDC + UI 865 5fb5f8273 di dalamnya; tanpa migrasi; architect xhigh akses, 4/5 temuan dibetulkan). Menggantikan `ui/edc-rekonsiliasi-865`; jangan antre 865 terpisah.
