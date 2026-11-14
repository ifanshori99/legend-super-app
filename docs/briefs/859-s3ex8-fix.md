# 859 s3ex8 perbaikan temuan architect (CTO, 15 Nov)

Cabang fix/s3ex8-859 (858e84324). Architect xhigh FAIL P2: dana resolved yang buktinya berubah (mis. refund 20k lalu bukti dikoreksi jadi 10k) tidak lagi ditandai, jadi finance tidak melihatnya.

Keputusan CTO: status tetap `resolved`, tambah field boolean `evidenceMismatch` (dari variabel `needsReview` yang sudah ada di build).
- packages/shared/src/payment/admin.ts: view schema.
- apps/api/src/services/payment-admin-funds.service.ts (build, sekitar :150).
- apps/web/src/features/ws05-payment-admin/components/unallocated-panel.tsx: badge "Bukti berubah" dan filter `needs_review` juga mencakup resolved dengan evidenceMismatch. Teks baru daftarkan di katalog (tests/text-contract.test.mjs).
- Test gagal-dulu di apps/api/src/test/payment-admin-multi-fund.test.ts: skenario tunggal (satu dana) field true.
- P3: komentar di payment-multi-fund.test.ts:428-432 bahwa credit dibuat lewat UPDATE karena API 503.
Pra-gate AGENTS.md (typecheck api + web lewat heavy). Commit + push tanpa force. Lapor sha.
