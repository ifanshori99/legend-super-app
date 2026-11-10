# PROGRESS — Legend Super App

Diperbarui 2026-11-08 oleh CTO (coordinator Ghostex, sesi "CTO legend"). Founder menghentikan semua kerja untuk dilanjutkan di sesi baru.

## legend-dwrr WS-12 provider AI OpenAI-compatible per tenant (engineer, cabang `ws/ai-provider-tenant` dari milestone/m1 d2080951, 2026-11-10)

- Satu migrasi `0188_ai_provider_configs` (when 1794267000000, prevId 8948ed96 = id snapshot 0186): tabel `ai_provider_configs` satu baris per tenant, tenant RLS (`ai-provider.custom.sql`). Kunci API disegel `sealSecret` (AAD `ai_provider_config:<tenantId>:<rowId>`), hanya `hasKey` + `keyLast4` yang keluar. Tipe koneksi `api_key`; `chatgpt_oauth` dicadangkan dan ditolak (legend-z83k).
- Rute `GET/PUT/DELETE /api/ai/provider`, `POST /api/ai/provider/test`, izin `ai.governance.manage` + back office (MFA). Kontrak `packages/shared/src/ai/provider.ts`. Keputusan: `docs/DECISIONS.md` "WS-12 provider AI per tenant".
- URL tenant selalu strict, https port 443, redirect ditolak, fetch berjaga (`lib/ai/guarded-fetch.ts`) memblok IP privat saat connect (tutup DNS rebinding). Ganti base URL wajib kirim ulang kunci. Tenant punya baris tidak pernah jatuh ke kunci platform; tanpa baris pakai provider env + `AI_MODEL`. Anggaran 0 tetap memblokir.
- Review architect (K): 1 tinggi (status di luar 200-599 mematikan proses API) dan 4 rendah, semua dibetulkan. Bukti gagal-dulu: 8 mutasi (izin, kunci di respons, URL longgar, fallback platform, anggaran, filter tenant, ganti host tanpa kunci), semua tertangkap test.
- Bukti (setelah perubahan terakhir 4b47b040): 6 file api 115/115 (ai-provider-config, ai-provider-probe, ai-provider, migration-force-rls-guard, migration-fk-force-rls, db/rls); root `tests/ai-contract.test.mjs` 72/72 (node --test, tanpa DB); db:generate kosong; tsc shared + api exit 0 (heavy); eslint + prettier bersih.
- Berikut: second-opinion Codex `docs/briefs/281b-second-opinion-ai-provider.md` (xhigh, belum dijalankan); UI Kelola legend-nnufz (butuh mockup, gerbang founder); merge train: gabung 0187 (`ws/audit-retention-purge`) dulu lalu rechain prevId 0188.
- Subagent: 15 (Explore 3, architect 2, implementer 8, test-writer 1, test-runner 1), puncak bersamaan 4.

## legend-1nmh WS-03 mode link meja (engineer, cabang `ws/table-link` dari ws/table-move-merge 6ef7034d, 2026-11-10)

- Link = dua meja atau lebih dikelompokkan untuk layanan saja; tagihan, pesanan, dan sesi tidak disentuh. Anggota = (meja, sesi aktifnya); satu meja paling banyak di satu grup hidup. Grup dengan kurang dari 2 anggota hidup bubar; papan hanya menampilkan `linkGroup` untuk 2+ anggota.
- Migrasi `0200_table_links` (idx 200, when 1794279000000): `table_link_groups`, `table_link_members`, RLS tenant+outlet, indeks unik parsial anggota hidup per meja dan per sesi.
- Endpoint `POST /api/table-links` (opsional `groupId` untuk menambah ke grup) dan `POST /api/table-links/:groupId/unlink` (tanpa `tableIds` = bubarkan), izin `floor.table.operate`, filter tenant/outlet, ulang = 200 tanpa tulis ulang.
- Sesi tutup, kedaluwarsa, atau jadi sumber gabung: anggota keluar (`session_closed` / `session_merged`). Pindah meja: anggota ikut ke meja baru. Event baru: `table_session.linked`, `table_session.unlinked`, `table.status_changed` (aksi staf, tutup, pindah, sumber gabung), audit link/unlink.
- Bukti: tes gagal-dulu 19 merah dari 29 di `table-link-api.test.ts` (rute belum ada), kini 29/29; regresi 4 file 67/67 + qr-order-api; contract node 51/51; tsc api lulus (heavy); eslint dan prettier bersih. Review S: tanpa temuan nyata; tercatat: `note` diterima tapi tidak disimpan, perluasan grup hanya memberi event `linked` ke sesi baru.

## WS-08 fondasi member: desain identitas pelanggan dan buku poin (architect, cabang `docs/arch-member-loyalty` dari m1 d2080951, 2026-11-10)

- Putaran 2: temuan challenger dan reviewer dilipat. Magic link pakai `login_challenges` (bukan plugin Better Auth); `auth_method` menjaga gerbang management (hanya `password`), staf tidak ditolak di metode member; magic link lintas perangkat tidak bisa menautkan WhatsApp (403); void dan refund membalik poin; restore menjaga kedaluwarsa asli; nilai poin disalin trigger.
- Sudah: desain `docs/design/ws08-member-loyalty.md`, bagian baru `docs/architecture.md` "WS-08 member foundation", entri `docs/DECISIONS.md` 2026-11-10 "Member identity and point ledger", brief 290a (111j), 290b (k2l), 290c (m4p5), 290d (ts50), 290e (3zd1), 290f (kartu baru jurnal poin), 290g (u57q).
- Keputusan: satu tabel `user` untuk semua orang (member = baris `customer_profiles` per tenant, staf = role); login member WhatsApp + magic link email + Google, menolak akun staf; merge hanya akun WhatsApp-saja; saldo poin dijaga trigger database dan tidak bisa negatif; earn/reverse dari `order.paid`/`order.refunded`; RLS `member_self` lewat `app.customer_profile_id`.
- Migrasi dipesan menurut urutan merge: 0193 111j, 0194 k2l, 0195 m4p5, 0196 ts50, 0197 3zd1 (`when` 1794272000000-1794276000000).
- Berikut: 290a dan 290b paralel; sesudah 290a: 290c, 290d, 290e, 290f paralel; terakhir 290g. Pertanyaan founder (A15 dan lain-lain) di laporan architect; default dipakai lewat setting.

## legend-pxcs + legend-dux2 kebijakan keuangan dan register aset tetap (engineer, cabang `ws/finance-policy-asset-register` dari m1 d8ea5e0b, 2026-11-10)

- Satu migrasi `0174_finance_policy_asset_register` (when 1794253000000, prevId ba41bcc6 = id snapshot 0166), hanya menambah: tabel `finance_policies` (PK tenant), `asset_categories`, kolom `fixed_assets.code` (unik per tenant+entity, backfill `FA-nnnnn` urut created_at lalu id) dan `category_id` (FK komposit tenant). FORCE RLS di `fixed_assets` dilepas selama backfill dan validasi FK, dipulihkan di akhir (migrator non-BYPASSRLS, pola 0139).
- legend-pxcs: `GET/PUT /api/accounting/finance-policy` (GET `accounting.journal.view`, PUT `accounting.reconcile`), validator strict `packages/shared/src/accounting/finance-policy.ts`, default 2/2 bila tak ada baris, per tenant (bukan per legal entity). API belum punya data/endpoint alert setoran kas: service `loadCashDepositPolicy` disiapkan untuk konsumen ACC-05; tes memakai `undepositedCashAlerts` dengan batas dari API.
- legend-dux2: `code`, `categoryId`, `categoryName`, `originalCostIdr`, `revaluationSurplusIdr`, `revaluationLossIdr` di `fixedAssetSchema` (surplus dihitung saat baca dari `fixed_asset_revaluations`, satu query agregat); `GET/POST /api/accounting/asset-categories`; kode ganda dan nama kategori ganda 409, kategori tenant lain 404.
- Bukti: db:generate kedua kosong; tes terarah 5 file 74/74 (finance-policy, fixed-asset-register, backfill, data-import-registry, edge-received-events-migration); `pnpm test` penuh 427/430 file: sisa gagal hanya `ai-gateway.test.ts` (kuota harian, tidak terkait, gagal juga sendirian, kemungkinan batas tanggal WIB); tsc shared+api+web exit 0 (heavy); eslint + prettier bersih.
- Review S: satu reviewer sonnet, 1 temuan nyata (backfill di bawah FORCE RLS) dibetulkan, plus tes penuh menangkap FK scan dan registry data-import, dibetulkan.

## legend-3nfc9, legend-fr62g, legend-bd1fj WS-11 shared putaran 3 (engineer, cabang `ws/ws11-shared-3` dari a92b9bac, brief 284, 2026-11-10)

- Sudah: F5 F8 F10 digabung `--no-ff` tanpa konflik teks (54a24341, 11e69a8d, bc5c94ad); reader mereka sudah sesuai kontrak putaran 2. Satu konflik makna: test tile dashboard yang belum dibangun kini dipilih dari registry (fc0b0448). m1 94995dad tidak digabung (migrasi 0167-0186 bentrok dengan 0181 F1); replay stok `posting_seq` dicatat saja.
- Sudah: kait finalitas `pendingDay` + `now` (5f4680ff), kode jumlah fasilitas dan rasio turunan (ca89c135), daftar NON_GL (666d1a66), mock mengikuti registry + test drift semua keluarga (dde00960), pesanan latihan keluar dari metrik penjualan (7bc36d67, 706ac5e1).
- Review architect (K): 1 tinggi, 3 sedang, 3 rendah. Dibetulkan: hold sebelum compute, pass susulan 90 hari, `keepFinal` (3bd8e577), reader fasilitas (9366429f). Kartu baru: legend-gkc6b (jurnal pesanan latihan), legend-4us1a (jam operasi berlaku-sejak).
- Bukti: api 22 file 414/414, root node 230/230, db:generate kosong, typecheck shared/api/web lulus, eslint dan prettier bersih. Gagal-dulu per butir: 22 test baru, 18 merah, 4 hijau (penjaga atau butir 7 yang memang sudah tercakup).
- Berikut: backfill riwayat (legend-ka1hg, termasuk kode jumlah fasilitas), second-opinion Codex (`docs/briefs/ws11b-second-opinion-ws11.md`).

## legend-iwsrp, legend-obwwi, legend-ip4v6, legend-nko71 WS-11 shared putaran 2 (engineer, cabang `ws/ws11-shared-2` dari 18455b7a, brief 272, 2026-11-10)

- Sudah: keluarga F2 F3 F4 F1 F11 digabung `--no-ff` tanpa konflik teks; konflik makna (contoh `pax` di test engine, assert net_sales payments-tax, konstanta mock DASH-02) dibetulkan di 8531d4df. routeTree diregenerasi tanpa beda.
- Sudah: registry satu reader per kode+dimensi dan `writesTotal`; pecahan net_sales per payment_method dan menu_category; kind `share`, GL `balance` dan `sourceTypes`; sumber pajak, `splitFrom` food_cost_pct, rata-rata tertimbang (`served_ticket_count`, `closed_session_count`); finalitas split GL per outlet; dashboard `managerRole`, `availability`, antrean 200; mock sales_target, day_of_week, SALES_REPORTS, SERVED_REPORTS.
- Review architect (K): 7 temuan tanpa kritis, semua dibetulkan (af0290e1, 1470d397). tax_payable per outlet sekarang `dimension_not_supported`.
- Bukti: api 16 file 312/312, root node 225/225, db:generate kosong, typecheck shared/api/web lewat heavy lulus, eslint dan prettier bersih.
- Bukti gagal-dulu per butir (test tiap commit dijalankan pada kode induknya): 54 test baru, 46 merah, 8 tetap hijau dan semuanya kontrol positif atau penjaga regresi. Test unknown managerRole diperkuat sampai merah di kode lama (6d65729f).
- Berikut: backfill riwayat bobot sebelum rilis (legend-ka1hg); bug pesanan latihan di `menu_sold_qty` (legend-fr62g).
- Biaya sesi (seluruh sesi ff8f7a53, beberapa brief): 19.4M token-biaya; subagent 49, puncak bersamaan sekitar 6.

## legend-svrzc, legend-ymtsg, legend-hdfd2 WS-11 shared putaran 1 (engineer, cabang `ws/ws11-shared-1` dari eb4383cb, brief 267, 2026-11-10)

- legend-svrzc: `GET /api/metrics/query` ikut aturan report run. Laporan sumber tiap metrik menentukan izin; tanpa izin penuh, `report.aggregate.view` hanya untuk laporan di daftar putih agregat; jangkauan diiris antar metrik; irisan kosong 403 `REPORT_NOT_PERMITTED`. Logika viewer bersama di `apps/api/src/routes/report-viewer.ts`. Akses juga melebar: `report.operational.view` kini membaca `cogs` dan sejenisnya (dulu butuh `report.financial.view`). Tidak ada pemanggil web.
- legend-ymtsg: baris report run membawa `bucket`, `bucketStart`, `bucketEnd`, plus `truncated` wajib; laporan `day`/`week`/`month` kini menjawab baris per bucket; finality per bucket dari engine.
- legend-hdfd2: `REPORT_RUN_MAX_SPLIT_DIMENSIONS = 1` (outlet + 1 dimensi); lebih dalam butuh perubahan skema `metrics_daily`. Dicatat di DECISIONS entri 2026-11-10 butir 6 dan 8.
- Konflik terbuka: `ws11-gl-parity.acceptance.test.ts` "SH-01 can read aggregate money figures equal to the ledger" mengharapkan 200 untuk pemegang saham yang meminta `cogs`; kini 403 karena `inventory.food_cost` tidak di daftar putih agregat. Test tidak diubah, menunggu keputusan CTO (kartu legend-upmn7).
- Review K architect: tanpa HIGH; 2 MEDIUM (pelebaran akses tak tercatat; baris hari terpotong diam-diam) dan LOW dibetulkan. Kartu baru: legend-e0fhh (mock handler report-runs abaikan bucket), legend-t5ujz (cache akses per request).
- legend-e0fhh: mock handler `report-runs` kini memakai bucket di kunci run; bucket yang tidak terdaftar dijawab 400 `REPORT_FILTER_NOT_SUPPORTED`, bukan total diam-diam. Review S reviewer sonnet: tanpa temuan nyata.
- Keputusan founder Q59 (legend-upmn7): pemegang saham membaca total `cogs` seluruh usaha lewat metrics query (`AGGREGATE_TOTAL_METRIC_CODES`), hanya tanpa `groupBy`, tanpa `outletIds`, bucket `total`; `inventory.food_cost` tetap di luar daftar putih agregat. SH-01 hijau tanpa ubah test. Q60: pelebaran `report.operational.view` hanya dalam outlet peran, dijaga test. Review K architect: tanpa kebocoran; MEDIUM (cakupan lebih luas dari kata founder) dan LOW (test Q60 lemah) dibetulkan.
- Langkah berikut: merge train, second opinion Codex 260b sesudah 15 Nov.

## legend-5wzoc WS-11 fondasi laporan dan metrik, kartu A (engineer, cabang `ws/ws11-foundation` dari milestone/m1 d8ea5e0b, 2026-11-10)

- Keputusan desain (architect): `docs/DECISIONS.md` entri 2026-11-10. Total uang tetap dari GL; pecahan non-outlet dari data operasional lewat `metrics_daily` dengan baris residual `__ledger_adjustment__` sehingga jumlahnya sama dengan GL; satu registry + satu engine (`evaluateMetrics`) untuk metrics query, report run, dasbor (F11), dan AI; laporan tanpa sumber menjawab `availability: unavailable` (belum tersedia), nilai null; kepemilikan berkas bersama hanya kartu A lalu kartu serial `ws11-shared`.
- Sudah: registry `services/metric-sources/` (gl + 10 stub keluarga), engine di `metrics-query.service.ts` (gl, daily, derived, unavailable, split + residual), tabel `metrics_daily` (migrasi 0176, when 1794255000000, prevId = snapshot 0166, RLS tenant + outlet), job `worker/metrics-daily.job.ts` (15 menit, hari ini + 7 hari, advisory lock, savepoint per keluarga, upsert hanya bila berubah), API `/api/reports` catalog/get/run/preview, kontrak `availability` wajib, mock web dipecah ke `features/ws11-reports/mock-families/<keluarga>.ts`.
- Review K architect: 2 temuan nyata dibetulkan (fallback agregat report run bocor ke tenant; hari tanpa baris tetap `final`), keduanya dengan test merah dulu. Second-opinion Codex: `docs/briefs/260b-second-opinion-ws11-foundation.md` (belum dijalankan).
- Kartu: A legend-5wzoc; F1 legend-ne81z, F2 legend-a82g9, F3 legend-e58wz, F4 legend-hpc4s, F5 legend-e12h5, F6 legend-qlirp, F7 legend-20ucm, F8 legend-lqf0j, F9 legend-y3huu, F10 legend-60tsm, F11 legend-flb8f, F12 legend-ay6e6, INT legend-x73li; tindak lanjut legend-svrzc (fallback agregat di `/api/metrics/query`, perilaku m1).
- Langkah berikut: merge train; F1-F12 memakai berkas keluarganya sendiri.

## legend-mbd2 + legend-t57t klaim lintas tenant: nomor WhatsApp dan custom domain (engineer, cabang `ws/tenant-claims` dari milestone/m1 d8ea5e0b, 2026-11-10)

- Migrasi `0178_tenant_claims` (when 1794257000000, idx 167, prevId 0166 `ba41bcc6`). SQL tangan dari `apps/api/src/db/schema/platform-integrations.custom.sql` dilipat di depan DDL hasil generate.
- legend-mbd2: dua indeks unik parsial di `tenant_integrations` (provider whatsapp, status active, tenant-wide): nomor penerima ternormalisasi (`app.whatsapp_receiving_number`) dan kunci routing (`app.whatsapp_routing_key` = phoneNumberId, kalau kosong nomor penerima). Fungsi SQL meniru `normalizeWhatsAppNumber`/`resolveWhatsAppChannel`, termasuk himpunan spasi JS. Service menyimpan bentuk kanonik (nomor digit E.164 tanpa plus, phoneNumberId trim + `^[A-Za-z0-9._-]{1,64}$`, kosong = belum diisi); bentrok -> 409 `WHATSAPP_NUMBER_TAKEN`. Draft dan disabled tidak dihitung (draft tidak bisa menyerobot). Data lama bentrok: blok `DO` membuat migrasi gagal dengan id integrasi; tangani dengan menonaktifkan baris yang salah lalu jalankan ulang.
- legend-t57t: `tenant_domains.hostname` unik hanya untuk baris terverifikasi (`tenant_domains_verified_hostname_key`), unik per tenant (`tenant_domains_tenant_hostname_key`), kolom `verification_token` (backfill untuk custom belum terverifikasi). `resolveHost` mengutamakan baris terverifikasi. Hostname = atau di bawah `PLATFORM_DOMAIN` (env baru, opsional) / `COOKIE_DOMAIN` -> 422 `DOMAIN_RESERVED`. Verifikasi TXT `_legend-verification.<host>` = `legend-domain-verification=<token>` lewat `POST /api/org/domains/:domainId/verify` (resolver DNS bisa diganti di test); gagal -> 422 `DOMAIN_VERIFICATION_FAILED`, host sudah diverifikasi tenant lain -> 409 `DOMAIN_TAKEN`. DTO domain dapat field `verification` (record TXT, null bila terverifikasi).
- Bukti: 10 file / 178 tes terarah hijau; `tests/platform-contract.test.mjs` 38/38; db:generate kedua kosong; tsc shared + api exit 0 (heavy); eslint + prettier bersih.
- Review K: architect -> 1 High (spasi Unicode lolos indeks SQL; dibetulkan: simpan kanonik + kelas spasi eksplisit), 1 Low (verifyDomain buka koneksi kedua; dibetulkan). Second opinion Codex: `docs/briefs/262b-second-opinion-tenant-claims.md` (belum dijalankan).
- Kontrak baru untuk UI: tombol verifikasi domain + tampilkan record TXT; pesan untuk `WHATSAPP_NUMBER_TAKEN`, `DOMAIN_RESERVED`, `DOMAIN_VERIFICATION_FAILED`; 422 `VALIDATION_ERROR` untuk nomor WhatsApp tidak valid.

## legend-bsw9 urutan sisip stock ledger untuk rebuild saldo (engineer, cabang `ws/stock-ledger-sequence` dari milestone/m1 3517283b, 2026-11-10)

- Keputusan CTO: tambah urutan sisip di `stock_ledger`, `rebuildStockBalances` melipat menurut urutan itu; posting mundur tanggal (EOD, opname, impor) tetap boleh. Posting live tidak berubah.
- Sudah: kolom `stock_ledger.posting_seq` (bigint identity GENERATED ALWAYS, CACHE 1). Posting live menyisip di bawah kunci advisory lokasi + kunci baris saldo, jadi urutan nomor = urutan penerapan rata-rata bergerak per (lokasi, item). Dua jalur sisip (`recordStockMovementInTransaction`, applier edge) sama-sama memegang kunci lokasi dulu. `foldStockLedger(entries, mode, "posting")` (shared) melipat menurut `postingSeq`; urutan `occurred_at` tetap default (dipakai mock web).
- Migrasi `0186_stock_ledger_posting_seq` (when 1794265000000, idx 186, prevId = id snapshot 0170): baris lama diberi nomor `(occurred_at, id)` (deterministik, urutan yang dipakai rebuild lama); trigger append-only dan FORCE RLS diangkat hanya di dalam transaksi migrasi dan dikembalikan sebelum selesai; identity di-restart di max+1; indeks `(tenant_id, outlet_id, posting_seq)`. Terdaftar di `MIGRATION_DATA_STATEMENTS`.
- Risiko: urutan sisip asli baris lama tidak tercatat. Database yang sudah punya posting mundur tanggal: rebuild sesudah migrasi tetap sama dengan rebuild lama untuk baris itu (bukan saldo live yang dulu terjadi); posting baru tepat. `stock_balances` tersimpan tidak disentuh. Migrasi memegang ACCESS EXCLUSIVE selama UPDATE seluruh tabel: cek jumlah baris production, jalankan saat sepi.
- Catatan merge: nomor 0186 dan `when` dipesan CTO; drizzle melewati migrasi yang `when`-nya lebih kecil dari migrasi terakhir yang terpasang, jadi 0171-0185 harus masuk lebih dulu atau 0186 dinomori ulang saat merge.
- Catatan F5 (`ws/ws11-inventory-purchasing`, `metric-sources/inventory-purchasing.ts:222`): replay nilai stok hari lampau mengurut `occurred_at, id`. Dengan posting mundur tanggal nilainya beda dari saldo live. Sesudah kedua cabang masuk, urutkan menurut `posting_seq` (filter `occurred_at < akhir hari` tetap). Berkas itu tidak diubah di sini.
- Bukti: gagal-dulu `inventory-ledger-sequence.test.ts` (live avg 1666.6667 vs rebuild urut-`occurredAt` 1500.0000); isolasi tenant, append-only tetap, migrasi mengisi nomor baris lama termasuk sebagai pemilik tabel biasa (bukan superuser; menemukan bug baca `max` setelah FORCE RLS, dibetulkan). Test terarah 7 file 103 lulus (+ set awal 11 file 211 lulus); kontrak root inventory + purchasing 38/38; `db:generate` kedua kosong; tsc shared + api exit 0 (heavy); eslint + prettier bersih.
- Review K: architect (migrasi aman, urutan sisip benar; temuan: tes pemilik non-superuser, `when` vs cabang lain, indeks tidak terpakai diganti, tes tanpa nilai dibuang, `cache_size` dipin, replay F5). Second opinion Codex disiapkan: `docs/briefs/279b-second-opinion-stock-ledger.md` (xhigh), belum dijalankan.
- Penulis ledger diperiksa (2026-11-10): hanya dua penyisip non-tes (`inventory.service.ts`, posting biasa dan applier edge), keduanya tanpa `posting_seq`, jadi identity mengisi. Restore tenant (`platform-org.service.ts` `restoreTenant`) hanya mengubah status tenant, tanpa salinan ledger; tidak ada seed, impor, salin tabel, atau `pg_dump` yang menyentuh `stock_ledger`. Tes penjaga `stock-ledger-writers.test.ts` (16 tes bersama `edge-stock-moved-applier`): penulis baru selain dua itu gagal, `posting_seq` eksplisit ditolak (428C9), event edge mundur tanggal yang diterapkan belakangan mendapat nomor lebih besar dan rebuild = saldo live.
- Langkah berikut: merge train, second opinion Codex sebelum gerbang rilis.

## legend-u4js6 HPP per baris pesanan saat penjualan (engineer, cabang `ws/cost-snapshot-at-sale` dari milestone/m1 3517283b, 2026-11-10)

