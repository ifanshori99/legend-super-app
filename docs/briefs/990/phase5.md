# 990 fase 5: clearance terikat sidik flag (legend-hklnq) + fee tersegel (legend-w9od2)

Keputusan CTO 17 Nov: (1) flag yang sudah dibersihkan hanya tetap bersih selama data yang di-flag tidak berubah; recon yang menaikkan key sama dengan sidik berbeda membuka ulang flag dan menahan lagi (aturan membatasi). (4) recon membandingkan `fee_idr` posting overpaid dengan fee tersegel; palsu = flag + tahan. Migrasi HANYA `0584` (nomor kerja). Kode error baru: PAYOUT-91 saja.

Konteks: `docs/briefs/sub-990-payout-lanjutan.md`, `docs/briefs/990/i1-contract.md` (clearance), 0580/0581 (tabel clearance, propose/approve, `app.payout_payslip_held_by_recon`), `app.payout_recon_flag` terkini di `apps/api/drizzle/0432_payout_batch_approve_grant.sql:239-268` (key `(tenant,kind,operation_id,item_id,reason)`, ON CONFLICT DO NOTHING, tanpa detail), `slipsHeldByReconException` di `apps/api/src/services/payroll-payout.service.ts:~1030`.

## Kontrak A (legend-hklnq), migrasi 0584

- `app.payout_recon_flag_fingerprint(p_tenant uuid, p_exception uuid) RETURNS varchar` (SECURITY DEFINER, owner legend_payout, STABLE): sha256 hex dari jsonb kanonik `{item, attestations, postings}`:
  - `item`: `to_jsonb(item)` baris `payroll_disbursement_items` milik exception (NULL bila item_id NULL), DIKURANGI `updated_at`, `pii_key_version`, dan semua kolom berakhiran `_encrypted` (reseal kunci tidak boleh membuka ulang; nilainya dijaga guard).
  - `attestations`: `jsonb_agg(to_jsonb(a) ORDER BY a.id)` dari `payroll_payout_attestations` tenant sama dengan `operation_id = exception.operation_id` (array kosong bila tidak ada).
  - `postings`: `jsonb_agg(to_jsonb(p) - 'updated_at' ORDER BY p.id)` dari `payroll_payout_gl_postings` tenant sama untuk item itu (bila tabel punya kolom item; cek skema).
- Tabel baru insert-only `payroll_payout_recon_flag_sightings` (id uuid pk, tenant_id, exception_id FK inline ke exceptions (tenant,id), flag_sha256 varchar(64) CHECK `^[0-9a-f]{64}$`, seen_at timestamptz default now). RLS `app.enforce_tenant_rls`, legend_app SELECT, legend_payout SELECT+INSERT, guard UPDATE/DELETE/TRUNCATE. Index (tenant_id, exception_id, seen_at DESC).
- "Sidik terkini" exception = `flag_sha256` sighting terakhir (seen_at, lalu id).
- `app.payout_recon_flag` diganti (signature sama): setelah insert/konflik, hitung sidik; INSERT sighting bila belum ada atau berbeda dari sidik terkini.
- Backfill di 0584 (sebagai migrator): satu sighting per exception yang sudah ada.
- `payroll_payout_recon_clearances`: kolom baru `flag_sha256 varchar(64) NOT NULL` (CHECK hex 64). Unique `(tenant_id, exception_id)` diganti `(tenant_id, exception_id, flag_sha256)`. Tabel belum ada di produksi (0580 satu rilis), jadi NOT NULL tanpa default aman; bila ada baris di DB test, isi dari sidik terkini dulu.
- `payout_recon_clear_propose`: mengikat clearance ke sidik terkini (bila belum ada sighting, hitung + insert dulu). Idempoten per (exception, sidik): clearance terbuka dengan sidik sama mengembalikan id-nya.
- `payout_recon_clear_approve`: hitung sidik LIVE; berbeda dari `clearance.flag_sha256` → `PAYOUT-91: the flagged data changed since the clearance was proposed`, tidak ada yang berubah, grant tidak terpakai (ikuti pola error lain).
- Tahanan: exception menahan payslip kecuali ada clearance disetujui dengan `flag_sha256 = sidik terkini` exception itu. Berlaku di `app.payout_payslip_held_by_recon` DAN `slipsHeldByReconException` (TS) — logika identik.
- API: PAYOUT-91 → 409 `PAYOUT_RECON_FLAG_CHANGED` (pesan Indonesia di katalog i18n yang sama dengan pesan clearance lain). DTO flag (`PayoutReconFlagDto`) tambah `reopened: boolean` (ada clearance disetujui untuk exception ini tetapi dengan sidik lain).

## Kontrak B (legend-w9od2), tanpa migrasi

Recon TS (`apps/api/src/services/payroll-payout-recon.service.ts`, bagian jurnal fee ~1414): untuk posting overpaid dengan `fee_idr` NOT NULL:

- dekripsi fee tersegel item (`payroll_disbursement_items.fee_idr_encrypted`, pola dekripsi yang sama dengan `safeFee` di `payroll-payout-overpaid.service.ts:79`); `fee_idr` posting ≠ fee tersegel → flag reason baru `fee_sealed_mismatch` pada item itu. Dekripsi gagal / fee tersegel tidak ada sementara `fee_idr` > 0 → juga `fee_sealed_mismatch` (fail closed).
- fee > 0 dan jurnal `payroll-payout-overpaid-fee:<item>` ada: total debit jurnal ≠ `fee_idr` → reason baru `fee_journal_amount`.
- Kind flag: pakai kind yang sudah dipakai flag jurnal fee (jangan tambah kind). Flag lewat `app.payout_recon_flag` biasa, jadi payslip tertahan.

