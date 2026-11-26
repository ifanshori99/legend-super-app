# Review K X1 EDC manual jalur normal (ws/1272-x1 838260a54)

Reviewer: architect (Opus, xhigh), 27 Nov. Baca kode saja. Hasil: **LULUS**, 0 P1, 2 P2, 3 P3. Perbaikan dicek CTO tanpa architect ulang.

## Aman
- Nominal dari server (`pos-order-payment.ts:610`), body bernominal 422. Ref slip wajib 6-24, tolak mirip PAN.
- Satu slip sekali per tenant: kunci slip (`pos-edc-standalone.ts:136-156`) + index unik `standalone:slip:<ref>` (`:203`).
- Atribusi `capturedBy`, shift `coalesce(tender, order)`, audit `tender_added`. Tender lain ditolak (`pos-order-payment.ts:305-311`).
- Alert selisih di belakang `payment.reconcile` + MFA. Job overdue idempoten.
- Hapus PIN supervisor wajar (Moka/Majoo/Pawoon: EDC terpisah = metode biasa + ref + rekonsiliasi harian).

## P2
1. `edc-reconciliation.service.ts:291-292`: baris manual cocok hanya dengan nominal; ref palsu bisa dicocokkan ke baris bank mana pun. Fix: `mode === "standalone"` wajib `source === "bank_statement"` dan `evidence.rrn` = `row.rrn` (dinormalkan); beda = tolak + alert selisih. Test.
2. `edc-reconciliation-alert.ts:150-151`: 500 baris terlama tanpa mengecualikan shift yang sudah di-alert -> shift baru tak pernah di-alert. Fix: kelompokkan per shift di SQL, kecualikan shift ber-alert. Test > 500 baris.

## P3
3. `:172-176` kunci alert per shift selamanya; muat hari jatuh tempo.
4. `edc-reconciliation.service.ts:430` alert selisih hanya dari HTTP; impor CSV X2 wajib memanggilnya.
5. Layar kasir `ws04-pos-kasir/api.ts:809-881` masih minta PIN: kartu UI sebelum rilis.

## Keputusan CTO 27 Nov
- P2 1, P2 2, P3 3 dikerjakan sekarang. P3 4 + cocokkan total struk settlement EDC per terminal di rekap Tutup Hari (sekarang `settlement` null) masuk X2 (legend-wasr7.11). P3 5 kartu UI kasir X1-UI.