- Keputusan lengkap di `docs/DECISIONS.md` (entri teratas). `order_items.cost_snapshot_idr` = HPP total baris (qty x HPP porsi), rupiah bulat, setengah ke atas sekali per baris; biaya = `stock_balances.avg_cost_idr` lokasi jual saat baris dimasukkan. NULL (bukan 0) bila tanpa resep, resep tak aktif/rusak, tanpa lokasi jual, qty < 1, atau satu bahan tanpa biaya.
- Helper bersama `services/order-cost-snapshot.service.ts` (`computeLineCostSnapshots`, savepoint, galat -> NULL + warn) dipakai POS, QR, delivery; `recipe-bom.service.ts` mendapat `explodeMenuLinesEach` (perilaku `explodeMenuLines` tetap). Applier edge tetap NULL. Tanpa migrasi (0183 dilepas), tanpa backfill.
- Bukti: gagal-dulu 10/12 gagal tanpa pemanggil; akhir `order-cost-snapshot.test.ts` 15/15; set terarah 7 file 115/115; tsc api, eslint, prettier bersih. Review K architect: 1 temuan kode (kode galat di log) dibetulkan, 2 celah tes ditutup.
- Risiko: `pos-order-support.ts:1048` dan `ai-metrics/sales.ts` masih membaca NULL sebagai 0 (kartu terpisah).

## legend-ul4s pemetaan HTTP galat inventory dan purchasing (engineer, cabang `ws/inventory-error-http` dari milestone/m1 3517283b, 2026-11-10)

- Sudah: satu pemetaan status HTTP + pesan aman per kode `InventoryError` dan `PurchasingError` (`inventoryErrorHttpStatus`, `purchasingErrorHttpStatus`, `*ErrorMessages` di `packages/shared/src/inventory/errors.ts` dan `purchasing/errors.ts`; tipe `Record` atas union kode, kode baru tanpa status gagal typecheck). Tabel kontrak di `docs/plan/contracts.md` (D-CORE-4).
- Sudah: satu translator `translateDomainError` (`apps/api/src/services/domain-error-http.shared.ts`); `translateInventoryError`, `translateCountError`, `translatePurchasingError` kini hanya mendelegasikan. Jalur kirim PO yang membocorkan pesan mentah (`purchasing-send.service.ts`) ikut pemetaan umum.
- Status berubah (belum ada jalur API yang memicunya): `PURCHASE_ORDER_LINE_MISMATCH` dan `THREE_WAY_MATCH_INVALID_INPUT` 409 ke 422. `INSUFFICIENT_STOCK` lewat translator umum 422 ke 409 (helper `insufficientStock` sudah 409). Tabel status hitungan stok dan self-approval purchasing (409) tidak berubah.
- Bukti: gagal-dulu `inventory-purchasing-error-http.test.ts` (modul belum ada); 6 file 175 tes lulus (count, ops, purchasing-flow, purchasing-send, purchasing-supplier + file baru); kontrak root inventory + purchasing 38/38; tsc shared + api exit 0 (heavy); eslint + prettier bersih. Review reviewer sonnet: 2 temuan (jalur kirim PO, pengecualian pesan `countError` di kontrak) dibetulkan.
- Langkah berikut: merge train.

## legend-umzos pulihkan tenant diarsip / outlet ditutup dalam 30 hari (engineer, cabang `ws/platform-restore-archived` dari integ/m1-batch31 d7a95d0c, 2026-11-09)

- Keputusan founder Q40. Super Admin memulihkan tenant `archived` ke status sebelumnya (`active`/`suspended`) dan outlet `closed` ke status sebelumnya (`preopening`/`active`) dalam 30 hari sejak transisi (batas inklusif); sesudahnya 409 `RESTORE_WINDOW_EXPIRED`. Peta transisi tetap final (`archived -> []`, `closed -> []`); endpoint status umum tetap 409 `INVALID_TRANSITION`. Pulih hanya lewat aksi khusus.
- Kontrak shared (`packages/shared/src/platform/org.ts` bagian "restore window (Q40)"): `RESTORE_WINDOW_DAYS`, `canRestoreFrom`, `restoreDeadline`, input `{reason}` (min 10), read model `tenantRestoreWindowSchema`/`outletRestoreWindowSchema`; error `RESTORE_NOT_AVAILABLE`, `RESTORE_WINDOW_EXPIRED`; 4 endpoint di `platformEndpoints`.
- API (router platform: `requirePlatformAdmin` + MFA sesi, sama dengan arsip): `POST /api/platform/tenants/:tenantId/restore`, `GET .../restore-window`, `POST /api/platform/tenants/:tenantId/outlets/:outletId/restore`, `GET .../outlets/:outletId/restore-window`. Audit `tenant.restored` / `outlet.restored` (safe field status, archivedAt/closedAt, activeEdgeNodes). Outlet tidak bisa dipulihkan selama tenant masih diarsip (409 `INVALID_TRANSITION`). Kunci baris tenant lalu outlet (`FOR UPDATE`).
- Migrasi `0165_platform_restore_window` (when 1794244000000): `tenants.archived_at`, `status_before_archive`, `outlets.closed_at`, `status_before_close` (nullable, CHECK enum + CHECK berpasangan). Tanpa backfill: data lama tanpa waktu transisi final (`RESTORE_NOT_AVAILABLE`); produk belum production, tutup outlet tidak pernah diaudit sehingga tidak bisa dibuktikan.
- Efek samping: nomor struk aman (counter tidak disentuh status, unique + trigger maju-saja); langganan: tidak ada tabel billing tenant, plan/limits tidak berubah; akses pengguna dan edge hanya digerbang saat baca, kembali saat pulih; kredensial edge tidak dicabut saat tutup, tetapi edge berhenti mencoba setelah ditolak sehingga layanan edge harus di-restart (kartu legend-rmq4g). Kuota outlet menghitung outlet tutup, jadi pulih tidak melampaui kuota.
- Bukti: `platform-restore-window.test.ts` 20/20; set terarah 5 file 59/59 (termasuk edge-received-events-migration, migration-fk-force-rls); db:generate kosong; tsc shared + api exit 0 (heavy); eslint + prettier bersih.
- Review K: reviewer Opus (tanpa bug; risiko urutan merge 0163/0164 vs 0165) + architect (blocking: audit ter-redaksi, dibetulkan dengan safe fields; PRD edge restart, dibetulkan). Second opinion Codex: `docs/briefs/230b-second-opinion-platform-restore.md` di folder utama.
- Kartu baru: legend-nb4iy (UI Panel Platform), legend-rmq4g (edge retry), legend-hb1u9 (audit status outlet).

## legend-ghgei refund pembayaran terlambat dan bagian gateway refund POS (engineer, cabang `ws/late-payment-refund-refile` dari ws/pos-order-replay-zone-charge c75b0d98, 2026-11-09)

- Temuan "refund staf untuk QR intent ber-orderId gagal source_document" tidak terjadi di production: tidak ada kode yang mengisi `payment_intents.order_id` (insert tunggal `payment.service.ts:744`), jadi `hasSourceDocument` tidak pernah aktif untuk intent QR/POS sungguhan. Refund late payment yang ditolak atau kedaluwarsa menjadi `failed` dan cap bebas lagi, jadi staf sudah bisa mengajukan ulang. Dibuktikan dengan test regresi `late-payment-refund-refile.test.ts` (QR dan POS, rejected dan approval_expired: staf ajukan ulang, orang lain setujui, dibayar sekali, 1 IDR tambahan ditolak). Tidak ada auto-refile: penolakan approver adalah keputusan manusia.
- Sudah: kunci idempoten berawalan sistem (`pos-late-payment-refund:`, `qr-late-payment-refund:`, `pos-refund-gateway:`, `reservation-refund:`) ditolak 422 `IDEMPOTENCY_KEY_RESERVED` untuk pengguna (`payment-admin-idempotency.ts`). Sebelumnya pengguna bisa merebut kunci itu lebih dulu sehingga filer sistem gagal `IDEMPOTENCY_KEY_REUSED`.
- Sudah: refund POS kini mengajukan refund WS-05 `system:pos` untuk bagian gateway-nya (`pos-refund-gateway.ts`, dipanggil dari `refundPosOrder` bila bukan retur barang saja). Per intent, intent EDC dilewati, jumlah = min(baris, cap - reserved), kekurangan diaudit `pos_order.refund_gateway_shortfall`, kunci `pos-refund-gateway:<posRefundId>:<intentId>`. Persetujuan dan payout tetap di WS-05.
- Empat mata: pembuat dan penyetuju refund POS tidak bisa menyetujui payout gateway-nya lewat jalur mana pun (approve langsung, inbox `/approvals/:id/decisions`, settle chain, revalidasi sweep/retry). Ditemukan oleh architect dan re-review Opus, dibetulkan; settle tidak pernah membuat refund macet `pending` (gagal `approver_unauthorized` / `pos_refund_party`).
- Bukti: test gagal di basis (gateway autofile 5/5 gagal tanpa baris refund; empat mata 2 + 3 gagal sebelum fix). Final: 18 file test API, 606 lulus, 8 dilewati `skipIf` milik escalation; tsc apps/api exit 0 (heavy); eslint + prettier bersih. Tanpa migrasi.
- Review K: architect (desain + diff), reviewer Opus (diff, 2 re-review delta, terakhir tanpa temuan). Second-opinion Codex: `docs/briefs/230b-second-opinion-late-payment-refund.md` di folder utama.
- Kartu tindak lanjut: legend-xtzpb (cap tidak mengurangi penjualan QR pay-first yang masih hidup), legend-4itg8 (daftar dan tampilan bagian gateway refund POS yang belum dibayar), legend-hzdv5 (prefiks kunci sistem di tiga tempat).

## legend-pszrm objek storage mencatat pemilik dan sumber, baca per objectId (engineer, cabang `ws/storage-object-owner` dari ws/support-storage-access b800ae30, 2026-11-10)

- Migrasi `0177_storage_object_owner` (`when` 1794256000000, prevId = snapshot 0171 `2c41f8ad`): `core_storage_objects` + `owner_user_id`, `source_kind` (check daftar kind), `source_id` (check: id butuh kind), index (tenant, kind, id). Backfill tautan lama dokumen karyawan, kontrak, lampiran cuti. Wajib merge setelah 0172–0176.
- Shared: `storageSourceKindSchema` (10 kind), `storageSourceKindPurpose`, `storageDefaultSourceKind` (selfie→attendance, menu_photo→menu_item), `sourceKind` opsional di metadata upload (harus cocok purpose).
- `core-storage-access.ts`: baca per objectId. Pemilik selalu boleh; reviewer hanya kind yang cocok izinnya, di outlet objek; kind null (data lama) hanya `storageLegacyReadMap` (selfie `hr.attendance.manage`, document `hr.employee.manage`, receipt `accounting.reconcile`, menu `menu.item.manage`). Objek hilang, tenant lain, ditolak: jawaban sama. Receipt wajib punya kind saat upload.
- `core-storage.ts`: upload mengisi pemilik = pengunggah dan kind; `linkStorageObjectSource` (sekali, purpose cocok, outlet cocok, hanya oleh pemilik; objek tanpa pemilik tidak pernah ditautkan, lampiran cuti juga wajib milik peminta). Render PDF menu otomatis: pemilik null. Dipakai kontrak, dokumen karyawan (pemilik → user karyawan), lampiran cuti.
- Router storage tetap belum dipasang (legend-7nv1).
- Review architect (K, lensa penyerang) 2 putaran: 2 temuan sedang (link tanpa cek outlet/pemilik + tanpa backfill; receipt tanpa kind) dan 1 rendah (PDF menu tanpa pemilik bisa diklaim sebagai lampiran cuti) semua dibetulkan.
- Bukti: gagal-dulu 7/17 tes akses di implementasi lama (b800ae30). Akhir: 16 file test API, 239 lulus (termasuk `core-storage-backfill.test.ts` 11 dan RLS guard migrasi). `db:generate` kedua kosong. tsc shared + api exit 0 (heavy). eslint + prettier berkas berubah bersih. Tes root `tests/core-storage-contract.test.mjs` tidak dijalankan (hanya lewat `pnpm test` penuh; dibaca, kompatibel).
- Brief Codex: `docs/briefs/261b-second-opinion-storage-owner.md` (belum dijalankan).
- Sisa: kind untuk media SOP, maintenance, checklist, equipment, menu import belum ada (upload document tanpa kind tetap bisa, baca hanya pemilik + `hr.employee.manage`).

## legend-3k8no + legend-k7x4p order POS: replay idempoten lintas deploy, biaya layanan zona (engineer, cabang `ws/pos-order-replay-zone-charge` dari integ/m1-batch31 37ec911e, 2026-11-09)

- Basis: integ/m1-batch31, bukan `milestone/m1` lokal (94d769c6, batch24), karena bug 3k8no ada di legend-63l6 (batch28) yang belum ada di `milestone/m1`.
- 3k8no sudah: `sendOrder` (`apps/api/src/routes/pos-order.routes.ts`) mengenali replay yang disimpan sebelum legend-63l6 (respons tanpa `version`). Untuk replay itu order dibaca ulang dari DB (`getPosOrder`), snapshot order diganti detail segar, dan ETag = `version` yang sama di body. Mutasi tidak diulang. Hasil tender tetap `{...data, order: segar}`. `posOrderVersion` (tidak dipakai lagi) dihapus.
- 3k8no test: `src/test/pos-order-legacy-replay.test.ts` (create, submit, tender; baris idempoten dibuang `version`-nya, versi DB dimajukan, retry). Gagal 3/3 di basis (`data.version` / `data.order.version` expected number, received undefined), lulus 3/3 setelah fix.
- k7x4p: tidak ada jalur API yang membuat order POS non-dine_in dengan sesi meja. Create menolak di `pos-order.service.ts:541`; QR selalu dine_in; delivery inject tanpa sesi; tidak ada update `serviceType`/`tableSessionId`; edge applier hanya menyalin order QR cloud. Jadi create (`:672`) dan reprice (`pos-order-support.ts:890`) selalu sama. Ditutup dengan test saja, tanpa ubah kode: `src/test/pos-order-session-service-type.test.ts` (7 kombinasi channel/serviceType ditolak 400 tanpa baris order, dine_in 201 dengan service charge zona 5%). Test gagal 7/8 bila guard `:541` dimatikan. Reviewer Opus + architect setuju.
- Bukti: 11 file test API, 113 lulus; tsc apps/api exit 0 (heavy); eslint + prettier bersih. Tanpa migrasi.
- Sisa (opsional, kartu baru bila mau): CHECK DB `table_session_id IS NULL OR service_type = 'dine_in'` dan refine schema edge `qrOrderPlacedEdgePayloadSchema`; butuh migrasi, tingkat K.

## legend-c9kbk support read_write butuh persetujuan Owner tenant (engineer, cabang `ws/support-rw-owner-approval` dari ws/impersonate-expiry-cap a0f0c127, 2026-11-09)

- Sudah (Q37/Q38): read_write tidak lagi dibuka langsung. `POST /api/platform/tenants/:id/support-access` dengan read_write kini 409 `SUPPORT_ACCESS_OWNER_APPROVAL_REQUIRED` (422 tetap lebih dulu untuk durasi > 30). Super Admin mengajukan `POST /api/platform/tenants/:tenantId/support-access-requests` (MFA segar, 15/30 menit). Selama menunggu, ditolak, atau kedaluwarsa tidak ada baris grant, jadi guard, impersonate dan batas sesi melihat "tanpa grant" (fail closed by construction). Owner menjawab lewat `GET /api/org/support-access/requests`, `POST .../:requestId/approve|reject`: izin `org.support_access.approve` (owner saja), sesi lulus 2FA, bukan sesi impersonate, penugasan Owner aktif tenant itu, bukan peminta, dan peran Owner-nya tidak dibuat oleh atau selama sesi dukungan peminta (`SUPPORT_APPROVER_NOT_INDEPENDENT`). Peminta yang sudah dicabut Super Admin-nya: 409. Approve membuka grant mulai saat itu (durasi dihitung dari approval). Tanpa jawaban 24 jam: kedaluwarsa (sweep worker + saat diakses).
- Audit tenant: `support_access.requested|approved|rejected|request_expired` (+ `granted` saat approve), label Indonesia. Notifikasi Owner lewat outbox `support_access.requested` (hanya pemegang template owner).
- Migrasi `0160_support_access_requests` (when 1794239000000; 0155-0159 milik cabang lain): tabel `support_access_requests` (RLS force, CHECK status/keputusan/jendela 24 jam, trigger membekukan baris yang sudah diputuskan, REVOKE DELETE/TRUNCATE dari legend_app), kolom `support_access_grants.approval_request_id` + FK komposit tenant + CHECK `support_access_grant_write_approved_check` (NOT VALID), backfill izin ke peran owner tenant lama. FK ke tabel FORCE: pola 1 (inline) dan pola 2 (lift FORCE) dari `docs/plan/contracts.md`.
- Rilis: migrasi dulu, lalu API + worker (catatan di `docs/deployment.md`). Web dialog lama hanya bisa read_only sampai kartu UI legend-8r77t.
- Review K: reviewer Opus (1 Medium: Owner kedua dibuat selama sesi read_write bisa menyetujui permintaan berikut, dibetulkan dengan cek independensi; Low list tanpa MFA/impersonate guard, notifikasi ke non-owner, DELETE baris keputusan; semua dibetulkan) + architect (setuju desain tabel terpisah; High DB masih menerima grant read_write tanpa approval, dibetulkan dengan `approval_request_id` + CHECK; Medium peminta dicabut, dibetulkan; contract test ditambah).
- Re-review K (reviewer Opus, delta fix): Medium CHECK NOT VALID tetap dicek saat UPDATE, jadi grant read_write lama tidak bisa diakhiri; dibetulkan (baris tertutup dikecualikan). Low: Owner tidak independen tetap boleh menolak; cursor id bukan uuid kini 422. Bypass aturan independensi tidak ditemukan.
- Bukti: repro gagal di base (impersonate 200, harus 403). 13 file test API 191 lulus, termasuk 3 test migrasi FORCE RLS; contract root 36/36; tsc api + shared exit 0 (heavy); eslint + prettier bersih; `db:generate` kosong.
- Berikut: second-opinion Codex (`docs/briefs/211b-second-opinion-support-rw-owner-approval.md` di folder utama), kartu UI legend-8r77t (menunggu review UI founder), merge train.
- Biaya sesi (npkpz + c9kbk, 13:33-14:24 UTC): total 7066k unit, 21 subagent (Opus 95 req, Sonnet 160 req, Haiku 13 req).

## legend-jcby0 write-off nomor struk ikut tersinkron ke edge (engineer, cabang `ws/receipt-writeoff-edge-sync` dari integ/m1-batch27 f448cf94 + merge hfq3z 996cc889, 2026-11-09)

- Sudah: edge meminta `receiptWriteoffs=1` di pull registri perangkat; cloud mengirim daftar write-off outlet itu (maks 1000 terbaru, diurut lama ke baru, dibaca dalam savepoint: gagal baca = field tidak dikirim). Edge (primary dengan binding) menyalin baris ke `receipt_number_writeoffs` lokalnya dengan id cloud, sekali per pull, idempoten. Baris hanya disalin bila edge memegang run yang sama (id, outlet, prefix) dengan `last_number >= nomor` dan belum ada struk lokal untuk nomor itu; selain itu dilewati (fail closed). Cek celah edge sudah memakai port yang sama dengan cloud, jadi Tutup Hari edge lulus sesudah pull, juga saat offline; struk terlambat membatalkan write-off seperti di cloud. Tanpa migrasi (0161 tidak dipakai).
- Kompat: edge lama tidak meminta, halaman tetap tanpa field baru. Edge baru ke cloud lama: 400, ulang tanpa `receiptWriteoffs`, lalu rantai mundur lama. Rilis: cloud dulu, lalu build edge. Runbook `docs/runbooks/receipt-number-writeoff.md` diperbarui (aturan sementara "tutup hari lewat cloud" hanya untuk edge lama).
- Bukti dan review: lihat komentar kartu legend-jcby0. Brief: `docs/briefs/sub-receipt-writeoff-edge-sync.md`, `-fix1.md`.
- Tindak lanjut: legend-mqh2m (status puller menampilkan hitungan write-off).

## legend-npkpz sesi impersonate dipotong saat grant berakhir (engineer, cabang `ws/impersonate-expiry-cap` dari integ/m1-batch24 94d769c6, 2026-11-09)

- Sudah: `expiresAt` sesi impersonated = min(expiry Better Auth, sekarang + 60 menit, akhir grant terakhir yang cocok) di `session.create.before` (`impersonationSessionEnd`). Grant dicabut atau kedaluwarsa kemudian tetap ditolak guard per request.
- Scan grant lintas tenant: dalam satu request `POST /api/auth/admin/impersonate-user` scan penuh pertama yang berhasil mengingat tenant yang cocok (memo `WeakMap` di store AsyncLocalStorage request); dua cek berikutnya scan ulang segar (grant + peran) hanya di tenant itu, jadi grant yang diakhiri di tengah request tetap ditolak (temuan Low reviewer Opus, dibetulkan). Test: 31 transaksi jadi < 2 × jumlah tenant. Tanpa request (server-side `auth.api`) tetap scan penuh tiap cek.
- Batas (jujur): grant ada di bawah RLS tenant yang di-force, jadi tanpa migrasi scan tetap mengunjungi tiap tenant sekali per request mulai, dan sekali saat selesai. Penyempitan sungguhan butuh fungsi SECURITY DEFINER (migrasi), di luar scope.
- Label audit: `support_access.*` (granted, denied, ended, expired, impersonation_started, impersonation_ended) dan object type `support_access_grant`.
- Audit mulai: `impersonationEndsAt` per tenant = min(akhir sesi, akhir grant tenant itu).
- Review K: reviewer Opus (1 Low: memo memakai baris grant lama, grant diakhiri di tengah request tetap dipercaya; dibetulkan, memo kini hanya tenant id) + architect (setuju; Low test dua tenant, Info akhir per tenant, Nit tipe: semua dibetulkan). Follow-up: legend-edjgj (fungsi SECURITY DEFINER, migrasi).
- Berikut: second-opinion Codex (brief `docs/briefs/206b-second-opinion-impersonate-expiry-cap.md` di folder utama), merge train.

## legend-nd3cu cursor link per instance edge (engineer, cabang `ws/edge-link-instance-resume` dari ws/edge-pin-instance e1100258, 2026-11-09)

- Sudah: cloud menyimpan instance edge pemilik cursor (`sync_cursors.peer_instance_id`) dan titik awal penomorannya (`peer_seq_offset`). Link bicara dengan nomor `tersimpan - offset`.
- Edge yang mengirim instance: cloud menunda hello-nya sampai hello edge tiba, lalu memutuskan:
  - Instance sama: tidak berubah.
  - Belum ada instance tersimpan: di-adopt.
  - Instance lain dengan cursor 0 (rebuild): kedua arah di-rebase. Edge→cloud mulai dari cursor yang diterima, cloud→edge dari ack terakhir.
  - Instance lain dengan cursor di atas 0 (restore/clone): ditolak 1008, tanpa perubahan.
- Cursor tersimpan tetap maju saja. Trigger: offset hanya naik, dan hanya saat instance berganti dari satu instance yang dikenal ke instance lain. Instance tidak bisa dihapus.
- Baris yang terikat instance hanya melayani instance itu: link basi dan link tanpa instance ditolak dengan 1008.
- Edge lama pada baris tanpa instance: perilaku sama. Sisi edge: offset 0, dijaga oleh check.
- Migrasi `0162_sync_cursor_peer_instance` (when 1794241000000; 0158 kosong; 0159-0161 dipesan cabang lain). Rilis: cloud dulu, lalu edge.
- Batas: DB restore/clone yang masih punya cursor tetap fail-closed (1008). Rebuild bersamaan dengan upgrade pertama ke rilis ini di-adopt tanpa rebase. Kedua kasus tetap memakai runbook daftar node baru. Mesin lama yang hidup lagi dengan cursor 0 bisa mengambil alih node (melanggar aturan satu mesin per node). Ini tidak menyebabkan apply ganda, karena event id di-dedupe. Merge train: 0159-0161 harus masuk sebelum 0162, atau `when` mereka dinaikkan di atas 1794241000000.

## legend-o839h PIN edge membedakan DB edge yang dibangun ulang lewat instance_id (engineer, cabang `ws/edge-pin-instance` dari integ/m1-batch24 94d769c6, 2026-11-09)