## Test gagal-dulu (test-writer, berkas baru)

`apps/api/src/test/payroll-payout-990-recon-reopen.test.ts`:

1. clearance disetujui → slip lepas; data item berubah (mis. ubah kolom non-volatile item lewat owner dengan guard off, atau tambah attestation untuk operasi itu) → recon jalan ulang → slip tertahan lagi (batch baru 409 / `app.payout_payslip_held_by_recon` true), DTO `reopened: true`, ada 2 sighting.
2. recon ulang tanpa perubahan data → tidak ada sighting baru, slip tetap lepas.
3. reseal/ubah hanya `updated_at` → tidak membuka ulang.
4. data berubah antara propose dan approve → approve PAYOUT-91 (SQL) / 409 `PAYOUT_RECON_FLAG_CHANGED` (HTTP), clearance tetap belum disetujui, slip tertahan; propose baru (sidik baru) oleh orang lain + approve orang ketiga/berbeda → lepas.
5. legend_app tidak bisa INSERT/UPDATE/DELETE sighting; tenant lain tidak terpengaruh.
   `apps/api/src/test/payroll-payout-990-fee-sealed.test.ts`:
6. posting overpaid dengan `fee_idr` 0 padahal fee tersegel > 0 (palsukan lewat owner, guard off) → recon flag `fee_sealed_mismatch` pada item, payslip tertahan.
7. `fee_idr` > fee tersegel → flag sama.
8. jurnal fee nominal ≠ `fee_idr` (palsukan baris jurnal) → `fee_journal_amount`.
9. alur sah (fee sama, jurnal sama) → tidak ada flag fee.
10. tenant lain tidak ditandai.
    Assert reason + item_id, bukan kind. Pakai fixture yang ada (`payroll-payout-fixtures.ts`, test 990-fee-commit, 990-recon-clear, 905-recon).

## Fase 6: temuan architect (keputusan engineer, aturan membatasi; dilaporkan ke CTO)

- P2-2 (dipilih yang membatasi): tahanan membandingkan sidik LIVE. Exception menahan kecuali ada clearance disetujui dengan `flag_sha256 = app.payout_recon_flag_fingerprint(tenant, exception)` saat ini. `GRANT EXECUTE` fungsi sidik ke legend_app di 0584; `app.payout_payslip_held_by_recon` dan `slipsHeldByReconException` (TS memanggil fungsi SQL yang sama) identik. `reopened` di DTO = ada clearance disetujui tapi tidak ada yang cocok dengan sidik live. Data berubah setelah approve = tertahan lagi seketika.
- P2-1: `fee_idr = 0` dengan fee tersegel > 0 sah HANYA bila jurnal `overpaidJournalKey(item)` tidak ada DAN akuntansi tenant mati (logika yang sama dengan `payroll-payout-overpaid.service.ts:229,256-258`); selain itu `fee_sealed_mismatch`. Posting overpaid dengan `fee_idr` NULL setelah trusted_since: fail closed, `fee_sealed_mismatch`.
- P3: `payout_recon_flag_see` diserialisasi dengan `pg_advisory_xact_lock` per exception (kunci hash tenant+exception) sebelum membaca sighting terakhir. Sidik posting membuang `updated_at`, `pii_key_version`, `*_encrypted` (diterima: nilai dijaga guard). Jurnal tidak masuk sidik (journal_lines append-only, 0027).

Pembagian (berkas tidak bertumpuk):

- J1: `apps/api/drizzle/0584_payout_990_flag_fingerprint.sql` (edit di tempat, belum rilis) + `apps/api/src/services/payroll-payout.service.ts` (`slipsHeldByReconException`) + clearance service (DTO `reopened`) — P2-2 + advisory lock.
- J2: `apps/api/src/services/payroll-payout-recon.service.ts` + `apps/api/src/test/payroll-payout-990-fee-sealed.test.ts` — P2-1 + NULL; test baru: legit akuntansi mati (fee 0, tanpa jurnal) tidak ditandai; palsu fee 0 dengan akuntansi nyala ditandai; NULL ditandai.
- J3: `apps/api/src/test/payroll-payout-990-recon-reopen.test.ts` — test: recon SUNGGUHAN (service recon, bukan `flagCall` sintetis) dua kali tanpa perubahan → tidak ada sighting baru; clearance disetujui lalu data berubah TANPA recon → slip langsung tertahan (`app.payout_payslip_held_by_recon` true dan batch baru 409), `reopened: true`. Sesuaikan test lama yang mengasumsikan tahanan hanya kembali setelah recon.

- P3 diterima: `accountingOn` dibaca dari setelan tenant saat recon jalan, bukan saat posting dibuat. Salah tanda hanya ke arah membatasi (item sah bisa tertandai `fee_sealed_mismatch`), dan dilepas lewat clearance. Fee 0 sah juga mensyaratkan tidak ada jurnal fee `payroll-payout-overpaid-fee:<item>`; selain itu `fee_sealed_mismatch`.
- `resolve_propose` atas item yang ditandai butuh clearance baru (sidik live) sebelum `resolve_approve`.
