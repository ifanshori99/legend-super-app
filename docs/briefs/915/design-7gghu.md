# 915 legend-7gghu: log persetujuan + notifikasi (architect, 16 Nov 2026)
Ruang lingkup kartu ini: log append-only + notifikasi tanda terima. "Bukan saya" + pembekuan = kartu baru (status halted belum punya penulis, harus menahan ~12 fungsi tepercaya + dispatch, pelepasan dua orang; tingkat K, xhigh).
Migrasi 0659 (xatux 0658; geser bila xatux mundur).

## 0659_payout_approval_log.sql
- Tabel payroll_payout_approval_log: id, tenant_id, grant_id, attestation_id, kind, step, operation_id, batch_id, item_count, actor, session_id, logged_at, txid. UNIQUE (tenant_id, grant_id). Semua FK di dalam CREATE TABLE (tenants, grants (tenant_id,id), batches (tenant_id,batch_id)). Tanpa nominal (total disegel).
- Hanya legend_payout yang INSERT (pemilik tabel tetap migrator, D8). legend_app hanya SELECT. Tidak ada UPDATE/DELETE/TRUNCATE. RLS app.enforce_tenant_rls.
- Trigger BEFORE UPDATE OR DELETE per baris dan BEFORE TRUNCATE per statement menolak (kode PAYOUT-7x, 23514).
- Buat ulang app.payout_attest (signature 0654 sama, ownership dance 0644): upsert diberi RETURNING id lalu INSERT ke log, actor+session dari baris grant. Semua langkah tercatat (propose juga), baris propose yang ditimpa tetap berjejak di log.
## Notifikasi
- Job worker worker/payout-approval-receipt.job.ts menyapu log (maks 200 baris/tick, jendela 7 hari): appendNotificationEvent `payout.step_attested` payload {logId} saja, event id turunan logId (idempoten; dibuat lagi bila outbox dihapus sebelum terkirim).
- Rule payoutStepAttestedRule (worker/notification-adapters.ts): baca log by tenant+id; penerima [log.actor] bila masih anggota aktif tenant; tenant event harus = tenant log.
- Kategori baru payout_receipt: bypassQuietHours; kanal web_push, email, whatsapp; masuk MANDATORY_EMAIL_CATEGORIES.
- Teks (tanpa Rp/nama/rekening): "Anda {mengusulkan/menyetujui/mencatat/mengonfirmasi} {label kind} untuk batch gaji periode {periode} ({n} item) pada {jam} WIB. Bukan Anda? Segera hubungi pemilik usaha dan ganti kata sandi." Link ke halaman batch. Teks masuk katalog text-contract.
## Berkas
drizzle/0659 + meta snapshot/_journal; db/schema/payroll-payout.ts; packages/shared hris/payroll/events.ts, events/catalog.ts, notification/schemas.ts; worker/payout-approval-receipt.job.ts + worker-main.ts; notification-adapters.ts (rule + case di ruleFor).
## Test: apps/api/src/test/payroll-payout-approval-log.test.ts
1 tiap fungsi tepercaya tulis tepat 1 baris log, actor=grant.actor. 2 propose diulang -> 2 baris. 3 langkah rollback -> log kosong. 4 legend_app tak bisa INSERT/UPDATE/DELETE/TRUNCATE (42501); legend_payout tak bisa UPDATE/DELETE/TRUNCATE (trigger). 5 RLS antar tenant. 6 sweep idempoten; event dibuat ulang bila outbox dihapus. 7 payload dengan userId tambahan ditolak; penerima dari log. 8 isi notifikasi tanpa Rp/angka nominal. 9 email tetap terkirim walau preferensi dimatikan. 10 session di-repoint ke user B: log mencatat B dan notifikasi ke B.
## Risiko sisa
legend_app masih bisa ubah outbox/notifikasi/email-WA pengguna (notifikasi bisa diredam); log tetap bukti. WA butuh template Meta (akun founder); email+in-app jalan. approvedBy batch utama tak pakai grant, tak tercatat.
