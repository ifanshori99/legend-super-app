# 915 payout grant lanjutan (3 kartu)

Cabang ghostex/915-payout-grant-lanjutan di atas 3cfecb901 (911). Migrasi sementara mulai 0658. Tidak merge, tidak deploy. Konteks: docs/briefs/911/design-p1-1.md, design-r86qa-izza4.md, PROGRESS.md bagian "Perbaikan second opinion 905" (baris ~6143).
Aturan uang: tidak ada pihak dibayar lebih, outlet tidak rugi; ragu -> aturan yang membatasi pembayaran.

## legend-786te

`PAYOUT_GRANTOR_DATABASE_URL` WAJIB di semua profil deploy production: validasi env gagal start bila kosong (NODE_ENV=production); doctor, check-compose-env.mjs, provision-roles.sh/ts, runtime.env.example, docs/deployment.md diperbarui. Dev/test tetap boleh SET LOCAL ROLE (fallbackRole di apps/api/src/db/grantor.ts).

## legend-xatux

Rute batal proposal koreksi/overpaid yang masih terbuka (API + tombol di UI payout yang sudah ada), lewat fungsi tepercaya + grant step-up (pola sama withdraw-resolution/grants 911). Batal TIDAK melepas hold closure. Teks UI baru masuk katalog text-contract.

## legend-7gghu

Sisa diterima (legend_app bisa palsukan baris sesi), DENGAN deteksi: tiap grant yang dipakai untuk persetujuan payout dicatat append-only di tabel milik `legend_payout`; penyetuju asli diberi notifikasi di luar sesi itu (in-app + email/WA lewat outbox yang ada) "Anda menyetujui <batch/nominal>". Penyetuju bisa tandai "bukan saya" -> bekukan batch. Bila bekukan terlalu besar: kerjakan catat + notifikasi, bekukan jadi kartu.

## Peta 7gghu (Explore, belum diverifikasi penuh)

- Grant: schema apps/api/src/db/schema/payroll-payout.ts:1354 (payrollPayoutGrants), attestation :1440; migrasi 0653 (tabel, payout_grant_consume), 0654 (payout_attest :134 membaca grant consumed), 0655 (kind: correction, overpaid, return, closure, posting_source, resolve, bank_confirm). "Persetujuan" = step 'approve' kind correction/overpaid/resolve/closure. Penerbit: services/payroll-payout-grant.service.ts.
- Titik sambung terkecil: tambahan di app.payout_attest -> tabel log append-only baru milik legend_payout (migrasi 0658+).
- Notifikasi: db/schema/notification.ts:22 (notification_outbox), services/notification-events.ts:117 appendNotificationEvent, notification-center.ts, notification-core.ts, worker/notification-adapters.ts:1221 resolver penerima (dari rule + state DB, bukan payload; tenant harus sama). Web: features/ws05-notifications/.
- Status batch: schema :193; PAYOUT_HALT_REASONS :171 (halted wajib haltReason dari 5 nilai); closure hold drizzle/0647. Nominal batch: totalEncrypted (bytea terenkripsi) -> dekripsi/hitung dari item.
- Residual: legend_app bisa re-point baris session (identitas) -> API menerbitkan grant sebagai user lain (design-p1-1.md sec 2).
