# 185b hasil architect 1 (review ganda Claude, brief 225)

Kode: `milestone/m1` 94d769c6. Kartu: legend-x1i1h, legend-j0ag5, legend-leqj6, legend-2dnh (review).

Hasil: **Bersih** (tidak ada P1/P2 baru).

## Yang diperiksa
- Jumlah refund late payment: `pos-order-late-payment.ts:108-116` dan `qr-order-late-payment.ts:98-104` `amount = cap - (reserved - pending)`; refund pending lain tidak dipotong. Approval: `payment-refund.service.ts:349-363`, refund late payment (dikenali dari kunci `payment_admin_idempotency`, 412-427, bukan dari requester) mengabaikan pending lain; approval lain menghitung semua termasuk late payment yang pending. Urutan apa pun memberi total yang sama. Contoh intent 100.000, refund P 30.000 pending: L = 100.000. L dulu: L approved, P gagal `cap_exceeded`. P dulu: P gagal (reserved 130.000 > 100.000), L approved. Tamu menerima 100.000 di kedua urutan.
- Void QRIS ke `customer_deposit`: `accounting-auto-journal-void.ts:111-186` hanya tunai dan gateway ber-intent dengan receipt terposting; EDC, poin, gateway tanpa intent, DP: parkir. Void baru untuk tender non-tunai sudah ditolak di POS (`pos-order-corrections.ts:266-277`), jadi jalur ini hanya untuk void lama.
- `backingStatesOf` (`accounting-auto-journal-guards.ts:117-303`): jurnal sale/refund POS yang di-reverse (ACC-01) dibaca `none`; SALE_MISSING non-retryable dibaca `pending` hanya bila sale-nya tidak di-reverse. `intentBackedAt` (668-808) mengeluarkan sale yang void-nya terposting; void pending membuat retryable.
- Isolasi tenant: semua query di atas memfilter `tenant_id`.

## Catatan P3
1. Refund late payment hanya dibuat sekali per intent. Bila approver menolaknya, tidak ada jalur sistem untuk membuatnya lagi; untuk intent QR yang membawa `orderId`, refund buatan staf gagal `source_document` (`payment-refund.service.ts:331-342`). Uang tamu tertahan sampai koreksi admin. Saran: izinkan re-file late payment setelah `rejected`/`failed`, atau aksi ops khusus.
2. `accounting-auto-journal-void.ts:169-179` membaca status receipt saat void diproses, bukan saat sale diposting. Sale yang diposting ke `gateway_clearing` lalu receipt terposting belakangan tetap konsisten (reversal mengkredit `gateway_clearing`), tetapi komentar berkas menyebut kredit ke `customer_deposit`. Hanya relevan untuk void lama.