- Sudah: edge mengirim `edge_nodes.instance_id` sebagai header upgrade link `x-edge-instance`; cloud menyimpannya di `staff_pins.generation_edge_instance_id` di samping node dan sequence. Sequence hanya dibandingkan untuk node + instance yang sama; instance lain (DB dibangun ulang) dan baris lama berinstance null dibandingkan dengan kunci, jadi set PIN baru diterima tanpa runbook. Instance tak diketahui (edge lama, drain parkir, replay konflik) memakai aturan node-saja seperti sebelumnya; drain parkir tidak meminjam instance link hidup.
- Migrasi `0157_staff_pin_generation_instance` (journal idx 155, when 1794236000000; 0155 payroll dan 0156 write-off struk di cabang lain). Merge train: 0155 dan 0156 harus masuk lebih dulu atau when-nya dinaikkan di atas 0157, karena migrator drizzle melewati migrasi dengan when lebih kecil dari yang sudah diterapkan.
- Rilis: migrasi + cloud dulu, lalu edge (urutan lain juga aman: header diabaikan cloud lama).
- Batas: celah saat upgrade (baris node+null yang kuncinya di depan jam edge menolak satu set/lock); restore/clone tetap sequence (lanjutan legend-g1799).

## legend-xx22n QR dine-in service charge default SC-DINE-IN (engineer, cabang `ws/qr-service-charge-default` dari m1 94d769c6, 2026-11-09)

- Hasil: temuan Codex 133 tidak tereproduksi. `selectServiceChargeRules` (qr-order-pricing.ts:560) sudah jatuh ke aturan published outlet/tenant bila zona 0; QR dan POS memakai loader dan selektor yang sama. Tidak ada perubahan kode produksi.
- Presedensi (tetap): zona `serviceChargeBp > 0` menimpa; 0 = pakai aturan published. Skema zona tidak membedakan "eksplisit 0" dan "tidak diisi" (`NOT NULL DEFAULT 0`), jadi zona tidak bisa menghapus service lewat 0; menghapus service = nonaktifkan aturan published.
- Bukti: test DB baru `apps/api/src/test/qr-service-charge-default.test.ts` (5 kasus: default tenant, override zona, paritas POS + takeaway 0, lintas tenant, default outlet-scoped). Mutasi reviewer (fallback dimatikan) membuat kasus 1, 3, 4 gagal. 3 file / 23 test lulus, tsc api, eslint, prettier hijau.
- Review K: reviewer + architect, tanpa temuan pada QR. Sisi lain: legend-k7x4p (POS takeaway di table session, belum terverifikasi). Brief Codex: `docs/briefs/209b-second-opinion-qr-service-charge-default.md` (folder utama).

## legend-hfq3z run struk pengganti yang ditolak edge pulih sendiri (engineer, cabang `ws/receipt-run-self-heal` dari integ/m1-batch24 94d769c6, 2026-11-09)

- Sudah: bila edge menolak run pengganti karena prefix atau id bentrok (`refused_prefix_used` / `refused_id_used`), pull berikutnya membawa `receiptRefused=<id>:<alasan>,...` (maks 50, id terkecil dulu). Cloud memensiunkan run itu (`claim_rotated`, tanpa migrasi) dan memberi run baru terikat ke database edge yang sama, di prefix di atas semua `P<n>` yang dilaporkan edge; edge menerimanya di respons yang sama dan penjualan jalan lagi. Syarat: run berlaku, terikat tepat ke (node, instance) ini, `lastNumber` 0, laporan `receiptRuns` di request yang sama ada; untuk `id_used` juga `edge_reported_number` 0 dan laporan tidak memberi nomor untuk prefix itu (untuk `prefix_used` nomor di laporan dan di `edge_reported_number` milik run lokal lain, jadi diabaikan). Laporan berulang, terlambat, id tak dikenal, id tenant/outlet/binding lain: diabaikan (lock outlet, hanya baris berlaku yang dikunjungi). Insert run di edge dibungkus savepoint: bentrok unique (termasuk baris yang tak terlihat RLS) jadi penolakan yang dilaporkan, bukan seluruh daftar gagal.
- Pengaman: maks 10 rotasi heal per perangkat per (node, instance) per 24 jam; lewat batas = `receiptRunAlert` + log error. Penanda baris heal tanpa migrasi: `claim_rotated` dengan `edge_reported_at = tau` dan `retired_at = tau` (`id_used`) atau `tau + 1 ms` (`prefix_used`); rotasi klaim biasa tidak cocok. Heal `id_used` ikut cek clone (laporan di atas high-water = alert); heal `prefix_used` tidak (edge memang terus melaporkan prefix itu untuk run lainnya).
- Kompat: edge lama tanpa `receiptRefused` tidak berubah. Edge baru ke cloud lama (query strict, 400): fetcher mengulang tanpa `receiptRefused` dulu, lalu jalur mundur lama. Rilis: cloud dulu, lalu edge.
- Bukti: test baru gagal di base 94d769c6 (32 gagal, 28 lama lulus; probe: 2 pull tambahan tetap tidak bisa menjual); sesudah perbaikan test terarah lulus (angka akhir di laporan kartu); tsc shared+api via heavy exit 0; eslint + prettier bersih. Review K: reviewer Opus + architect, lalu dua putaran re-review Opus; semua temuan nyata dibetulkan (`docs/briefs/sub-receipt-run-self-heal-fix1.md` sampai `-fix3.md`).
- Tindak lanjut: legend-p7gb6 (alasan pensiun khusus `edge_refused`, migrasi), legend-c4ejw (edge mengingat cloud yang menolak `receiptRefused`).

## legend-63l6 + legend-kz1m + legend-lvx2 paket kontrak kecil (engineer, cabang `ws/small-contracts-pack`, rebase ke m1 94d769c6, 2026-11-09)

- Sudah: (63l6) respons order POS memuat `version`; body mutasi order (submit, fire, complete, void, void item, tender, diskon tambah/hapus) menerima `expectedVersion` opsional, setara `If-Match`; keduanya ada dan beda = 412; tulisan basi perangkat kedua pada status sama ditolak `PRECONDITION_FAILED`; klien lama tanpa keduanya tetap jalan (guard `expectedStatus` tetap). Salinan body dibuang sebelum fingerprint idempotency (retry header/body tetap replay); ETag diambil dari `version` respons. Fixture shared dan mock kasir web ikut `version`. (kz1m) kode `org.notification_policy.manage` (tanpa tag), owner otomatis lewat aturan katalog, `tenant_admin` eksplisit, label Indonesia; belum dipasang ke route. (lvx2) payload bertipe `checklist.completed`, `checklist.reminded`, `equipment_service.reminded`, `prep_list.created`.
- Migrasi `0159_notification_policy_permission` (data saja, pola 0148; journal idx 155, when 1794238000000). Merge hanya setelah 0155-0158 cabang lain masuk journal, karena drizzle melewati `when` lebih tua yang datang belakangan.
- Gate (di atas 94d769c6): tsc shared/api/web (heavy), eslint dan prettier 20 file, vitest 10 file 101 test, root DB-free 7 file 104 test, `db:generate` kosong.
- Review K: reviewer Opus + architect (izin) dan reviewer Opus + architect (konkurensi); temuan nyata dibetulkan (fingerprint idempotency, ETag). Berikut: second-opinion Codex brief `docs/briefs/207b-second-opinion-small-contracts-pack.md` (folder utama), merge train. Keputusan founder terbuka: `tenant_admin` boleh mengatur batas biaya WhatsApp lewat izin ini.

## legend-gauz3 + legend-r11j7 + legend-lhffb race PIN edge (engineer, cabang `ws/edge-pin-race-fixes` dari m1 94d769c6, 2026-11-09)

- Sudah (gauz3, P1): job resend material PIN mengunci baris PIN (`FOR UPDATE`) sebelum membaca material dan event set terakhir, satu baris per transaksi (review K: mengunci semua baris sekaligus bisa deadlock dengan penarik PIN yang mengunci urut id cloud). Reset yang bersamaan tidak lagi membuat PIN lama aktif lagi.
- Sudah (lhffb, P2): lock dari node asal generasi dengan sequence ≤ sequence set generasi ditolak sebelum perbandingan timestamp, sama seperti guard set.
- Sudah (r11j7, P2): migrasi `0163_staff_pin_attempt_revision` (`when` 1794242000000): kolom `attempt_revision` yang dinaikkan trigger setiap counter, lock, atau material berubah, dan baseline edge `cloud_attempt_revision`. Edge menilai "counter bergerak" dari revisi bila keduanya punya; tanpa revisi, perbandingan nilai seperti sebelumnya. Ekspor membawa `attemptRevision` hanya bila edge meminta `revision=1` (edge lama memakai schema strict).
- Rilis: cloud dahulu (sudah urutan di `docs/deployment.md`); edge baru butuh cloud yang mengenal `revision=1`.
- Batas: restore cloud yang memundurkan revisi tepat ke baseline edge bisa memunculkan lagi kasus ABA (jarang, arah aman). Saat merge dengan cabang generation instance (0157), klausa baru guard lock harus ikut memakai pemeriksaan asal yang sadar instance.
- Second opinion Codex: `docs/briefs/221b-second-opinion-edge-pin-race-fixes.md` (folder utama, tidak di-commit).

## legend-sduiq edge berhenti menomori run yang dipensiunkan cloud (engineer, cabang `ws/edge-restore-retired` dari b6d6c8b4, 2026-11-09)

- Sudah: sesudah sequence satu halaman pull diterapkan, edge mempensiunkan run lokal yang masih berlaku di sini (terikat ke binding sendiri, atau belum terikat) tetapi tidak ada lagi di daftar penuh dari cloud. Alasannya `edge_replaced`, tanpa migrasi. Pilihan A (apply) dipilih, bukan B (alokasi menolak), karena B butuh state baru, satu baca ekstra tiap penjualan, dan salah pada boot pertama. Rincian: `docs/briefs/sub-edge-restore-retired.md`.
- Pengaman: daftar kosong, daftar yang ditolak, daftar tanpa entri untuk binding sendiri, standby, dan baris yang terikat ke instance lain tidak pernah dipensiunkan. Status edge mendapat `deviceRegistry.receiptSequencesRetired` dan `receiptSequencesRetiredAt`.
- Batas (jujur): bila pengganti ditolak karena prefix atau id bentrok, perangkat itu tetap tidak bisa menjual (fail closed) sampai prosedur manual zsdd dijalankan. Tandanya `receiptSequencesRefused > 0` yang menetap. Kasus pengganti yang sudah maju (L > 0) pulih sendiri lewat rotasi berikutnya; ini hanya dianalisis dan belum diuji.
- Rilis: hanya edge, tanpa urutan khusus terhadap cloud.

## legend-ktc4d lanjutan: audit `platform.access.denied` untuk sesi impersonate (engineer, cabang `ws/grant-role-lock-b33` dari `hold/ktc4d-qr1uv-b33` + cherry-pick 8ajy4, 2026-11-09)

- Sebab gagal di merge train: sesudah support-readonly 6618970d, sesi impersonate ditolak oleh guard support di dalam `requireAuth` (403 `SUPPORT_ACCESS_REQUIRED`), sebelum `requirePlatformAdmin` dan service ktc4d, jadi `tenant_owner.denied` tidak tertulis.
- Sudah: `requirePlatformAuth` (membungkus `requireAuth`, dipakai `platformRouter` dan `platformGuard`) dan `requirePlatformAdmin` menulis `platform.access.denied` (aktor = admin yang impersonate; `after`: cause, code, impersonatedBy, impersonatedUserId, method, route) untuk tiap tolakan 403 karena impersonate. Hasil auth tidak berubah. Tenant baris: hanya `/api/platform/tenants/<uuid>` atau tenant yang di-resolve, dan hanya bila salah satu orang punya role atau grant support di tenant itu. Route dinormalisasi, segmen bebas jadi `*`, maks 256 karakter; satu baris per sesi, tenant, kode, metode per 60 detik. `support-session.ts` dan `auth.ts` tidak diubah.
- Bukti: di basis hold 3 test gagal (termasuk test ktc4d yang ditahan); sesudah fix 12 file test terarah 113 lolos (termasuk `platform-support-access`, `support-session-readonly`). tsc api bersih, eslint dan prettier bersih.
- Review K: reviewer Opus + architect; temuan tenant pilihan pemanggil, banjir baris, aktor tidak konsisten, `next` di dalam try, teks bebas di route: semua dibetulkan dan diuji.

## legend-8ajy4 grantRoleAssignment: kunci tenant dulu, waktu sesudah kunci (engineer, cabang `ws/grant-role-lock` dari `ws/end-role-assignment-lock` 61eb1ca0, 2026-11-09)

- Sudah: `grantRoleAssignment` mengambil kunci advisory per tenant yang sama dengan `endRoleAssignment` dan jalur platform Owner sebagai perintah pertama transaksi, lalu membaca `now`, lalu memeriksa pemberi (`assertCanGrantRole`, legend-7vsby) dengan data yang dibaca sesudah kunci. Owner atau admin yang penugasannya diakhiri selagi pemberian menunggu tidak bisa memberi role lagi. Opsi `now` dihapus (tidak ada pemanggil). Tanpa migrasi, tanpa perubahan kontrak.
- Bukti: test baru `access-grant-role-lock.test.ts` (3 kasus: race Owner berakhir vs pemberian template Owner, race vs template finance, sanity). Di basis 61eb1ca0 2 dari 3 gagal; sesudah fix 10 file test terarah 87 lolos. tsc api bersih, eslint dan prettier bersih.
- Review K: reviewer Opus dan architect tanpa temuan pemblokir; komentar kunci diperbarui. Kartu baru: legend-tegsk P2 (`updateCustomRole` membaca `now` sebelum kunci baris). legend-hzdy5 (jam DB) diberi catatan: berlaku juga untuk jalur grant. Brief Codex: `docs/briefs/224d-second-opinion-grant-role-lock.md` (folder utama).

## legend-qr1uv endRoleAssignment: waktu sesudah kunci, Owner tersisa harus permanen (engineer, cabang `ws/end-role-assignment-lock` dari `ws/platform-assign-owner` 9b9d719e, 2026-11-09)

- Sudah: `endRoleAssignment` mengambil kunci advisory per tenant dulu, lalu membaca `now`, lalu cek izin `access.role.assign` dan cek Owner dengan waktu itu (parameter `now` dihapus, tidak ada pemanggil yang mengisinya). `assertCanEndOwnerAssignment` hanya menghitung Owner permanen (`valid_until` null) sebagai Owner tersisa; Owner sementara tetap berwenang sebagai pelaku. Sama dengan jalur platform legend-ktc4d.
- Bukti: test baru `access-end-owner-lock.test.ts` (4 kasus: race Owner vs Owner dengan Owner ketiga, race Owner berakhir vs penugasan Admin, Owner sementara, sanity). Di basis 9b9d719e 3 dari 4 gagal; sesudah fix 9 file test terarah 84 lolos. tsc api bersih, eslint dan prettier bersih.
- Review K: reviewer Opus dan architect: kode service benar; test race diperketat (jam Node, hanya `PERMISSION_DENIED`, Owner ketiga) dan hitungan Owner tanpa perbandingan jam DB. Kartu baru: legend-8ajy4 P2 (grant tanpa kunci tenant), legend-hzdy5 P3 (jam DB untuk cek Owner). Catatan: tenant yang Owner aktifnya hanya sementara tidak bisa mengakhiri Owner (409); sebelum deploy cek data tenant tanpa Owner permanen. Brief Codex: `docs/briefs/224c-second-opinion-end-role-lock.md` (folder utama).

## legend-ktc4d Super Admin menunjuk/mengganti Owner tenant (engineer, cabang `ws/platform-assign-owner` dari `ws/owner-grant-escalation` e2d5df50, 2026-11-09)

- Sudah: `POST /api/platform/tenants/:tenantId/owners` (tunjuk) dan `.../owners/:assignmentId/replace` (ganti dalam satu transaksi). Hanya registry `platform_admins`, sesi impersonasi ditolak, TOTP segar per request (`mfaCode`, aturan 5 menit seperti support access), alasan wajib (kosong 422). Akun: anggota aktif tenant (`userId`) atau undangan dengan aturan akun admin pertama provisioning. Tolak: diri sendiri, Super Admin lain, akun sistem/di-ban. Hanya Owner permanen (`valid_until` null) dihitung "sudah Owner" dan "tenant masih punya Owner"; kunci advisory sama dengan `endRoleAssignment`, `now` dibaca sesudah kunci. Event `role_assignment.granted/ended` + audit `role_assignment.*` (dengan alasan) + `tenant_owner.assigned/replaced/denied`. `assertCanGrantRole` tidak berubah. Tanpa migrasi.
- Bukti: 8 file test terarah 80 lolos (21 di `platform-tenant-owner.test.ts`), tsc shared+api bersih, eslint dan prettier bersih.
- Review K: reviewer Opus + architect; temuan Owner sementara dipakai ulang (tenant bisa tanpa Owner saat kedaluwarsa), `now` sebelum kunci, target Super Admin lain, `impersonatedBy` di audit penolakan: semua dibetulkan dan diuji. Kartu baru: legend-be0lx (UI Panel Platform, butuh mockup), legend-qr1uv P1 (race `now` sebelum kunci di `endRoleAssignment`, sudah ada sebelumnya). Brief Codex: `docs/briefs/224b-second-opinion-platform-assign-owner.md` (folder utama).

## legend-7vsby template Owner hanya dari Owner (engineer, cabang `ws/owner-grant-escalation` dari `ws/receipt-writeoff-hardening` c4c347ef, 2026-11-09)

- Sudah: `assertCanGrantRole` mewajibkan pemberi template owner memegang penugasan template owner aktif bercakupan tenant (403 `PERMISSION_DENIED`); izin yang sama lewat role custom, Owner cakupan brand, atau penugasan berakhir tidak cukup. `OWNER_TEMPLATE_ONLY_PERMISSIONS = ["pos.receipt.writeoff"]` ditolak di role custom (422 `PERMISSION_OWNER_ONLY`, kode dan pesan baru). Data lama: `rolePermissionsAsGranted` membuang kode itu dari semua role selain template owner saat dibaca (`toRole`, `toRoleGrant`, jalur grant); edit role lama membuangnya dari baris tersimpan. Runbook write-off diperbarui.
- Bukti: di basis c4c347ef 7 dari 10 test API baru gagal dan 8 test kontrak gagal; sesudah fix 9 file test API terarah 155 lolos, `access-contract` + `access-error-messages` 69 lolos, tsc shared+api bersih, eslint dan prettier bersih.
- Review K: reviewer Opus tanpa bypass. Architect: fix bertahan; hardening (strip untuk semua role non-owner) sudah diterapkan. Kartu baru: legend-ktc4d P1 (tidak ada jalur resmi membuat Owner pertama tenant, perlu keputusan), legend-kcwfy P3 (picker UI masih menampilkan kode write-off). Brief Codex: `docs/briefs/220b-second-opinion-owner-grant-escalation.md` (folder utama).

## legend-l56xd + legend-xlvvl pengerasan write-off nomor struk (engineer, cabang `ws/receipt-writeoff-hardening` dari `ws/receipt-number-writeoff` 13ce6220, 2026-11-09)

- Sudah: `POST`/`GET` write-off hanya untuk role template owner (role custom yang memegang kode ditolak 403). `POST` wajib verifikasi 2FA dalam 5 menit terakhir (401 `REAUTH_REQUIRED`; sesi dicabut/kedaluwarsa juga 401). `GET` ditolak di edge (409). `receiptGapsForOutlet` membaca struk + write-off dalam satu statement `UNION ALL`. Komentar di `mergeDeviceReceiptRun`: write-off tidak pernah membuat run maju. Runbook: siapa boleh, preflight, jendela kompatibilitas, rollback mencabut kode dari semua role.
- Bukti: red-first 4 test gagal di kode dasar, hijau sesudahnya. 10 file test terarah, 264 lolos. tsc bersih. Commit bf232507, e6cb3e1b.
- Review K: reviewer Opus bersih. Architect: celah lama di `grants.ts` (template owner bisa diberikan tanpa owner lewat role custom berisi semua kode owner) dicatat sebagai legend-7vsby P1, di luar cakupan 214. Brief Codex: `docs/briefs/214b-second-opinion-receipt-writeoff-hardening.md` (folder utama).

## legend-0hzqw write-off teraudit nomor struk hilang (engineer, cabang `ws/receipt-number-writeoff` dari `ws/day-close-all-gaps` 57e92b6d, 2026-11-09)

- Sudah: tabel `receipt_number_writeoffs` (migrasi 0156, when 1794235000000; FORCE RLS tenant + outlet, append-only, trigger backstop insert), izin `pos.receipt.writeoff` hanya template owner (backfill baris owner tenant lama di 0156), `POST`/`GET /api/outlets/:outletId/pos/receipt-writeoffs` (cloud saja, sesi wajib 2FA terverifikasi, kunci baris sequence, tolak nomor ber-struk / di atas lastNumber / ganda, audit `pos.receipt.written_off`). Cek celah (Tutup Hari, rekap shift) menghitung nomor write-off sebagai ada; rekap shift memuat `writtenOff`. Write-off yang nomornya kemudian punya struk diabaikan (tidak dihitung ganda).
- Review K: reviewer Opus + architect. Dibetulkan: fast path tetap jalan dengan write-off, struk terlambat, wajib 2FA, runbook (edge, urutan rilis, rollback). Lanjutan: legend-jcby0 (sync write-off ke edge, P1), legend-refx7 (alarm struk terlambat), legend-vsw4q (UI, menunggu review founder). Brief Codex: `docs/briefs/201b-second-opinion-receipt-number-writeoff.md` (folder utama).
- Rilis: 0155 (payroll) harus masuk sebelum atau bersama 0156. Runbook: `docs/runbooks/receipt-number-writeoff.md`.

## legend-6b0ld Tutup Hari memeriksa celah struk semua run outlet (engineer, cabang `ws/day-close-all-gaps` dari `ws/receipt-gaps-prefix` 4087b661, 2026-11-09)

- Sudah: port baru `posOutletReceiptGapsPort` (app.ts memasang `receiptGapsForOutletFast`) dicek sekali di `closePosDay` sesudah loop per perangkat. Tutup Hari kini ditolak (`RECEIPT_SEQUENCE_GAP`) bila ada nomor hilang di run mana pun milik outlet: perangkat yang tidak aktif hari itu, perangkat dicabut, run pensiun, dan urutan cloud prefix C. Pesan menyebut sampai 20 nomor (mis. `C-000002`). Rentang hilang `edge_regressed` tetap tidak menahan. Hitungan celah memakai kolom ordinal (indeks).
- Review K: reviewer Opus (tanpa temuan) + architect (F1 pesan, F3 hitungan dibetulkan; F2 jadi legend-0hzqw: runbook/penghapusan teraudit untuk nomor yang benar-benar hilang, karena satu lubang kini menahan setiap Tutup Hari outlet; catatan ke legend-ol6v). Brief Codex: `docs/briefs/199b-second-opinion-day-close-all-gaps.md` (folder utama).

## legend-nhmct celah nomor struk per prefix di laporan shift (engineer, cabang `ws/receipt-gaps-prefix` dari `ws/edge-restore-detect` b6d6c8b4, 2026-11-09)

- Sudah: port `PosReceiptGapsPort` mengembalikan satu entri per run perangkat `{prefix, missing[], lost}` (run tertua dulu; run tanpa masalah dihilangkan, perangkat bersih tetap `[]`). Laporan shift `receiptGaps` kini `[{prefix, missing: ["P2-000003"], lostRange}]`, jadi P1 #3 dan P2 #3 tampil terpisah. Run pensiun `edge_regressed` dengan `edge_reported_number` > `lastNumber` cloud menampilkan `lostRange` lastNumber+1..high-water untuk rekonsiliasi (dihitung saat dibaca, menyusut bila struk menyusul). Tutup Hari tetap menolak hanya bila ada nomor hilang; rentang hilang tidak menahan (satu baris di `pos-day.service.ts`).
- Kontrak DTO berubah (`posShiftReportSchema.receiptGaps`: dari `number[]` ke array objek). Web belum merender field ini (hanya mock `[]`).
- Review K: reviewer Opus + architect. Temuan nyata (urutan test, 2 test tambahan, komentar) dibetulkan. Kartu lanjutan: legend-6b0ld (Tutup Hari hanya cek perangkat yang aktif hari itu; outlet cloud sequence tidak dicek). Brief Codex: `docs/briefs/196b-second-opinion-receipt-gaps-prefix.md` (folder utama).

## legend-yd0h8 deteksi database edge hasil restore/clone (engineer, cabang `ws/edge-restore-detect` dari `ws/receipt-seq-edge` 64638306, 2026-11-09)

