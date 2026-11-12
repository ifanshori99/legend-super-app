# 552 — Triage kartu siap

Tanggal: 12 November 2026. Sumber: `docs/briefs/552-ready-cards.txt` (57 kartu).

## Acuan dan arti status

- Snapshot yang diperiksa: `origin/milestone/m1@ede015c99e3da8274d0f1bb0daddcf46eb87f55e` (commit 12 November 2026 06:24 WIB), serta ref lokal dan remote `ws/*` yang belum menjadi ancestor snapshot tersebut. Tidak menjalankan fetch; hasil merujuk ref yang tersedia lokal.
- Lima subagent read-only membagi daftar dengan indeks modulo 5 (12/12/11/11/11 kartu); puncak lima berjalan bersamaan. Induk menggabungkan hasil, memeriksa ulang ancestry seluruh commit berstatus selesai yang dicantumkan, serta membaca ulang kartu gi697, 8erc, dan bxdhv.
- Per kartu: `bd --readonly show <id>`, `git log --all --oneline --grep=<id>`, pemeriksaan kode via `git show <ref>:<path>`/`git grep <pola> <ref>`, dan `git merge-base --is-ancestor <commit> <snapshot>`. Pencarian juga memakai suffix tanpa `legend-` bila pesan commit tidak memakai prefix.
- **SELESAI** berarti cakupan implementasi kartu ditemukan dan cocok secara statis pada ref yang disebut. Bukan pengesahan test ulang, kelulusan release gate, atau bukti eksekusi database production. Contoh gi697 meminta query dan prosedur preflight: keduanya ada di cabang; eksekusi production tetap gerbang rilis.
- **BELUM** berarti hasil yang diminta belum ditemukan pada ref yang diperiksa, atau bukti gerbang operasional yang menjadi tujuan kartu belum tersedia. **SEBAGIAN** menyebut sisa spesifik; bukti kegagalan lama yang belum diuji ulang dinyatakan demikian.
- Tidak mengubah kode, bd, cabang, atau commit; tidak commit/push/merge dan tidak menjalankan heavy, test, build, layanan, atau akses staging/production. Satu-satunya berkas keluaran tugas ini adalah dokumen ini.

## Ringkasan

| Status | Jumlah |
| --- | ---: |
| SELESAI-di-m1 | 16 |
| SELESAI-di-cabang | 5 |
| SEBAGIAN | 18 |
| BELUM | 17 |
| BASI-tidak relevan | 1 |
| **Total** | **57** |

## Hasil per kartu

Path pendek pada catatan adalah nama file di ref yang disebut atau snapshot m1, bukan asumsi isi cabang checkout saat ini.

