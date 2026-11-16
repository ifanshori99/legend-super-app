# Antrean merge train (serah terima, 15 Nov 2026)

Ditulis oleh merge train batch64g. Sumber: pesan CTO G6evw, G6w9t, G4j04. Tip SHA di bawah dicatat saat pesan CTO; ambil tip terbaru (`git fetch`, lalu `git rev-parse origin/<cabang>`) sebelum menyusun batch, karena banyak cabang dipin ulang.

## Sudah mendarat 16 Nov

- Batch73 -> m1 719171d33. Batch74 -> m1 40f6f3c95: payout-so895-897 (migrasi 0395-0400), qris-hold-so-879 (0401-0406), seat-reservation-lock-order-f7rnw, kecil-859 (0407), print-alert-supervisor, print-agent-kds-retry (0408). Jangan antre ulang.

## Batch75 (berikut, basis m1 40f6f3c95)

- `ghostex/911-payout-905-perbaikan-p1-p2` 3cfecb901 (memuat 905 + 911; menggantikan `fix/payout-trusted-boundary-905`; migrasi sementara 0643-0657 dinomori ulang mulai 0409). Second opinion 909 + perbaikan 911.
- `fix/qr-va-queue-after-paid-xzu4l` c35d1c794 SIAP untuk batch76 (912 tiga putaran + ek1wt + 4n8rs + 154wr; tanpa migrasi baru; memuat QRIS 785b3b453 + VA 906 + 908; menggantikan `fix/va-staff-exit-5wn1e`, jangan merge itu terpisah; migrasi sementara 0631_payment_va_releases dinomori ulang).
- `fix/guest-active-code-916` 1fec4716d SIAP batch76, ditumpuk di atas qr-va (pesan tamu 409, web saja; menggantikan qr-va bila diambil bersama).
- `fix/e2e-m1-858` 3272f4dee: konflik dengan e2e mock m1 (legend-jemae) di 3 spec; perlu rebase dulu.

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
- QRIS hold SIAP (16 Nov: 896 + SO akhir 902 [2 P1] + perbaikan 903, architect xhigh 2 ronde 0 P1, 543 test area; tip 785b3b453, tanpa migrasi baru sejak 896; kartu 896 ad95t/xg6qk/5h8ob/o6q8i/la1yk tutup setelah merge): `fix/qris-hold-so-879` (memuat C1+C2/C3+m1; menggantikan `ghostex/775-qris-hold-c1` dan `ghostex/qris-hold-dp-c2-c3`, jangan merge keduanya terpisah). Tip fd4427fd1 (7 temuan 878 + void order refund penuh; 180 berkas test, architect xhigh; sudah memuat m1 2bf32cd92). Migrasi 0381-0383 bentrok dengan batch69 (0381/0382): nomori ulang setelah batch69 masuk. Beberapa test m1 disesuaikan ke aturan hold (QR→VA), assertion uang tidak dilemahkan. Tutup legend-yhia9.2/.3/.4, zff37, ota0l, w0ows, 9ho2v, kf104, eqeu7, 5ailc setelah merge. Catatan lama: `ghostex/qris-hold-dp-c2-c3` 6cfe64ba6 tepat setelah `ghostex/775-qris-hold-c1` 1275f0123 (architect xhigh 2 ronde OK, 260/260 test, tanpa migrasi baru). Saat merge: tambahkan guard hold (409 `QRIS_HOLD_ACTIVE`) ke penulisan orders di `qr-order.service.ts` m1 setelah 5dcc1cfd9 (sekitar baris 1629, 2128, 2569; kartu `legend-5ailc`), supaya bukan 500. Tutup `legend-yhia9.2/.3/.4` setelah merge.
- Cuti/fasilitas/pemasok: `fix/leave-attachment-active-permission` f161bcca7 -> `fix/leave-create-outlet-permission` 043a8cb23 (setelah leave-attachment); `fix/facility-evidence-bind-source` ca9a7c0f4 dan `fix/supplier-invoice-invoiced-qty` 5cccfd4b9 (setelah induknya); `ghostex/upload-foto-fasilitas-sungguhan` b961fdcc7 (migrasi 0376; nomori ulang); `ghostex/layar-input-faktur-pemasok` 882900f6a.
- UI: `ghostex/ajakan-wa-poin-grid-qr-meja` bcfbdf011; `ghostex/780-ui-operasional-kecil` (cek konflik dengan `fix/e2e-mock-support-access` c3cef7cb4 di `e2e/legend-ujxl.mock.spec.ts`); `fix/ops-statusbar-contrast` b1af31c1b (setelah 780) -> `ui/ops-statusbar-mobile` ca0b1bf0a (setelah ops-statusbar-contrast); `ui/member-whatsapp-link` c3e616ddb (Q29 disetujui; risiko konflik teks di `packages/shared/src/i18n/messages/id.ts` dengan ajakan-wa-poin-grid-qr-meja); `ghostex/846-delivery-needs-review-layar` 66d1fbf35; `ghostex/52c30e92` 9fc198918; `ghostex/19eebc7a` 738731095; `ghostex/5ce165c2` 2f62ed4be.
- `ws/doit-refund-hardening` 72805cd6f (tanpa migrasi). `ws/criteria-*`: pakai `ws/traceability-strict` ce9337bf4 (sudah di m1), jangan ambil `criteria-pph21`, `criteria-pay-edc`, `criteria-ai-mcp` lama.
- Prioritas rendah, tingkat S: `fix/esnvi-859` dan `fix/5v8sm-859` sudah di m1 (batch73). `fix/s3ex8-859` sudah diantre di bagian uang.
- Prioritas rendah: `fix/kecil-859` f561df281 (migrasi 0448, index `push_subscriptions(user_id)`), `fix/e2e-m1-858` 3272f4dee (e2e saja: delivery e8oa, POS koreksi mzg/rx0h, PAY-04 sgg; kredit tamu `test.fixme` legend-whd5c; tingkat S, paling akhir).