- Sudah: tiap pull primary edge melaporkan counter lokal per run (`receiptRuns=P1:150,...`). Cloud menyimpan high-water per run (`receipt_sequences.edge_reported_number`, `edge_reported_at`, tidak pernah turun). Laporan lebih rendah (atau run terikat yang tidak lagi dipegang edge) = restore/clone: run dipensiunkan (`retired_reason = edge_regressed`) dan perangkat lanjut di prefix baru. Laporan lama yang diproses terlambat (waktu tiba di cloud tidak lebih baru dari yang tersimpan) diabaikan; token memakai jam cloud, bukan jam edge, jadi jam edge yang salah tidak mematikan deteksi. Rate limit: maks 2 rotasi regresi per perangkat per node per 24 jam, sesudahnya run dipertahankan dan halaman membawa `receiptRunAlert`; laporan run pensiun di atas high-water bekunya = database kedua hidup, alert langsung. Alert tampil di `GET /api/edge/status` (`deviceRegistry.receiptRunAlert`, `receiptRunAlertAt`). Semua jalur pensiun menyimpan alasan; trigger mewajibkannya. Edge lama tanpa `receiptRuns` tidak dicek dan tidak menerima field baru; fetcher mundur bertahap pada 400.
- Batas (jujur): penjualan antara restore dan pull sukses pertama tetap bisa mengulang nomor, dan tidak terdeteksi bila melewati high-water; backup yang lebih baru dari pull terakhir tidak terdeteksi. Clone (dua database hidup, node + instance sama) hanya mendapat ALARM, bukan pencegahan: keduanya menerima prefix baru. Prosedur manual zsdd tetap wajib. Deteksi penuh lewat event struk: legend-ol6v.
- Migrasi `0154_receipt_sequence_restore_detect` (when 1794233000000; 0153 dipakai ws/edge-pin-pull, journal idx 154 sengaja melompati 153). Rilis: cloud dulu, lalu edge.

## legend-mxxev audit buta untuk angka laci shift sendiri (engineer, cabang `ws/day-closed-audit-blind` dari fa472534, 2026-11-09)

- Sudah: `GET /audit-events` (audit.log.view) menyamarkan angka laci ("[REDACTED]") saat dibaca, untuk pembaca tanpa `pos.day.close` di outlet itu. Baris `pos_daily_close` (`totalVarianceIdr`) disamarkan bila pembaca punya shift di outlet+tanggal itu. Baris `pos_shift`, `pos_shift_count`, dan override `cash_shift_close` (expected/variance/difference/kas keluar, plus `valueIdr` = |selisih|) disamarkan bila shift-nya milik pembaca (id hitungan dipetakan ke shift) atau pembaca adalah peminta override. Baris yang tidak bisa dipetakan ditutup (fail closed). Pola sama dengan hitung stok buta legend-zbzr.
- Event outbox `day.closed` tidak berubah. Satu-satunya konsumen (potong resep) hanya membaca outletId + businessDate. Tidak ada pembaca HTTP outbox. Data audit tersimpan utuh, jadi manager, owner, dan supervisor lain tetap melihat angka penuh. Tanpa migrasi.
- Review K: reviewer Opus + architect, 3 putaran. Temuan nyata dibetulkan: baris shift/count bocor, `valueIdr` bocor, objectId override adalah id hitungan, test override kosong, pengecualian `pos.day.close` dipindah ke outlet shift. Berikut: second-opinion Codex (brief `docs/briefs/190c-second-opinion-day-closed-audit.md` di folder utama), merge train.

## legend-awg5p laporan harian buta untuk shift sendiri (engineer, cabang `ws/day-report-blind` dari m1 12c91f6b, 2026-11-09)

- Sudah: `GET /pos/day` memberi recap buta (`endOfDayBlindRecapSchema`, `drawerFiguresHidden: true`) bila pemanggil tidak punya `pos.day.close` di outlet dan punya shift (`pos_shifts.cashier_id`) di tanggal bisnis itu, sebelum maupun sesudah tutup hari (recap live dan beku). Kosong: `cashVarianceIdr` + `expiredCashOutIdr` tiap perangkat tempat ia ber-shift, `totalVarianceIdr`, `totalExpiredCashOutIdr`, dan semua jumlah per metode. Baris metode selalu daftar tetap `POS_TENDER_METHODS` (temuan architect K: metode yang muncul membocorkan net tunai di hari satu perangkat, tunai saja). Outlet manager ke atas dan supervisor tanpa shift: recap penuh seperti sebelumnya. POST close tetap recap penuh.
- Kontrak: `endOfDayRecapViewSchema` (union penuh | buta) untuk respons GET; skema simpan `endOfDayRecapSchema` tidak berubah. Web: angka null tampil "—", catatan "angka laci disembunyikan".
- Review K: reviewer Opus (tanpa temuan) + architect (1 temuan nyata, dibetulkan). Follow-up: legend-mxxev (event `day.closed` dan audit menyimpan `totalVarianceIdr`; bocor hanya bila supervisor diberi `audit.log.view`). Berikut: second-opinion Codex (brief `docs/briefs/190b-second-opinion-day-report-blind.md` di folder utama), merge train.

## legend-41li5 urutan refund di payout guard saat completedAt sama (engineer, cabang `ws/payout-refund-order` dari f1276d2f, 2026-11-09)

- Keputusan: bukan bug uang, tie-break tidak diganti, tanpa migrasi. Guard membaca baris `payment_refunds` completed (bukan jurnal) dengan urutan total `(completed_at, id)`, jadi cek intent dan fund bergantung pada baris tersimpan saja, bukan urutan kirim event atau retry sweep. Pada satu intent `completed_at` tidak pernah seri: satu-satunya penulis completion (`payment-refund.service.ts:533`) mengunci intent dan memberi waktu setelah fakta terakhirnya (`lockIntentsForFact`). Flaky di legend-9z1vm berasal dari seed test.
- Celah lintas intent (cek DP sesi): completion hanya mengunci intent sendiri, jadi refund yang distempel lebih awal bisa commit setelah yang lain dinilai. Cap saat request (`depositInUseOfIntent`) mencegah rugi nyata. Diikuti di legend-88pky (keputusan desain kunci, architect).
- Berubah: komentar `refundsAt`; test `accounting-auto-journal.test.ts` (legend-41li5 O1-O4: completedAt sama, id tetap, dua urutan kirim, hasil sama; O4 diputus cek DP sesi) dan `dp-intent-lock-race.test.ts` (dua completion dengan `now` sama: `completed_at` kedua lebih besar). Test lulus di service lama (tidak ada bug untuk direproduksi).
- Gate: tsc (heavy), eslint, prettier, 3 file 219 test. Review K: architect + reviewer Opus (2 temuan: klaim lintas intent terlalu luas, O4 tidak menguji cek sesi; keduanya dibetulkan, re-review bersih). Second-opinion Codex: `docs/briefs/189c-second-opinion-payout-refund-order.md` (folder utama).

## legend-9z1vm + legend-45bs9 + legend-8v2yl atribusi intent POS per tender (engineer, cabang `ws/intent-attribution-tender` dari m1 12c91f6b, 2026-11-09)

- Sudah: `pos-intent-attribution.ts` membaca `pos_order_refunds.lines[].tenderId` / `paymentIntentId` (ditulis sejak ws/pos-refund-promo, jadi 8v2yl sudah terpenuhi di sana). Baris bertender mengembalikan jumlahnya ke intent hanya bila tender itu milik intent pada pesanan dan metode yang sama dan baris menyebut intent itu; baris tender yang tidak cocok tidak mengembalikan apa-apa (fail closed). Baris lama tanpa id tetap aturan per metode. Cek "metode kembali penuh" memakai total baris lama + baris tender yang cocok dengan tender pesanan itu (pesanan dengan refund sebelum dan sesudah legend-186). `posRefundsOfIntentSql` (ledger) ikut memasukkan refund yang baris tendernya menyebut tender sah lain pada pesanan/metode itu. Tanpa migrasi.
- Test: held (`payment-refund-pos-tender-guard.test.ts`, legend-9z1vm T1-T5c) dan ledger (`accounting-auto-journal.test.ts`, AJ-9Z1VM-01..07). T1/T2 dan AJ-9Z1VM-01/02 gagal dulu di kode lama. Gate: tsc (heavy), eslint, prettier, 11 file 391 test.
- Review K: reviewer Opus + architect; satu temuan nyata (campuran baris lama + tender menahan intent) dibetulkan; re-review Opus bersih. Second-opinion Codex: brief `docs/briefs/189b-second-opinion-intent-attribution.md` (folder utama).
- Catatan: guard payout mengurutkan refund `(completedAt, id)`; refund dengan `completedAt` sama diurutkan menurut uuid acak (test memakai `completedAt` berbeda).
- Metrik (19:40-20:03): biaya* sesi 2050k (Opus utama 1102k, Opus subagent 342k, Sonnet subagent 605k), 9 subagent Claude, 0 Codex, puncak 3 berjalan, 0 compact.

## legend-75kr + legend-k8sz + legend-1coh tindak lanjut jurnal payroll (engineer, cabang `ws/payroll-journal-followups` dari m1 12c91f6b, 2026-11-09)

- Sudah: potongan custom (iuran koperasi dsb.) dipisah dari LATE. Totals run dapat `customDeductionsIdr` (default 0, bagian dari `otherDeductionsIdr`); jurnal: LATE Cr salary_expense (`lateDeductionsIdr`), custom Cr role baru `payroll_custom_deduction` (tipe expense atau liability, default 6101). Reversal simetris; cross-check reversal juga menerima entri lama (late + custom satu baris).
- service_charge: mapping dibatasi liability atau revenue (asset/expense/equity ditolak 422). Bila dipetakan ke revenue, payroll.locked memakai varian `payroll.locked#service_charge_expense` (payout SC ke Beban Gaji, tidak pernah mendebit pendapatan). Mapping lama tipe lain tetap didebit di akun yang sama (tempat POS mengkreditnya).
- Kasbon: `employee_loan.disbursed` dapat `disbursedVia` opsional (cash/bank); rule `#cash` Cr 1102, `#bank` Cr 1103; event lama tanpa field tetap 1102. Belum ada emitter disburse.
- Migrasi data `0155_payroll_custom_deduction_role` (when 1794234000000, idx 153; 0153/0154 dipakai cabang lain): mapping role baru = akun salary_expense entitas lama, idempoten.
- Gate: tsc shared/api/web/root (heavy), eslint + prettier berkas berubah, 19 file 537 test lulus. Test reproduksi gagal di base m1 (16 gagal + 1 file gagal load). Review K: reviewer Opus + architect; temuan dibetulkan (varian hanya revenue, tipe input totals, contract test, reversal bentuk lama); re-review segar bersih.
- Terbuka: legend-dhbt1 (P1, edge master sync menolak role tak dikenal; harus masuk sebelum atau bersama cabang ini). Second-opinion Codex: `docs/briefs/197b-second-opinion-payroll-journal-followups.md` (folder utama).
- Metrik (19:59-20:17): biaya* sesi 5686k (Opus utama 3691k, Opus subagent 650k, Sonnet subagent 1262k, Haiku 83k), 15 subagent Claude, puncak 4 bersamaan, 0 compact.

## legend-dhbt1 master sync menoleransi role mapping yang belum dikenal edge (engineer, cabang `ws/master-sync-role-tolerance` dari m1 12c91f6b, 2026-11-09)

- Sudah: role di wire master sync jadi string terbatas (`z.string().min(1).max(40)`); role kosong, lebih dari 40 karakter, atau duplikat tetap `BAD_SNAPSHOT`. Helper `partitionEdgeMasterMappings` di shared memisah role dikenal dan tidak.
- Edge (`applyEdgeMasterSnapshotInTransaction`): role tak dikenal dibuang sebelum upsert, dicatat `logger.warn` (nama role + jumlah saja) dan dihitung `droppedMappings`; uom, lokasi, akun dan role dikenal tetap diterapkan; penggantian set mapping memakai role dikenal saja. Tanda tangan tetap dicek atas snapshot mentah sebelum filter.
- Repro: di kode base test baru gagal `BAD_SNAPSHOT`; sesudah fix lulus. Tanpa migrasi.
- Aturan rilis: build ini harus sampai di semua edge sebelum cloud memetakan role posting baru (edge lama tetap menolak). Role hanya ditambah, tidak di-rename/split, selama edge lama masih jalan.
- Gate: tsc shared/api/web/root (heavy), eslint dan prettier 3 file, 3 file test 89 test. Review: reviewer Opus + architect (tanpa bug; 2 aturan rollout dan 2 test tambahan diterapkan), re-review segar bersih.
- Berikut: second-opinion Codex (brief `docs/briefs/200b-second-opinion-master-sync-role-tolerance.md` di folder utama), merge train (di-merge sebelum cabang payroll).
- Metrik (sesi kumulatif, termasuk tugas payroll sebelumnya): biaya* 7017k (Opus utama 4717k, Opus subagent 860k, Sonnet subagent 1330k, Haiku 110k), 22 subagent Claude, 0 Codex, 1 compact. Tugas ini: 6 subagent, puncak 3 berjalan bersamaan.

## legend-zsdd nomor struk perangkat terikat ke satu database edge (engineer, cabang `ws/receipt-seq-edge` dari batch16 cc188ee0, 2026-11-09)

- Sudah: `receipt_sequences` dapat `edge_node_id` + `edge_instance_id` (database mana yang memegang counter) dan `retired_at`; satu baris aktif per perangkat (unique parsial), prefix tidak pernah dipakai ulang; trigger: ikatan sekali, pensiun final. `edge_nodes.instance_id` = id acak database edge (edge dibangun ulang = id baru). Pull cloud oleh primary aktif yang mengirim `edgeInstance`: klaim urutan bebas di 0, rotasi (prefix baru) untuk urutan yang mungkin sudah bernomor di tempat lain; standby atau tanpa instance dapat `[]`. Cloud tidak meneruskan counter edge. Edge menolak ikatan asing dan memakai run terikat hanya bila cocok dengan `edge_nodes` miliknya. Status urutan ditolak tampil di `GET /api/edge/status` (`deviceRegistry.receiptSequencesRefused`, `receiptSequencesRefusedAt`). Fetcher edge baru mundur tanpa `edgeInstance` bila cloud lama menjawab 400. Perbaikan sementara 3yqy dipertahankan sebagai backstop.
- Migrasi `0152_receipt_sequence_edge_binding` (dinomori ulang dari 0148/0151; when 1794231000000). Urutan rilis: cloud dulu, lalu edge.
- Prosedur restore/clone DB edge: set `edge_nodes.instance_id` ke uuid baru sebelum API edge jalan (tetap wajib). Deteksi otomatis sebagian: legend-yd0h8 (lihat batasnya di bawah). Gap struk per prefix di laporan shift: legend-nhmct.
- Review K: architect + reviewer Opus; temuan nyata dibetulkan (R1). Berikut: second-opinion Codex (brief `docs/briefs/187b-second-opinion-receipt-seq-edge.md` di folder utama), merge train.

## Brief 185 refund followups 2: legend-x1i1h, legend-j0ag5, legend-leqj6 (engineer, cabang `ws/refund-followups-2`, rebase ke batch17 9fb949ca, 2026-11-09)

- Sudah: void penjualan ber-tender QRIS/gateway dengan intent yang penerimaannya terposting kini dijurnal (bagian gateway kembali ke `customer_deposit`); EDC/poin tetap parkir `AUTO_JOURNAL_VOID_UNSUPPORTED`. Guard payout tidak menghitung penjualan yang void-nya terposting; void yang belum terposting membuat payout menunggu (retryable). Jurnal sale, refund POS, dan void yang di-reverse finance (ACC-01) dibaca `none` (fail closed). Refund late payment POS dan QR = cap - (reserved - pending); approval refund late payment tidak menghitung refund lain yang masih `pending`, jadi tamu menerima penuh di urutan approval mana pun.
- Commit (setelah rebase): bbffa965, 30f95f2d, b86b942c, bf5e0c67, f642fa84, e2363aff. Tanpa migrasi. Train mengembalikan 25cbe987 karena dua test leqj6 memakai alur approval lama; setelah rebase test disesuaikan ke rantai approval legend-2dnh (refund sistem membuka rantai saat dibuat, policy default threshold 0 supervisor), kode tidak berubah.
- Gate (di atas 9fb949ca): tsc (heavy), eslint dan prettier 9 file, 26 file 710 test.
- Review K: reviewer Opus + architect; P1 (refund late gagal `cap_exceeded` bila disetujui duluan) dan P2 runbook dibetulkan; re-review segar bersih.
- Rilis: jalankan langkah sekali di `docs/runbooks/auto-journal-sale-missing.md` (re-queue void parkir lama dan payout-nya).
- Tugas 4 (legend-45bs9 + legend-8v2yl) dilepas ke agent refund promo; tanpa commit, patch WIP `docs/briefs/185-task4-wip-8v2yl-45bs9.patch` di folder utama.
- Metrik (17:28-18:55): biaya* sesi 10369k (Opus utama 2530k, Opus subagent 6597k, Sonnet subagent 1209k, Haiku 33k), 20 subagent Claude, 0 Codex, rata-rata 3 subagent berjalan, 1 compact.

## legend-yvhw8 + legend-kgbw + legend-rucdm + legend-7vv8h + legend-4z2ch penarik PIN edge (engineer, cabang `ws/edge-pin-pull` dari e420469e, 2026-11-09)

- Sudah: edge (primary dan standby) menarik `staff-pin-records` dengan puller generik yang sama (jadwal, backoff, stale), checkpoint stream `staff_pins`; watermark disimpan setelah semua halaman; cursor ditolak 400 mulai ulang sekali. Cloud mengadopsi set berikut dari node yang sama berdasarkan sequence agregat walau jam edge mundur (kolom `generation_edge_node_id`/`generation_edge_sequence`), set lama node yang sama tidak pernah menang lewat kunci, lock node itu tetap diterima. Set edge yang ditolak cloud dengan material lain menyentuh baris cloud agar diekspor ulang, edge lalu memakai PIN cloud. Resync penuh tidak mengembalikan counter/lock yang sudah dibersihkan edge (baseline `cloud_failed_attempts`/`cloud_locked_until`, aturan "berbeda dari baseline"). Runbook `docs/deployment.md`: synchronous_commit/fsync, restamp setelah dump/restore, idle_in_transaction_session_timeout lewat ALTER DATABASE (provisioning RESET ALL role), alert horizon, cloud dulu, satu mesin per node id.
- Migrasi `0153_staff_pin_pull` (dinomori ulang dari 0148 saat rebase ke m1 12c91f6b; when 1794232000000).
- Review K: reviewer Opus + architect, perbaikan (baseline berbeda bukan lebih besar, guard urutan node sama, lock node setelah adopsi sequence) di-review ulang bersih. Bead lanjutan: legend-li03g (edge jangan ganti PIN lokal selama set lokal belum di-ack).
- Berikut: second-opinion Codex brief `docs/briefs/188b-second-opinion-edge-pin-pull.md` (folder utama), merge train.

## legend-t9ii + legend-zclb + legend-7iti sinkron PIN edge-cloud dan audit override edge (engineer, cabang `ws/edge-pin-sync`, 2026-11-09)

- Sudah: ekspor PIN cloud ke edge berurutan commit (kolom `staff_pins.sync_xid` xid8 + trigger, filter `pg_snapshot_xmin`, cursor `spin2` [tag, epoch, xid, id], epoch = system_identifier:timeline:postmaster start; cursor lama, epoch lain, atau xid dari masa depan mulai ulang dari awal). Edge membandingkan kunci generasi (`pin_generation_at`), bukan jam; kolom baru `cloud_generation_at` menjadi dasar cap set edge, jadi jam edge tertinggal 10 atau 30 menit tetap menang. Job edge sekali jalan `staff-pin-resend.ts` mengirim ulang set PIN v1 tanpa material (setAt = occurredAt lama, dibatasi jam edge). Cloud: material sama = no-op (lock tidak dibuka). Override `cash_shift_close` dari edge membawa `shiftCloseVariance` (hanya proses edge); audit cloud dan edge berisi expectedIdr, countedIdr, varianceIdr, valueIdr = |varians|.
- Migrasi `0151_staff_pin_sync_xid` (0147 di cabang, dinomori ulang di batch16; when 1794230000000), merge m1 `bddf8442` sudah masuk. Rilis: cloud dulu, lalu edge.
- Review K: reviewer Opus + architect + re-review architect; temuan dibetulkan (epoch restore, cap 5 menit, cap setAt resend, rentang xid). Bead lanjutan: legend-yvhw8 (puller edge belum terpasang, P1), legend-rucdm (residu cap), legend-4z2ch (timeout transaksi idle + alert).
- Berikut: second-opinion Codex brief `docs/briefs/183b-second-opinion-edge-pin-sync.md` (folder utama), merge train.

## legend-15by + legend-wkl3 + legend-s7rx + legend-8v2yl refund POS berpromo dan baris refund per tender (engineer, cabang `ws/pos-refund-promo` dari m1 9a2c1e86, 2026-11-09)

- Sudah: 15by dan wkl3 ternyata sudah ada di m1 (c140459c, bc16e207, e3d5f56e); kini dibuktikan dengan test angka kartu (BOGO 4 kopi + 2 croissant: retur croissant Rp0 tercatat, kopi berikut Rp30.000).
- s7rx: refund tanpa item pada pesanan berpromo yang sudah pernah direfund menjadi pelunasan sisa (min jumlah diminta, jatuh tempo, sisa tender); pesanan belum pernah direfund tetap wajib pilih item; promo gugur saat pelunasan: 422 `REFUND_SETTLEMENT_NEEDS_ADMIN`. Pesanan DP dengan tender habis: retur item jadi baris Rp0, audit `depositOwedIdr` (saldo berjalan).
- 8v2yl: baris `pos_order_refunds.lines` mencatat `tenderId` dan `paymentIntentId` (FIFO per tender; total per metode tetap); event `order.refunded` tidak berubah. Tanpa migrasi (jsonb).
- Lanjutan: legend-9z1vm (atribusi intent membaca id baris, setelah ws/refund-payout-followups masuk m1), legend-pk38k (alur pengembalian DP dan pendapatan untuk retur Rp0 DP).

## legend-lg45 sisa PAN di ujung pesan EDC 200 karakter (engineer, cabang `ws/edc-pan-tail` dari f5438770, 2026-11-09)

- Sudah: aturan ujung pesan (hanya pesan asli tepat 200 unit UTF-16): `[disamarkan]` + pemisah lebar + digit di ujung, dan run 7+ digit yang memuat/diakhiri pemisah lebar (opsional potongan `[disamarkan`), diganti `[disamarkan]`, lalu dipotong 200 code point. Ada di `0143_edc_pan_scrub_separators.sql` (diubah di tempat; syarat 200 dicek pada pesan asli sebelum rantai 0143), jalur baca JS `maskStoredMessage`, dan skrip cadangan `apps/api/scripts/edc-pan-scrub-tail.sql` (hanya untuk DB yang sudah menjalankan 0143 lama). Jalur tulis tidak berubah. Runbook bagian 6.
- Bukti: test 13 file EDC 229/229, tsc shared+api (heavy), eslint, prettier, `db:generate` kosong. Review K: reviewer Opus 0 bug (fuzz 230k baris), architect 0 blokir (fuzz 40k baris 0135→0143 = JS).
- Keputusan: hash 0143 berubah (lama `67c6b05a…`); DB yang sudah menjalankan 0143 lama tidak menjalankan ulang, pakai skrip cadangan. Kartu baru `legend-deu7r` (pemisah newline/NBSP/`/`/`_`, sudah ada sebelumnya).
- Berikut: second opinion Codex `docs/briefs/191b-second-opinion-edc-pan-tail.md` (folder utama), keputusan CTO soal sisa potongan sebelum pemisah lebar pertama, merge train.

## legend-rzirp + legend-6yfhc impersonate butuh grant, 60 menit, audit atas nama impersonator (engineer, cabang `ws/impersonate-grant`, 2026-11-09)

- Sudah: `/admin/impersonate-user` di-gate di `lib/auth.ts` (`hooks.before` + ulang di `databaseHooks.session.create.before`): pemanggil platform admin, target bukan platform admin/bukan diri sendiri, grant aktif di tenant tempat target punya peran; sesi dibatasi 60 menit (`impersonationSessionDuration`, cap saat dibuat, `touchSession` tidak memperpanjang, `disableSessionRefresh`). Audit tenant `support_access.impersonation_started` (fail closed) dan `support_access.impersonation_ended` (stopped/signed_out/revoked/expired, `impersonationId` memasangkan baris). Revoke sesi support oleh user tenant menghapus sesi dan mencatat akhir.
- Sudah (6yfhc): `enforceSupportSession` menaruh grant di request context; `core-audit.recordAudit` (satu-satunya penulis `audit_logs`) mengganti actor user tenant dengan impersonator, `sensitiveAccess` true, alasan grant, tag `support` (field opsional di event jsonb, tanpa migrasi).
- Gate: test baru `impersonation-grant.test.ts` (13 kasus, 11 gagal di base) + `support-session-readonly.test.ts` diperbarui; 9 file 91 test API lulus; tsc api/shared (heavy), eslint, prettier. Review K: reviewer Opus + architect, temuan Medium (refresh Better Auth) dan Low dibetulkan.
- Sisa: sesi impersonasi yang kedaluwarsa tanpa dipakai lagi tidak menulis baris akhir (grant expiry tetap tercatat); `findImpersonationGrants` loop semua tenant. Codex: `docs/briefs/195b-second-opinion-impersonate-grant.md` (tidak di-commit).