| Id | Status | Catatan 1 baris |
| --- | --- | --- |
| legend-w8dfz | BASI-tidak relevan | Founder Q10 mengganti outbound dengan WhatsApp masuk; anak implementasi ditutup, urusan produksi tersisa pada legend-axmob. |
| legend-fgg1h | BELUM | Belum ada bukti pemeriksaan hash migrasi 0239 di staging/production; perlu akses saat gerbang rilis. |
| legend-0kxb2 | SELESAI-di-m1 `f24fc754` | 0276–0278 sudah dinomori 0256–0258; timestamp journal sesudah 0249 dan rantai snapshot 0255→0258 tersambung. |
| legend-10nex | SELESAI-di-cabang `ws/edge-catalog-fresh` | `46cba3ea`, `e38a3fdc`: freshness, hold 24 jam, override Owner, trusted clock, alarm/notice ada; belum di m1. |
| legend-9f1p3 | SELESAI-di-m1 `e50526f7` | `facility-subscription-quota.ts:246` memakai subscriptionAccessPeriod(sub, now, graceDays); argumen wajib dan test kuota tenggang tersedia. |
| legend-0c5yg | SELESAI-di-m1 `a9a04b67` | Guard payroll tertutup di `hris-leave-request.service.ts:145,822,1211,1369` dan fungsi `0258_leave_clash_backfill.sql:101,158` sudah ada. |
| legend-bxdhv | SEBAGIAN — tiga regresi refund masih tercatat | Fix ada di ws/rat9r-followups; `docs/PROGRESS.md:9` cabang masih mencatat refund T3/T4 dan rereport RR-2 gagal; belum diuji ulang pada triage. |
| legend-lt0v4 | SELESAI-di-m1 `6b350e14`, `2fd45773` | `profit-share-membership.ts:75` memilih versi approved yang berlaku hari ini; guard transisi fiscal period dan test regresi tersedia. |
| legend-gi697 | SELESAI-di-cabang `ws/preflight-0301` | `85b70aad`: SQL preflight read-only 0301+prosedur deployment ada; eksekusi staging/production tetap gerbang rilis. |
| legend-f4uvg | SELESAI-di-m1 `315553fe`, `2245f6ba` | Endpoint/field Ubah atasan, guard hak/siklus, manifest dan employee scope tersedia; komentar kartu mencatat UI Q58 lolos. |
| legend-09sxa | SELESAI-di-cabang `ws/edge-promo-streams` | Commit `d47d35f9`: stream promo/voucher, migrasi 0333–0334, dan test sinkron/uang; belum di m1. |
| legend-svqew | SELESAI-di-cabang `ws/payroll-engine` | Rapel approved/idempotent ada di lokal `bfe6a5a4` / origin `eb3f7351`, belum di m1; jangan jadwalkan ulang payroll aktif. |
| legend-g5v69 | SELESAI-di-cabang `ws/payroll-engine` | `d3233cdd`: `payroll-components.service.ts:1093` memakai loadPinnedOvertimeFormulas; test formula berbeda tersedia, belum di m1. |
| legend-bod | SEBAGIAN — penyampaian staf/integrasi tersisa | `ws/bod-emergency-relay@f46b2cd4` punya ingest, incident, LAN hub/ack; kartu menyisakan kmjax cloud/web-push dan kpzmi banner staf. |
| legend-5f7 | SELESAI-di-m1 `a4dae5fb`, `bba0bc13`, `3aa1cb6b` | Refund/approval dan payment-failover+probe worker ada; DOIT sandbox adalah gerbang terpisah legend-4hf. |
| legend-m0k | SEBAGIAN — bukti EDC-05 offline-sync tersisa | Wiring `app.ts:115` dan `pos-order-payment.ts:399` ada; `0c959539` mengaktifkan EDC-01/02/04, EDC-05 masih `it.skip` di `az-e-cashier-shift.test.ts:1225`. |
| legend-ihf7 | BELUM | `.github/workflows/ci.yml:31` masih pnpm traceability tanpa --strict; prasyarat 125 kriteria belum dibuktikan. |
| legend-5rzy | SELESAI-di-m1 `6fee08e3`, `854075b4` | Route expo/runners tersedia; `expo.service.ts:159` memberi stationName dan `pickup.service.ts:242–281` promosi aman untuk display. |
| legend-gq0w | BELUM | `facility/endpoints.ts:117` masih credential sekali; getAccessTicket (:157) view tanpa credential, endpoint reissue belum ada. |
| legend-83ll | SELESAI-di-m1 `9992e1d3` | `identity-session.service.ts:360,382` menyatukan revoke+outbox dalam transaksi; destination identity terdaftar di transport worker. |
| legend-tj8o | SEBAGIAN — picker grant-rule dan proteksi End Owner | Editor masih memakai katalog umum; `assignments-page.tsx:311–317` menampilkan End hanya berdasar canAssign, tanpa proteksi Owner terakhir. |
| legend-hcqs | SEBAGIAN — approval rekonsiliasi dan credit tersisa | Refund/unallocated sudah membuka chain; `payment-admin-reconciliation.service.ts:197` resolve langsung update status, credit masih 503 (:296–301). |
| legend-d8ez | SELESAI-di-m1 `6343a727` | `edge-catalog-sync.ts:31` membaca tabel dengan cursor dan brand outlet terverifikasi; tidak lagi bergantung outlet anchor outbox. |
| legend-bf20 | SEBAGIAN — wiring PWA dan scanner reject tersisa | `ws/hris-misc@7661d2d5,14ec78a4` punya bind supervisor+multipart; `selfie.ts:102` masih SELFIE_UPLOAD_UNAVAILABLE, test scanner reject masih skip. |
| legend-5nv1 | SELESAI-di-m1 `a9a04b67` | Scope tersisa kartu (self logs/corrections/shifts) tersedia di service attendance/correction/roster; storage selfie juga terpasang. |
| legend-jlqi | BELUM | `payment-admin-reconciliation.service.ts:144–150` masih `SETTLEMENT_IMPORT_UNAVAILABLE`; `abb920e4` hanya auto-journal event settlement. |
| legend-r1ax | BELUM | `pos/schemas.ts:2058` belum punya feed promo/status/kode pairing display; enam digit baru ada pada input pairing. |
| legend-13q7 | BELUM | `e2e/mock-global-setup.ts:159` tetap menghangatkan semua WARM_ROUTES, belum memilih berdasarkan spec/shard. |
| legend-bpvf | SELESAI-di-m1 `ce080d9d` | `public-rate-limit.ts:24` memakai shared Redis bila REDIS_URL tersedia; shared-window-store menyediakan window dan fallback lokal. |
| legend-moe5 | SEBAGIAN — bukti konfigurasi/firewall production tersisa | Kode SSR visitor IP bersecret sudah m1 `ce080d9d`; `docs/deployment.md:231,235` mensyaratkan shared secret/proxy hops/firewall tanpa bukti operasional. |
| legend-zygi | SEBAGIAN — CRUD master HRIS tersisa | `hris.routes.ts:248,269` baru perubahan manager/PII; write employee, org-unit, position, contract, document belum terpasang. |
| legend-bj5m | SEBAGIAN — resolver customer produksi tersisa | Sweeper terjadwal `worker-main.ts:469`; resolver `facility.routes.ts:75` baru dipasang test, default produksi masih null. |
| legend-n039 | SELESAI-di-m1 `6d9d766e` | Blind index v2 memakai HKDF, kandidat lintas versi dan worker rebuild; metadata contractFileUrl menunjuk file_object_id. |
| legend-fy5y | SELESAI-di-m1 `9992e1d3`, `73048ee8` | platform-org.service append status/package ke outbox; invitation service, adapter notifikasi dan accept route tersedia. |
| legend-4961 | SEBAGIAN — petty cash outlet dan transfer antar akun tersisa | POS cash-movements ada; `accounting/banking.ts` baru account/import/reconciliation/deposit, endpoint/UI kas dan transfer khusus belum ada. |
| legend-ds1o | BELUM | `gateway-settlement-card.tsx:47–57` menghitung settlementRows dari jurnal/mutasi di browser; endpoint gross/fee/net/variance belum ada. |
| legend-bbp6 | SELESAI-di-m1 `9beb0763` | Platform dinomori 0050/0051; 0051 mempertahankan tiga enforce RLS+REVOKE consents, 0040–0042 main terjaga. |
| legend-tg0m | SELESAI-di-m1 `6618970d`, `5ec53979` | Guard support memanggil assertSupportAccess dan audit impersonator; HTTP test read-only menolak mutasi tersedia. |
| legend-je1f | SEBAGIAN — serverTime QR tersisa | Endpoint keputusan review ada `hris/endpoints.ts:619`; token `hris/attendance.ts:102` baru issuedAt/expiresAt tanpa serverTime. |
| legend-2mey | BELUM | Rute masuk.email/google/tautan masih returnPathSchema, belum safeReturnPath; `signed-in.tsx:37` masih Link runtime yang disebut kartu. |
| legend-uwsl | BELUM | `e2e/mock-global-setup.ts:29–80` baru `/karyawan`; slip gaji, kasbon, reimbursement, dan `/kelola/payroll/*` belum masuk WARM_ROUTES. |
| legend-0mn8 | BELUM | Kontrak baru create `/api/org/*`; create `/api/platform/tenants/:id/{brands,outlets,legal-entities}` belum ada. |
| legend-bag1 | BELUM | Audit lintas tenant masih kontrak lokal `ws01-platform-ops/contract-gap.ts:44`; shared audit/health belum ada, termasuk ws belum merged. |
| legend-at8c | SEBAGIAN — delete/import/brand-media tersisa | GET/PUT override+derived token ada; DELETE dan org import masih endpoint lokal web, brand media belum ada. |
| legend-0una | SEBAGIAN — integrasi receiving/petty upload dan signed-read tersisa | Storage generik ada; `receiving-form-page.tsx:188,342` dan `petty-page.tsx:117,171` masih membuat ID media lokal dari data URL. |
| legend-8erc | SEBAGIAN — cleanup workaround tersisa | Inti FormField→SelectTrigger selesai `ccf7a7fa`; `start-run-dialog.tsx:150,217` masih memakai workaround aria-label yang diminta dibersihkan. |
| legend-wf37 | BELUM | Checklist photo/signature dan breakdown ticket masih memakai preview/ID media lokal; upload produksi belum tersambung. |
| legend-s6o8 | BELUM | `platform/text-consent.ts:42` baru list/put; shared DELETE dan `/api/org/config/import` belum tersedia. |
| legend-saag | SEBAGIAN — serverTime daftar perangkat tersisa | `edge/endpoints.ts:229` punya reason+idempotencyKey dan cloud registry ada; list edge/outlet (:170,:189) belum serverTime. |
| legend-bw2q | BELUM | `area-frame.tsx:265` selalu memasang banner; `connectivity-banner.tsx:82–86` baru mengecualikan guest, belum platform. |
| legend-2gvt | BELUM | `supportAccessGrantSchema` belum punya nama Super Admin; cursor page `platform/endpoints.ts:286,498` belum punya serverNow. |
| legend-vz93 | SELESAI-di-m1 `ce080d9d` | public-cache.server.ts, middleware start.ts dan test public-html-cache menyediakan cache HTML publik dengan batas cookie/tenant. |
| legend-uyk2 | SEBAGIAN — pemanggil source dan aging contract tersisa | Helper AP/AR tersedia tetapi source purchasing/AR belum memanggilnya; ws06/ws07 juga belum memasang pemanggil. |
| legend-nz13 | BELUM | Tolerance baru argumen `inventory/purchasing/schemas.ts:1174`/fixture 200 bp; endpoint setting belum ada termasuk ws/ws06-purchasing. |
| legend-do1o | BELUM | `operations-food-safety/logic.ts:240–265` masih memakai batch expiry; kontrak operations belum punya shelf-life per prep item. |
| legend-ga0n | SEBAGIAN — antrean offline/replay klien tersisa | Server checklist idempotent tersedia; `checklist-item-card.tsx:54–55` masih memblokir jawaban offline karena kontrak antrean belum ada. |
| legend-7j4e | SEBAGIAN — close persisten tersisa | Guard konfirmasi ada; status baru submitted/acknowledged dan endpoint create/acknowledge, belum ada close. |