## Cabang yang ditahan atau dijatuhkan

- `fix/edge-snapshot-tolerant` tip lama 49dea22d4: dijatuhkan (CTO opsi a). Pakai 92accc51e.
- `fix/panic-device-cross-tenant` lama dan tip panic lain: sudah di m1 lewat 495c88b45 (migrasi dinomori ulang 0369-0371). Rantai panic selesai; jangan masukkan lagi.
- 950317cf7 (cash-out lama): jangan diambil.
- Bead di REVIEW milik CTO: legend-oan3p, jztb7, kmjax, kpzmi, alovk. Jangan tutup `legend-d6d1` (parsial) dan `56mo2` (parsial, belum ada konsumen).

## Catatan migrasi

- Nomor terakhir di m1 setelah 64g: 0372 (`0372_edc_sale_wire_open`). Entri sementara dari brief CTO (0373-0385, 0440, 0448) hanyalah nomor kerja; nomor akhir mengikuti ujung m1 saat merge.
- Migrasi data (`0377_recipes_resync_edges` dll.) dikunci per nama berkas di `data-import-registry.test.ts`.
- Peringatan check-journal terbuka: migrasi 0369 menambah FK `push_subscriptions_device_fk` pada tabel lama tanpa NOT VALID. Catat untuk review sebelum rilis.

## Item rilis yang harus diangkat ulang

- Second opinion Codex wajib sebelum gerbang rilis (area uang dan payout).
- Remote `int/batch64f` basi (jangan ditimpa).
- `fix/edc-agent-867` 569a56005 (base 46f9d1bca = batch65; tanpa migrasi; architect xhigh, 5 temuan dibetulkan; gagal-dulu 8/14). Cabang uang EDC: bukti tanpa sale kedua tetap berlaku. Tes root kontrak belum diulang setelah ronde 2 (server.ts, unit systemd, deployment.md) — fast gate wajib memuatnya.
- `ghostex/4eda746b` 4db4c178e (868 API antrean rekonsiliasi EDC + UI 865 5fb5f8273 di dalamnya; tanpa migrasi; architect xhigh akses, 4/5 temuan dibetulkan). Menggantikan `ui/edc-rekonsiliasi-865`; jangan antre 865 terpisah.