## legend-cg071 sesi support baca-saja (engineer, cabang `ws/support-readonly`, 2026-11-09)

- Sudah (`6618970d`): API menolak semua mutasi sesi impersonasi tanpa grant atau dengan grant read_only (satu guard di `requireAuth` + `guardImpersonatedAuthRoutes` untuk `/api/auth`), kredensial (MCP, device, edge node, PIN) ditolak bahkan dengan read_write. `/api/me/access` membawa `supportSession`.
- Sudah (ronde UI): tombol submit baca-saja memakai aria-disabled + gembok + aria-describedby + toast saat diklik; banner dan notice digabung menjadi satu bar sticky (role=status, countdown, "Akhiri sesi" ≥44px di layar sentuh, detail lewat disclosure, teks "Sesi segera berakhir" tidak hanya warna); scroll-padding agar bar tidak menutup field yang difokus.
- Gate: API 46/46 terarah, tsc web, eslint, prettier, e2e mock cg071 4/4 + 335 + mjmm lulus. Screenshot `docs/design/screenshots/legend-cg071/kelola-readonly-{390,1440}-light.png`.
- Keputusan: MFA tenant tetap tidak bisa dibuka lewat sesi support (opsi a, CTO). Lanjutan: legend-rzirp, legend-6yfhc, legend-1pz5e. Codex second-opinion `docs/briefs/193b-second-opinion-support-readonly.md` (tidak di-commit) belum dijalankan.

## legend-wg5t + legend-ccpn tutup shift butuh approval (merge train batch11, cabang `ws/shift-close-fix` 1c051167, 2026-11-09)

- Sudah: migrasi cabang `0141_cash_shift_close_approval_policies_data` diurutkan ulang menjadi `0145_cash_shift_close_approval_policies_data` (custom apa adanya, NO FORCE dan FORCE pada `roles` dan `approval_policies`), dan `0142_pos_shift_count_cash_watermark` menjadi `0146_pos_shift_count_cash_watermark` (kolom `pos_shift_counts.cash_watermark`, dari `db:generate`). 0145 terdaftar di `MIGRATION_DATA_STATEMENTS`.
- Berikut: gate batch11, lalu merge ke `milestone/m1`.

## legend-2dnh refund sistem membuka rantai approval (merge train batch11, cabang `ws/refund-tier` 40800ce2, 2026-11-09)

- Sudah: refund buatan sistem (late payment POS dan QR, deposit reservasi) membuka rantai approval lewat akun sistem terkunci (banned, tanpa role, tanpa akun login). Migrasi `0135_system_approval_requester` diurutkan ulang menjadi `0144_system_approval_requester` (custom, isi apa adanya), terdaftar di `MIGRATION_DATA_STATEMENTS`.
- Berikut: gate batch11, lalu merge ke `milestone/m1`.

## legend-8cm4 + legend-2zb5 open bill oleh supervisor + kebijakan outlet (ui-engineer, cabang `ws/open-bill-r1`, 2026-11-09)

- Sudah (langkah 1, `8c39264d`): UI panel meja POS "Jadikan open bill" (dialog PIN supervisor) dan layar `/kelola/pengaturan/open-bill`; founder OK Q33=A, Q34=A.
- Sudah (langkah 2): permission baru `floor.session.open_bill` (owner, GM, outlet_manager, supervisor) dan `floor.open_bill_policy.manage` (owner, GM, outlet_manager), backfill migrasi `0148_open_bill_roles_permissions` (0144 di cabang). Route baru `open-bill.routes.ts`: GET/PUT kebijakan, GET penyetuju, POST konversi (`approverUserId` + PIN, cek hak sebelum PIN, kunci meja lalu sesi, tolak bila sisa tagihan >= batas, audit `open_bill.session_converted` tanpa PIN). Sweep permintaan tagihan memakai `billRequestSloSeconds` kebijakan outlet (satu query). Web tersambung ke API.
- Gate: tsc api/web/shared, eslint, prettier, 8 file 79 test API, 20/20 e2e mock, root 1661/1664 (3 gagal hanya karena butuh DB `pnpm test`), `drizzle-kit generate` tanpa perubahan.
- Review K: reviewer Opus dan architect; tanpa temuan High/Medium, Low dibetulkan. Codex second-opinion: `docs/briefs/180b-second-opinion-open-bill.md` (tidak di-commit), belum dijalankan.
- Terbuka untuk CTO: pesanan `awaiting_payment` tetap harus dibayar dulu setelah konversi; exposure ikut menghitung pesanan menunggu bayar yang ditinggal (bisa menolak keliru, aman); sesi support belum dibuat baca-saja.

## Codex 160 dua P2 di legend-kyie (engineer, cabang `ws/edge-access-apply`, 2026-11-09)

- Sudah: urutan set PIN memakai kolom baru `staff_pins.pin_generation_at` (migrasi `0142_high_scrambler`), terpisah dari `pin_set_at` yang dibatasi. Set lebih dari 5 menit di depan jam cloud ditolak; lock begitu diabaikan. Kunci generation di edge dan cloud tidak pernah mundur, dan kunci edge yang tertinggal jauh di depan pulih setelah jam dibetulkan. Galat tulis yang membawa hash atau salt dibungkus galat generik tanpa cause (`withoutSecretErrorDetail`).
- Gate: tsc, eslint, prettier, 31 file 450 test.
- Review K: reviewer Opus dan architect, plus re-review; semua temuan nyata dibetulkan. Sisa skew antar node di bawah 5 menit diserahkan ke legend-t9ii; set edge yang ditolak tidak diekspor ulang: legend-kgbw.
- Berikut: legend-t9ii, legend-zclb. Migrasi sudah diurutkan ulang di merge train batch10 (0134 jadi `0141_great_firedrake`, 0135 jadi `0142_high_scrambler`).

## legend-kyie cloud menerapkan event akses dari edge (engineer, cabang `ws/edge-access-apply`, 2026-11-09)

- Sudah: `staff_pin.set` (hash lewat field opsional `material`, hanya dari proses edge), `staff_pin.locked` dan `pos_override.recorded` (audit saja) diterapkan di cloud. Urutan PIN lewat kolom baru `staff_pins.pin_set_at`; baris parkir lama di-drain lazy dan ditandai `applied_at`/`apply_outcome`. Hash diredaksi dari konflik, baris parkir dan log.
- Migrasi diberi nomor ulang di merge train batch10: `0141_great_firedrake.sql` (dulu `0134_white_oracle`).
- ATURAN DEPLOY: cloud harus dirilis sebelum edge. Cloud lama menyimpan `staff_pin.set` beserta hash tanpa redaksi.
- Test: `apps/api/src/test/edge-access-applier.test.ts`; 33 file terkait lulus.
- Review K: reviewer Opus dan architect, dua putaran; temuan nyata dibetulkan.
- Berikut: legend-zclb (kirim ulang PIN v1), legend-0q3r (drain lintas tenant di worker), legend-t9ii (versi sinkron PIN berurutan commit). Brief: `docs/briefs/160-second-opinion-edge-access-apply.md` (tidak di-commit).

## legend-uznb + legend-8izz + Codex 119/124 guard master edge dan limiter (engineer, cabang `ws/edge-masters-guard`, 2026-11-09)

- Sudah: `/api/edge-sync/bootstrap/masters` punya limiter sendiri (120 per IP, 30 per IP + hash bearer), dipasang di `app.ts` sebelum resolusi tenant (Codex 119). `syncEdgeMasters` dan `applyEdgeMasterSnapshotInTransaction` lewat `guardDataImport("edge.bootstrap")` (legend-8izz). Galat DB di endpoint masters menjadi 503 tetap tanpa SQL atau id (Codex 124).
- Test: `edge-bootstrap-rate-limit.test.ts` (mounted app hitung query domain), `edge-master-sync.test.ts` (8izz, Codex 124 sentinel), `data-import-registry.test.ts` (cek statis).
- Review K: reviewer Opus dan architect; temuan nyata dibetulkan. Batas NAT outlet dan `TRUST_PROXY` dicatat di `docs/deployment.md`.
- Berikut: Codex 160 dua P2 di `ws/edge-access-apply` (urutan generasi PIN, galat outbox berisi material), lalu legend-t9ii dan legend-zclb. Brief second opinion: `docs/briefs/166-second-opinion-edge-masters-guard.md` (tidak di-commit).

## legend-6bq2 + legend-x9w2 cek intent penjualan POS, daftar provider settlement, penjaga fire QR (engineer, cabang `ws/aj-pos-intent` dari 6cc87dab, 2026-11-09)

- Sudah (6bq2): `order.paid` POS kini memanggil `assertSaleWithinReceipt` per intent ber-receipt posted dengan batas `saleBoundOf` (sama seperti penjualan QR), jadi refund intent yang selesai sebelum penjualan tidak bisa mendebit customer_deposit dua kali. Penjualan yang melebihi saldo intent parkir `POSTING_AMOUNTS_MISMATCH`. Test AJ-POSI-01..05 gagal dulu (6 dari 12), lalu lulus. `pos-order.service.ts` tidak disentuh.
- Sudah (x9w2): `settlement.reconciled.provider` jadi allow-list `GATEWAY_SETTLEMENT_PROVIDERS = ["doit", "duitku"]` (provider gateway di `payment/admin.ts`); kode bank EDC dan `edc_<bank>` ditolak. `fireQrOrder` mensyaratkan status `awaiting_payment` di WHERE dan melempar bila tidak ada baris. Test baru `settlement-events.unit.test.ts`, QR-PAID-05.
- Bukti: gate 73 file (1557 lulus, 11 skip; 3 gagal lalu dibetulkan: 2 test duitku, 1 POS-01 timing yang lulus saat diulang sendiri), ulang 4 file terdampak 186 lulus. tsc api dan shared bersih, eslint bersih, kontrak node 228 lulus.
- Review K: reviewer Opus dan architect tanpa bug nyata. Temuan architect duitku dibetulkan. Risiko lama dicatat sebagai legend-ni6o (order.refunded tidak cek jurnal penjualan) dan legend-riqu (refund boleh untuk intent yang dipakai tender POS; jendela jam aplikasi sebelum commit).
- Berikut: second opinion Codex `docs/briefs/169b-second-opinion-aj-pos-intent.md` (tidak di-commit). Belum ada test untuk penjualan dua intent, intent plus DP, campuran receipt posted dan pending.
- Biaya sesi engineer (sejak slice 4): total 13792k, 42 subagent, compact 2.

## legend-a0i7 + legend-ioyg refund promo dan void POS non-tunai (engineer, cabang `ws/pos-refund-void`, 2026-11-09)

- legend-a0i7 #1 (Codex 127): diskon yang dipertahankan per baris redemption tidak lagi dibatasi diskon yang tersisa di baris setelah refund sebelumnya (`crm-promo-refund.ts`); `order-promo-refund.ts` kini menaikkan atau menurunkan baris dan `spent_idr` promosi dengan jumlah yang sama, naik dibatasi sisa anggaran (kekurangan dicatat di audit `promo_application.clamped`, `budgetShortIdr`). Contoh Codex: retur bertahap Rp10.000 + Rp46.000 = Rp56.000, sama dengan sekaligus.
- legend-a0i7 #2: pesanan berpromo, refund yang meminta kurang dari yang jatuh tempo ditolak 422 `REFUND_AMOUNT_BELOW_DUE` sebelum menulis apa pun (sebelumnya sisa Rp10.000 terkunci). Minta lebih tetap dibatasi.
- legend-ioyg: void penjualan selesai ditolak 409 `CONFLICT` bila ada tender non-tunai `captured`/`authorized` (QRIS, VA, e-wallet, kartu, EDC, poin, metode lain); kasir diarahkan ke refund. Dicek setelah cek hari usaha tutup (hari tutup dilaporkan lebih dulu); penolakan me-rollback transaksi sehingga persetujuan tidak terpakai. Auto-journal tidak diubah.
- Test: `pos-refund-promo-db.test.ts` (A1, B1), `pos-order-void-noncash.test.ts` (C1-C3), gagal dulu di kode lama.
- Brief second opinion: `docs/briefs/172b-second-opinion-pos-refund-void.md` (tidak di-commit).

## legend-de3b cek tumpang-tindih aturan pajak (engineer, cabang `ws/tax-rule-overlap` dari `ws/provisioning-race`, 2026-11-09)

- Akar masalah: `publishTaxRule` tidak memeriksa tabrakan. Owner bisa menerbitkan aturan tenant-wide F&B kedua di samping `PBJT-FNB`, lalu semua order gagal `TAX_RULE_AMBIGUOUS` (409).
- Sudah: `packages/shared/src/tax/overlap.ts` (`taxRuleTie`, `findTaxRuleTies`, memakai `resolveTaxRule` asli, berpasangan, per tanggal berlaku). `publishTaxRule` menolak aturan aktif yang seri dengan 409 yang menyebut kode, versi, dan tanggal aturan lawan, di bawah `lockTaxConfig`. Pesan 409 service charge kini memakai label Indonesia. Owner mengganti aturan dengan menerbitkan versi tidak aktif dulu (pola legend-mdh0). Data lama yang ganda: `GET /api/tax/rules/conflicts`, plus banner di halaman aturan pajak dengan tombol "Buat versi nonaktif". Dialog versi baru kini mempertahankan outlet aturan (dulu jadi tenant-wide).
- Test: `src/test/tax-rule-overlap.test.ts` (10 kasus; 4 gagal di kode lama), `tests/tax-rule-overlap.test.mjs` (21 unit). Test terarah 16 file, 186 test lulus; node 80/80; tsc shared/api/web lulus.
- Review K: reviewer Opus 2 putaran dan architect (setuju); ui-auditor (8 cacat, sudah dibetulkan).
- Batas yang diketahui: cek berpasangan bisa menolak konfigurasi yang aman karena ada aturan ketiga yang lebih spesifik (sama dengan pola service charge). Banner menampilkan "item tertentu" atau "kategori tertentu" tanpa nama.

## legend-dq0n + legend-hd1m race backfill provisioning (engineer, cabang `ws/provisioning-race`, 2026-11-09)

- Akar masalah: backfill pajak dan CoA mengunci, tetapi penulis owner tidak, jadi backfill bisa melihat tabel kosong lalu menyisipkan default di samping aturan atau akun owner. Tipe lokasi standar dilewati permanen bila namanya sudah dipakai.
- Sudah: satu modul kunci `apps/api/src/services/tenant-config-locks.ts`. Urutan kunci: 1 CoA per entitas, 2 lokasi per outlet, 3 pajak per tenant, 4 service charge per tenant. Kunci lama tidak berubah. Penulis owner pajak (create, update, publish aturan; create, publish settings) dan CoA (create, update akun; ganti mapping) mengambil kunci yang sama. Lokasi yang namanya bentrok tetap ditambah sebagai `<nama> 2`, `<nama> 3`, dan seterusnya.
- Test: `src/test/provisioning-race.test.ts` (dua transaksi, `pg_locks`): gagal di kode lama, lulus dengan fix. Test terarah 17 file, 216 test lulus; kontrak node 139/139; tsc api/shared lulus.
- Review K: reviewer Opus (tanpa blocker) dan architect (setuju). Second opinion Codex: brief `docs/briefs/173b-second-opinion-provisioning-race.md`.
- Berikut: legend-de3b (P1, `publishTaxRule` tanpa cek tumpang-tindih; owner masih bisa memicu `TAX_RULE_AMBIGUOUS` tanpa race).

## legend-r7g2 parser refund DOIT (engineer, cabang `ws/doit-refund-parser`, 2026-11-09)

- Akar masalah: jawaban POST refund DOIT yang menyebut payment lain diterima sebagai sukses (`parseDoitRefundAnswer`). Sekarang objek refund wajib membawa `payment_id` dan `amount` yang cocok; `idempotency_key` dan `reference`, bila ada, juga harus cocok. Selain itu `DOIT_REFUND_IDENTITY_MISMATCH` (hasil tak dikenal, bukan sukses, bukan gagal).
- Mismatch jadi flag lengket `PAYOUT_IDENTITY_MISMATCH`: tidak dikirim ulang, tidak diganti `MANUAL_RECONCILIATION`, masuk eskalasi, audit `payment.refund_payout_identity_mismatch` + log error berisi id DOIT.
- Webhook P2 (Codex 117 Run B): objek `refund` dengan `reference` tetap dibaca sebagai refund dan `reference`-nya dicek; jalur `payment_object` tidak menimpa `providerRef` `rf_` yang sudah ada. P2 (c) jadi legend-gqv7; temuan minor jadi legend-fpe6.
- Bukti: test reproduksi gagal di kode lama; 20 file `*doit*`/`*refund*`/`payment-webhook*` 759 lulus, 10 skip (sandbox tanpa kunci); tsc lewat heavy, eslint, prettier, kontrak node 44/44. Review K: reviewer Opus + architect, re-review architect: tertutup.
- Commit 36f59dc3, 3b053bb8. Brief Codex `docs/briefs/175b-second-opinion-doit-refund-parser.md` (tidak di-commit).

## legend-4wrfd tutup buta untuk kasir (engineer, cabang `ws/shift-blind-close` dari `6b3c6840`, 2026-11-09)

- Keputusan CTO: DTO shift dan respons tutup ke peran tanpa izin lihat selisih membawa `expectedIdr`, `varianceIdr` dan rincian laci (`cashSalesIdr`, `cashRefundsIdr`, `cashInIdr`, `cashOutIdr`, `cashDropIdr`) null. Supervisor ke atas melihat lengkap untuk shift kasir lain; shift sendiri tetap buta (POS-03). Cash out held tidak diberitahukan ke kasir.
- Sudah: skema shared nullable semua-atau-tidak, `shiftDto(..., { blind })`, `shiftFiguresDto` untuk event, audit, ledger. Open, close, replay buta; report dan list buta kecuali supervisor membaca shift orang lain; force close lengkap.
- Test: `pos-shift-blind-close.test.ts` (9), test oracle held refund di `pos-shift-held-expire.test.ts` aktif. Repro gagal di basis bersih `6b3c6840` (10 gagal).
- Review K: reviewer Opus dan architect, tidak ada cacat di diff. Tindak lanjut: legend-awg5p (laporan harian menampilkan selisih shift sendiri ke supervisor, perlu keputusan CTO), legend-ekaca (tipe web POS kasir belum menerima null).
- Brief second opinion: `docs/briefs/176c-second-opinion-blind-close.md` (tidak di-commit). legend-3l4q ditunda.

## legend-eadm + legend-niq9 klasifikasi event edge ke cloud (engineer, cabang `ws/edge-event-class`, 2026-11-09)

- Reproduksi: di integ/m1-batch5 batch campuran tidak macet; legend-9fhs sudah memarkir event tak dikenal. Klaim stall legend-eadm tidak terbukti di basis ini.
- Sudah: `pos_override.*` dan `staff_pin.*` diparkir `deferred` (`registerAccessDeferredEdgeApplier`, runtime.ts blok registrasi saja). Event `unclassified` (termasuk `stock.*` selain `stock.moved`, niq9) kini memberi alarm ke supervisor outlet: sekali per nama event per outlet per 24 jam, dihitung dari `notification_outbox`, dalam savepoint (gagal alarm tidak menggagalkan batch).
- Test: `apps/api/src/test/edge-event-class.test.ts` (R, A, B, C, D). Semua 23 file `edge-*` lulus.
- Review K: reviewer Opus dan architect, dua kali re-review; temuan nyata dibetulkan.
- Berikut: legend-kyie (P1, cloud menerapkan event PIN dan override), legend-vw3d (kategori alarm sendiri), legend-tbl4 (index outbox, test tanpa supervisor). Brief second opinion: `docs/briefs/158-second-opinion-edge-event-class.md` (tidak di-commit).
  \=======
  \=======

## legend-4n3r + legend-w6vah: posting jurnal payroll ke buku besar, refund PPh21 perusahaan dipisah (engineer, cabang `ws/payroll-posting`, 2026-11-09)

- Sudah: consumer `apps/api/src/services/payroll-gl-consumer.ts` dipasang di `worker-main.ts` (cloud saja). `payroll.locked` memposting jurnal run; `payroll.paid` (rule baru: Dr 2103, Cr 1103/1102) melunasi Utang Gaji; `payroll.reversed` membalik entri lock lewat `reverseJournalInTransaction` (kunci unik `journal_entries_reversal_once_key`); kasbon dan reimbursement tunai diposting; reimbursement payout payroll dilewati. Helper emit `payroll-events.ts` untuk layanan run (legend-07eg, belum ada).
- Sudah: refund PPh21 perusahaan dipisah proporsional: bagian tunjangan gross-up kembali ke 6101, sisanya ke 6111 (`pph21EmployerAllowanceRefundIdr`). Payload `payroll.paid` membawa `bankTransferIdr`/`cashIdr`.
- Review K: reviewer Opus (2 temuan: flag akuntansi dimatikan setelah lock, run nol) dan architect (tanggal kalender Jakarta, tanggal lock dan reversal, reversal manual, run sudah dibayar, cross-check per baris, batas bagian ditanggung). Semua dibetulkan dan diuji.
- Untuk legend-07eg: lock harus menolak periode tutup di transaksi lock; jalur paid-lalu-reversed dilarang state machine run.
- `docs/briefs/174-dfuzz.mts` tidak bisa jalan (impor `./sim.mts` tidak ada); fuzz 2500 kasus di `accounting-payroll-journal.test.ts` dipakai dengan pemisahan baru.
- Second-opinion Codex: `docs/briefs/182b-second-opinion-payroll-posting.md` di folder utama (tidak di-commit).
- Metrik sesi 4479e5 (16:40-17:54, tugas s8a3 + 4n3r/w6vah): biaya* 7478k, 25 subagent (Claude saja, Codex 0), puncak 4 jalan bersamaan, rata-rata 0.56 subagent jalan.

> > > > > > > 0e26cf35

## legend-s8a3: jurnal payroll seimbang (engineer, cabang `ws/payroll-journal`, 2026-11-09)

- `payroll_run.completed` diganti `payroll.locked` dan cerminnya `payroll.reversed` (PAYR-04/05). Jumlah dari `payrollJournalAmounts(totals)`; totals run membawa PPh21 ditanggung (B), refund karyawan, refund perusahaan, dengan cek identitas `pph21 = W + B + R - rf - erf`.
- Akun: telat/custom mengkredit 6101, cicilan kasbon dan piutang PPh21 ke 1204, B dan refund perusahaan ke 6111 (role baru `pph21_borne_expense`, koreksi fiskal), service charge debit 2106, reimbursement ke 6110 (role baru `reimbursement_expense`). Rule `employee_loan.disbursed` dan `reimbursement.paid#cash` mengkredit 1102 Kas Kecil.
- Migrasi data 0134 (`when` 1794220000000): backfill 1204/6110/6111 dan mapping untuk setup lama; merge train menomori ulang setelah `ws/provisioning-race`.
- Bukti: repro 5 dari 6 kombinasi tidak seimbang sebelum fix; fuzz 2.500 run lewat engine PPh21 asli seimbang. Gate: 45 file vitest (778 lulus, 15 skip), 142 test root lulus, tsc shared/api/web, eslint, prettier, db:generate kosong. Architect approve; reviewer Opus 1 temuan salah akun (legend-w6vah).
- Biaya sesi ~3,66 jt token-setara, 15 subagent, maks 4 bersamaan, rata 0,54.
- Follow-up: legend-w6vah, legend-4n3r (wiring + payroll.paid + reversal), legend-1coh, legend-75kr, legend-k8sz. Second-opinion Codex: `docs/briefs/174b-second-opinion-payroll-journal.md`.

> > > > > > > 0705f12f

## legend-kn3n bagian 2, legend-xzid, legend-6ajk: kekurangan PPh21 jadi piutang karyawan (engineer, cabang `ws/pph21-overwithhold`, 2026-11-09)

