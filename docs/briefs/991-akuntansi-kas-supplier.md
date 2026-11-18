# Brief 991: bayar supplier ber-approval, kas kecil vs GL

Worktree ini, base 1b0fd2a9e. Migrasi nomor kerja 0585-0589 (renumber oleh merge train; terakhir di repo 0442). FK tabel baru inline di CREATE TABLE. Baca `bd show <id>` tiap kartu. Jangan sentuh payout, refund, charge, DOIT, payroll, akses perangkat, fasilitas.

Aturan uang: tidak ada pembayaran melebihi tagihan, tidak dobel (termasuk bersamaan), di atas batas wajib disetujui orang lain (pembuat != penyetuju), jurnal seimbang, persediaan tidak dobel, tenant/outlet lain tidak tersentuh. Ragu: blokir, catat keputusan.

Pemisahan: test-writer HANYA menulis `apps/api/src/test/*` (dan tests root bila perlu), TIDAK menjalankan test, TIDAK mengubah src. implementer HANYA mengubah file non-test, TIDAK menjalankan tsc/vitest (token heavy dipegang orchestrator), TIDAK menulis test. Satu kartu satu pemilik file.

## A. legend-xxqz3 (pemilik: schema/supplier-payments.ts, migrasi 0585, services/purchasing-supplier-payment.service.ts, routes tambahan di purchasing-invoice.routes.ts, purchasing-approval-consumer.ts, validators/types shared supplier-payment)

Peta: `paySupplierInvoiceInTransaction` accounting-ap.service.ts:262 (settle + jurnal Dr AP / Cr bank, key `ap-pay:${settlementId}`); settle accounting-open-items.service.ts:253 (FOR UPDATE, tolak > outstanding); action `supplier_payment` sudah ada di APPROVAL_ACTIONS; permission `accounting.supplier_payment.process`; contoh consumer `purchasing-approval-consumer.ts`; contoh open `inventory-count.service.ts:1058`; `openApprovalRequest` platform-approval.service.ts:520 (fail-closed bila policy hilang).
Desain:

- Tabel `supplier_payments` (id ULID, tenant, outlet, legal_entity, supplier_invoice_id, amount_idr, paid_on, status pending_approval|approved|paid|rejected|cancelled, requested_by, approval_chain_id, settlement/journal ref, idempotency_key; unique (tenant, idempotency_key); RLS; CHECK amount > 0).
- `requestSupplierPayment`: kunci faktur (FOR UPDATE), tolak bila amount + SUM(pembayaran pending/approved belum paid milik faktur itu) > outstanding; insert; `openApprovalRequest` (actionType supplier_payment, objectType supplier_payment); required:false => bayar langsung lewat paySupplierInvoiceInTransaction. Kebijakan hilang => blokir (tidak bayar).
- Consumer `approval.resolved` objectType supplier_payment: kunci baris pembayaran, abaikan replay, tolak bila approver == requested_by, resolved approved => paySupplierInvoiceInTransaction + status paid; rejected => rejected. Hitung ulang outstanding saat eksekusi.
- HTTP: `POST /supplier-invoices/:id/payments` (body: amountIdr integer, paidOn YYYY-MM-DD, + field bank/akun yang dibutuhkan paySupplierInvoiceInTransaction, idempotencyKey), `GET /supplier-invoices/:id/payments`. Respons: {id, status}. Ikuti prefix dan guard routes purchasing-invoice yang ada (requireAuth, requireTrustedOrigin, jsonBody, permission).
- Tabel baru: daftarkan di `data-import-registry.test.ts` (diakui) dan tes cakupan tabel schema bila ada; tambah izin/label/katalog bila perlu.

## B. legend-a4z2f (pemilik: accounting-petty-cash.service.ts, accounting-petty-cash.routes.ts, validator/DTO shared petty reconciliation; TANPA migrasi bila tidak perlu)

Divergensi: posting-rules.ts payroll.paid (:492,:516), loan (:564,:575), reimbursement (:599) kredit 1102 tanpa `changeBalance` => fund >= GL; jurnal pembelian diparkir => GL tertinggal; `return` hanya dicek terhadap fund (`createPettyCashMovement` ~:534).
Desain: `GET /petty-cash/reconciliation?legalEntityId&outletId` (read-only; permission baca akuntansi yang ada): {fundIdr, glIdr, diffIdr, parkedEntries, nonPettyCredits1102}. GL = SUM debit - kredit akun role petty_cash pada jurnal posted untuk scope itu. Guard: `return` (dan penarikan lain) ditolak bila amount > min(fund, GL) dengan kode `PETTY_CASH_GL_INSUFFICIENT`, dihitung di dalam kunci baris fund. Bila GL 1102 hanya per legal entity (tanpa dimensi outlet): bandingkan di tingkat entity dan catat sebagai keputusan untuk CTO (konservatif: blokir).

