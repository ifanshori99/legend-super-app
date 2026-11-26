# Review K C2a Duitku .40/.41 (ws/1272-c2a 88e888198)

Reviewer: architect (Opus xhigh), 27 Nov. Baca kode saja. Hasil: **LULUS**, 0 P1, 1 P2, 2 P3.

## Aman
Tautan tanpa order dikunci `FOR UPDATE` sebelum cek ulang, orphan `failed` tetap memblok; routing default null = nonaktif, tenant DOIT saja tanpa aturan gagal tertutup 503; VA/bank_transfer `max(link, now+10m)` (`payment.service.ts:1351`); replay kunci sama tidak 409; floor `expiryPeriod` (`payment-duitku.ts:487`).

## P2
`payment.service.ts:1009-1019`: QRIS tidak bisa dibatalkan di gateway (DOIT/Duitku tanpa `cancel`), jadi QRIS yang diganti kode baru di tautan DP tetap bisa dibayar sampai 10 menit (tamu bayar dua kali, refund manual).

## P3
1. `payment.service.ts:1285-1316`: tautan DP membaca gateway walau void pasti kosong; baca gagal = 503, mestinya 409.
2. `payment-gateway-select.ts:265`: default null tanpa aturan jatuh ke `manual` `down` tanpa `unconfigured`, membuka insiden palsu.

## Keputusan CTO 27 Nov
- P2: aturan paling ketat, QRIS hidup juga 409 di tautan DP (hapus `ne(method,"qris")`). Test: QRIS hidup lalu VA = 409, `gw.created` 1.
- P3 1-2 dibetulkan sekarang; test DP VA hidup + `failMethods` = 409; default null `syncGatewayHealth` tanpa insiden; dua VA paralel kunci beda = satu tersimpan + 409 + orphan; VA `pending` lewat waktu belum final tetap 409.
- Runbook rilis: `gateway:set duitku --enabled --default`, `gateway:set doit --disabled`, periksa aturan routing tiap tenant.