- Keputusan founder B8: potongan PPh21 karyawan di atas gaji tersedia jadi piutang karyawan (`tax.pph21ReceivableIdr`), bukan beban perusahaan; setoran tetap T, tanpa gross-up.
- Engine `pph21.ts`: W = clamp(De + bE, 0, cap), piutang = sisanya, tidak masuk X; priorTax memuat piutang; jalur settlement dihapus (6ajk hilang). Fuzz diferensial architect 16.000 tahun: 0 beda dengan model.
- R63: sebelum X = T = B = 5.646.900 (PKP 77.646.000); sesudah X 0, T 4.800.000, piutang 4.800.000 (PKP 72.000.000).
- xzid: `payslipWithholdingCap` + builder fixtures mengisi `employeeWithholdingCapIdr`.
- Penagihan: urutan BPJS, PPH21, LATE, PPH21_RECEIVABLE, LOAN, plafon = sisa sebelum pinjaman; refund PPh21 menetting piutang. Totals run punya `pph21ReceivableIdr` / `pph21ReceivableCollectedIdr`.
- Jurnal: role `employee_receivable`, akun 1204 Piutang Karyawan, baris di `payroll_run.completed`. Tanpa migrasi.
- Gate: 44 file test payroll/accounting/hris lulus (758 lulus, 15 skip), tsc api/shared/web bersih, eslint, prettier. Review K: reviewer Opus 0 temuan, architect approve.
- Follow-up: legend-s8a3 (aturan payroll tidak seimbang + backfill mapping 1204), legend-itph (open item party employee), legend-45lm (piutang karyawan keluar / write-off), legend-f2rv (ekspor menghitung piutang), legend-8463 (default proportional menghasilkan piutang besar).
- Berikut: second-opinion Codex brief 170b, gerbang founder untuk merge.

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

### Serah terima slice 4 dan 3 (sesi ee66d9 compact 3x, 2026-11-09 15:08 WIB)

- legend-e7zj selesai: cabang `ws/dp-refund-guard` 72e4f973 (kode + test) + 41524fcb (progress); brief Codex 157 sudah dijalankan, tanpa temuan; masuk merge train.
- Slice 4 (settlement + MDR): cabang `ws/aj-settlement` dari b714f7b6, worktree `.worktrees/aj-settlement` (worktree:setup sudah). Belum ada kode.
  - Fakta (Explore): rule `gateway_settlement` dan `edc_settlement` sudah ada di `packages/shared/src/accounting/posting-rules.ts:232-253` (Dr bank net, Dr gateway_fee_expense fee, Cr gateway_clearing / edc_clearing gross). Nama event di catalog (`catalog.ts:46`, `:68`). Belum ada payload schema, emitter, maupun tabel settlement; `payment-admin-reconciliation.service.ts:144` melempar 503. Tidak ada poster settlement lain (tidak dobel). `bank` = akun 1103 tunggal. Consumer melewati intent EDC (`accounting-auto-journal-amounts.ts:329`, `:621`); edc_clearing di-debit lewat paidEdcIdr pada order.paid.
  - Yang dikerjakan: schema v1 `settlement.reconciled` {settlementId, provider, outletId, settledOn, grossIdr, feeIdr, netSettledIdr; refine gross = net + fee} dan `edc_transaction.settled` {settlementBatchId, terminalId, outletId, settledOn, grossIdr, feeIdr, netSettledIdr}; kunci `aj:settlement:<id>` dan `aj:edc-settlement:<batchId>`; waktu uang = settledOn (periode tutup: hari buka pertama, audit); handler di amounts.ts + consumer; test event sintetis; update `docs/design/auto-journals.md` §8.
  - Emitter menunggu bead yang sudah ada: legend-3a5m (ledger impor + emit settlement.reconciled), legend-jlqi, legend-cs7. Tidak perlu bead baru.
- Slice 3 (kej3 + fbms): cabang baru dari milestone/m1 terbaru (9126f624 atau lebih baru), gabung slice 1/2/4, nomor ulang migrasi 0113/0114 di atas m1. Isi: emit order.paid dari jalur QR (`qr-order-consumers.ts` ~:341, tender intent gateway, paidAt = intent.paidAt, paidDepositIdr = depositApplied), `orderRevenueSplit()` bersama di `order-revenue.ts` (eksklusif/inklusif, selain itu fail closed), fbms desain A (schema total nonnegatif, buang `if (order.totalIdr > 0)`, consumer lewati jumlah nol semua).
- Gate tiap slice: semua `src/test/accounting*.test.ts`, RLS, payment-support, pos-order*, qr-order*, reservation*, pos-shift* (`LEGEND_TEST_FILES` dari root worktree, daftar dibuat dengan bash nullglob), tsc api/shared/web lewat `heavy`, eslint, kontrak node (`^ℹ pass`). Review K: reviewer Opus + architect paralel. Brief Codex per slice (tidak di-commit, maks 800 baris non-test, tanpa temuan Claude). Jangan sentuh app.ts, routes/index.ts, worker-main.ts, edge/runtime.ts, adapter/webhook DOIT, modul refund, crm-promo-refund.ts, approval policies.
- SSD: cleanup-ssd --apply mengembalikan 0.07 GB (32.58 ke 32.65 GB kosong); tidak ada worktree yang aman dihapus.
- Biaya sesi ee66d9 total (05:55-08:07 UTC): biaya* 18606k (utama Opus 7871k, subagent Opus 7398k, Sonnet 3134k, Haiku 203k), 45 subagent, maks 4 paralel, rata 0.85 berjalan. Gelombang e7zj (07:24-08:07 UTC): sekitar 4153k.

### Langkah 0: perbaikan temuan Codex 142 (cabang `ws/aj-fix142` dari `ws/dp-late-journal` b714f7b6, 2026-11-09)

- Desain bersama subagent architect: `docs/design/auto-journals.md` §10.
- F1 payout tanpa penerimaan: payout dicari penopangnya (receipt intent, atau receipt dana tak teralokasi bila dana itu punya event sendiri). Pending parkir `AUTO_JOURNAL_RECEIPT_PENDING` (diulang), tidak ada parkir `AUTO_JOURNAL_RECEIPT_MISSING` (tidak diulang). Receipt yang dibalik finance tidak menopang apa pun.
- F2 void penjualan selesai: event `order.voided` (voidedFinalOrder) membalik jurnal `aj:sale:<orderId>` lewat ACC-01 (`reverseJournalInTransaction`, kunci `aj:sale-void:<orderId>`). Hanya penjualan tunai murni; ada tender gateway/EDC/poin parkir `AUTO_JOURNAL_VOID_UNSUPPORTED` (void hanya mengembalikan tunai). Jurnal penjualan belum ada: `AUTO_JOURNAL_SALE_PENDING` / `AUTO_JOURNAL_SALE_MISSING`.
- F3 DP hangus: cek payout menghitung forfeit; cek forfeit menghitung refund sebelumnya.
- F4 urutan event: semua cek dibatasi waktu dari baris faktanya sendiri (dibaca di SQL, bukan JS Date: presisi mikrodetik). Seri: penjualan lebih dulu dari refund/forfeit, forfeit lebih dulu dari refund.
- File: `accounting-auto-journal-{amounts,consumer,guards (baru),void (baru)}.ts`, `accounting-journal.service.ts` (ekstrak `reverseJournalInTransaction`), test, desain.
- Sisa (usulan ke CTO, berkas terlarang/di luar scope): U1 `refundableBalance` kurangi DP hangus; U2 void harus menolak atau mengembalikan tender gateway/EDC/poin; U3 order QR butuh waktu selesai sebelum slice 3; U4 race urutan commit vs cap waktu (penulis refund, penjualan, forfeit perlu kunci baris payment_intents sebelum ambil waktu).
- Bukti: gate 37 file test API 569 lulus 1 skip; ulang 5 file accounting setelah perubahan terakhir 169 lulus 1 skip (auto-journal 86/86); kontrak node 131 lulus; tsc api/shared/web, eslint, prettier bersih. Commit 84218ab4. Brief Codex `docs/briefs/142b-second-opinion-fix142.md` (main checkout, tidak di-commit, 3 run).
- Biaya sesi 9d8aab (08:10-08:31 UTC): total biaya* 5316k (utama Opus 2324k, subagent Opus 1133k, Sonnet 1689k, Haiku 170k), 15 subagent.
- Berikut: tunggu CTO, lalu gabung `ws/aj-fix142` ke `ws/aj-settlement` dan mulai slice 4.

### Slice 4: settlement gateway dan EDC + MDR (cabang `ws/aj-settlement`, 2026-11-09)

- Gabung `ws/aj-fix142` ke `ws/aj-settlement` (ab1c5aab).
- Schema shared v1 `settlement.reconciled` dan `edc_transaction.settled` (`packages/shared/src/payment/settlement-events.ts`): strict, gross = net + fee, fee dan net >= 0, provider `edc_*` ditolak di event gateway. Header berisi kontrak emitter (satu emitter per payout, satu event per outlet, id unik per tenant, emit sekali saat final, koreksi lewat jurnal manual, net >= 0, `bankAccountId` v2).
- Consumer: kunci `aj:settlement:<id>` dan `aj:edc-settlement:<batchId>`; tanggal jurnal = `settledOn` persis (`AutoJournalFact.entryDate`, tidak lewat jam dan cutoff outlet); periode tutup ke hari buka pertama dengan audit; outlet envelope harus sama dengan payload; tanpa guard penopang (kelebihan settlement = kasus rekonsiliasi).
- Review K (reviewer Opus + architect): tanpa cacat kode. Dibetulkan: test AJ-SET-04 kini cutoff 08:00 (uji mutasi: tanpa `entryDate` test gagal), AJ-SET-07 pakai outlet nyata entitas lain, provider `edc_` ditolak (AJ-SET-17), kontrak emitter ditulis di header dan desain §4/§8.
- Cek CTO 84218ab4: (1) aggregateType `order.paid` = `order` (catalog `name.split(".")[0]`, `appendPosEvent` pakai `entry.aggregateType`), cocok dengan guard sale; (2) `auditAccountingChange` menerima `actorId: null` (actorType system).
- Bukti: gate 33 file 489 lulus 1 skip (sebelum perbaikan review); ulang 10 file accounting setelah perbaikan 217 lulus 1 skip (auto-journal 104/104); kontrak node 137 lulus; tsc shared/api/web, eslint, prettier bersih.
- Emitter tetap milik legend-3a5m, legend-jlqi, legend-cs7.

### Slice 3: penjualan QR, pembagian pendapatan, fbms, U3 (cabang `ws/aj-qr-sale`, 2026-11-09)

- Cabang dari `milestone/m1` a8c90378, gabung `ws/aj-settlement` (7822d66e). Slice 1/2 sudah di m1 (migrasi sudah dinomori ulang di sana), jadi tidak ada migrasi baru. Konflik hanya dari commit prettier m1; sisi `ws/aj-settlement` diambil.
- kej3: pesanan QR pay-first memancarkan `order.paid` dari `fireQrOrder` (satu-satunya titik yang menandai pesanan QR lunas), lewat `qr-order-paid.ts`; intent yang benar-benar membayar dipin ke `orders.payment_intent_id`; sekali per pesanan (baris pesanan dikunci `FOR UPDATE`, fire hanya dari `awaiting_payment`).
- `orderRevenueSplit()` bersama (`order-revenue.ts`): identitas eksklusif/inklusif menurut `pricesIncludeTax`, selain itu gagal tertutup; POS dan QR memakainya.
- fbms desain A: `order.paid` total 0 boleh, tender boleh kosong, guard `totalIdr > 0` dibuang; consumer mengabaikan `order.paid` yang semua jumlahnya 0; potong resep berjalan sekali untuk total 0 dan untuk QR.
- U3: waktu penjualan dibaca di SQL = `pos_orders.completed_at`, atau `orders.fired_at` untuk QR pay-first; semua guard (bound, DP sesi, payout) menghitung penjualan QR.
- Review K: reviewer (4 risiko terbuka, semua dicek tidak nyata) dan architect (1 cacat nyata: refund intent sebelum fire lalu penjualan QR mendebit `customer_deposit` dua kali). Dibetulkan: `assertSaleWithinReceipt` di sisi penjualan QR, nominal intent wajib menutup total minus DP. Void tetap: cek baris void dulu (koreksi menolak total 0, baris void butuh `pos_orders`).
- Sisa: penjualan POS dengan tender intent belum punya cek sisi penjualan yang sama (perilaku lama, usulan kartu); U4 tetap.
- Bukti: gate 43 file 658 lulus 1 skip; kontrak node 228 lulus; tsc shared/api/web bersih; ulang 23 file (accounting, qr-order, pos-order, recipe-pos-hpp, order-revenue) setelah perbaikan F1 374 lulus 1 skip; eslint dan prettier bersih.
- Biaya sesi 9d8aab (08:10-09:04 UTC, termasuk langkah 0): total biaya* 11718k (utama Opus 4658k, subagent Opus 3193k, Sonnet 3581k, Haiku 287k), 37 subagent; slice 4 + slice 3 sekitar 6400k, 22 subagent, maks 4 paralel. parallel-report tidak menemukan sesi di folder proyek (sesi ini tercatat di folder akun lain).
- Brief Codex (main checkout, tidak di-commit): `docs/briefs/163-second-opinion-aj-settlement.md` (slice 4, 1 run) dan `docs/briefs/164-second-opinion-aj-qr-sale.md` (slice 3, 2 run).
- Berikut: CTO; merge train `ws/aj-qr-sale` (berisi fix142 + slice 4 + slice 3 di atas m1).

## legend-em6p + legend-fsl5: waktu fakta DP terkunci per intent dan batas refund DP hangus (engineer, cabang `ws/dp-intent-lock` dari `milestone/m1` a8c90378, 2026-11-09)

- em6p (U4): penulis tiga fakta uang (selesai refund `completeRefund`, selesai penjualan POS `completePosOrder`, tutup reservasi staf `closeReservation` dan tamu `cancelGuestReservation`) mengunci baris `payment_intents` (`FOR UPDATE`, urut naik), lalu mengambil waktu dari `lockIntentsForFact` (`apps/api/src/services/payment-refund-fact-time.ts`): `now` pemanggil, atau 1 ms setelah fakta terakhir yang sudah commit pada intent itu. Waktu fakta per intent mengikuti urutan commit, tanpa seri, tidak bergantung jam host API.
- Intent penjualan: alokasi DP sesi meja + intent tender gateway tertangkap. Penutup reservasi mengunci sesudah `reconcileDeposit` (DP yang baru tertaut ikut terkunci).
- Urutan kunci: orders -> pos_orders -> payment_intents (sama dengan refund terlambat POS); reservations -> payment_intents; refund tetap intent dulu. Advisory e7zj tetap sesudah baris intent. Urutan 94qt tidak berubah.
- fsl5 (U1): `refundableBalance` mengurangi `deposit_forfeited_idr` reservasi cancelled/no_show; refund atas DP hangus 409 `REFUND_DEPOSIT_FORFEITED`, dicek sebelum `REFUND_DEPOSIT_IN_USE`.
- Test: `apps/api/src/test/dp-intent-lock-race.test.ts` (9 test; T1-T4 gagal di baseline, lulus sesudah fix; T5 tanpa 40P01).
- Review K: Opus reviewer + architect. Temuan nyata (High, keduanya sama): penutup mengunci sebelum `reconcileDeposit` → dibetulkan + T2b. Tidak ada deadlock.
- Brief Codex: `docs/briefs/168b-second-opinion-dp-intent-lock.md` (main checkout, tidak di-commit).
- Sisa: QR tidak punya `pos_orders.completed_at` (U3, kartu lain). Tanggal bisnis jurnal forfeit memakai `occurredAt` event (`now`), selisih ms dari `closed_at`.

## legend-tjwb perbaikan temuan Codex 150 EDC PAN scrub (engineer, cabang `ws/edc-pan-fix` dari `milestone/m1` a8c90378, 2026-11-09)

- Masalah: pola PAN hanya menerima satu pemisah, jadi `4111  1111  1111  1111` atau `4111 - 1111-1111 1111` lolos di migrasi 0135, query deteksi runbook, dan scrub JS. Oracle test memakai ambang 13+ global, jadi PAN 12 digit di kolom teks bebas tidak tertangkap.
- Keputusan migrasi (dengan architect): migrasi baru `0143_edc_pan_scrub_separators.sql`, 0135 tidak diubah. Migrator drizzle hanya menjalankan file dengan `when` di atas migrasi terakhir yang tercatat dan tidak memeriksa hash; 0135 yang diedit tidak akan jalan ulang di dev/staging yang sudah menerapkannya, dan AGENTS.md melarang menulis ulang migrasi yang sudah diterapkan. 0143 mengulang scrub penuh; DB baru menjalankan 0135 lalu 0143 dalam satu batch.
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
- Efek yang diterima dan dicatat di runbook: angka sah 5+ digit sesudah mask dengan `-` (mis. kode approval `- 123456`) ikut terhapus, tidak bisa dikembalikan.
- Review K: reviewer Opus + architect paralel, keduanya setuju aturan lengkap (fuzz 300k-500k PAN, paritas SQL Postgres vs JS 3000 input, idempoten). Dibetulkan: catatan "tidak bisa dikembalikan" dikembalikan ke runbook dan header SQL, fixture `- 123456`.
- Gate: test gagal dulu (migrasi 2/14, pola 1/20), lalu 3 file `edc-pan*` 44/44; 14 file EDC/POS EDC 189/189; `edc-contract` 6/6; tsc api dan shared lewat heavy, eslint, prettier lulus.
- Bead baru: `legend-lg45` (P2, sisa PAN di pesan yang terpotong 200 karakter oleh jalur tulis lama; celah lama, bukan dari diff ini).
- Berikut: second opinion Codex run 2 (brief 150b, bagian Run 2), urutan merge 0141 vs `ws/shift-close-fix`.

## legend-riqu + legend-ni6o: refund intent tidak memakai uang tender POS, refund jurnal menunggu penjualan (engineer, cabang `ws/refund-intent-guard` dari `milestone/m1` fee69d45, 2026-11-09)

- Sudah: ni6o (71ddaf57) `order.refunded` parkir `AUTO_JOURNAL_SALE_PENDING` (retryable, sweep) sampai `aj:sale:<orderId>` posted; `SALE_MISSING` non-retryable seperti void. riqu (e8f1faa4) `refundableBalance` mengurangi `posSaleInUse` (tender POS yang masih memakai intent, dikurangi retur gateway refund POS per metode); permintaan dan approval menjawab 409 `REFUND_INTENT_IN_POS_SALE`; approval di bawah kunci `lockIntentsForFact`, waktu fakta dari kunci.
- Perbaikan review K (e23edfa5 + commit berikut): pesanan ber-void tidak menahan intent; retur penuh satu metode membebaskan semua intent metode itu; tender `authorized` pada pesanan terbuka ikut menahan (webhook paid menangkapnya tanpa kunci intent).
- Bukti: test repro gagal di kode lama (ni6o :1651/:1726; riqu :331/:341/:367/:389/:428/:444; R6/R7 :466/:485 di e8f1faa4; R8 :511 di e23edfa5). 20 file test refund/jurnal: 611 lulus, 8 skip. Root contract node: 92 lulus.
- Bead sisa: legend-r5brx (capture tender kunci intent), legend-hxpd5 (guard GL payout tanpa retur POS, P1), legend-3bsyh (parkir SALE_MISSING tidak diulang), legend-8v2yl (baris refund POS per tender).
- Berikut: second opinion Codex `docs/briefs/179b-second-opinion-refund-intent-guard.md` (folder utama), gerbang merge CTO.

## legend-hxpd5 + legend-060xt + legend-r5brx + legend-3bsyh: sisa refund intent (engineer, cabang `ws/refund-payout-followups` dari `ws/refund-intent-guard` 27ba1fb9, 2026-11-09)

- Sudah: hxpd5 (d19e323e, 060e3d66, a2f7727b) `intentBackedAt` mengurangi bagian gateway yang diretur refund POS lewat modul atribusi bersama `pos-intent-attribution.ts` (dipakai juga `posSaleInUseOfIntent`); hanya refund POS yang jurnalnya posted dikurangi, yang masih bisa posting (termasuk parkir `SALE_MISSING`) membuat payout parkir retryable `AUTO_JOURNAL_RECEIPT_PENDING`. 060xt (d19e323e) tender `authorized` dicocokkan lewat `payment_link_id` intent (refresh QR). r5brx (df7a3fb6, 9341c5e2) capture QRIS: kunci link FOR UPDATE lalu semua intent paid link dalam satu `lockIntentsForFact`, pilih intent yang uangnya dihitung link (bukan double payment), tolak capture (void + refund late payment) bila refund approved/completed > cap; refund pending tidak memblok (approval-nya gagal cap). 3bsyh (771c9fc5) saat `aj:sale:X` posted, baris parkir `SALE_MISSING` void/refund X jadi retryable `nextRetryAt = now`; runbook `docs/runbooks/auto-journal-sale-missing.md`.
- Urutan kunci capture: orders → pos_orders → tender → payment_links → payment_intents (ORDER BY id) → day lock. Refund: payment_intents → fund → payment_refunds. Tidak ada migrasi.
- Bukti: repro gagal di kode lama (AJ-HXPD5-01 :5411, -03 :5475, -04 :5494, -06 :5596; PAY-04 R9 201≠409; race C1 :509, C2a :559, C2b :601 dengan `pg_locks`, C5 :652; AJ-3BSYH-01/02). 24 file test terarah 629/629 lulus; setelah perbaikan terakhir 3 file 185/185. tsc api lewat heavy, eslint, prettier lulus.
- Review K: reviewer Opus + architect paralel tiap putaran, temuan nyata dibetulkan, perbaikan terakhir dibaca reviewer segar.
- Bead baru: legend-x1i1h (void QRIS tidak kredit balik customer_deposit, P2), legend-45bs9 (dua intent QRIS + refund POS sebagian, P3), legend-leqj6 (late refund memotong refund pending, P3).
- Biaya sesi: 6.241k (biaya*), 14 subagent, rata 0,97 berjalan, puncak 3.
- Berikut: second opinion Codex `docs/briefs/181b-second-opinion-refund-payout-followups.md` (folder utama), gerbang merge CTO setelah `ws/refund-intent-guard`.

## legend-4xai + legend-cy2e station printer dan gate station (engineer, cabang `ws/station-fixes` di atas 9a2c1e86, 2026-11-09)

- 4xai temuan 1: `revokeDevice` mengosongkan `stations.printer_device_id` di transaksi yang sama sesudah kunci device (urutan device lalu station, sama dengan create/update), mengirim event menu per station, audit `clearedStationIds`. Migrasi data 0148 (`when` 1794222890808) mengosongkan binding lama yang bukan printer aktif tenant+outlet yang sama (FORCE RLS stations dan devices diangkat lalu dipulihkan).
- 4xai temuan 2: DTO station membawa `updatedAt`; `expectedUpdatedAt` wajib bila `printerDeviceId` dikirim (400), basi = 409 `CONFLICT` (cek awal sesudah izin + `UPDATE ... WHERE date_trunc('milliseconds', updated_at) = expected`). Form web tidak mengirim printer, tidak berubah; mock web ikut aturan 409.
- cy2e: `requireStationScopePermission` memakai gabungan outlet reach dan outlet dari station reach; service tetap menyaring per station (listStations `permittedStationIds`, 7 route ticket KDS `assertTicketStationPermission`). Komentar invariant `holdsToolAccess` dan `gatewayContext`, `docs/plan/contracts.md`.
- Bukti merah dulu: union 3/7 gagal di m1, revoke 3/4 gagal, stale form 5/10 gagal. Hijau: 43 file API 1063/1063, root node 146/146, tsc shared/api/web lewat heavy, eslint, prettier, `db:generate` kosong.
- Review K: reviewer Opus + architect paralel. Dibetulkan: nomor migrasi bentrok (0147 jadi 0148 sesudah rebase), event dan audit di revoke, urutan cek basi, backfill binding lama, test race update vs revoke, test HTTP 409, union semua route ticket. Brief Codex `docs/briefs/184b-second-opinion-station-fixes.md` (folder utama, tidak di-commit).
- Biaya sesi 9b6ee4f5: total biaya* 3674k (utama Opus 1726k, subagent Opus 796k, Sonnet 1087k, Haiku 65k), 14 subagent, puncak 4 berjalan.

## legend-0q3r sweep worker baris akses edge yang diparkir (engineer, cabang `ws/deferred-access-drain` di atas 12c91f6b, 2026-11-09)

