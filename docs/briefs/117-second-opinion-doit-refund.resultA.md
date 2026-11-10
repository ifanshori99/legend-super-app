# Hasil Codex 117 Run A: DOIT refund (G6kgt, akun Codex #3, 9 Nov 15:45)

`ws/doit-refund` HEAD 5316426a, basis 176c8912. 4 file test terarah 167/167 lulus. Belum: transaksi DOIT nyata. Run B belum dijalankan (wajib sesi dan akun Codex lain: akun #2).

## Temuan
- **P1, `apps/api/src/services/payment-doit-wire.ts:429` (invariant 4 dan 6)**: refund Rp50.000 untuk `pay_EXPECTED`/`intent_EXPECTED` menerima respons `{id:"pay_OTHER",status:"refunded",amount:50000,reference:"intent_OTHER"}` sebagai sukses. ID berbeda membuat objek payment jatuh ke cabang "refund object" tanpa cek identitas; `payment-refund.service.ts:1451` lalu menandai refund sasaran `completed`. Respons refund dengan `payment_id` berbeda juga diterima sebagai `succeeded` maupun `failed`. Direproduksi lewat parser. Fix: schema payment dan refund dibedakan eksplisit, cocokkan identifier pembayaran/reference, mismatch atau bentuk ambigu = unknown. Tambah test regresi.
