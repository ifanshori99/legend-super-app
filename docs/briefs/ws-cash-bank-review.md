# Review architect xhigh ws/cash-bank (52346c44..0f4b3317) — tanpa Critical/High

M1. Entri kas kecil diparkir tidak bisa diposting setelah periodenya tutup. accounting-petty-cash.service.ts:496 retry pakai row.entryDate -> PERIOD_CLOSED terus. Fix: pola auto-journal (accounting-auto-journal-consumer.ts:606-615, wouldPostingBeBlockedByClosedPeriod + resolveAutoJournalDate): posting ke periode terbuka dengan lateAdjustmentFrom = row.entryDate. Test: parkir, tutup periode, pasang peta, retry -> tepat 1 jurnal, bertanggal periode terbuka.

M2 + L1. Akun lawan kas masuk/keluar terlalu bebas (accounting-cash-bank-entries.service.ts:231,303). Fix: satu query denylist per badan usaha: tolak akun lawan yang (a) dipetakan ke role milik subledger: accounts_receivable, accounts_payable, salaries_payable, tax_payable_*, customer_deposit, edc_clearing, inventory* (cek nama role persis di posting-rules/coa), (b) gl_account_id rekening bank mana pun di badan usaha itu, (c) dipetakan ke petty_cash, cash_on_hand, bank. Kode CASH_BANK_COUNTER_ACCOUNT_INVALID 422. Test tiap kelompok.

L2. outletId tag tidak dicek terhadap badan usaha (accounting-cash-bank-entries.service.ts:306). Fix: outlets.legalEntityId harus = input.legalEntityId, selain itu 422. Test.

Catatan (bead terpisah): payroll/pinjaman/reimburse tunai kredit 1102 tanpa menarik dana kas kecil (posting-rules.ts:480,493,504,528).
