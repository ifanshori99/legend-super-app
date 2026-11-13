# Desain ws/cash-bank (legend-4961; legend-gq0w)

Architect, 13 Nov 2026. Tingkat K (uang, migrasi, akses). Basis 52346c44.

## Kartu 2: legend-gq0w TERBLOKIR

Belum ada handler `bookAccessTicket` di API, `access_tickets` belum punya kolom digest (`apps/api/src/db/schema/facility.ts:225-228`), legend-bzih DEFERRED, dan resolver tamu masih stub `null` (`apps/api/src/routes/facility.routes.ts:63-79`). Catatan untuk nanti: digest di-hash, jadi re-issue harus memutar kredensial (QR/PIN baru, digest lama mati), tidak bisa menampilkan ulang kredensial lama.

## Kartu 1: keputusan

1. **Kas masuk, kas keluar, transfer**: satu tabel dokumen `cash_bank_entries` (tingkat badan usaha). Jurnal diposting sinkron di transaksi yang sama. Gagal posting berarti seluruh request batal (rollback). Dokumen ini tidak pernah diparkir, karena semua akunnya dipilih eksplisit.
2. **Kas kecil per outlet**: tabel `petty_cash_funds` menyimpan saldo, ditambah buku besar append-only `petty_cash_entries`. Pergerakannya: `topup` (bank ke kas kecil), `return` (kas kecil ke bank), dan `purchase`.
3. **Belanja dari kas kecil** tetap lewat pembelian sederhana yang sudah ada (foto dan batas, `petty-purchase.service.ts`). Bila outlet punya dana, pembelian mengurangi saldo dana di transaksi yang sama, dan ditolak bila saldo kurang. Tidak ada jalur "spend" kedua tanpa bukti foto.
4. **Akun bank** diambil dari `bank_accounts.gl_account_id` milik rekening (divalidasi saat rekening dibuat, `accounting-bank-accounts.service.ts:67-92`). **Akun lawan** kas masuk/keluar dipilih pengguna secara eksplisit, sama seperti jurnal manual. **Akun kas kecil** diambil dari role peta akun `petty_cash` (1102). Bila peta itu hilang, dokumen diparkir dengan kode `ACCOUNT_MAPPING_MISSING`. Sistem tidak menebak akun.

## Tabel: migrasi 0484 (dibuat drizzle) dan 0485 (custom)

Berkas skema baru: `apps/api/src/db/schema/accounting-cash-bank-entries.ts`, diekspor dari `schema/index.ts`.

**`cash_bank_entries`** (RLS tenant; `outlet_id` boleh null, jadi tanpa RLS outlet, sama seperti `accounting-cash-bank.custom.sql:5-8`):
- Kolom: `id uuid pk`, `tenant_id`, `legal_entity_id`, `outlet_id uuid NULL` (tag biaya, opsional), `kind varchar(20)` (`cash_in|cash_out|transfer`), `entry_date date`, `amount_idr bigint`, `bank_account_id`, `to_bank_account_id NULL`, `counter_account_id NULL`, `description varchar(255)`, `reference varchar(60) NULL`, `idempotency_key varchar(100)`, `journal_entry_id NOT NULL`, `created_by`, `created_at`.
- CHECK: `amount_idr > 0`.
- CHECK: `transfer` jika dan hanya jika `to_bank_account_id` NOT NULL, `counter_account_id` NULL, dan `to_bank_account_id <> bank_account_id`.
- CHECK: `cash_in` dan `cash_out` jika dan hanya jika `counter_account_id` NOT NULL dan `to_bank_account_id` NULL.
- UNIQUE `(tenant_id, idempotency_key)`. UNIQUE `(tenant_id, journal_entry_id)`.
- FK komposit `(tenant_id, bank_account_id)` dan `(tenant_id, to_bank_account_id)` ke `bank_accounts`. `outlet_id` memakai pola FK outlet.

**`petty_cash_funds`** (RLS tenant dan outlet):
- Kolom: `id`, `tenant_id`, `legal_entity_id`, `outlet_id NOT NULL`, `balance_idr bigint NOT NULL DEFAULT 0`, `created_by`, `created_at`, `updated_at`.
- **CHECK `balance_idr >= 0`** (jaring pengaman DB). UNIQUE `(tenant_id, outlet_id)`.