## C. legend-4qowr (pemilik: packages/shared/src/access/approval.ts, i18n ws01-approvals.ts + access.ts, apps/web/src/features/ws01-approvals/logic.ts, accounting-cash-bank-entries.service.ts, approval consumer baru `cash-bank-approval-consumer.ts` + registrasi worker, migrasi 0586 backfill policy, seed access.service.ts/seed-dev-tenant.ts; tests/legend-g6d.test.mjs + tests/access-contract.test.mjs hanya bila perlu diperbarui)

Baca `docs/briefs/sub-cash-out-approval.md`. Q7 sudah ada: createCashBankEntry (:348) menaruh baris pending_approval; approveCashBankEntry (:609)/rejectCashBankEntry (:721) sudah menjaga CASH_OUT_SELF_APPROVAL, idempoten, key `cb:<id>`. Sisa: action `cash_out` di APPROVAL_ACTIONS; ACTION_MODULE `cash_out: "finance"`; label `cash_out: "Kas keluar"` di ws01-approvals.ts dan access.ts; policy default per tenant (ikuti pola cash_shift_close: DEFAULT_*_POLICIES, access.service.ts, seed-dev-tenant.ts, migrasi backfill seperti 0145 termasuk NO FORCE RLS); openApprovalRequest saat pengajuan (objectType cash_bank_entry); consumer memanggil approve/reject yang ada. JANGAN duplikasi jurnal; JANGAN sentuh data-import-registry.test.ts (milik A).

## D. legend-efdx6 (pemilik: apps/web/src/features/ws06-purchasing/{receiving-api.ts,receiving-hooks.ts,components/receiving-list-page.tsx, komponen dialog baru}, packages/shared/src/i18n/messages/ws06-receiving.ts)

Endpoint `journalizeGoodsReceipt` (shared/inventory/purchasing/endpoints.ts:691) belum dipakai web. Tambah `useJournalizeGoodsReceipt` (useInvalidatingMutation), tombol "Jurnalkan penerimaan" di sel aksi receiving-list-page.tsx:394-402 (hanya bila izin accounting.journal.post), dialog konfirmasi (pola edc-reconciliation/components/confirm-dialog.tsx, ada centang pengakuan) dengan peringatan jelas: bila stok penerimaan ini sudah dimasukkan di jurnal pembuka manual, persediaan terhitung dua kali. Kode error 409 SUPPLIER_INVOICE_POSTING_DISABLED / GOODS_RECEIPT_JOURNAL_PARKED / 422 nilai 0 ditampilkan ramah. Semua teks lewat katalog `inventoryReceiving.journalize.*` (cek apakah perlu katalog bahasa lain; lolos text-contract). Ikuti `~/.agents/team/ui-standard.md`.

## E. legend-eestb (pemilik: apps/api/src/scripts/purchase-return-variance-check.ts + helper murni baru; boleh mengekstrak helper dari purchase-return.service.ts:540-602 TANPA mengubah perilakunya)

Skrip BACA-SAJA: per tenant, semua purchase_returns terposting dengan invoiced_value_idr > 0 pada PO yang fakturnya punya selisih harga (billed != nilai PO); hitung price_variance_idr seharusnya (rumus purchase-return.service.ts:602: billed - invoicedValue; billed dari slot FIFO per baris faktur) dan bandingkan dengan nilai tersimpan (0 untuk retur lama). Keluaran laporan (JSON + ringkas), hasil kosong = aman, tidak menulis apa pun. Gaya: scripts/metrics-daily-backfill.ts (USAGE, pathToFileURL, establishTenantContext, withTenant). Ekspor fungsi inti agar bisa dites.

## Test (test-writer, file terpisah)

- `src/test/supplier-payment-approval.test.ts` (A): tak bisa bayar > tagihan; dua permintaan bersamaan (Promise.all) yang totalnya > outstanding => salah satu ditolak; idempotency key sama => satu pembayaran; di atas batas pending sampai disetujui; pembuat menyetujui sendiri => ditolak; ditolak => tidak ada jurnal; jurnal seimbang (SUM debit = SUM kredit) dan satu kali; tenant/outlet lain tidak bisa melihat/bayar (404/tidak berubah); kebijakan hilang => blokir.
- `src/test/petty-cash-gl-reconciliation.test.ts` (B): payroll/loan/reimburse tunai membuat diff > 0 terlihat di laporan; return > min(fund, GL) ditolak PETTY_CASH_GL_INSUFFICIENT; return <= keduanya lolos; scope outlet/tenant lain tidak bocor.
- `src/test/cash-out-approval-inbox.test.ts` (C): kas keluar di atas batas membuat approval_requests cash_out; pembuat != penyetuju; approve => satu jurnal, ulang approve/replay => tetap satu; reject => tanpa jurnal; di bawah batas tetap langsung.
- `src/test/purchase-return-variance-check.test.ts` (E): dataset dengan retur lama bervarian terdeteksi dengan angka benar; dataset bersih => kosong; skrip tidak menulis (hitung baris sebelum/sesudah).
  Ikuti konvensi test API yang ada (ID ULID, helper brand TenantId/OutletId, path `src/test/...`). Test akan gagal-dulu karena modul/route/kolom belum ada.
