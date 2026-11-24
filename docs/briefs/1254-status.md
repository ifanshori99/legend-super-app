# 1254 status batch106 (21 Nov)

Base milestone/m1 (6f418df53). Cabang int/batch106. Tanpa migrasi baru. Tanpa konflik merge.
HEAD gate terakhir hijau: e4b076a84 (gelombang 2).

## Sudah masuk (merge --no-ff)

| Cabang                          | Merge SHA |
| ------------------------------- | --------- |
| ws/1251-journal-dividend-period | 60a693160 |
| ws/1243-promo-refund-manual     | 430658a96 |
| ws/1245-void-ack-ingest         | 13b92cd32 |
| ws/1250-gateway-cli             | b95269f0d |
| ws/1249-mock-guard-reports      | 61930d7a8 |
| ws/1253-payslip-pdf             | 0acc6a186 |
| ws/1242-receipt-bonus-flag      | 73042a49c |
| ws/1248-edge-day-close          | da3614479 |
| ws/1252-production-journals     | 5942e7519 |
| ws/1257-hide-unready            | ac986b6af |
| ws/1244-edge-refund-exception   | 3543bba22 |

## Gate di 3543bba22 (fast gate, bukan full run): hijau

- Redefinisi migrasi ok (0 baru), db:generate "No schema changes", check-workspace-links exit 0.
- Prettier 57+ berkas berubah: lulus. Lint 0 error, 2 warning exhaustive-deps lama.
- Typecheck 3 task lulus. Tes kontrak root 921 lulus, 0 gagal.
- Tes area 120 berkas + finance-exceptions-edge-refund, edge-order-ingest-guard, refund-1095-edge-void, shared-device-hide-1257: 113 berkas vitest 1820 lulus 1 skip, 0 gagal.
- Prettier gagal di run pertama (14 berkas): tidak bisa direproduksi, run ulang lulus berulang.

## Gelombang 2 (25 Nov): lima cabang digabung, tanpa konflik

| Cabang                         | Merge SHA |
| ------------------------------ | --------- |
| ws/1260-gl-blocked-visible     | 8f694f72b |
| ws/1256-sentry                 | c024f63af |
| ws/1255-email-reset            | 72dcf05c7 |
| ws/1261-deploy-template        | b1ed7842a |
| ws/1259-manual-refund-ui       | e4b076a84 |

Gate gabungan hijau di e4b076a84 (fast gate, bukan full run): install frozen-lockfile ok; redefinisi migrasi ok (0 baru, tanpa 0523); check-workspace-links 0; prettier 45 berkas lulus; lint 0 error (2 warning lama); typecheck 3 task lulus (1m41); tes kontrak root 900 lulus 0 gagal (text-contract, ws05-manual-settle, web-mock-build-guard, shared-device-hide-1257); tes area 118 berkas vitest 1888 lulus 1 skip, 0 gagal + 72 tes root; deploy/single-vm/test-deploy.sh lulus; API build + dist/set-gateway.js ok. check-compose-env.mjs tidak ada.
Catatan: `heavy pnpm exec prettier --check` dengan daftar berspasi newline gagal (ENAMETOOLONG); pakai satu baris dipisah spasi. Tes root `tests/*.test.mjs` penuh punya kegagalan khusus lingkungan DB terisolasi (bukan regresi).
1263 menunggu pesan CTO.

## Belum

- Full run (CTO). Build API terakhir hijau di da3614479, belum diulang sesudahnya.