**`petty_cash_entries`** (RLS tenant dan outlet, append-only):
- Kolom: `id`, `tenant_id`, `legal_entity_id`, `outlet_id`, `fund_id`, `kind` (`topup|return|purchase`), `amount_idr`, `balance_after_idr`, `bank_account_id NULL`, `petty_purchase_id NULL`, `entry_date` (tanggal bisnis outlet), `description`, `idempotency_key`, `journal_status` (`posted|parked|external`), `journal_entry_id NULL`, `park_code varchar(60) NULL`, `park_attempts int`, `created_by`, `created_at`.
- CHECK: `amount_idr > 0`. CHECK: `balance_after_idr >= 0`.
- CHECK: `purchase` jika dan hanya jika `petty_purchase_id` NOT NULL, `bank_account_id` NULL, dan `journal_status='external'`.
- CHECK: `topup` dan `return` jika dan hanya jika `bank_account_id` NOT NULL dan `journal_status IN ('posted','parked')`.
- CHECK: `posted` jika dan hanya jika `journal_entry_id` NOT NULL. `parked` jika dan hanya jika `park_code` NOT NULL.
- UNIQUE `(tenant_id, idempotency_key)`. Baris pembelian memakai kunci `pp:<purchaseId>`.
- UNIQUE parsial `(tenant_id, petty_purchase_id)` dan `(tenant_id, journal_entry_id)`, keduanya WHERE NOT NULL.

**Perubahan lain di 0484**: CHECK `journal_entries.source_type` (`schema/accounting.ts:314`) ditambah `cash_receipt`, `cash_payment`, `bank_transfer`, `petty_cash_topup`, `petty_cash_return`. Semuanya muat di varchar(30).

**0485 custom**, mengikuti pola `0440_payment_settlements.sql:62-77`:
- `app.enforce_tenant_rls` untuk ketiga tabel.
- `app.enforce_outlet_rls` untuk `petty_cash_funds` dan `petty_cash_entries` (guard `src/db/outlet-rls.test.ts`).
- `REVOKE UPDATE, DELETE, TRUNCATE` dari `legend_app` untuk ketiga tabel.
- `GRANT UPDATE (balance_idr, updated_at) ON petty_cash_funds`.
- `GRANT UPDATE (journal_status, journal_entry_id, park_code, park_attempts) ON petty_cash_entries`.
- Cerminkan SQL ini di `apps/api/src/db/schema/accounting-cash-bank-entries.custom.sql`.

**Penomoran**: drizzle akan memberi nomor berikut secara otomatis. Ganti nama tag menjadi 0484/0485 dan atur `idx` serta `when` (> 1794543670328) seperti 0440 di `meta/_journal.json`. Sesudahnya, `pnpm db:generate` harus kosong.

## Aturan posting

| Dokumen | Debit | Kredit | source_type | Cara posting |
|---|---|---|---|---|
| cash_in | GL rekening | akun lawan | cash_receipt | `postJournalInTransaction` (`accounting-journal.service.ts:465`) |
| cash_out | akun lawan | GL rekening | cash_payment | sama |
| transfer | GL rekening tujuan | GL rekening asal | bank_transfer | sama |
| petty topup | role `petty_cash` | role `bank` (override = GL rekening) | petty_cash_topup | `postJournalFromRuleInTransaction` (`:558`) dengan `eventName: "document:petty_cash_topup"` dan `accountOverrides: { bank }` (pola di `accounting-ap.service.ts:274-288`) |
| petty return | role `bank` (override) | role `petty_cash` | petty_cash_return | sama |
| purchase | (tidak ada jurnal di sini) | | | Jurnal tetap milik `petty_purchase.recorded` (`posting-rules.ts:423-431`) |

- Dua aturan dokumen baru masuk ke `posting-rules.ts`: `document:petty_cash_topup` dan `document:petty_cash_return`, dengan kunci jumlah `amountIdr`.
- Role `petty_cash` yang hilang memicu `ACCOUNT_MAPPING_MISSING` dari `buildJournalLinesFromRule` (`posting-rules.ts:734`).
- Validasi akun lawan cash_in dan cash_out:
  - Harus dari badan usaha yang sama, aktif, dan bukan akun header. Ini sudah dicek oleh `postJournalInTransaction`.
  - Tidak boleh berkategori `cash_and_equivalents`. Pakai transfer untuk itu. Kode error: `CASH_BANK_COUNTER_ACCOUNT_INVALID` (422).
- Transfer:
  - Kedua rekening harus dari badan usaha yang sama dan aktif.
  - `gl_account_id` keduanya tidak boleh sama (422).
  - Transfer antar-badan usaha di luar cakupan (422).
