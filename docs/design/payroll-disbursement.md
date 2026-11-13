# Desain: pembayaran gaji lewat disbursement (Duitku) dan transfer manual per bank

Status: usulan architect, 13 Nov 2026, sudah direview satu kali (reviewer konteks segar; temuan sudah dimasukkan). Tingkat K (uang, akses, integrasi pihak ketiga, data pribadi).
Epic bd: `legend-wnkep`. Terkait: `legend-z94o` (disbursement otomatis, Pascarilis PRD v1.7 §3 F30), `legend-1gtfm` (layout file bank), `legend-34qx` (registry format ekspor), `legend-89cl7` (snapshot rekening saat kunci run).
Keputusan founder yang menjadi dasar: Q3 13 Nov 2026 (gaji lewat Duitku/DOIT otomatis atau transfer manual per bank, dipilih per tenant), Q10 13 Nov 2026 (metode bawaan transfer bila ada rekening, selain itu tunai), aturan "jangan sampai rugi" 11 Nov 2026.

## 1. Ringkasan

1. **Duitku bisa dipakai.** Duitku punya API disbursement terdokumentasi: cek nama rekening (inquiry), transfer, cek status, cek saldo. Uangnya diambil dari saldo deposit Duitku milik PT, jadi PT harus mengisi saldo dulu.
2. **DOIT tidak bisa dipakai untuk gaji, saat ini.** Dokumen publik DOIT tidak punya fitur kirim uang ke rekening pihak ketiga. DOIT menulis: "payouts never will be, because we never hold funds". Desain menyisakan slot `doit` di antarmuka adapter, tetapi tidak ada pekerjaan sampai DOIT mengonfirmasi tertulis (kartu `legend-wnkep.8`).
3. **Transfer manual tetap jalur utama awal.** Registry format ekspor bank sudah ada di cabang `ws/payroll-followups` (baru `generic_csv`; layout BCA/Mandiri/BNI/BJB menunggu `legend-1gtfm`). Desain ini membungkusnya dengan batch yang sama: disetujui dua orang, file diunduh sekali, lalu hasil per karyawan dikonfirmasi orang lain.
4. **Satu mesin status untuk semua jalur.** Tiap slip gaji punya paling banyak satu percobaan bayar yang hidup. Status yang tidak pasti (timeout, kode 68) tidak pernah dikirim ulang otomatis. Run yang sedang dibayar tidak bisa dibalik.
5. **Jurnal per kelompok setoran, bukan per karyawan.** Jurnal mencatat total yang berhasil per kelompok, supaya gaji per orang tidak terbaca di buku besar, dan tiap slip hanya masuk satu jurnal.

## 2. Riset penyedia

Sumber: Context7 `/websites/duitku` (bagian disbursement), https://docs.duitku.com/disbursement/en/, https://www.duitku.com/en/pricing/, https://doit.id/docs/en/, https://doit.id/en/platform/, https://doit.id/en/. Dibaca 13 Nov 2026. Sebagian halaman Duitku hanya terbaca sebagai ringkasan (tabel kode, testing, daftar bank); butir itu ditandai **BELUM PASTI** dan wajib dicek di sandbox.

### 2.1 Duitku Disbursement

| Hal | Isi | Kepastian |
|---|---|---|
| Produk | Transfer Online (inquiry, transfer), Clearing (LLG, RTGS, H2H, BIFAST), Cash Out (Indomaret, Pos), inquiryStatus, checkBalance, listBank | Pasti |
| Host | Sandbox `https://sandbox.duitku.com/webapi/api/disbursement/...`, produksi `https://passport.duitku.com/webapi/api/disbursement/...` | Pasti |
| Endpoint Transfer Online | Sandbox `inquirysandbox`, `transfersandbox`; produksi `inquiry`, `transfer`; keduanya `inquirystatus`, `checkbalance`, `listBank` | Pasti |
| Kredensial | `userId` (int), `email`, `secretKey`. **Berbeda** dari `merchantCode` + API key pembayaran yang dipakai `apps/api/src/services/payment-duitku.ts` | Pasti |
| Tanda tangan | SHA256 hex dari gabungan string polos (bukan HMAC). `timestamp` Unix milidetik, kedaluwarsa 5 menit (`-960`) | Rumus pasti; kedaluwarsa dari ringkasan |
| Rumus inquiry | `email + timestamp + bankCode + bankAccount + amountTransfer + purpose + secretKey` | Pasti |
| Rumus transfer | `email + timestamp + bankCode + bankAccount + accountName + custRefNumber + amountTransfer + purpose + disburseId + secretKey` | Pasti |
| Rumus inquiryStatus | `email + timestamp + disburseId + secretKey` | Pasti (Context7) |
| Rumus checkBalance | `email + timestamp + secretKey` | BELUM PASTI |
| Rumus callback clearing | `email + bankCode + bankAccount + accountName + custRefNumber + amountTransfer + disburseId + secretKey` | Pasti |
| Respons inquiry | `accountName`, `custRefNumber`, `disburseId`, `responseCode`, `responseDesc` (+ gema field request) | Pasti |
| Respons transfer | Tanpa `disburseId`; `responseCode`, `responseDesc`, `accountName`, `custRefNumber` | Pasti |
| Respons checkBalance | `balance` (sebelum settlement), `effectiveBalance` (bisa dipakai kirim) | BELUM PASTI |
| Callback | Hanya untuk Clearing tipe H2H. POST JSON, balas `SUCCESS`, selain HTTP 200 dikirim ulang maks 5 kali. Kode callback `00` berhasil, `01` gagal, `68` tunggu T+1. Transfer Online tidak disebut punya callback: hasilnya langsung di respons transfer | Callback H2H pasti; "Online tanpa callback" BELUM PASTI |
| IP | Callback datang dari IP Duitku tertentu. Panggilan kita ditolak `-930` bila IP server kita tidak di-whitelist Duitku, jadi server produksi butuh IP keluar tetap | Daftar IP pasti; `-930` dari ringkasan |
| Batas | Transfer Online Rp50–100 juta per transaksi tergantung bank tujuan. LLG maks Rp1 miliar, RTGS min Rp100 juta, jam BI 08:00–15:00 hari kerja. Batas harian tidak disebut | Per transaksi pasti; harian BELUM PASTI |
| Biaya (termasuk PPN) | BI-Fast Rp2.500, Online Transfer Rp5.000, SKN/LLG Rp5.000, RTGS Rp35.000 per transaksi. Volume > Rp500 juta/bulan bisa nego | Pasti (halaman harga); pemetaan "Online Transfer" = API Transfer Online adalah dugaan |
| Apakah biaya memotong saldo deposit | Tidak disebut | BELUM PASTI; desain menganggap ya |
| Waktu proses | Transfer Online langsung (sinkron) kecuali kode `68`/`TO`; clearing ikut jadwal BI | Sebagian |
| Kode bank | Sandi bank BI 3 digit: BCA `014` (pasti), Mandiri `008`, BNI `009`, BRI `002`, BJB `110` | Selain BCA BELUM PASTI; ambil dari `listBank` |
| Idempotensi | Tidak ada kunci idempotensi resmi. `disburseId` dibuat oleh inquiry; kode `-142` "Transaction already finished" mengisyaratkan `disburseId` yang sama tidak diproses dua kali | BELUM PASTI; desain tidak bergantung padanya |
| `custRefNumber` | Dok tidak konsisten: "9 digit" di respons, contoh 12 karakter, string(255) di request transfer | BELUM PASTI |
| Larangan ulang | Respons transfer `TO`, `68`, `-100`: jangan ulangi, hubungi Duitku. Inquiry gagal boleh diulang sekali | Pasti |
| Polling status | Dok melarang permintaan status otomatis berulang; melewati batas diblokir sekitar 1 jam | Batas angka BELUM PASTI |
| Reversal/dana kembali | Tidak didokumentasikan | BELUM PASTI; desain menyediakan status `returned` yang dicatat manual |
| Sandbox | Kredensial sandbox diminta lewat email ke Duitku (contoh publik dihapus di v1.2). Rekening uji transfer: `8760673566` berhasil; `8760673561` TO; `8760673562` -510; `8760673564` 68; `8760673565` -100 | Dari ringkasan, BELUM PASTI |