## Tiga paket kerja usulan

Paket di bawah hanya memakai kartu BELUM/SEBAGIAN (11 kartu unik). Tingkat paket mengikuti risiko tertinggi. Batas file antarpaket dipisahkan; tidak ada kartu selesai yang dijadwalkan ulang. Ini usulan pembagian kerja, bukan pekerjaan implementasi yang sudah dimulai.

| Paket | Kartu | Area dan tingkat | File utama dan batas kepemilikan |
| --- | --- | --- | --- |
| A — Infra pengujian terarah (3 kartu) | `legend-13q7`, `legend-uwsl`, `legend-ihf7` | Pemanasan route per spec/shard, kelengkapan warm route, traceability CI — **S** | `e2e/mock-global-setup.ts`, `playwright.mock.config.ts`, `.github/workflows/ci.yml`, `scripts/ci/traceability.mjs`, pemetaan acceptance terkait; tidak mengubah modul aplikasi. |
| B — Operasi harian dan replay offline (5 kartu) | `legend-ga0n`, `legend-do1o`, `legend-7j4e`, `legend-wf37`, `legend-8erc` | Checklist offline, shelf-life prep, close handover, upload foto/tanda tangan, cleanup label Select — **K** (sinkron offline, akses media/foto/tanda tangan) | `packages/shared/src/operations/{schemas,endpoints,machines}.ts`; `apps/api/src/services/operations-{checklist.service,equipment.service,prep-production}.ts`; `apps/api/src/routes/operations-equipment.routes.ts`; `apps/web/src/features/operations-checklist/`, `operations-equipment/`, `operations-food-safety/logic.ts`, `facility-admin/api.ts` (ketiga path terakhir di bawah features). |
| C — Kontrak dan transport HRIS (3 kartu) | `legend-zygi`, `legend-bf20`, `legend-je1f` | Write master HRIS, unggah selfie/binding supervisor, serverTime QR — **K** (akses, data pribadi) | `packages/shared/src/hris/{endpoints,attendance}.ts`; `apps/api/src/routes/hris.routes.ts`; `apps/api/src/services/hris-{employee,org,contract}.service.ts`; test HRIS terkait; `apps/web/src/features/ws10-hris-employee/selfie.ts` untuk memakai transport yang ada. |