- Tanggal:
  - `entry_date` untuk cash_bank tidak boleh di masa depan (`entityToday`, `accounting-ap-fa-shared.ts:204`). Periode tertutup ditolak dengan `PERIOD_CLOSED`.
  - Pergerakan kas kecil memakai tanggal bisnis outlet saat ini (pola `petty-purchase.service.ts:259-266`) dan tidak bisa mundur tanggal.
- Kunci idempoten jurnal diturunkan dari server: `cb:<entryId>` dan `pc:<entryId>`. Kunci unik `(tenant, idempotency_key)` di `journal_entries` dan UNIQUE pada `journal_entry_id` dokumen menjamin satu dokumen menghasilkan satu jurnal.
- Pencocokan bank tidak butuh kerja tambahan. Matcher sudah membaca baris jurnal pada GL rekening (`accounting-bank-matching.ts:98`).

**Parkir (kas kecil saja)**:
- Posting dijalankan dalam savepoint (`tx.transaction`). Hanya `AccountingError` berkode `ACCOUNT_MAPPING_MISSING` yang di-rollback ke savepoint. Entri lalu disimpan dengan `journal_status='parked'`, `park_code` diisi, dan saldo tetap bergerak karena uang fisik memang sudah pindah.
- Semua error lain dilempar ulang dan membatalkan seluruh request.
- Retry: `POST .../petty-cash/entries/:id/post`. Endpoint ini mengunci baris (FOR UPDATE), memposting dengan kunci `pc:<id>` yang sama, lalu mengubah status ke `posted`. Entri yang sudah `posted` dikembalikan apa adanya.
- Setiap park dan retry dicatat lewat `auditApFa`.

## Kunci saldo kas kecil (tidak bisa minus)

Urutan kunci untuk setiap mutasi dana, dijalankan di dalam `withTenant`:

1. `idempotentCommand` (`accounting-ap-fa-shared.ts:73`), atau untuk pembelian `claimPurchasingIdempotency` yang sudah ada.
2. `entityLock` (`accounting-bank-matching.ts:53`), hanya untuk topup dan return karena keduanya menyentuh rekening.
3. Topup saja: `INSERT petty_cash_funds ... ON CONFLICT (tenant_id, outlet_id) DO NOTHING`. Dana dibuat otomatis pada topup pertama.
4. `SELECT ... FROM petty_cash_funds WHERE tenant_id, outlet_id FOR UPDATE`.
5. Pengurangan saldo: `UPDATE ... SET balance_idr = balance_idr - $amt, updated_at = now() WHERE id = $id AND balance_idr >= $amt RETURNING balance_idr`. Bila 0 baris yang berubah, lempar `PETTY_CASH_INSUFFICIENT` (422 baru di `errors.ts`). Penambahan saldo tanpa syarat.
6. Insert entri dengan `balance_after_idr` = hasil RETURNING.

Kaitan dengan pembelian sederhana:
- Panggil `drawPettyCashForPurchase(tx, context, {outletId, purchaseId, amountIdr, actorId})` di `petty-purchase.service.ts`, sesudah insert `pettyPurchases` dan sebelum `appendPettyRecordedEvent`.
- Outlet tanpa dana: tidak ada efek, perilaku lama tetap jalan. **Pertanyaan untuk founder lewat CTO**: apakah dana kas kecil wajib ada sebelum pembelian sederhana boleh dicatat? Sampai ada keputusan, aturan hanya berlaku untuk outlet yang sudah punya dana.

## Idempotensi

- Semua POST membawa `idempotencyKey` di body, lewat `idempotencyKeySchema` seperti di `createCashDepositInputSchema`.
- `idempotentCommand` memakai operasi `cash_bank.entry.create` dan `petty_cash.movement.create`.
- `run()` hanya mengembalikan id entri. Service membaca DTO terbaru setelahnya, supaya replay menampilkan status terkini (misalnya parked yang sudah menjadi posted).
- Kunci sama dengan isi berbeda: `IDEMPOTENCY_KEY_REUSED` 409.
- Ada tiga lapis pengaman berurutan: kunci advisory per kunci idempoten, UNIQUE `idempotency_key` di dokumen, dan UNIQUE kunci jurnal.

## Izin dan guard

- Kode baru di `packages/shared/src/access/permissions.ts` (sekitar baris 176):
  - `accounting.cash_bank.record` dengan tag `["finance"]`.
  - `accounting.petty_cash.manage` dengan tag `["finance"]`.
