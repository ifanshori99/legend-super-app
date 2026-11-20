# 1254 status batch106 (21 Nov)

Base milestone/m1 (6f418df53). Cabang int/batch106. Tanpa migrasi baru. Tanpa konflik merge.
HEAD gate terakhir hijau: 3543bba22 (sebelum commit status ini).

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

## Antrean belum digabung (menunggu kuota Claude, reset Selasa 18:00)

1. ws/1260-gl-blocked-visible b2f0dc9c0 (memuat 1252, git melewatinya)
2. ws/1256-sentry 1841d4828 (dependency baru @sentry/node, @sentry/react 11.11.0)
3. ws/1255-email-reset 3d8138a1c (dependency nodemailer; kemungkinan konflik .env.example, config/env.ts, docs/production-credentials.md dengan 1256: gabung keduanya)
4. ws/1261-deploy-template f942adbc2 (setelah 1256 final; konflik mungkin di docs/production-credentials.md dan .env.example; env SMTP_HOST/PORT/SECURE/USER/PASS, EMAIL_FROM)
5. ws/1259-manual-refund-ui 527677a29 (mungkin konflik docs/runbooks/refund-manual.md)
6. 1263 menunggu pesan CTO.

## Rencana gate gabungan (satu kali, sesudah kelima merge di atas)

- pnpm install --frozen-lockfile (atau worktree:setup) sekali; lint; typecheck api+web; tes kontrak root (+ tests/ws05-manual-settle, shared-device-hide-1257).
- affected-tests --max 120 ditambah wajib: inventory-gl-blocked-visible, inventory-gl-production, tes period close akuntansi, sentry.test.ts, error-handler, tes web sentry, password-reset-email, member-signin, better-auth-admin-lockdown, auth-shared-device-guard, test web ws05-payment-admin.
- heavy sh deploy/single-vm/test-deploy.sh, node scripts/check-compose-env.mjs bila ada, prettier, API build + apps/api/dist/set-gateway.js.
- Merah: cari kartu penyebab lewat berkas gagal, perbaiki atau revert merge itu saja, lapor CTO.

## Belum

- Full run (CTO). Build API terakhir hijau di da3614479, belum diulang sesudahnya.