Batas pelaksanaan agar paket tidak mengulang atau bertabrakan:

- **A:** `ihf7` baru mengaktifkan strict setelah cakupan 125 kriteria benar-benar lengkap. Bila belum lengkap, hasil pertama adalah daftar gap, bukan mengaktifkan gate yang diketahui gagal. `uwsl` hanya menambah daftar warm route test, tidak mengubah mesin payroll atau UI payroll.
- **B:** Lanjutkan/integrasikan pemilik `ws/checklist-engine` karena cabang belum merged sudah mengubah `operations-checklist.service.ts`; jangan mulai salinan pekerjaan di file yang sama. Offline replay harus mempertahankan idempotensi dan scope outlet. `8erc` hanya membersihkan workaround di `operations-checklist/components/start-run-dialog.tsx`, bukan mengulang perbaikan komponen UI inti. Upload memakai kontrak storage generik yang sudah ada, tanpa mengubah core storage bersama paket C.
- **C:** Lanjutkan pemilik `ws/hris-misc` untuk `bf20` agar bind/transport yang sudah ada tidak ditulis ulang. Batasi ke master HRIS/attendance dan transport employee; tidak menyentuh `payroll-*`, service cuti/payroll, layar/rute `hris-requests`, atau UI 539 lainnya. Bila scanner reject memerlukan perubahan core storage, tetapkan `apps/api/src/routes/core-storage.routes.ts` dan `apps/api/src/services/core-storage-access.ts` hanya kepada C; paket B tetap konsumen API.
- **Antarpaket:** A memiliki konfigurasi/suite e2e global; B dan C memakai test domain masing-masing. Perubahan registry global atau nomor migrasi perlu satu integrator dan rentang terpisah saat brief implementasi dibuat; jangan memberi file tersebut kepada dua paket sekaligus. Kebutuhan menulis file di luar batas harus diselesaikan pembagian kepemilikannya sebelum implementasi.

