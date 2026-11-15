# 896 QRIS area akhir: perbaikan 5 P1 second opinion + temuan architect

Cabang `fix/qris-hold-so-879` (lanjutkan dari c2902fa4e, tanpa force). Tingkat K uang. Kartu: legend-ad95t, legend-xg6qk, legend-5h8ob, legend-o6q8i, legend-la1yk (`bd update --status in_progress`; saat lapor `--status review` + `bd comment`).

## Sumber
- `docs/qa/second-opinion-qris-area-final.md` (Codex, 5 P1, ada skenario dan usul test).
- Review architect xhigh CTO (16 Nov 04:00), tumpang tindih dengan P1 #1-#3:
  - P1: `failed` non-final keluar dari poll (`payment.service.ts:2911-2913` hanya pending/expired; `syncExpiredIntentPayment` `:2683` keluar bila bukan expired). Juga `payment-live-code.ts:52`: setelah expires_at+60 s kode dianggap mati hanya dari jam lokal. Fix: kind kedua poll memuat `failed` + providerRef + `provider_final_at IS NULL` + tanpa hold tertutup; `syncExpiredIntentPayment` menangani failed; hapus klausa waktu (kode mati hanya oleh `providerAnswerFinal` atau rekonsiliasi); `applyGatewayFailure` (`:2672`) menandai final untuk failed+final.
  - P2: `failedWithOpenFund` (`payment-failed-funds.ts:18-20`) menyaring status failed; dana kurang bayar yang diparkir poll pada kode expired (`:1657`, `:1695`) lolos di `createGuestPayment` (`qr-order-payment.ts:780`) dan `assertSplitMutableTx` (`bill-split.service.ts:241`). Fix: hapus filter status (kecuali paid).
  - P3: jawaban final poll (`payment.service.ts:707`, `:1695`, `:2698`) tidak memeriksa `answer.providerRef === intent.providerRef`; tambahkan.
  - P3: baris pending yang terlewat budget waktu tetap ter-lease 2 menit tanpa dipoll (`:2979`); lepaskan lease-nya.

## Keputusan CTO
- Waktu lokal tidak pernah membuat kode mati (desain D-03). Kode yang penyedianya tak pernah final: tetap hidup; jalan keluar staf VA dikerjakan terpisah (legend-5wn1e), QR lewat force release Q93.
- Dana terbuka apa pun (status intent apa pun, order atau part, termasuk tender POS setelah force release) memblokir tender/kode/split baru: 409 `FUNDS_UNRESOLVED`.
- DOIT ditarik dari paket: tetap larang penerbitan baru, tapi verifikasi webhook dan poll intent yang sudah terbit tetap jalan (`forStoredIntent`).

## Bukti selesai
- Satu test gagal-dulu per temuan (usul test di laporan), lalu hijau; suite QRIS/split/payment/POS terarah hijau (`LEGEND_TEST_FILES=... heavy pnpm test`), dengan exit code dari log.
- Pra-gate AGENTS.md (prettier, eslint, typecheck api+web lewat heavy, `db:generate` kosong).
- Satu subagent architect xhigh atas diff `c2902fa4e..HEAD`; temuan nyata dibetulkan. Second opinion Codex berikutnya hanya atas diff ini (CTO yang memulai).
- Push tanpa force. Lapor SHA, test merah→hijau, angka subagent. Jangan merge, jangan deploy.