- Baru `apps/api/src/worker/access-drain.job.ts` (`sweepParkedAccessEvents`), didaftarkan di relay `worker-main.ts` (izin CTO, hanya ini): per tenant, maks 20 outlet yang punya baris `staff_pin`/`pos_override` belum diterapkan (urut yang tertua), tiap outlet maks 2 batch x 25 baris, tiap batch satu transaksi dengan konteks satu outlet, throttle 60 detik per tenant. Memakai `drainParkedAccessEvents` yang sama dengan drain lazy (`FOR UPDATE SKIP LOCKED`), jadi sweep, drain lazy, dan sweep bersamaan tidak menerapkan satu baris dua kali. Param `meta` drain jadi `Omit<EdgeApplyMeta, "edgeNodeId">` (tiap baris memakai node-nya sendiri).
- Bukti merah dulu: dengan sweep dimatikan, 3 dari 4 test baru gagal (baris tetap parkir). Hijau: `edge-access-applier.test.ts` 38/38, tsc api lewat heavy, eslint, prettier. 4 test: outlet tanpa event baru, batas batch, 12 baris dengan sweep dan drain lazy paralel (tepat 1 audit per override), lintas tenant/outlet plus baris refused tidak menahan yang lain.
- Review S: 1 reviewer, tanpa temuan nyata. Batas diturunkan dari 50x4 ke 20x2 agar satu tick relay tidak panjang.
- Risiko: drain yang gagal total (select/update) tetap diam dan mengembalikan 0 (perilaku lama), jadi `failedOutlets` tidak menghitungnya; outlet macet di depan antrean hanya mengganggu bila lebih dari 20 outlet macet sekaligus.

## legend-usw3 kontrak picked-up dan runner-delivered (engineer, cabang `ws/expo-pickup-contract` di atas 42ee5c28, 2026-11-09)

- Kontrak saja (`packages/shared/src/kitchen`): `markPickupPickedUp` (POST `/pickup-calls/:callId/picked-up`), `markExpoOrderDelivered` (POST `/expo/:orderId/delivered`), tanpa body. Tabel `PICKUP_CALL_TRANSITIONS` + `pickupCallBlock`, `expoDeliveryBlock`, `expoTicketSchema.deliveredAt`, `errors.ts` (5 kode 409, pesan Indonesia).
- Idempoten: pickup di `picked_up` dan diantar di tiket yang sudah diantar menjawab 200 tanpa ubah (stempel pertama dipakai). `assigned -> picked_up` ditolak `PICKUP_CALL_NOT_CALLED`; `call` dari `picked_up` ditolak `PICKUP_CALL_CLOSED`.
- Bukti: `tests/kitchen-contract.test.mjs` 15/15 (3 test baru), tsc shared/api/web lewat heavy bersih, eslint, prettier. Review S: 1 reviewer, 2 temuan dibetulkan (refine deliveredAt tanpa isComplete, helper kode tolak pickup).
- Belum: mock web (`ws04-expo/mock.ts`) tanpa handler picked-up/delivered dan kode `PICKUP_CALL_CLOSED` (UI belum memakai); event realtime pickup/delivered tidak ada.

## legend-gfcr skema payroll + RLS + API konfigurasi, kasbon, reimburse, service charge (engineer, cabang `ws/payroll-schema-api` dari `milestone/m1` 42ee5c28, 2026-11-09)

- Migrasi 0167 `0167_payroll_core` (`when` 1794246000000), satu-satunya. 14 tabel di `apps/api/src/db/schema/payroll.ts` (13 baru; `payroll_pph21_policies` sudah ada sejak 0085): statutory_rates, payroll_policies, thr_schedules, pay_components, employee_pay_components, payroll_runs, payslips, bank_transfer_files, payroll_tax_exports, service_charge_pools, service_charge_allocations, employee_loans, reimbursement_categories, reimbursements. Semua `tenant_id` + `app.enforce_tenant_rls` (pool juga `enforce_outlet_rls`), FK komposit `(tenant_id, id)`, FORCE RLS induk employees/legal_entities/outlets diangkat lalu dipulihkan (pola legend-m007).
- HR-03: `employee_pay_components.amount_encrypted` dan `payslips.calculation_encrypted` disegel AES-256-GCM (`lib/payroll-sealed.ts`, AAD tenant/tabel/baris/field/versi kunci). Kasbon, reimburse, service charge tetap plaintext.
- Guard DB (`payroll.custom.sql`): statutory hanya insert draft, baris non-draft tidak bisa diubah/dihapus; transisi run sesuai kontrak, run frozen wajib snapshot+2 approver+lock, reversed wajib reversal approved; payslip/bank file hanya untuk run locked; jendela komponen gaji tidak boleh tumpang (EXCLUDE gist) dan hanya ditutup sekali; pool dan alokasi beku sejak approve; REVOKE DELETE/TRUNCATE/UPDATE kolom tersegel.
- Route `defineEndpoint`: `/hris/payroll/{statutory-tables,policies,thr-schedules,components,employees,loans,service-charge-pools,reimbursement-categories,reimbursements}` + `/hris/me/{loans,reimbursements}`. Tanpa run lifecycle (legend-07eg) dan mesin hitung (legend-j2l2). `updatePayComponent` dan `updatePayrollPolicy` merge lalu parse ulang.
- Bukti: 11 file test eksplisit 265/265 (migrasi edge-received-events, fk-force-rls, force-rls-guard, rls, payroll-core-db 119 kasus RLS/grant/FK/segel/guard, 6 file API payroll). tsc api lewat heavy 0 error, eslint 24 file bersih, prettier bersih, `db:generate` kosong. Test merah dulu untuk temuan review (5 merah lalu hijau).
- Review K: architect 2x. Putaran 1 "block merge" dibetulkan di 0167 (guard run/payslip/pool/jendela gaji). Putaran 2 tanpa blocker; dibetulkan: pembayar reimburse tunai tidak boleh pengaju, karyawan non-aktif tidak bisa mengajukan, cursor rusak 422, cancel kasbon tidak menimpa approver. Bug `payroll_runs_reversed_check` (NULL lolos) ditemukan test-writer, dibetulkan dengan COALESCE.
- Kartu sisa: legend-xo0xx (tabel run results + potongan kasbon), legend-8xf32 (tolak effectiveFrom gaji mundur ke periode terkunci), legend-fij0l (batas kasbon), legend-8399r (batas bulanan reimburse, receipt URL + cek kepemilikan receipt), legend-pf9u7 (calculate/approve pool), legend-07eg (run lifecycle).
- Risiko: rotasi kunci segel harus jalan sebagai owner role (app role tidak bisa UPDATE kolom tersegel); total run plaintext agregat; effectiveFrom gaji mundur belum ditolak (legend-8xf32).
- Brief Codex `docs/briefs/237b-second-opinion-payroll-schema.md` (tidak di-commit).
- Biaya sesi 479bb9e8: total biaya* 8596k (utama Opus 2779k, subagent Opus 819k, Sonnet 4946k, Haiku 52k), 19 subagent (Explore 5, implementer 8, test-writer 1, architect 2, test-runner 3), puncak sekitar 8 berjalan. `parallel-report` tidak menemukan sesi ini (transkrip di `.claude-swap-backup`).

## legend-aiksz tabel pickup_calls dan expo_assignments (engineer, cabang `ws/expo-pickup-tables` di atas 4fe23687, 2026-11-09)

- Migrasi `0168_expo_pickup_tables` (`when` 1794247000000). Skema `apps/api/src/db/schema/expo-pickup.ts`, trigger + RLS di `expo-pickup.custom.sql` (sudah ditempel ke migrasi).
- `pickup_calls`: nomor harian per outlet 1..999, unik `(tenant, outlet, business_date, number)` dan `(tenant, order)`; check status/channel dan `called_at`/`picked_up_at` sesuai status; trigger: status tidak mundur, waktu pertama tetap.
- `expo_assignments`: satu baris per order saat runner ditugaskan; `runner_id NOT NULL` (diantar selalu punya runner), `delivered_at`/`delivered_by` berpasangan; trigger: baris yang sudah diantar beku dan tidak bisa dihapus.
- Kedua tabel: `enforce_tenant_rls` + `enforce_outlet_rls`, FK komposit ke orders/outlets ditulis di dalam CREATE TABLE (pola 1, aman untuk owner non-superuser).
- Trigger tambahan (temuan architect): baris wajib di outlet order-nya (`app.order_outlet_match`, 23503, juga menolak order yang tak terlihat di RLS sesi); kolom identitas beku; status pickup tidak boleh loncat assigned->picked_up; baris expo yang sudah diantar beku penuh.
- Bukti: `LEGEND_TEST_FILES` 5 file 113/113 (`expo-pickup-rls.test.ts`, edge-received-events-migration, migration-fk-force-rls, migration-force-rls-guard, db/rls), `db:generate` kosong, tsc api lewat heavy, eslint, prettier.
- Review K: reviewer Opus (FK ke tabel FORCE RLS lewat ALTER, dibetulkan dengan FK di dalam CREATE TABLE), architect (sama + celah trigger, dibetulkan), reviewer Opus ulang (logika benar, 3 celah cakupan test, ditutup). Second-opinion Codex: brief `docs/briefs/238b-second-opinion-expo-pickup-tables.md` (antre).
- Untuk legend-mzhr0/him8j (komentar bd): alokasi nomor butuh advisory lock + retry; perilaku >999 dan order void belum diputuskan; runner_id tanpa FK, cek staf outlet di service.

## legend-8399r batas bulanan reimburse + receipt (engineer, cabang `ws/payroll-caps` dari `ws/payroll-schema-api` f99d9d2e, 2026-11-09)

- Commit 75b11175. Batas bulanan per karyawan+kategori+bulan (bulan dari `expenseDate`) ditegakkan saat ajukan di bawah `pg_advisory_xact_lock`; pemakaian = jumlah klaim `submitted` + jumlah disetujui `approved`/`paid`. Saat setujui dicek ulang (approved/paid lain + jumlah disetujui, batas jabatan saat ini). Ditolak/dibatalkan membebaskan jumlahnya.
- Receipt: harus UUID objek `core_storage_objects` tenant sama, purpose `receipt`, outlet = outlet karyawan, umur maks 24 jam, belum dipakai klaim/dokumen/cuti lain (lock per ref). `receiptUrl` ditandatangani sesudah transaksi lewat `HrisFileSigner` yang disuntik (`createPayrollReimbursementRouters({ fileSigner })`, ekspor lama tetap); respons idempotent tidak menyimpan URL; signer gagal = URL null.
- Bukti merah dulu: 10 dari 14 test baru gagal di kode lama (termasuk 2 test paralel). Hijau: `payroll-reimbursements-caps.test.ts` 15 + `payroll-reimbursements-api.test.ts` 32 = 47, plus loans/components/core-db hijau (4 file 193 test sebelum perbaikan fixture). tsc api lewat heavy 0 error, eslint, prettier bersih. Test lama disesuaikan: ref `uploads/struk-1` jadi objek receipt sungguhan; fixture batas bulanan jabatan A dinaikkan agar tidak bentrok.
- Review K: 1 architect, tanpa blocker. Tersisa: (1) klaim bisa diberi tanggal mundur untuk memakai batas bulan lama (butuh keputusan founder soal jendela), (2) unique index `receipt_upload_ref` butuh migrasi, (3) `core_storage_objects` tanpa uploader, (4) signer belum dipasang di bootstrap produksi.
- legend-fij0l TIDAK dikerjakan: `loanPolicySchema` hanya ada di kontrak dan fixture, tidak ada tabel atau kolom di API. Butuh migrasi (nomor dari CTO) atau keputusan penyimpanan lain.
- Brief Codex: bagian ditambahkan ke `docs/briefs/237b-second-opinion-payroll-schema.md` di folder utama (file belum ada, dibuat, tidak di-commit).
- Biaya sesi 651f863e: total biaya* 1759k (utama Sonnet 1214k, subagent Opus 249k, Sonnet 296k), 4 subagent (Explore 2, test-writer 1, architect 1), puncak 2 berjalan.

## legend-fij0l batas kasbon + migrasi 0169 (engineer, cabang `ws/payroll-caps`, 2026-11-09)

- Commit 27603b9e. Migrasi 0169 `0169_payroll_loan_policy` (idx 162, `when` 1794248000000, prevId snapshot 0167; merge train perlu rechain karena 0168 sudah ada di cabang lain). Isi: tabel `payroll_loan_policies` (id, tenant_id UNIQUE, max_principal_idr, max_principal_of_base_salary_bp, max_installments, max_deduction_of_net_pay_bp, single_open_loan, updated_by; CHECK minimal satu batas, rentang nilai), RLS `enforce_tenant_rls`, REVOKE DELETE/TRUNCATE app role; plus unique index `reimbursements_receipt_upload_ref_key` (lower, partial non-null) untuk legend-8399r.
- `assertLoanAllowed` (payroll-loans.service.ts) dipanggil saat ajukan dan saat setujui (hanya loan `pending`), di bawah `pg_advisory_xact_lock` per tenant+karyawan: tanpa baris policy = `PAYROLL_LOAN_LIMIT_EXCEEDED` (fail closed); batas pokok, kelipatan gaji pokok (jumlah komponen `base_salary` aktif hari ini, disegel; tidak ada = 0), maks cicilan, satu kasbon terbuka (pending/approved/disbursed; loan sendiri dikecualikan saat setujui). Memakai `assertLoanWithinPolicy` kontrak.
- Bukti merah dulu: 12 dari 20 test baru gagal di service lama (termasuk paralel dan setujui). Hijau: 9 file 253 test (payroll-loans-caps 22, payroll-loans-api, payroll-reimbursements-caps, payroll-reimbursements-api, payroll-components-api, payroll-core-db, edge-received-events-migration, migration-fk-force-rls, migration-force-rls-guard). `db:generate` kosong ("nothing to migrate"), tsc api lewat heavy 0 error, eslint, prettier bersih. Test lama disesuaikan: payroll-loans-api menyemai policy longgar, payroll-core-db memuat tabel ke-15 (+ `ONE_ROW_PER_TENANT`).
- Review K: 1 architect, tanpa blocker kode. Dibetulkan: approve pada loan non-pending kini `PAYROLL_INVALID_TRANSITION`, bukan galat batas. Tersisa: (1) rantai migrasi (journal idx 162 dan snapshot perlu rechain di atas 0168), (2) `singleOpenLoan=false` memeriksa tiap kasbon sendiri-sendiri, total terbuka tidak dibatasi (keputusan produk), (3) tidak ada endpoint/seed untuk menulis policy: kasbon mati di semua tenant sampai ada kartu konfigurasi (dengan audit), (4) unique index receipt gagal bila DB integ yang sudah menjalankan 0167 memuat ref ganda.
- Langkah integrasi: izin `self.loan.request` ada di `ws/access-perm-backfill`; route `/hris/me/loans` harus memakainya setelah kedua cabang bertemu (belum ditambahkan, kode izin belum ada di basis ini).
- Biaya sesi 651f863e: total biaya* 3863k (utama Sonnet 2755k, subagent Opus 420k, Sonnet 688k), 8 subagent (Explore 4, test-writer 2, architect 2), puncak 2 berjalan.

## legend-hjaot endpoint policy kasbon + dua keputusan founder (engineer, cabang `ws/payroll-loan-policy-api` dari dd72324c, 2026-11-09)

- Commit kode 5bda30ac. `GET/PUT /api/hris/payroll/loan-policy` (kontrak `getLoanPolicy`/`setLoanPolicy` di endpoints.ts): baca `payroll.view`, tulis `payroll.run`, tenant-wide, idempotent (kunci sama + isi beda = 409), satu baris per tenant, penulis antre di advisory lock per tenant, audit tiap perubahan (before/after nilai batas saja; kunci audit `principalMultipleBp` karena masker menolak kunci berisi "salary"). Kasbon menyala untuk tenant begitu PUT pertama dilakukan.
- Keputusan founder (1): klaim reimburse maksimal 30 hari kalender ke belakang dari tanggal pengajuan (`REIMBURSEMENT_BACKDATE_DAYS`, hari ini-30 boleh, -31 ditolak 422), dicek saat ajukan saja; setujui/bayar klaim lama tidak dicek ulang.
- Keputusan founder (2): batas total kasbon terbuka per karyawan `maxTotalOpenIdr` (wajib, > 0): sisa pokok semua kasbon belum lunas (pending/approved memegang pokok penuh, disbursed sisa) milik karyawan lain-kasbon + pengajuan <= batas, ditegakkan saat ajukan dan setujui di bawah lock per karyawan yang sama (`assertLoanWithinPolicy` kini menerima `openOutstandingIdr`). Berlaku bersama `singleOpenLoan` dan batas per pengajuan.
- Migrasi 0169 DIUBAH di tempat (kolom `max_total_open_idr bigint NOT NULL` + CHECK > 0, snapshot ikut). `db:generate` kosong. Tanpa migrasi baru.
- Bukti merah dulu: endpoint 34 merah tanpa route; total 10 merah tanpa cek dan 1 test paralel merah tanpa advisory lock; jendela 3 merah tanpa cek. Hijau: 10 file API 312 test (loan-policy-api, loans-caps, loans-api, reimbursements-caps, reimbursements-api, core-db, components-api, edge-received-events-migration, migration-fk-force-rls, migration-force-rls-guard) plus `tests/payroll-contract.test.mjs` 24/24. tsc api+web+shared lewat heavy 0 error, eslint dan prettier bersih.
- Review K: 1 architect. Blocker: `tests/payroll-contract.test.mjs` belum memuat `maxTotalOpenIdr`/`openOutstandingIdr` (merah, dibetulkan dan diberi kasus total). Tersisa: (1) 0169 sudah ada di `integ/m1-batch36` dan `ws/payroll-caps`: DB yang sudah menjalankan 0169 lama tidak mendapat kolom baru, buat ulang DB lokal atau pastikan tidak ada DB bersama yang memakainya; dd72324c harus diganti oleh cabang ini di merge train, (2) urutan lock approve = baris loan lalu advisory (aman sekarang; potongan payroll di masa depan harus mengikuti urutan sama), (3) tidak ada aturan `maxTotalOpenIdr >= maxPrincipalIdr` (total lebih kecil diam-diam menurunkan batas per pengajuan), (4) UI reimburse belum memakai jendela 30 hari sebagai `min` tanggal dan UI kasbon belum cek batas total (server tetap menegakkan), konstanta ada di service API bukan kontrak shared.
- Langkah integrasi tetap: `/hris/me/loans` memakai `self.loan.request` setelah bertemu `ws/access-perm-backfill`.

- Tambahan (keputusan CTO 9 Nov, commit di cabang yang sama): `loanPolicySchema` dan input PUT menolak `maxTotalOpenIdr < maxPrincipalIdr` (422; tanpa batas rupiah total bebas), CHECK sama di `payroll_loan_policies` (0169 diubah lagi di tempat, snapshot ikut, `db:generate` kosong). `REIMBURSEMENT_BACKDATE_DAYS` kini diekspor dari kontrak shared (`reimbursements.ts`). Merah dulu: kontrak 1, PUT 422 1, CHECK DB 2. Hijau: 10 file API 314 test + `tests/payroll-contract.test.mjs` 24/24, tsc api+web+shared heavy 0 error, eslint dan prettier bersih. Mengganti poin sisa (3) dan (4-konstanta) review sebelumnya.

## legend-8vgid failover otomatis bayar di kasir dari GatewayHealth (engineer, cabang `ws/gateway-failover-cashier` di atas 4c818489, 2026-11-09)

- Sudah ada: `GatewayHealth` (tipe, dibaca live tiap request), metode online nonaktif saat `down`, `requestPayAtCashier` (hanya audit), kolom `fallbackProvider`. Dibangun: `payment-failover.service.ts` (insiden per outlet di `audit_logs`, tanpa tabel), satu alert supervisor per insiden (kategori baru `payment_failover`), penanda per bill per insiden, `requestPayAtCashier` idempoten dan tidak menunggu gateway, `reason: "unconfigured"` agar outlet tanpa akun gateway tidak dianggap gangguan.
- Review K (architect): 6 temuan, 1-4 dan 6 dibetulkan (unconfigured, ack tanpa health, query dibatasi outlet+waktu dan baca tanpa lock, gateway naik-turun membuka ulang insiden yang sama tanpa alert baru, bill lunas tidak ditandai). Sisa: probe terjadwal di worker, indeks audit_logs (butuh migrasi).
- Bukti: 5 file API 270/270 (payment-failover 13 baru, payment-api, payment-doit, ai-anomaly-summary, ws03-guest-va), `pnpm typecheck` lewat heavy exit 0, eslint, prettier.

## legend-5ffks probe terjadwal + test dua tenant failover (engineer, lanjutan `ws/gateway-failover-cashier`, 2026-11-09)

- Baru `apps/api/src/worker/payment-failover-probe.job.ts`: `sweepGatewayHealth` memeriksa hanya outlet dengan insiden terbuka (maks 10, 5 paralel, throttle 5 menit per tenant); `startGatewayProbeSweep` dijalankan tanpa menunggu dari relay `worker-main.ts` (satu sweep per tenant). Pemulihan tercatat tanpa trafik tamu.
- `payment-failover.service.ts`: heartbeat `payment.gateway_still_down` (tiap 3 jam, hanya saat ada pembacaan `down`) menjaga insiden panjang tidak basi, jadi tidak alert ulang tiap 6 jam; `listOutletsWithOpenIncident`.
- Bukti merah dulu: modul probe belum ada (suite gagal impor); setelah modul ada tanpa heartbeat, test gangguan panjang gagal (alert 15 vs 14), lalu hijau.
- Review K (architect, diff baru): 3 temuan, semua dibetulkan: sweep tidak lagi menahan relay, daftar probe memakai usia baris terbaru (bukan 7 hari) dan dipilih sesudah baris terbaru per outlet, `now` per outlet sesudah `health()`.
- Test: `payment-failover.test.ts` 20, `payment-failover-tenants.test.ts` 4 (isolasi dua tenant: insiden, penanda bill, penerima alert, sweep per tenant). 6 file API 272/272, `pnpm typecheck` heavy exit 0, eslint, prettier.

## legend-6mla + legend-v0s2 + legend-p4yd + legend-z6a5 + legend-3wyz + legend-bddb kontrak laporan keuangan WS-07 (engineer, cabang `ws/finance-report-contracts` dari `ws/finance-policy-asset-register` cd6fe532, 2026-11-10)

- Satu commit per kartu, tanpa migrasi. p4yd `5f2dbd7f` (+ perbaikan review `9556ffd7`), z6a5 `7abca441`, 6mla `c88d0ef6`, v0s2 `d576a9b5`, 3wyz `765396ae`, bddb `28bbd769`; `522b8f85` dan `1b2518fd` hanya lint dan tipe tes.
- 6mla: tiap respons statement membawa `basis` (`closed_snapshot|live`), `periodKeys`, `closedPeriodKeys`; helper murni `statementBasisFor` / `statementBasisFields` di shared (satu sumber untuk web dan handler kelak). Handler statements belum ada di `apps/api`, jadi baru kontrak dan helper. Handler kelak memanggil `statementBasisFields` (`cumulative: true` untuk neraca, arus kas, ekuitas).
- v0s2 (uang): `FixedAsset` membawa `bookValueIdr` (cost dikurangi akumulasi) dan `disposalResultIdr` (null kecuali dilepas; sama dengan hasil yang diposting saat pelepasan), invarian di superRefine, semua pembaca dan respons dispose memakainya.
- p4yd (uang): `parseBankCsvAmount` hanya tata bahasa (pecahan tidak nol tetap ditolak, ribuan valid, tanda ganda, spasi dalam angka, dan "Rp" di tengah angka ditolak); tetap bilangan rupiah bulat, kode `STATEMENT_VALUE_INVALID`. Tiga bug (tanda ganda yang membalik nilai, spasi dalam angka yang terbaca menyambung, "Rp" di tengah angka) ditemukan architect dan sudah dibetulkan di `9556ffd7`.
- z6a5: `signedStorageUrl(..., { downloadFileName })` memasang `Content-Disposition: attachment` dengan `filename` dan `filename*`; `coretaxExportFileName(type, period)` membuat `coretax-<type>-<period>.xml`. Handler ekspor Coretax belum ada, jadi handler kelak wajib memakai keduanya.
- 3wyz: `GET /api/accounting/open-items` (item terbuka per dokumen, urut jatuh tempo lalu id, cursor, filter counterparty/outlet). bddb: `GET /api/accounting/legal-entities` di bawah `accounting.journal.view` (`id,name,npwpLast4,isPkp`); guard `org.structure.manage` pada route org tidak diubah.
- Bukti: tes terarah API 10 berkas / 104 lulus (1 dilewati); tes root kontrak 101/101; tsc shared, api, web bersih; eslint dan prettier berkas berubah; satu architect untuk diff gabungan.
- Pemakaian sesi (`session-usage.py`, gabungan tugas 1 dan 2): biaya* 6319k (utama sonnet 2718k, subagent sonnet 3163k, opus 402k, haiku 37k), 20 subagent total sesi; tugas 2: 12 subagent, puncak 6 bersamaan.