- Tambahkan kedua kode ke template peran finance di `access/roles.ts`.
- Semua router: `router.use(requireAuth, requireTrustedOrigin, requireTenantContext)`, plus `jsonBody` pada POST (pola `accounting-cash-deposits.routes.ts:44,74-80`).
- POST cash_bank, POST petty movements, dan retry post memakai `requireTenantPermission(code)` (`middleware/permissions.ts:150`), ditambah `assertTenantScope` di service (`accounting-ap-fa-shared.ts:163`). Alasannya: rekening bank ada di tingkat badan usaha (`accounting-cash-bank-shared.ts:7-10`).
- GET memakai `requireMenuPermission(code)`, lalu service mempersempit ke outlet dalam jangkauan (`accounting-cash-deposits.service.ts:80-89`).
- Id dari tenant atau outlet lain menghasilkan 404, karena RLS menyembunyikan barisnya (`notFound`, `accounting-cash-bank-shared.ts:35`). Tanpa izin: 403.

## Endpoint (BASE `/api/accounting`, objek `defineEndpoint` di `accounting/endpoints.ts`)

| # | Method dan path | Body/query | Izin |
|---|---|---|---|
| 1 | GET `/cash-bank/entries` | `legalEntityId, from, to, kind?, bankAccountId?, cursor?, limit` | cash_bank.record |
| 2 | GET `/cash-bank/entries/:entryId` | | cash_bank.record |
| 3 | POST `/cash-bank/entries` | discriminatedUnion `kind`: cash_in/cash_out `{legalEntityId, bankAccountId, counterAccountId, amountIdr, entryDate, description, reference, outletId?, idempotencyKey}`; transfer `{legalEntityId, fromBankAccountId, toBankAccountId, amountIdr, entryDate, description, reference, idempotencyKey}` | cash_bank.record |
| 4 | GET `/petty-cash/funds` | `legalEntityId, outletId?` | petty_cash.manage |
| 5 | GET `/petty-cash/entries` | `outletId, from, to, cursor?, limit` | petty_cash.manage |
| 6 | POST `/petty-cash/movements` | discriminatedUnion `kind`: topup/return `{outletId, bankAccountId, amountIdr, description, idempotencyKey}` | petty_cash.manage |
| 7 | POST `/petty-cash/entries/:entryId/post` | `{}` (retry entri yang diparkir) | petty_cash.manage |

Halaman memakai cursor keyset `(created_at, id)`, pola `accounting-cash-deposits.service.ts:119-160`.

**Lanjutan (bead baru)**: saldo dana tampil di layar pembelian sederhana untuk staf outlet. Tidak masuk kartu ini.

## Kontrak di `packages/shared/src/accounting`

- `ids.ts`: `cashBankEntryIdSchema`, `pettyCashFundIdSchema`, `pettyCashEntryIdSchema`.
- `banking.ts`, ditambahkan di bagian baru dengan kode lama tidak diubah:
  - `CASH_BANK_ENTRY_KINDS`, `cashBankEntrySchema`, `createCashBankEntryInputSchema` (discriminatedUnion), `cashBankEntryQuerySchema`.
  - `pettyCashFundSchema`, `PETTY_CASH_ENTRY_KINDS`, `pettyCashJournalStatusSchema`, `pettyCashEntrySchema`, `pettyCashMovementInputSchema`.
  - Fungsi murni:
    - `cashBankJournalLines(input, {bankGl, toBankGl, counter})` memakai `assertJournalBalanced`.
    - `applyPettyCashDelta(balance, delta)` melempar `PETTY_CASH_INSUFFICIENT`.
- `errors.ts`: `PETTY_CASH_INSUFFICIENT: 422`, `CASH_BANK_COUNTER_ACCOUNT_INVALID: 422`, beserta pesan berbahasa Indonesia.
- `journal.ts`: 5 source type di atas.
- `posting-rules.ts`: 2 aturan dokumen di atas.
- `endpoints.ts`: 7 endpoint, ditambahkan ke daftar ekspor di sekitar baris 860.

## Pembagian berkas (tidak bertumpuk)

**C, kontrak dan migrasi. Jalan pertama; A dan B mulai sesudah C di-commit.**
- `packages/shared/src/accounting/{banking,ids,errors,journal,posting-rules,endpoints}.ts`
- `packages/shared/src/access/{permissions,roles}.ts`
- `apps/api/src/db/schema/accounting-cash-bank-entries.ts` (baru), `accounting-cash-bank-entries.custom.sql` (baru), `schema/index.ts`
- `apps/api/drizzle/0484_*.sql`, `0485_*.sql`, `meta/_journal.json`, `meta/0484_snapshot.json`, `meta/0485_snapshot.json`
- Test murni: `packages/shared/src/accounting/cash-bank-entries.test.ts` (baru)