## Tidak masuk paket baru

- **Payroll aktif:** `svqew` dan `g5v69` sudah di `ws/payroll-engine`; `0c5yg` sudah di m1. Tidak perlu dibuka sebagai implementasi baru.
- **Pajak/akuntansi aktif:** `4961`, `ds1o`, `jlqi`, dan `uyk2` tetap memiliki sisa, tetapi tidak dijadwalkan paralel dengan `ws/ws07-tax-reports`; integrasi purchasing juga bersinggungan `ws/ws06-purchasing`.
- **UI 539:** `tj8o`, `r1ax`, `bw2q`, serta perubahan UI untuk `0mn8`, `bag1`, `at8c`, `s6o8`, `2gvt` tidak masuk paket baru. Area `pos-cashier-captain`, `pos-extra`, `ai-mcp`, `backoffice-platform`, dan `hris-requests` tetap di luar scope paket.
- **Pemilik aktif lain:** `0una` dan `nz13` mengikuti `ws/ws06-purchasing`; `10nex` dan `09sxa` sudah di cabang edge; `saag` menyentuh kontrak edge yang sedang berubah. `bod` mengikuti cabang relay yang ada. `bj5m` perlu koordinasi pemetaan customer dengan CRM.
- **Uang dan release gate:** `bxdhv` harus ditangani pemilik `ws/rat9r-followups` dengan bukti regresi baru; catatan tiga gagal adalah bukti historis, bukan hasil run triage ini. `hcqs` masih perlu approval rekonsiliasi/credit, tetapi refund unallocated sudah punya chain. `fgg1h`, eksekusi preflight `gi697`, dan konfigurasi/firewall production `moe5` tetap membutuhkan bukti gerbang rilis.
- **Credential fasilitas:** `gq0w` tetap BELUM; jangan menjadwalkan kontrak reissue sampai aturan penerbitan ulang QR/PIN dan otorisasinya ditetapkan dalam brief tingkat K.

## Batas verifikasi

Status di atas adalah triage statis untuk memperbaiki keputusan penjadwalan. Tidak ada klaim test/build lulus, migrasi aman di database nyata, secret/firewall terpasang, atau izin menutup kartu. CTO dapat memakai bukti commit/ref dan sisa tiap kartu untuk memperbarui bd melalui proses timnya.