## legend-ggpoe nomor panggil berhuruf di order takeaway dan delivery (engineer, cabang `ws/pickup-call-letters` di atas 6fee08e3, 2026-11-10)

- Keputusan founder Q51: pesanan tidak pernah ditolak karena nomor habis. Format: A-001..A-999, B-001.., Z-999, lalu AA-001, AB-001 dst (keputusan CTO), reset harian per outlet.
- `pickup_calls.number` tetap urutan harian 1, 2, 3... (smallint jadi integer, check `>= 1`); kode dihitung dari urutan oleh `formatPickupCode` (`packages/shared/src/kitchen/pickup-code.ts`), tidak disimpan. Data lama (1..999) otomatis jadi A-001..A-999.
- Migrasi `0175_pickup_call_letters` (`when` 1794254000000): ubah tipe `number`, ganti check nomor, tambah channel `delivery` (POS delivery sendiri) di check channel.
- `allocatePickupCall`: tanpa batas 999 (`PICKUP_NUMBER_EXHAUSTED` dan `PICKUP_NUMBER_MAX` dihapus), `PickupCall.code`, service type `delivery` memakai channel `delivery`. Dipasang di `createPosOrder` (takeaway dan delivery, satu transaksi dengan order); dine-in dan perangkat training tidak dapat nomor.
- Kontrak: `pickupCallSchema.code`, `expoTicketSchema.pickupCode`, `number` tanpa batas atas, channel `delivery`.
- UI yang perlu menyusul (bukan scope): `ws04-expo/components/target-label.ts` ("Antrean {number}") dan `pickup-screen.tsx` + `sound.ts` (pengumuman suara) harus memakai `code`, bukan `number`.
- Perbaikan web (keputusan CTO opsi 2): `channel-badge.tsx` entri `delivery` (ikon Bike, label `channel.delivery`), `pickup-screen.tsx` tampil, suara, dan label tombol memakai `code` (urutan tetap `number`), `target-label.ts` memakai `pickupCode`. `sound.ts` tidak berubah (teks suara dari `pickup-screen`). Tes: 3 tes baru di `tests/kitchen-pickup-display.test.mjs` (gagal-dulu terbukti, 9/9 lulus), tsc `apps/web` bersih.

## legend-wt33, legend-9by4, legend-wq3f jejak audit RBAC dan login staf (engineer, cabang `ws/auth-audit-trail` di atas d8ea5e0b, 2026-11-10)

- RBAC: writer `coreAuditWriter` sudah terpasang di `app.ts`; sisa kerja hanya test. `rbac-audit-writer.test.ts` (10 test): audit ikut commit, ikut rollback bersama tulis domain, fail closed tanpa writer, tenant lain tidak bisa membaca. Writer uji di `platform-access-api.test.ts` dihapus, diganti `coreAuditWriter` plus baca `audit_logs`.
- Login: `services/identity-wa-audit.ts` (baru) dan panggilan audit di `identity-login.service.ts` / `identity-wa-inbound.service.ts`: `login_challenge.created|completed|rejected|expired|cancelled|rate_limited|claimed|claim_failed`. Tanpa migrasi, tanpa kode OTP/token/nomor penuh (hanya 3 digit akhir nomor (keputusan CTO 10 Nov, minimisasi data), IP digest berkunci).
- Bukti: gagal-dulu (12 dari 13 test login audit gagal di sumber basis), 5 file / 66 test hijau, tsc api bersih lewat heavy, eslint, prettier. Review K: satu architect, 1 temuan nyata (banjir baris rate_limited) dibetulkan dengan throttle satu baris per tenant+perangkat per 15 menit.
- Celah yang diketahui: pesan webhook tanpa challenge cocok dan batas per-nomor tidak punya tenant, jadi tidak diaudit (tetap tercatat di `wa_inbound_messages`). Brief Codex: `docs/briefs/265b-second-opinion-auth-audit.md`.

## legend-fc0f2 rate limit HTTP login-challenges (engineer, cabang `ws/auth-audit-trail` di atas 72b17ed2, 2026-11-10)

- `middleware/login-challenge-rate-limit.ts` (baru), dipasang di `app.ts` sebelum `guardImpersonatedAuthRoutes` dan `tenantContext`: kelas issue (30 per IP, 10 per binding per menit) dan poll/cancel (600 dan 120). Counter, galat 429, dan `req.ip` (TRUST_PROXY) sama dengan `publicRateLimit`. Cookie binding harus bertanda tangan valid; cookie palsu hanya dihitung ke IP. Logika AUTH-04 tidak diubah, tanpa migrasi.
- Bukti: gagal-dulu (mount dilepas: 10 dari 12 test gagal; dua perbaikan architect dikembalikan: test terkait gagal). 6 file / 78 test hijau, tsc api via heavy bersih, eslint, prettier. Banjir 429 tanpa `db.transaction`, `pool.query`, `pool.connect`, termasuk dengan cookie sesi palsu, dan tanpa baris `audit_logs` atau `login_challenges`.
- Review K: satu architect, 2 temuan nyata dibetulkan (kelas issue gagal-tertutup untuk semua POST selain cancel, huruf besar-kecil; tidak ada IP yang dikecualikan secara default). IPv6 per /64: kartu `legend-6jgd2` (P2). Limiter per proses (memori); beberapa instance masing-masing punya jendela.

## legend-6jgd2 kunci IP IPv6 per /64 (engineer, cabang `ws/ipv6-rate-limit-key` di atas fd953712, 2026-11-10)

- `lib/client-ip-key.ts` (baru): `clientIpKey` satu helper untuk tiga tempat. IPv4 utuh, IPv4-mapped (`::ffff:a.b.c.d` dan hex) menjadi IPv4, IPv6 lain menjadi /64 kanonis, kosong `unknown`, teks tak valid tidak melempar galat. Dipakai di `login-challenge-rate-limit.ts` (kunci `ip:`), `public-rate-limit.ts` (`ip:` dan `write-ip:`), dan `clientIpDigest` (hitungan AUTH-04 per IP). Pengecualian `internalIps` tetap membandingkan alamat persis. Tanpa migrasi.
- `ip_hash`: digest IPv4 tidak berubah. Digest IPv6 berubah menjadi digest dari /64, di `login_challenges.ip_hash` dan di `ip_hash` audit (helper yang sama, jadi tetap konsisten dengan hitungan AUTH-04). Baris lama tidak ditulis ulang; jendela AUTH-04 hanya 15 menit.
- Bukti: gagal-dulu (3 source dikembalikan ke basis: 14 dari 21 tes `ipv6-rate-limit-key.test.ts` gagal; 38 tes unit helper lulus karena helper file baru). 8 file / 137 tes hijau (2 baru + 6 lama), tsc api via heavy bersih, eslint, prettier.
- Sisa kunci IP mentah di luar cakupan: `edge/link-server.ts`, `routes/staff-pin-sync.routes.ts`, `routes/edge-bootstrap.routes.ts`, `routes/payment-webhook.routes.ts`, `routes/mcp.routes.ts`, rate limit Better Auth via `CLIENT_IP_HEADER`.
- Review K: satu architect, tanpa temuan nyata (fuzz 200 ribu IPv6 valid, tidak ada yang jatuh ke kunci teks mentah). 3 catatan dipakai: digest `::ffff:a.b.c.d` ikut berubah (dicatat di brief 265b), komentar helper dibetulkan, sisa risiko /48 atau /56 dicatat (invariant 22).

## WS-04 KDS issues dan stasiun (engineer, cabang `ws/kds-issues-station` di atas d8ea5e0b, 2026-11-10)

- Sudah: legend-d60m `d73a19a4` (satu bentuk `order_issues`, dimiliki kontrak kitchen, qr-order re-export), legend-tsp5 `cb63b7d9` (GET station-summary), legend-4b5 `2a75a8c4` + perbaikan review `6bbcb6cc` (tabel `order_issues`, migrasi 0180 idx 167 when 1794259000000, route report/list), legend-rutl `3bf87664` (tableLabel + channel di tiket), legend-0eq7 `3795a148` (proyeksi nama order/item/staf).
- Diparkir: legend-44jm (tidak ada tabel capacity rules di API) jadi kartu legend-w4nq4. Baru: legend-uyw0v (alur persetujuan refund manual; kini 422), legend-o8quo (validasi voucher/replacement), legend-xz3ll (UI).
- Bukti: API 10 file 142 tes lulus, root 6 file 86 tes lulus, tsc shared/api/web bersih, db:generate kosong dua kali. Review K: 1 architect, 4 temuan nyata dan 2 lebih ringan, dibetulkan (kecuali voucher/replacement jadi kartu).

## WS-04 KDS capacity rules (engineer, cabang `ws/kds-capacity-rules` di atas 038d8201, 2026-11-10)

- Sudah: legend-w4nq4 `dc6f2c43` (tabel `kitchen_capacity_rules`, migrasi 0184 idx 168 when 1794263000000 prevId 28dfdeab, service, GET dan PUT, izin `kds.station.manage`), legend-44jm `f7991157` (test dan komentar route GET).
- Bukti: API 5 file 112 tes lulus, tsc shared/api/web bersih, db:generate kosong dua kali, review S: tanpa temuan nyata (catatan kecil: CHECK DB tidak mengulang batas atas capacity_points dan near_capacity_bp).
- Bagian 1 (bukti gagal-dulu untuk 6bbcb6cc, tsp5, rutl): tes comp ganda diperkuat jadi 8 paralel (`038d8201`).

## WS-04 KDS baca cook dan alert staf (engineer, cabang `ws/kds-cook-reads` di atas 34f0dc53, 2026-11-10)

- Sudah: legend-gt7f `0f4e94d5` (cook dengan `kds.ticket.process` membaca label stasiun dan aturan kapasitas lewat dua endpoint KDS khusus baca; `menu.item.view` dan `kds.station.manage` tidak dilonggarkan, PUT kapasitas tetap `kds.station.manage`, batas stasiun diterapkan di SQL), legend-078b `732d416f` + perbaikan review `4aa960c8` (alert staf lewat notifikasi yang ada, kategori baru `kitchen_alert`: audit `kitchen_ticket.unrouted` untuk baris QR tanpa stasiun dan `order.kitchen_voided` untuk void dapur pesanan QR). Tanpa migrasi.
- Kontrak baca: GET `/api/outlets/:outletId/kitchen/station-labels` dan GET `/api/outlets/:outletId/kitchen/stations/:stationId/capacity-rules`, keduanya `kds.ticket.process`. Komentar kontrak ada di legend-xz3ll.
- Alert: satu notifikasi per kejadian per penerima (kunci dedupe `eventId:userId:category`, idempoten), hanya staf outlet itu. Baris tanpa stasiun ke pemegang `kds.station.manage`; void QR ke pelayan zona yang masih layak (tidak diblokir, penugasan aktif dengan `floor.table.operate`), bila kosong ke pengelola KDS. Void tiket tanpa baris tidak mengirim alert. Kegagalan alert ditelan di savepoint agar checkout tidak gagal.
- Bukti: API 7 file 138 tes lulus, root 3 file 38 tes lulus, tsc api lewat heavy bersih (shared dan web bersih sebelum perbaikan review, shared tidak berubah sesudahnya), eslint dan prettier bersih per berkas. Review K: 1 architect, 3 temuan nyata (pelayan zona basi, void tanpa baris, test jalur checkout nyata), semua dibetulkan.
- Risiko: halaman kitchen-config web masih memanggil `/api/menu/stations`; bila tidak ada pemegang `kds.station.manage` dan tidak ada pelayan zona, alert tidak punya penerima; route kontrak `GET /kitchen/stations` belum punya sumber DB.
- Biaya sesi 291a5b03 (sampai titik ini): total biaya* 9165k (utama Sonnet 2941k, subagent Opus 751k, Sonnet 5474k), 15 subagent total sesi, brief ini: 2 Explore + 3 implementer + 1 architect, puncak 2 berjalan.

## legend-6g29 DOIT getPayment untuk PaymentProvider (engineer, cabang `ws/doit-get-payment` dari 3517283b, 2026-11-10)

- Temuan: `PaymentProvider` hanya dipakai `FakePaymentProvider`; DOIT hanya lewat `PaymentGatewayPort.getStatus` (lifecycle: `refunded` jadi `pending`). Verifier `verifyDoitSignature` sudah cocok dengan dokumen publik DOIT (https://doit.id/docs/en/: `PayBridge-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>." + raw body)>`, `timingSafeEqual`), jadi tidak diubah. Memakai `node:crypto`, bukan `adapters/hmac.ts` (WebCrypto, async; verifier dan pemanggil sinkron).
- Dibangun: `doitPaymentToProviderStatus`/`doitPaymentToProviderResult` (5 status DOIT ke enum 6, `refunded` tetap `refunded`, tak dikenal = SERVICE_UNAVAILABLE, tak pernah `paid`), `DoitGateway.lookupPayment` (GET /v1/payments/{id}, id dan reference jawaban harus sama), `createDoitPaymentReader` (`payment-doit-provider.ts`, resolver diinjeksi, cek tenant/outlet/scope), log `DOIT answer failed validation` (hanya path).
- Belum ada pemanggil `createDoitPaymentReader`: resolver (reference Legend ke id DOIT) dan pemasangan ke worker/poller adalah langkah berikut.
- Bukti merah dulu: 49 dari 54 tes gagal tanpa implementasi; cek outlet resolver: 1 gagal tanpa cek, 57/57 hijau dengan cek. Review K (architect): 1 sedang (outlet resolver tidak dicocokkan) dibetulkan + 2 tes celah; tidak ada migrasi.
- Gelombang: sesi `21802f2a` 8 menit, 9 subagent (3 Explore, web-fetch, implementer, test-writer, doc-writer, architect, test-runner), puncak 3 bersamaan, biaya* 1446k; `parallel-report` 02:15: rata-rata 0,79 subagent berjalan, 15 langkah tanpa subagent (sesi `21802f`).

## legend-rfiof DOIT poller: kunci kerja antar worker (engineer, cabang `ws/doit-pending-poller` dari d2080951, 2026-11-10)

- Arah (keputusan CTO): poller yang ada (`pollPendingGatewayIntents`, legend-b9i) ditambah, bukan poller baru. Resolver id DOIT dan pemanggil `createDoitPaymentReader` tidak dibangun: id DOIT selalu tersimpan di `provider_ref`, pembayaran yatim tidak bisa dicari lewat reference (DOIT hanya `GET /v1/payments/{id}`), dan reader tanpa jumlah uang tidak cukup untuk melunasi.
- Sudah: kolom `payment_intents.gateway_poll_lease_until` (migrasi 0190, when 1794269000000), klaim atomik `FOR UPDATE SKIP LOCKED`, lease 2 menit dari jam dinding, dilepas di `finally` hanya bila masih milik run itu. Tes baru `payment-poll-lease.test.ts` (10) dan `payment-terminal-paid.test.ts` (15).
- Status akhir: poller hanya memilih `pending` dan `expired`. `failed`/`refunded`/`partially_refunded` tidak pernah ditanyakan. Webhook `paid` untuk `refunded` dengan id DOIT sama = `duplicate` (tidak ada catatan baru), id berbeda ditolak `REFERENCE_MISMATCH`. Webhook `paid` untuk `failed` hari ini menyelesaikan sebagai late payment (tes PAY-03, keputusan founder menunggu); `syncExpiredIntentPayment` tidak disentuh.
- Review architect: dua temuan diperbaiki (lepas lease tanpa cek pemilik; lease dari `now` pemanggil). Risiko urutan merge migrasi 0190 vs 0187-0189 dicatat di laporan.
- Langkah berikut: second opinion Codex (`docs/briefs/283b-second-opinion-doit-poller.md`, belum dijalankan), merge train.

## WS-07 kas & bank (engineer, cabang `ws/cash-bank-recon` dari d2080951, 2026-11-10)

- Dibangun (legend-fnxl.1–.7): migrasi 0191 (`when` 1794270000000, prevId 0186 `8948ed96`), 8 tabel kas-bank dengan FK inline, RLS tenant di semua tabel, RLS outlet di `cash_deposits`, log aksi kasus append-only (REVOKE). API: rekening bank (nomor tersegel + HMAC, hanya 4 digit terakhir keluar), impor CSV ketat (semua atau tidak sama sekali, dedupe per kemunculan, impor ulang tidak menggandakan), auto-match hanya jumlah pasti + tanggal dalam toleransi kebijakan dan unik dua arah, match/exclude/unmatch/ringkasan, setoran kas + alert ACC-05 dari `pos_shifts`, kasus dengan PIC dan log tiap aksi. Web `ws07-cash-bank` membaca `GET finance-policy` dan menampilkan pesan jelas untuk CSV yang ditolak.
- Tidak ada posting jurnal otomatis (legend-9pz9), tidak ada gateway/EDC (legend-fnxl.8 menunggu legend-cs7).
- Review K (satu architect): 4 sedang + 4 rendah, semua dibetulkan dengan tes gagal-dulu (DECISIONS #8, #12–15): koleksi ACC-05 memasukkan selisih kas shift, keunikan auto-match per akun GL, pasangan yang di-unmatch tidak dicocokkan otomatis lagi (tabel `bank_statement_match_rejections`), dokumen di kasus terbuka bukan kandidat dan kasus menolak dokumen yang sudah dicocokkan, buka kasus idempoten, urutan kunci setoran, impor ke rekening nonaktif ditolak, kunci dedupe > 400 karakter ditolak rapi.
- Bukti akhir: 10 berkas API 106/106 hijau (termasuk RLS 28), tes root 172/172 (kontrak + ws07), tsc shared/api/web bersih lewat `heavy`, eslint + prettier bersih. Second generate drizzle kosong. Brief Codex `docs/briefs/271b-second-opinion-cash-bank.md` (xhigh) siap, belum dijalankan.
- Merge train: `when` 0191 harus tetap paling besar sesudah 0187–0190 digabung (drizzle melewati migrasi dengan `when` lebih kecil tanpa error).
- Gangguan: disk Mac penuh (ENOSPC) di tengah gelombang; tes, tsc dan review diulang sesudah CTO membebaskan 23 GB.
- Gelombang: sesi `9cb2a25e` 36 menit tercatat sesudah compact, 21 subagent (implementer, test-writer, architect, test-runner, Explore), puncak 6 bersamaan, biaya* 8712k; `parallel-report` 05:00: rata-rata 1,34 subagent berjalan, 27 langkah tanpa subagent.

## legend-o032 WS-14 peralatan dan perawatan (engineer, cabang `ws/equipment-maintenance` dari d2080951, 2026-11-10)

- Temuan: registri peralatan, jadwal, tiket kerusakan dengan auto-86 (`disabled_item_ids`), dan gerbang serah terima (OPS-05) sudah ada di m1. Kurang: pengingat servis (event `equipment_service.reminded` ada di kontrak tetapi tidak dipancarkan siapa pun), aksi "servis selesai", tes isolasi tenant perilaku, tes izin, assert `disabled_item_ids`.
- Dibangun: kolom `maintenance_schedules.reminded_for_due_at` (migrasi 0198, `when` 1794277000000, satu ALTER ADD COLUMN nullable); `sweepEquipmentServiceReminders` (horizon 7 hari, sekali per tanggal jatuh tempo, SKIP LOCKED, batas 200, peralatan retired dilewati) dipasang di relay worker; aturan notifikasi `equipment_service.reminded` (supervisor outlet, cadangan owner; tanpa aturan event dead-letter); `POST /api/operations/maintenance-schedules/:scheduleId/complete` (majukan `next_due_at`, idempoten, audit, `completedAt` masa depan dipotong ke sekarang).
- Bukti: API 9 file 113 tes lulus (sebelum klem; sesudahnya 2 file 17 tes lulus), root `operations-contract.test.mjs` 13 lulus, tsc shared dan api lewat heavy bersih (api diulang setelah klem), eslint dan prettier bersih, `db:generate` kedua kosong, tes guard RLS migrasi lulus. Review S: 1 reviewer, 1 catatan nyata (completedAt masa depan membungkam pengingat), dibetulkan.
- Biaya sesi dca0a2b2: total biaya* 1688k (utama 562k, subagent 1127k), 7 subagent (3 Explore, 2 implementer, 1 test-writer, 1 reviewer), puncak 3 bersamaan.

## WS-03 operasi meja: pindah, gabung, pindah item (legend-685n, cabang `ws/table-move-merge`)
- Dibangun: `POST /api/table-sessions/:id/move`, `/merge`, `/move-items` (`services/table-session-operations.service.ts`, route di `table-sessions.routes.ts`), event `table_session.moved|merged|items_moved` di katalog WS-03, audit tiap operasi. Tanpa migrasi.
- Aturan: total tagihan tetap; pembayaran (tautan bayar, deposit, tender POS) mengunci gabung dan pindah item; sesi open bill yang lunas tidak dipindah; ulang permintaan dijawab dari event tersimpan tanpa tulis ulang.
- Bukti: tanpa route 35 dari 38 tes gagal; dengan implementasi 84 dari 84 hijau di 5 file terkait; mutasi dua penjaga membuat 3 tes gagal. Review K (architect): 2 tinggi, 5 sedang, 3 rendah; 7 dibetulkan, sisanya dicatat sebagai risiko.
- Keputusan: meja sumber setelah gabung jadi `dirty` (bukan `occupied`) supaya pindai ulang QR tidak membuka tagihan kedua.

- 10 Nov 05:5x legend-9p0k selesai di ws/notification-outbox-events: notification.created/read dan notification_preference.updated masuk outbox cloud-sync satu transaksi dengan datanya, urutan agregat dari outbox (tanpa migrasi; 0192 tidak dipakai). 27 tes baru+lama lulus, tsc api bersih. 1 reviewer, 2 temuan dibetulkan (preferensi user outlet-terbatas, markAllRead massal).

## legend-bjy6 snapshot pajak checkout (engineer, cabang `ws/tax-snapshot-facility` dari d2080951, 2026-11-10)

- Temuan: `recordTaxSnapshots` sudah dipanggil di QR (`qr-order.service.ts:1548`, `:2038`) dan POS (`pos-order.service.ts:1225`). Checkout fasilitas belum ada di kode: `holdFacilitySlot` tanpa pemanggil, bayar tiket fasilitas ditunda ke `legend-bzih` (DEFERRED). Jadi tidak ada panggilan fasilitas yang ditambahkan; arsitek mengonfirmasi tidak ada jalur lain yang perlu mencatat `facility_ticket`.
- Dibangun: `qr-tax-snapshot.test.ts` (2 tes) dan `pos-tax-snapshot.test.ts` (4 tes): snapshot tertulis sekali per aturan, jumlah cocok dengan total order dan per aturan, tidak ada baris sebelum bayar, ulang bayar/`payment.paid` tidak mengubah baris. Tanpa perubahan kode sumber, tanpa migrasi.
- Bukti: mutasi (panggilan dimatikan) membuat tes gagal (POS 3 dari 4, QR tiap panggilan gagal di tesnya); 6 dari 6 hijau setelah perubahan terakhir; tsc api, eslint, prettier bersih. Review K (architect): 4 temuan nyata dibetulkan.
- Sisa: pemasangan di checkout fasilitas menunggu `legend-bzih`.

## legend-a30j unggah logo tenant (engineer, cabang `ws/brand-logo-upload` dari d2080951, 2026-11-10)

- Dibangun: purpose `brand_logo` (publik, 2 MiB), `outletId` opsional dengan refine (brand_logo tanpa outlet, purpose lain wajib outlet), izin `org.theme.manage` di skala tenant, resolver hanya memberi scope tenant bila body purpose tepat `brand_logo`. Migrasi `0201_brand_logo_storage` (nomor dipesan, idx 201, when 1794280000000): `outlet_id` nullable, CHECK `(outlet_id IS NULL) = (purpose = 'brand_logo')`, kebijakan RLS: baca baris tanpa outlet boleh untuk staf outlet, tulis hanya scope tenant, UPDATE/DELETE tetap ketat (`outlet_isolation_update`, `outlet_isolation_delete`).
- Review K (architect): HIGH (staf outlet bisa ubah/hapus/ambil alih baris logo lewat FOR ALL longgar) dan MEDIUM (CHECK terlalu longgar) dibetulkan + tes; LOW: `hris-sop.service.ts:320` dan `inventory-waste.service.ts:209` menerima id logo dari staf outlet (publik, dampak rendah, tidak diubah).
- Bukti: 27 tes baru (10 resolver, 17 DB/RLS/service/skema), mutasi policy/izin tertangkap; 14 file 183 tes hijau termasuk storage lama, rls, outlet-rls, hris-leave, payroll-reimbursements; `db:generate` kedua kosong; tsc api dan shared, eslint, prettier bersih.
- Sisa: belum ada rute/UI yang memanggil unggah brand_logo atau mengisi `brands.logo_media_id`; merge train merantai ulang 0201.