**A, API.**
- Service baru: `apps/api/src/services/accounting-cash-bank-entries.service.ts`, `accounting-petty-cash.service.ts`
- Route baru: `apps/api/src/routes/accounting-cash-bank-entries.routes.ts`, `accounting-petty-cash.routes.ts`
- Diubah: `routes/index.ts` (dua `apiRouter.use("/accounting", ...)` di dekat baris 325), `services/petty-purchase.service.ts` (satu panggilan draw), `services/accounting-ap-fa-shared.ts` (tambah `AUDIT_SAFE_FIELDS`: `balanceAfterIdr`, `journalStatus`, `parkCode`)
- Test baru: `apps/api/src/test/accounting-cash-bank-entries.test.ts`, `accounting-petty-cash.test.ts`

**B, web.**
- `apps/web/src/features/ws07-cash-bank/{api,queries,hooks,mock}.ts`
- Komponen baru: `components/cash-entries-section.tsx`, `cash-entry-dialog.tsx`, `petty-cash-card.tsx`, `petty-cash-movement-dialog.tsx`, dipasang di `cash-bank-page.tsx`
- Test: `apps/web/tests/ws07-cash-bank.test.mjs`
- Mengikuti `~/.agents/team/ui-standard.md`. Layar baru butuh gerbang review UI founder; api, queries, hooks, dan mock boleh dikerjakan lebih dulu.

## Test gagal-dulu untuk 4 aturan uang founder (di berkas test A)

1. **Transfer seimbang dan idempoten**:
   - Jurnal punya Dr GL tujuan = Cr GL asal = jumlah, dengan total debit = total kredit.
   - Replay dengan kunci sama menghasilkan entri dan jurnal yang sama (hitung baris = 1).
   - Dua POST paralel dengan kunci sama (`Promise.all`) menghasilkan 1 baris.
   - Kunci sama dengan jumlah berbeda: 409 `IDEMPOTENCY_KEY_REUSED`.
   - Rekening asal = tujuan, atau GL keduanya sama: 422.
2. **Kas kecil tidak bisa minus**:
   - Dana 100.000, return 150.000: 422 `PETTY_CASH_INSUFFICIENT`. Saldo tetap, tanpa entri, tanpa jurnal.
   - Pembelian sederhana 150.000 pada dana 100.000: 422. Tidak ada baris pembelian dan tidak ada event outbox.
   - Dua pembelian paralel masing-masing 60.000 pada dana 100.000: tepat satu yang lolos, saldo 40.000.
   - `UPDATE` langsung ke saldo negatif lewat koneksi owner: ditolak oleh CHECK.
3. **Akses**:
   - Tanpa `accounting.cash_bank.record` atau `accounting.petty_cash.manage`: 403.
   - Pengguna finance dengan cakupan outlet yang POST cash_bank atau movement: 403 `OUTLET_OUT_OF_SCOPE`.
   - Rekening atau entri milik tenant lain: 404.
   - GET entri untuk outlet di luar jangkauan: kosong atau 404.
   - Retry post untuk entri milik outlet lain: 404.
4. **Satu dokumen, satu jurnal**:
   - Retry post dua kali menghasilkan id jurnal yang sama.
   - Entri diparkir (peta `petty_cash` dihapus), peta dipasang lagi, lalu post: tepat 1 jurnal `petty_cash_topup`.
   - Entri `purchase` tidak punya `journal_entry_id`. Sesudah consumer auto-journal jalan, jurnal dengan `source_type='petty_purchase'` untuk pembelian itu tepat 1.
   - Jumlah jurnal per `source_id` = 1 untuk setiap kind.
- **Invarian**: `balance_idr` = Σtopup − Σreturn − Σpurchase per dana, dicek sesudah setiap skenario.

## Risiko

- `accountOverrides` sekarang dipakai untuk `bank` (diturunkan dari server, bukan input pengguna). Jangan pernah mengisinya dari body.
- Mengikat pembelian sederhana ke dana kas kecil mengubah jalur uang yang sudah ada. Test `petty-purchase*` lama harus tetap hijau, karena outlet tanpa dana tidak berubah perilakunya.
- Test yang menghitung aturan posting atau source type (snapshot atau jumlah) mungkin perlu diperbarui. Ubah hanya angka hitungannya; jangan melonggarkan batas apa pun.
- Jurnal pembelian yang diparkir (async) membuat GL 1102 tertinggal dari subledger, sementara saldo dana tetap benar. Rekonsiliasi kas kecil terhadap GL masuk bead lanjutan.
