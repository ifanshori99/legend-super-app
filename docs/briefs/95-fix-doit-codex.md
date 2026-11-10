# Brief 95: perbaiki temuan second-opinion Codex pada DOIT (tingkat K: uang)

Untuk thread asal G8x09 (Fix review K DOIT). Cabang `ws/doit-provider`, SHA 8fed84ef. Ikuti `docs/briefs/_TEMPLATE-workstream.md`: implementer per temuan, test-writer, semua paralel.

## Temuan
1. P1, `apps/api/src/services/payment-doit.ts:477`: DOIT bisa sudah menerima POST, lalu respons hilang atau insert lokal gagal. Saat retry, UUID intent baru dibuat dan replay key lama ditolak pemeriksaan `reference`. Akibatnya pembayaran remote yatim.
   - Simpan intent dan payload yang stabil sebelum POST.
   - Pulihkan dengan key dan reference yang sama.
2. P1, `apps/api/src/services/payment.service.ts:1741`: error gateway setelah expiry membuat intent `expired`. Bila outage lebih dari 60 detik, intent keluar dari polling. Bila webhook lunas juga hilang, uang tidak tercatat.
   - Pertahankan retry rekonsiliasi dengan backoff sampai status definitif dari provider.
3. P2, `apps/api/src/services/payment-doit-wire.ts:274`: polling membuang `paid_at`. Pembayaran 09:59 yang dicek 10:01 tercatat 10:01 dan diberi tanda `late_payment`. Webhook sesudahnya dianggap duplikat, jadi tidak membetulkannya.
   - Teruskan waktu bayar provider lewat `GatewayPaymentStatus` dan pakai saat konfirmasi.

## Bukti selesai
- Test regresi tiap temuan.
- Test terdampak lewat `test-runner`.
- `heavy pnpm check` sekali di akhir, di latar.
- Reviewer Opus dan architect paralel.
- Commit lokal saja.