Kode status Duitku (ringkasan, cek ulang di sandbox): `00` berhasil, `EE` error umum, `TO` timeout jaringan, `LD` gangguan link, `NF` tidak tercatat, `76` rekening tujuan salah, `80` tunggu callback (H2H), `-100` error lain, `-120` user tidak ada, `-123` user diblokir, `-141` nominal salah, `-142` transaksi sudah selesai, `-148` bank tidak dukung H2H, `-149` bank tidak ada, `-161` callback URL tidak ada, `-191` tanda tangan salah, `-192` rekening diblacklist, `-213` email salah, `-420` transfer tidak ditemukan, `-510` saldo kurang, `-920` batas terlampaui, `-930` IP belum whitelist, `-951` timeout vendor, `-952` parameter salah, `-960` timestamp kedaluwarsa.

### 2.2 DOIT

Jawaban: **tidak ada API disbursement ke rekening pihak ketiga** di dokumen publik.

- doit.id adalah gerbang penerimaan pembayaran. Kutipan: "payouts never will be, because we never hold funds" (https://doit.id/docs/en/, bagian Xendit compat).
- Satu-satunya uang keluar adalah settlement ke rekening merchant atau sub-merchant sendiri. Rekening tujuan dikunci saat onboarding (`POST /v1/submerchants/{id}/bank`, panggilan kedua `409 bank_locked`), nama harus sama dengan pemilik usaha.
- Status settlement `pending | processing | sent | failed` lewat `GET /v1/submerchants/{id}/settlements`. Biaya Rp10.000 per transfer settlement.
- Mendaftarkan karyawan sebagai sub-merchant untuk menggaji mereka tidak sesuai model DOIT (sub-merchant harus usaha yang menerima pembayaran, KYC per pemilik). Tidak dipakai.
- Ada pertentangan di halaman DOIT ("hold funds and pay out yourself from the portal" vs "never hold funds"). Perlu konfirmasi tertulis dari DOIT sebelum ada pekerjaan.

Kode yang ada (`apps/api/src/services/payment-doit.ts`) memakai `Authorization: Bearer` dan header `Idempotency-Key`; pola itu bisa dipakai bila DOIT kelak membuka payout.

## 3. Kondisi kode sekarang

| Area | Lokasi | Catatan |
|---|---|---|
| Status run | `apps/api/src/db/schema/payroll.ts:137-145`, `drizzle/0167_payroll_core.sql:160` | `draft, simulated, hr_approved, approved, locked, paid, reversed` |
| Run unik per periode | `payroll.ts:472-475` | Run `reversed` tidak dihitung, jadi run baru periode sama bisa dibuat setelah dibalik |
| Status `paid` | `payroll.ts:512-513` | `paid` wajib `paid_at` + `paid_by` (alur "tandai dibayar" lama per run) |
| Pembalikan run | `payroll.ts:515-` (PAYR-05) | Hanya lewat pembalikan yang disetujui |
| Persetujuan run | `payroll.ts:433-436`; trigger `drizzle/0300_*`, `0304_payroll_run_approver_write_guard.sql` | `approvedByHr` + `approvedByFinance`, penyetuju bukan pembuat (ditegakkan trigger) |
| CHECK dua orang | `apps/api/src/db/schema/accounting-journal-requests.ts:235`, `accounting-profit-share.ts:544` | `approvedBy <> requestedBy`; pola untuk batch |
| Slip | `payroll.ts:523` | `payment_method` `bank_transfer`/`cash` (Q10); net pay ada di dalam `calculation_encrypted` (tersegel, HR-03) |
| Rekening karyawan | `apps/api/src/db/schema/hris.ts:207` | `bank_account_encrypted` + `bank_account_hmac`, satu blob tersegel; **tidak ada kolom kode bank** |
| Snapshot rekening saat kunci | `ws/payroll-followups:apps/api/src/db/schema/payroll.ts:631` (`payslip_bank_snapshots`) | Belum di `milestone/m1`; tidak berubah setelah ditulis; isi: nomor, nama pemilik, nama bank (tanpa kode bank, tanpa HMAC) |
| Registry format ekspor | `ws/payroll-followups:apps/api/src/lib/payroll-export/bank-formats.ts:81` | `generic_csv` jalan; BCA/Mandiri/BNI/BJB `422 PAYROLL_BANK_FORMAT_NOT_SUPPORTED` |
| File transfer bank | `payroll.ts` `bank_transfer_files` | `total_idr`, `row_count`, `checksum_sha256` |
| Rekening PT | `drizzle/0191_*` `bank_accounts` | Per `legal_entity_id`, nomor tersegel + `last4` |
| Jurnal payroll | `apps/api/src/services/payroll-gl-consumer.ts:10-31`, `:298-322` | `payroll.paid`: Dr salaries_payable net, Cr bank/petty_cash per run, kunci `payrollGlKeys.paid(runId)`; dilewati bila jurnal kunci run tidak ada |
| Kredensial per tenant | `apps/api/src/services/platform-integration.service.ts:5` | Baris integrasi tersegel AES-256-GCM, `loadIntegrationCredentialsById` |
| Webhook + dedupe | `routes/payment-webhook.routes.ts:88`, `db/schema/payment-gateway-webhook.ts:76` | Unik (tenant, provider, event_id) bila tanda tangan sah; penahan retry di `ghostex/webhook-retry-guard-dan-flake-edge` |
| Adapter Duitku pembayaran | `services/payment-duitku.ts`, `payment-duitku-wire.ts` | `fetch` disuntik, timeout 15 dtk, tanpa retry, saklar sandbox/produksi `config.environment` |
| Saklar mati | `.env.example:183` `DOIT_REFUNDS_ENABLED` | Pola untuk saklar disbursement |
| Izin | `packages/shared/src/access/permissions.ts:234-238` | `payroll.view, run, approve, lock, cancel.approve`; belum ada izin bayar |
| Audit, outbox, retry | `db/schema/core-audit.ts`, `services/core-outbox.ts`, `services/delivery-platform-retry.ts` | Dipakai ulang |
| MFA sesi | `apps/api/src/middleware/identity.ts:89` `requireSessionMfa()` | Khusus platform: hanya sesi login password, kebijakan sesi manajemen. Belum ada versi tenant |

## 4. Model data

Migrasi usulan **0530–0534**. `milestone/m1` berhenti di 0320; cabang lokal tertinggi 0491 (`ws/purchasing-*`, `ghostex/388d5f96`). Jarak dibiarkan untuk cabang yang sedang berjalan; merge train menomori ulang bila bentrok.

Semua tabel memakai `tenant_id` + kunci gabungan `(tenant_id, id)` seperti tabel payroll lain, `timestamptz`, dan rupiah bulat `bigint`. Nominal yang bisa menunjukkan gaji satu orang selalu tersegel dengan kunci PII payroll (`lib/payroll-sealed.ts`), dan semua kolom tersegel baru didaftarkan ke job segel ulang (pola 0248).

### 4.1 `payroll_payout_configs` (0530)

Satu baris per `(tenant_id, legal_entity_id)`.

| Kolom | Isi |
|---|---|
| `method` | `duitku` \| `doit` \| `manual_bank`. CHECK. `doit` ditolak service sampai ada adapter |
| `integration_id` | FK ke baris integrasi tersegel (kredensial Duitku disbursement). Wajib bila `method = duitku`, null untuk `manual_bank` (CHECK) |
| `manual_source_bank_account_id` | FK `(tenant_id, legal_entity_id, id)` ke `bank_accounts`. Selalu wajib: rekening yang didebit untuk jalur manual, termasuk slip yang jatuh ke manual dari PT berjalur Duitku. Akun kredit jurnal manual mengikuti pemetaan rekening ini |
| `manual_bank_format` | `generic_csv` \| `bca` \| `mandiri` \| `bni` \| `bjb` (sama dengan `BANK_FORMATS`) |
| `max_per_transfer_idr` | Bawaan 50.000.000 (batas Duitku terendah). CHECK `> 0 AND <= 100000000`. Slip di atas batas otomatis ke jalur manual |
| `daily_cap_idr` | Null = tanpa batas tambahan. Bila diisi, kirim berhenti sebelum melewati batas hari itu |
| `fee_per_transfer_idr` | Bawaan 5.000 (Online Transfer). Dipakai cek saldo dan jurnal biaya |
| `enabled` | Bool |
| `updated_by`, `updated_at` | Diaudit |

Deposit Duitku memakai pemetaan akun `payout_deposit` per PT (§8), bukan rekening bank.

Aturan: ubah `method`, `integration_id`, `manual_source_bank_account_id`, atau `enabled` ditolak `409 PAYOUT_CONFIG_BUSY` selama ada batch PT itu berstatus `pending_approval`, `approved`, `sending`, `exported`, atau `halted`.

### 4.2 `payroll_disbursement_batches` (0531)

| Kolom | Isi |
|---|---|
| `legal_entity_id`, `payroll_run_id` | Run harus `locked` saat batch pertama dibuat; batch susulan untuk slip `returned`/`failed` boleh saat run `paid` (§7.8) |
| `channel` | `duitku` \| `doit` \| `manual_bank` \| `cash` |
| `status` | `draft`, `pending_approval`, `approved`, `sending`, `exported`, `completed`, `partially_failed`, `halted`, `cancelled` (CHECK) |
| `halt_reason` | `insufficient_balance`, `daily_cap`, `provider_down`, `kill_switch`, `config_disabled`; null bila tidak `halted` |
| `requested_by`, `requested_at` | Pembuat |
| `approved_by`, `approved_at` | CHECK `approved_by IS NULL OR approved_by <> requested_by` (pola `accounting-journal-requests.ts:235`) |
| `approval_expires_at` | `approved_at + 24 jam`. Lewat batas: kirim dan ekspor ditolak, minta setujui ulang |
| `content_hash` | SHA-256 hex dari daftar item terurut (`payslip_id`, nominal, `account_hmac` dan `bank_code` dari snapshot, nama hasil inquiry). Disimpan saat diajukan; persetujuan menyimpan hash yang dilihat penyetuju; kirim dan ekspor menghitung ulang dan menolak bila beda |
| `item_count` | Terbuka |
| `totals_encrypted` | Tersegel: total, total biaya, saldo sebelum dan sesudah (Duitku). Tersegel karena batch satu orang membuka gaji orang itu |
| `export_checksum_sha256`, `exported_by`, `exported_at` | Jalur manual, diisi sekali |
| `worker_lease_until`, `worker_id` | Satu pekerja per batch |

Indeks unik parsial: satu batch terbuka per `(tenant_id, payroll_run_id, channel)` selama status bukan `completed`, `partially_failed`, atau `cancelled`.

### 4.3 `payroll_disbursement_items` (0531)

| Kolom | Isi |
|---|---|
| `batch_id`, `payroll_run_id`, `payslip_id`, `employee_id` | FK gabungan dengan `tenant_id` |
| `channel` | Sama dengan batch (untuk CHECK per kanal) |
| `attempt_no` | 1, 2, ... per slip |
| `idempotency_key` | `payslip:<payslipId>:attempt:<n>`, UNIQUE per tenant |
| `amount_encrypted`, `pii_key_version` | Net pay tersegel |
| `bank_snapshot_id` | FK ke `payslip_bank_snapshots`; nomor rekening tidak disalin |
| `bank_code` | Sandi bank BI 3 digit (tidak rahasia), disalin dari snapshot |
| `inquiry_account_name_encrypted` | Nama hasil inquiry, tersegel |
| `name_match` | `exact` \| `mismatch` \| null |
| `status` | lihat §5.2 (CHECK) |
| `excluded_reason` | `inquiry_failed`, `name_mismatch`, `bank_code_missing`, `over_cap`, null |
| `provider_ref` | `disburseId` Duitku; jalur manual: referensi bank |
| `cust_ref_number` | Dibuat kita, 9 digit unik per tenant |
| `last_response_code` | Kode penyedia terakhir. Teks respons mentah tidak disimpan di kolom; teks yang ditampilkan berasal dari tabel kode kita |
| `failure_class` | `definitive` \| `unknown_resolved` \| null |
| `fee_idr_encrypted` | Biaya sebenarnya, tersegel |
| `sent_at`, `settled_at`, `returned_at` | Waktu |
| `confirmed_by`, `confirmation_ref`, `confirmation_evidence_key` | Konfirmasi manual/tunai: orang bukan pembuat, referensi bank, berkas bukti |
| `resolved_by`, `resolved_by_2`, `resolution_note`, `resolution_evidence_key` | Penyelesaian status tidak pasti. CHECK `resolved_by_2 IS NULL OR resolved_by_2 <> resolved_by` |
| `gl_posting_id` | FK ke §4.6; diisi sekali |

Kendala inti (kunci "tepat sekali"):

- **Indeks unik parsial `payroll_disbursement_items_one_live_per_payslip`** pada `(tenant_id, payslip_id)` `WHERE status IN ('prepared','blocked','approved','sending','exported','unknown','succeeded')`. Akibatnya: tidak bisa ada dua percobaan hidup untuk satu slip, dan tidak bisa membuat percobaan baru setelah berhasil. Percobaan baru hanya mungkin setelah status `failed`, `not_sent`, `cancelled`, atau `returned`.
- CHECK `succeeded`: wajib `settled_at`; kanal `duitku`/`doit` wajib `provider_ref`; kanal `manual_bank` wajib `confirmed_by` + `confirmation_ref`; kanal `cash` wajib `confirmed_by`.
- CHECK `resolved_by`/`resolved_by_2` keduanya terisi bila `failure_class = 'unknown_resolved'` atau bila `unknown` diputus manual ke `succeeded`.
- Trigger penjaga tulis (pola trigger `0300`/`0304`): setelah `approved`, kolom `amount_encrypted`, `bank_snapshot_id`, `bank_code`, `batch_id`, `channel` tidak bisa diubah; perpindahan status di luar §5.2 ditolak di DB.

### 4.4 `payroll_payout_provider_events` (0532)

Log semua respons dan callback penyedia: `provider`, `kind` (`inquiry`, `transfer`, `status_check`, `balance`, `callback`), `item_id` (null untuk saldo), `provider_ref`, `response_code`, `signature_valid`, `payload_redacted` (jsonb: nomor rekening jadi last4, nama dan nominal dibuang, deret angka 6 digit atau lebih di teks bebas disamarkan), `received_at`.
Indeks unik parsial `(tenant_id, provider, provider_ref, response_code)` `WHERE kind = 'callback' AND signature_valid` untuk dedupe callback (pola `gateway_webhook_events`). Tabel terpisah dari webhook pembayaran karena akses dan masa simpan berbeda.

### 4.5 Data rekening karyawan dan snapshot (0533)

- `employees.bank_code` (sandi BI 3 digit, boleh null untuk data lama).
- `payslip_bank_snapshots` ditambah `bank_code` dan `account_hmac` (HMAC nomor rekening dengan kunci yang sama dengan `employees.bank_account_hmac`), dan JSON tersegelnya ditambah `legal_name` (nama resmi karyawan saat run dikunci). Semua diisi saat kunci run; snapshot tetap tidak bisa diubah.
- Slip tanpa `bank_code` tidak masuk batch Duitku (`excluded_reason = bank_code_missing`) dan jatuh ke manual `generic_csv`.

### 4.6 `payroll_payout_gl_postings` (0534)

Satu baris per jurnal kelompok: `batch_id`, `kind` (`settle`, `settle_skipped`, `return`, `overpaid`), `item_set_hash`, `journal_key`, `total_encrypted`, `posted_at`. UNIQUE `(tenant_id, journal_key)`. Item ditautkan lewat `items.gl_posting_id`. Bila tabel pemetaan akun punya CHECK kunci, 0534 juga menambah kunci `payout_deposit` dan `bank_charges`.

## 5. Mesin status

### 5.1 Batch

```
draft -> pending_approval -> approved -> sending  -> completed | partially_failed
                                     \-> exported -> completed | partially_failed
                     sending -> halted -> (setujui ulang oleh orang kedua) -> sending
                     halted  -> cancelled (sisa item approved -> not_sent)
draft | pending_approval | approved -> cancelled
```

- `completed`: semua item yang tidak `cancelled` berstatus `succeeded`.
- `partially_failed`: semua item final, sebagian `failed` atau `not_sent`.
- Item `unknown` atau `exported` menahan batch di `sending`/`exported` sampai diputus.
- `halted` lebih dari 7 hari muncul sebagai peringatan; tidak ada pembatalan otomatis.

### 5.2 Item

```
prepared --(inquiry gagal / nama beda / kode bank kosong)--> blocked
prepared | blocked --(batch diajukan: item blocked dikeluarkan)--> cancelled
prepared --(batch disetujui)--> approved
approved --(Duitku: CAS + commit SEBELUM HTTP)--> sending
approved --(manual: unduhan file satu-satunya)--> exported
approved --(tunai: konfirmasi serah terima oleh orang bukan pembuat)--> succeeded
approved --(batch halted lalu dibatalkan)--> not_sent
sending  --(00)--> succeeded
sending  --(kode gagal pasti)--> failed
sending  --(timeout, 68, TO, -100, kode tak dikenal, proses mati)--> unknown
exported --(konfirmasi orang bukan pembuat + referensi bank + bukti)--> succeeded | failed
unknown  --(inquiryStatus 00 / callback 00)--> succeeded
unknown  --(dua orang berbeda + bukti Duitku, paling cepat T+1 hari kerja)--> succeeded | failed
failed   --(00 terlambat dari penyedia, slip belum punya percobaan hidup)--> succeeded  [insiden PAYOUT_LATE_SUCCESS]
failed   --(00 terlambat, slip sudah dibayar percobaan lain)--> overpaid           [insiden PAYOUT_DOUBLE_PAID]
succeeded --(dana kembali, dua orang + bukti)--> returned
```

- Setiap perpindahan memakai update bersyarat (`UPDATE ... WHERE id = $1 AND status = $expected`) dalam transaksi pendek. Nol baris terubah berarti ada pekerja lain: berhenti.
- Item `blocked` dikeluarkan saat batch diajukan, jadi tidak pernah menahan batch dan tidak menahan slot slip; slipnya ditampilkan ke penyetuju sebagai "dikeluarkan, bayar lewat manual/tunai".
- `overpaid` di luar himpunan "hidup", jadi tidak melanggar indeks unik. Ia memicu jurnal piutang karyawan (§8) dan notifikasi ke penyetuju; penagihan kembali lewat proses piutang karyawan yang ada.

### 5.3 Klasifikasi kode respons transfer Duitku

| Kelas | Kode | Tindakan |
|---|---|---|
| Berhasil | `00` | `succeeded` |
| Gagal pasti | `76`, `-120`, `-123`, `-141`, `-149`, `-191`, `-192`, `-213`, `-920`, `-930`, `-952`, `-960` | `failed`, `failure_class = definitive` |
| Saldo kurang | `-510` | Item `failed`; batch `halted` (`insufficient_balance`); sisa item tetap `approved` sampai dilanjutkan atau dibatalkan |
| Sudah diproses | `-142` | `unknown`, langsung satu kali inquiryStatus |
| Tidak pasti | `TO`, `68`, `-100`, `LD`, `NF`, `EE`, `-951`, `80`, HTTP timeout, HTTP 5xx, respons bukan JSON, kode lain apa pun | `unknown`; tidak pernah dikirim ulang otomatis |

Daftar ini dicek ulang di sandbox sebelum produksi (`legend-wnkep.3`). Kode di luar tabel selalu jatuh ke `unknown`: aturan yang membatasi pembayaran.

## 6. Aturan uang

Tiap aturan punya penegak dan test yang wajib ada sebelum kode backend (kartu `legend-wnkep.1`).

| # | Aturan | Penegak | Test bukti |
|---|---|---|---|
| R1 | Tiap slip dibayar tepat sekali | Indeks unik parsial §4.3; `idempotency_key` unik; item `sending`/`unknown`/`exported` tidak pernah dikirim atau diekspor ulang | Dua pekerja bersamaan untuk satu batch: tepat satu panggilan transfer per item. Membuat percobaan baru saat ada yang `succeeded`/`unknown`/`exported`: ditolak DB |
| R2 | Timeout tidak pernah memicu kirim ulang | `sending` di-commit sebelum HTTP; `sending` lebih tua dari 2 menit tanpa hasil dianggap `unknown`; tombol "coba lagi" hanya untuk `failed` | Fetch palsu melempar timeout: item `unknown`, nol panggilan transfer kedua, coba lagi ditolak `409` |
| R3 | Nama rekening hasil inquiry wajib sama dengan nama resmi karyawan | Normalisasi (huruf besar, buang tanda baca, rapatkan spasi), lalu harus sama persis dengan `legal_name` di snapshot. Nama pemilik ketikan HR tidak dipakai untuk mencocokkan. Beda: item dikeluarkan, penyetuju tidak bisa menimpa | Nama beda satu huruf: item `blocked` lalu `cancelled`, nol transfer. HR mengganti rekening ke rekening sendiri: nama inquiry tidak sama dengan nama karyawan, nol transfer |
| R4 | Inquiry ulang tepat sebelum kirim | Saat kirim, inquiry dijalankan lagi untuk item `approved` (nama dan nominal harus tetap sama); `disburseId` dari inquiry itu disimpan dalam commit yang sama dengan CAS ke `sending`. Item `sending`/`unknown` tidak pernah di-inquiry ulang | Nama berubah di antara persetujuan dan kirim: item `failed` (`definitive`), nol transfer |
| R5 | Dua orang sebelum uang keluar, di semua kanal | CHECK `approved_by <> requested_by`; izin terpisah; MFA step-up penyetuju; `content_hash` sama saat kirim/ekspor | Pembuat menyetujui sendiri: ditolak DB dan API. Item diubah setelah disetujui: kirim dan ekspor ditolak |
| R6 | Saldo kurang: berhenti sebelum kirim | checkBalance: `effectiveBalance >= Σ nominal + Σ biaya` item yang akan dikirim. Kurang: batch `halted`, nol transfer. `-510` di tengah: berhenti | Saldo kurang Rp1: nol transfer. `-510` di item ke-3 dari 5: 1-2 `succeeded`, 3 `failed`, 4-5 tetap `approved` dan tidak dikirim |
| R7 | Gagal sebagian tidak mengirim ulang yang berhasil | Batch susulan hanya memuat slip yang percobaan terakhirnya `failed`/`not_sent`/`returned`/`cancelled` | Batch kedua tidak memuat slip yang `succeeded` |
| R8 | Nominal = net pay slip | Nominal diambil dari kalkulasi tersegel saat batch dibuat; slip `cash` ke kanal tunai; di atas `max_per_transfer_idr` ke manual | Σ nominal semua batch run = Σ net pay slip; slip Rp60 juta dengan batas Rp50 juta masuk manual |
| R9 | Biaya ditanggung PT (usulan, Q-F2) | Biaya tidak dikurangkan dari nominal; dijurnal ke beban | Karyawan menerima net pay utuh |
| R10 | Buku besar dikredit tepat sekali | Jurnal kelompok §8 di bawah kunci advisory batch, kunci jurnal dari hash himpunan item, tautan item dalam transaksi yang sama; "tandai dibayar" lama ditolak bila run punya batch; `payroll.paid` alur baru tidak memposting | Σ kredit = Σ net pay slip yang dibayar; settle dipicu dua kali bersamaan: satu jurnal; tandai dibayar lama pada run ber-batch: `409` |
| R11 | Run yang sedang atau sudah dibayar tidak bisa dibalik | Pembalikan run mengunci baris run (`FOR UPDATE`) dan ditolak bila ada batch run itu yang belum `completed`/`partially_failed`/`cancelled`, atau ada item `sending`/`exported`/`unknown`/`succeeded`. Pekerja membaca baris run (`FOR SHARE`) dalam transaksi CAS tiap item dan berhenti bila status bukan `locked`/`paid` | Batch `approved`, lalu run dibalik: pembalikan ditolak. Run dibalik lewat jalur lain sebelum kirim: pekerja berhenti, nol transfer |
| R12 | Status tidak pasti diputus dengan hati-hati | Otomatis hanya dari bukti penyedia (`00`). Manual ke `succeeded` atau `failed`: dua orang berbeda (`resolved_by`, `resolved_by_2`) + bukti, ke `failed` paling cepat T+1 hari kerja | Satu orang memutus: ditolak DB |
| R13 | Percobaan baru setelah `unknown` yang diputus gagal tidak boleh membayar ganda | Tepat sebelum percobaan baru dibuat, satu inquiryStatus untuk percobaan lama; `00` membatalkan percobaan baru. `00` terlambat sesudahnya: `overpaid` + jurnal piutang + notifikasi | inquiryStatus palsu `00`: percobaan baru ditolak dan percobaan lama jadi `succeeded` |
| R14 | File manual hanya keluar sekali | Unduhan pertama memindah batch ke `exported` (CAS), mengecek ulang `content_hash`, masa persetujuan, dan `enabled`. Unduhan kedua `409 PAYOUT_EXPORT_ALREADY_DOWNLOADED`. File hilang: batch dibatalkan oleh dua orang yang menyatakan file belum diunggah ke bank (item `not_sent`), lalu batch baru dengan persetujuan baru | Unduhan kedua ditolak; konfirmasi hasil oleh pembuat ditolak |
| R15 | Pengaman dicek di tiap item, bukan sekali | Sebelum tiap item: saklar `PAYROLL_DISBURSEMENT_ENABLED`, `enabled` konfigurasi, lease pekerja, status run, batas harian | Saklar dimatikan di tengah batch: item berikutnya tidak dikirim, batch `halted` (`kill_switch`) |

## 7. Alur

### 7.1 Konfigurasi per PT

Layar pengaturan payroll per PT (`legend-wnkep.6`): pilih metode, sambungkan kredensial Duitku disbursement (field hanya tulis, tampil email tersamar), pilih rekening sumber manual, format bank manual, batas per transfer, batas harian. Simpan butuh izin `payroll.payout.configure` + MFA step-up. Tombol "Tes koneksi" memanggil checkBalance dan hanya menampilkan saldo efektif.

### 7.2 Menyiapkan batch

Dari run `locked`: sistem membagi slip ke kanal. `cash` ke batch `cash`; `bank_transfer` ke kanal PT (Duitku atau manual); slip di atas batas atau tanpa kode bank ke manual. Untuk Duitku, tiap item di-inquiry (nominal = net pay) dan dicocokkan dengan `legal_name` (R3). Pembuat (`payroll.disburse.request`) mengajukan; item `blocked` dikeluarkan; `content_hash` dihitung.

### 7.3 Persetujuan

Orang kedua (`payroll.disburse.approve`, bukan pembuat, MFA step-up) melihat: nama karyawan, bank, rekening last4, nama hasil inquiry, nominal, total, perkiraan biaya, saldo efektif, slip yang dikeluarkan beserta alasannya, dan **tanda "rekening atau nama diubah dalam 35 hari sebelum run dikunci" beserta siapa yang mengubah** (dari audit). Setuju menyimpan `content_hash` yang dilihat. Berlaku 24 jam. Payroll sekarang sudah mewajibkan penyetuju run bukan pembuat (trigger `0300`/`0304`), jadi tiap PT yang menjalankan payroll sudah punya minimal dua orang.

### 7.4 Kirim Duitku (pekerja latar)

1. Endpoint setuju memasukkan pekerjaan `payroll.disbursement.send` ke outbox (`core-outbox.ts`). Tidak ada HTTP ke penyedia di dalam request pengguna.
2. Pekerja mengambil lease batch (`worker_lease_until`, update bersyarat). Gagal ambil lease: keluar.
3. Cek masa persetujuan dan `content_hash`, lalu checkBalance (R6); simpan saldo sebelum di `totals_encrypted`.
4. Per item, berurutan: cek R15 -> inquiry ulang (R4) -> transaksi: baca run `FOR SHARE` (R11), CAS `approved -> sending`, simpan `disburseId`, commit -> transfer -> CAS ke hasil (§5.3) + log event.
5. `-510` atau R15 gagal: berhenti (`halted`). Selesai: checkBalance lagi, simpan saldo sesudah, set status batch, picu settle jurnal (§8).
6. Melanjutkan batch `halted` butuh persetujuan ulang oleh orang bukan pembuat (hash dihitung ulang atas sisa item).

### 7.5 Rekonsiliator status

- `sending` lebih tua dari 2 menit tanpa hasil: jadi `unknown` tanpa memanggil penyedia.
- inquiryStatus otomatis paling banyak 3 kali per item: +5 menit, +60 menit, dan hari kerja berikutnya pukul 10:00 WIB (untuk kode `68`, T+1). Global maks 10 panggilan per menit per kredensial; tanda blokir dari Duitku menghentikan semua panggilan status 1 jam.
- Setelah itu hanya tombol "cek status" manual, sekali per 15 menit per item.
- `00` -> `succeeded`. Kode lain tetap `unknown`. Masih `unknown` setelah T+1: tampil di layar "perlu diputus" (R12) dan notifikasi ke penyetuju.
- Jadwal ini harus dikonfirmasi tertulis ke Duitku karena dok melarang permintaan status otomatis berulang (`legend-wnkep.9`). Bila Duitku menolak, panggilan otomatis dimatikan dan hanya tombol manual yang tersisa.

### 7.6 Callback (hanya bila nanti memakai clearing/BIFAST)

Rute `POST /api/webhooks/payouts/duitku` tanpa sesi: verifikasi tanda tangan SHA256 dengan `crypto.timingSafeEqual` memakai `secretKey` dari integrasi yang cocok dengan `userId`/email; dedupe §4.4; isi callback (HMAC rekening, nominal, `disburseId`) harus sama dengan item, bila beda dicatat dan diabaikan; balas `SUCCESS`. Callback tidak bisa memundurkan `succeeded`. Allowlist IP Duitku hanya lapisan tambahan. Untuk Transfer Online v1 rute ini belum diperlukan.

### 7.7 Jalur manual bank

1. Batch `manual_bank` diajukan dan disetujui dua orang dengan aturan yang sama (R5).
2. Unduhan file satu-satunya (R14): dibuat dari registry format (`bank-formats.ts`), langsung dialirkan (tidak disimpan), `export_checksum_sha256` dicatat, diaudit; batch dan item jadi `exported`.
3. Setelah transfer di internet banking, orang yang **bukan pembuat** dengan izin `payroll.disburse.approve` mengonfirmasi hasil per item (`succeeded` dengan referensi bank, atau `failed`), dengan berkas bukti (laporan hasil bank). "Semua berhasil" sekaligus boleh dengan satu referensi batch + satu berkas bukti.
4. Nama rekening tidak bisa dicek sistem di jalur ini; layar memperingatkan bahwa cek nama terjadi di internet banking.

### 7.8 Dana kembali dan batch susulan

Bila bank mengembalikan dana setelah berhasil, dua orang mencatat `returned` dengan bukti; jurnal kebalikan diposting (§8). Slip itu boleh masuk batch susulan walau run sudah `paid` (batch susulan hanya untuk slip yang tidak punya percobaan hidup). Status run tidak dimundurkan; layar run menampilkan "ada slip belum terbayar".

### 7.9 Run menjadi `paid`

Run pindah ke `paid` otomatis (mengisi `paid_at`, `paid_by` = penyetuju batch terakhir) saat setiap slip punya satu item `succeeded`. Event `payroll.paid` membawa `settledPerItem: true`. "Tandai dibayar" lama per run ditolak `409 PAYROLL_RUN_HAS_PAYOUT_BATCH` bila run punya batch yang tidak `cancelled`.

## 8. Jurnal dan rekonsiliasi

- **Settle**: dipicu saat batch final, saat konfirmasi manual/tunai, dan saat rekonsiliator memutus `unknown`. Dalam satu transaksi: `pg_advisory_xact_lock` atas batch; pilih item `succeeded` dengan `gl_posting_id IS NULL` (`FOR UPDATE`); hitung `item_set_hash` = SHA-256 id item terurut; kunci jurnal `payroll-payout:<item_set_hash>`; posting Dr `salaries_payable` Σ / Cr akun kanal (Duitku: `payout_deposit` per PT; manual: akun dari `manual_source_bank_account_id`; tunai: `petty_cash`); tautkan item dengan update bersyarat; jumlah baris tertaut harus sama dengan yang dipilih, bila tidak rollback.
- **Tanpa jurnal kunci run** (akuntansi dinyalakan setelah run dikunci): sama dengan `payroll-gl-consumer.ts:298-305`, tidak ada jurnal; item tetap ditautkan ke baris `settle_skipped` supaya tidak diproses lagi.
- **Biaya**: dalam transaksi yang sama, Dr `bank_charges` / Cr `payout_deposit` sebesar Σ biaya item kelompok itu, kunci `payroll-payout-fee:<item_set_hash>`. Biaya bank jalur manual dicatat keuangan terpisah.
- **Kembali**: Dr akun kanal / Cr `salaries_payable` untuk item `returned`, kunci `payroll-payout-return:<itemId>`.
- **Bayar ganda terdeteksi** (`overpaid`): Dr `employee_receivable` / Cr akun kanal, kunci `payroll-payout-overpaid:<itemId>`.
- **`payroll.paid`** dengan `settledPerItem: true`: `payroll-gl-consumer.ts` tidak memposting apa pun. Run lama tanpa batch tetap memakai aturan sekarang. Ini satu-satunya perubahan pada konsumen yang ada dan wajib punya test Σ kredit (R10).
- **Isi deposit Duitku**: Dr `payout_deposit` / Cr rekening bank, dicatat keuangan lewat jurnal kas/bank biasa (SOP di `legend-wnkep.9`).
- **Rekonsiliasi**: laporan per batch (dibuka dengan izin `payroll.view`): selisih saldo sebelum dan sesudah dibanding Σ nominal + Σ biaya; Σ jurnal settle dibanding Σ item `succeeded`; daftar item `unknown`/`exported`. Selisih ditandai merah. Impor mutasi Duitku menyusul (tidak ada API mutasi di dok; BELUM PASTI).

## 9. Keamanan

- **Kunci hanya di server.** Kredensial Duitku per PT disimpan di baris integrasi tersegel AES-256-GCM yang sudah ada; kunci induk dari env. Tidak pernah dikirim ke browser, tidak pernah dicetak. Tambah `secretKey`, `signature`, `bankAccount`, `accountName` ke redaksi pino.
- **Saklar mati** `PAYROLL_DISBURSEMENT_ENABLED` (bawaan `false`) divalidasi di `apps/api/src/config/env.ts` dan tercantum di `.env.example` tanpa nilai. Lingkungan sandbox/produksi mengikuti `config.environment` baris integrasi; produksi menolak kredensial bertanda sandbox.
- **Akses.** Izin baru `payroll.payout.configure`, `payroll.disburse.request`, `payroll.disburse.approve` di `packages/shared/src/access/permissions.ts`. Rute: `requireAuth`, `requireTrustedOrigin`, `requireTenantPermission`.
- **MFA step-up.** Setuju, lanjutkan batch `halted`, putus status, konfirmasi manual, dan ubah konfigurasi butuh MFA. `requireSessionMfa()` (`identity.ts:89`) tidak dipakai apa adanya: ia menolak sesi yang masuk lewat Google, email, atau WhatsApp dan memaksa kebijakan sesi manajemen platform. BE-1 menambah `requireTenantStepUpMfa({ maxAgeMinutes: 15 })` di berkas yang sama: `loadSessionRow` + `sessionPolicy`, `mfaVerifiedAt` harus ada dan tidak lebih tua dari 15 menit, tanpa syarat login password. BELUM PASTI: alur verifikasi ulang yang memperbarui `mfaVerifiedAt` sudah ada atau belum; BE-1 memeriksanya. Akibat bisnis: penyetuju gaji wajib sudah memasang faktor kedua.
- **Callback** diverifikasi tanda tangan dengan perbandingan waktu-konstan; IP allowlist sebagai lapisan tambahan; payload dicocokkan dengan item.
- **IP keluar tetap** untuk server produksi wajib didaftarkan ke Duitku (tanpa itu `-930`).
- **Data pribadi.** Nominal per orang, total batch, saldo, biaya per item, dan nama hasil inquiry tersegel dan ikut job segel ulang; nomor rekening tetap di snapshot tersegel; layar menampilkan last4. File ekspor manual tidak disimpan, hanya checksum. Teks respons penyedia tidak disimpan mentah.
- **Batas laju** pada endpoint ajukan, setuju, kirim, ekspor, cek status.
- Test tidak pernah memanggil Duitku atau DOIT sungguhan: `fetch` disuntik dengan fixture dari dok.

## 10. Keputusan teknis

**D-01. Duitku Transfer Online untuk v1, BI-FAST menyusul.**
Alasan: alurnya langsung (hasil keluar saat itu juga), ada rekening uji resmi, tidak butuh callback. Risiko: biaya Rp5.000 per transfer, dua kali BI-FAST (Rp2.500); untuk 100 karyawan selisih Rp250 ribu per bulan. Cadangan: setelah sandbox membuktikan alur clearing BIFAST (respons dan callback), tambah sub-kanal `duitku_bifast`.

**D-02. DOIT tidak dikerjakan sampai ada konfirmasi tertulis.**
Alasan: dokumen resmi DOIT menyatakan tidak menahan dana dan tidak ada payout. Risiko: founder mengira DOIT bisa. Cadangan: antarmuka adapter sudah punya kanal `doit`; bila DOIT membuka payout, cukup satu adapter baru.

**D-03. Tidak ada kirim ulang otomatis untuk status tidak pasti.**
Alasan: Duitku sendiri melarang mengulang setelah `TO`/`68`/`-100`, dan tidak menjanjikan idempotensi. Mengulang bisa membayar dua kali. Risiko: sebagian karyawan menunggu sampai status diputus (T+1). Cadangan: cek status terbatas (3 kali) + layar putus manual dua orang + deteksi bayar ganda (R13).

**D-04. Nama hasil inquiry dicocokkan dengan nama resmi karyawan, sama persis setelah normalisasi.**
Alasan: aturan founder; nama pemilik rekening ketikan HR bisa dipakai HR untuk mengalihkan gaji ke rekening sendiri, nama resmi karyawan tidak. Risiko: nama terpotong atau disingkat bank membuat slip dikeluarkan dari batch otomatis. Cadangan: slip itu dibayar lewat manual/tunai periode ini; HR membetulkan data karyawan untuk periode berikutnya. Snapshot tidak pernah diubah.

**D-05. Jurnal per kelompok, bukan per karyawan.**
Alasan: gaji per orang tersegel (HR-03) dan tidak boleh muncul di buku besar. Risiko: jejak audit per orang ada di tabel item, bukan di jurnal. Cadangan: laporan rekonsiliasi menautkan jurnal ke daftar item.

**D-06. Kredensial per PT di baris integrasi tersegel, bukan env.**
Alasan: tiap PT punya akun Duitku sendiri; pola tersegel sudah dipakai pembayaran. Env hanya menyimpan kunci induk dan saklar. Risiko: kebocoran kunci induk membuka semua kredensial. Cadangan: rotasi kunci versi (`key_version`) yang sudah ada.

**D-07. Pekerja latar lewat outbox, satu pekerja per batch.**
Alasan: request pengguna tidak menunggu bank; proses mati di tengah tidak menggandakan kirim. Risiko: penundaan beberapa detik. Cadangan: tombol "lanjutkan" yang hanya mengambil lease lagi.

**D-08. Run yang punya batch hanya bisa dibayar lewat batch.**
Alasan: dua jalur bayar untuk satu run membuat jurnal dan uang keluar ganda. Risiko: tenant yang terbiasa "tandai dibayar" harus memakai batch tunai/manual. Cadangan: batch tunai dan manual tetap sederhana (ajukan, setujui, konfirmasi).

## 11. Slice dan kartu bd

Urutan mengikuti alur tim: mockup dan UI dengan data contoh, review founder, kontrak dan test gagal-dulu, backend, sambung UI, review, rilis.

| Urut | Kartu | Isi | Bergantung | Migrasi | Tingkat |
|---|---|---|---|---|---|
| 1 | `legend-wnkep.6` UI-1 | Mockup + layar konfigurasi per PT (data contoh) | - | - | S |
| 1 | `legend-wnkep.7` UI-2 | Mockup + layar batch: siapkan, setujui, kirim, status, putus, ekspor, konfirmasi | - | - | S |
| 2 | `legend-wnkep.1` TEST | Test gagal-dulu R1–R15 + kontrak zod/DTO | Gerbang review UI founder | - | K |
| 3 | `legend-wnkep.2` BE-1 | Inti: konfigurasi, batch, item, mesin status, izin, MFA step-up tenant, adapter palsu, `bank_code` + snapshot, penolakan "tandai dibayar" lama, penjaga pembalikan run | `legend-89cl7` (merge `ws/payroll-followups`), `.1` | 0530–0533 | K |
| 4 | `legend-wnkep.3` BE-2 | Adapter Duitku, rekonsiliator, rute callback | `.2` | - | K |
| 4 | `legend-wnkep.4` BE-3 | Kanal manual dan tunai: ekspor sekali, konfirmasi hasil per item | `.2`; layout bank `legend-1gtfm` | - | K |
| 4 | `legend-wnkep.5` BE-4 | Jurnal kelompok, biaya, kembali, bayar ganda; `settledPerItem` | `.2` | 0534 | K |
| 5 | `legend-wnkep.6`/`.7` | Sambung UI ke API | `.2`–`.5` | - | S |
| - | `legend-wnkep.9` EXT | Akun Duitku disbursement per PT, kredensial sandbox, IP keluar tetap, SOP isi deposit, konfirmasi batas cek status | Founder, saat go-live | - | - |
| - | `legend-wnkep.8` | Adapter DOIT (diparkir) | Konfirmasi tertulis DOIT | - | K |

Slice 4 bisa paralel (file berbeda: `services/payroll-payout-duitku*.ts`, `services/payroll-payout-manual.ts`, `services/payroll-payout-gl.ts` + `payroll-gl-consumer.ts`). Second opinion Codex sekali untuk seluruh area sebelum gerbang rilis.

File yang diusulkan (BE-1): `apps/api/src/db/schema/payroll-payout.ts`, `apps/api/src/services/payroll-payout.service.ts`, `apps/api/src/services/payroll-payout-provider.ts` (antarmuka: `inquiry`, `transfer`, `status`, `balance`), `apps/api/src/routes/payroll-payout.routes.ts`, `apps/api/src/middleware/identity.ts` (`requireTenantStepUpMfa`), `packages/shared/src/validators/payroll-payout.ts`, DTO di `packages/shared/src/types/api.ts`, test di `apps/api/src/test/payroll-payout-*.test.ts`.

## 12. Keputusan bisnis untuk founder

| # | Pertanyaan | Rekomendasi | Dampak bila ditolak |
|---|---|---|---|
| Q-F1 | DOIT tidak punya fitur kirim gaji ke rekening karyawan. Untuk gaji kita pakai Duitku + transfer manual saja, DOIT ditunda sampai DOIT mengonfirmasi tertulis? | Ya | Bila tetap ingin DOIT: founder perlu menanyakan langsung ke DOIT apakah ada payout tertutup |
| Q-F2 | Biaya transfer (Rp5.000 per karyawan per gajian di Duitku) ditanggung siapa? | PT (outlet), dicatat sebagai beban bank. Karyawan menerima gaji utuh | Bila dipotong dari gaji: perlu potongan resmi di slip dan cek aturan ketenagakerjaan |
| Q-F3 | Kapan bayar otomatis Duitku dinyalakan? PRD v1.7 menaruhnya setelah rilis (Jan–Mar 2027) | Rilis awal: transfer manual lewat file bank + persetujuan dua orang. Duitku dibangun sekarang di belakang saklar, dinyalakan per PT setelah akun Duitku disbursement, deposit, dan uji sandbox siap | Bila Duitku wajib saat rilis: akun Duitku disbursement, kredensial sandbox, dan IP server tetap harus siap sebelum rilis |
| Q-F4 | Layout file bank manual mana yang dibuat pertama? | Bank tempat PT membayar gaji sekarang; bila belum ada, BCA | Tanpa jawaban, hanya CSV umum yang tersedia |

Sudah diputuskan di desain ini (bisa dikoreksi founder): semua batch di semua kanal butuh dua orang berbeda tanpa ambang nominal; slip di atas Rp50 juta otomatis lewat manual; nama rekening yang tidak sama dengan nama resmi karyawan tidak dibayar otomatis; penyetuju wajib MFA.

## 13. Belum pasti, wajib dicek di sandbox Duitku

1. Perilaku `disburseId` yang sama dikirim dua kali (`-142`?) dan masa berlaku `disburseId`.
2. Panjang dan keunikan `custRefNumber`.
3. Apakah Transfer Online pernah mengirim callback.
4. Apakah biaya memotong `effectiveBalance`, dan nama field checkBalance.
5. Tabel kode status lengkap dan kode yang dikembalikan inquiryStatus untuk transfer tertunda.
6. Batas laju inquiryStatus dan apakah jadwal §7.5 diizinkan.
7. Kode bank selain BCA dari `listBank`.
8. Batas harian akun.
9. Ada atau tidaknya API mutasi/laporan untuk rekonsiliasi.
10. Apakah Duitku bisa mengembalikan dana setelah `00` dan bagaimana diberitahukan.
11. Seberapa sering nama hasil inquiry berbeda dari nama KTP (disingkat, gelar) pada bank besar; bila sering, aturan R3 perlu dibahas ulang dengan founder.
