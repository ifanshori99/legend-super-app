# Brief: engineer — perbaikan review K ws/doit-provider (be35d6b)

Peran: `~/.agents/team/roles/engineer.md`. Worktree `.worktrees/doit-provider`, cabang `ws/doit-provider`. Jangan baca `.env*`, jangan `pkill`.

## Temuan reviewer Opus
1. Tinggi — `services/payment-doit.ts:96-101,223`: kredensial DOIT dipilih dari cakupan pemanggil (`singleOutletId(context)`), bukan outlet tagihan. QR-order pakai konteks tenant (`routes/qr-order.routes.ts:52-56`) → intent dibuat di akun tenant, webhook dicek dengan integrasi outlet (`payment-webhook.service.ts:277-297,474`) → `REFERENCE_MISMATCH`, polling ke akun salah → intent `expired`, uang tamu masuk tapi pesanan tak lunas. Fix: adapter pilih kredensial dari `outletId` tagihan/intent (field `outletId` di `GatewayIntentRequest`). Test: konteks tenant + integrasi per outlet.
2. Sedang — `services/payment.service.ts:836`: polling tidak mencatat dana yang tak bisa melunasi (409 `AMOUNT_MISMATCH`), langsung expire. Fix: pakai logika `recordUnsettledFunds` yang sama dengan webhook.
3. Rendah — `payment.service.ts:1453,1462`: polling berhenti setelah 3 error berturut dan selalu mulai dari intent tertua → intent lain tak pernah dipoll. Fix: urut per waktu terakhir dipoll / lewati yang error.
4. Rendah — `payment-webhook.service.ts:497-498`, `routes/payment-webhook.routes.ts:310`: `paid` tanpa `paid_amount` disimpan failed tapi dijawab 200. Fix: 5xx untuk failed, atau hapus klaim kirim ulang.
5. Rendah — `payment-webhook.service.ts:180`: `readPaidAt` jatuh ke `new Date()` (bukan `now`) → retry lama menandai `late_payment`. Fix: parse payload atau tolak MALFORMED.
6. Migration bentrok dengan main (0063–0067): merge `main`, renumber via drizzle-kit.

## Temuan architect
(menyusul)

## Bukti selesai
Test regresi per temuan; gerbang penuh; reviewer subagent konteks segar; commit lokal. Laporan: SHA, test, migration lama→baru.
