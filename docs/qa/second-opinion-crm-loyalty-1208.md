# SO CRM + loyalty (1208, 20 Nov, architect, int/batch100)
Verdict: LOLOS (tanpa P0-P2)
## P3 Event earn yang diparkir tidak pernah dilepas
`apps/api/src/services/loyalty-earn-consumer.ts:206-222`: mismatch/ambiguous badan usaha atau refund sebelum payment -> `loyalty_earn_parked`, tidak pernah dibaca lagi. Member kehilangan poin diam-diam; outlet tidak rugi. Usulan: tampilan parkir untuk owner + replay (urut payment lalu refund). Bead P3.
Dicek aman: ledger poin idempoten + restore ke grant asal + expiry FIFO; bayar poin di POS (cloud, bukti hadir, QR 120 dtk sekali pakai terikat bill/jumlah/saldo, nilai <= sisa bill); refund bill berpoin ditolak (`pos-order-corrections.ts:1004`); reversal earn proporsional dibulatkan merugikan member; cap harian di bawah lock; redeem reward stok/limit/idempoten; voucher sekali pakai, limit + budget atomik, kode ketik ditolak di edge; referral; merge identitas pindah bukan jumlah.
Belum: aritmetika `crm-promo-refund.ts`/`order-promo-refund.ts`, cap `apology-voucher.service.ts`, `table-claim.service.ts`, misi + tier, jurnal loyalty, `member-points-redeem.service.ts` >400, RLS `crm-member.custom.sql`.
