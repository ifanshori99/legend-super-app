# Brief 243b: second opinion untuk notifikasi ganti Owner dan email security wajib (legend-fmpgz + legend-307w3, tingkat K: auth)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`. Read-only: jangan ubah kode, jangan commit. Pecah tugas, spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/owner-change-notify`, cabang `ws/owner-change-notify`, HEAD `a2d54c63`. Basis `783e3bbf`.
Diff: `git diff 783e3bbf a2d54c63` (empat commit: `c81e214d` legend-fmpgz, `7849bf84` legend-307w3, `dd3159d2` legend-cz6aq, `a2d54c63` legend-md0zx).

## Konteks
Keputusan founder Q46: saat Super Admin menunjuk/mengganti Owner lewat `platform-tenant-owner.service.ts`, kabari Owner yang diganti dan semua Owner aktif tenant (siapa pelaku, kapan, akun baru, alasan) lewat email dan notifikasi in-app. Gagal kirim tidak membatalkan penunjukan, tetapi tercatat. Tanpa migrasi.
Mekanisme: event `tenant_owner.changed` -> `domain_event_outbox` (destination notification) -> consumer notifikasi -> rule `tenantOwnerChangedRule` di `apps/api/src/worker/notification-adapters.ts` (kategori `security`).

## Berkas berisiko
- `apps/api/src/services/platform-tenant-owner.service.ts`: `notifyOwnerChange` (savepoint `tx.transaction`, catch -> audit `tenant_owner.notify_failed`), dipanggil terakhir di `changeOwner`.
- `apps/api/src/worker/notification-adapters.ts`: `tenantOwnerChangedRule` (penerima dari baris DB, bukan payload; Owner lama dari baris assignment yang sudah berakhir; filter `validFrom <= changedAt`; body dipotong 1000).
- `packages/shared/src/platform/events.ts`, `events/catalog.ts`.

## legend-307w3 (commit 7849bf84)
Keputusan founder: email kategori `security` tidak bisa dimatikan oleh `email_enabled` tenant atau opt-out user.
- `packages/shared/src/notification/schemas.ts`: `MANDATORY_EMAIL_CATEGORIES = ["security"]`, `isEmailMandatory`.
- `packages/shared/src/notification/delivery.ts` `planDelivery`: email security hanya skip bila alamat belum terverifikasi (`unreachable`); push dan WhatsApp tetap punya opt-out; kategori lain tidak berubah.
- Pengguna kategori security: `support_access.granted/ended` (admin tenant dengan settings.manage), `support_access.requested` (Owner penyetuju), `tenant_owner.changed`.
- Test: `tests/notification-contract.test.mjs` (3 baru), `apps/api/src/test/notification-delivery.test.ts` (2 baru, jalur kirim).
Pertanyaan tambahan: ada gerbang lain yang masih memblokir atau memaksa email? Tenant tanpa baris policy (default `emailEnabled=false`) kini tetap menerima email security: apakah ini aman? Toggle UI `preferences-panel.tsx` masih bisa dimatikan tetapi diabaikan server (follow-up UI).

## Yang ditanyakan
1. Ada jalur di mana penunjukan Owner gagal/rollback gara-gara notifikasi, atau transaksi tetap terbuka rusak setelah savepoint gagal?
2. Penerima salah: Owner berakhir lebih awal, tenant lain, duplikat, Owner temporer, user banned/dihapus?
3. Race antara emit dan consume (Owner diakhiri/ditunjuk di antaranya, replay outbox, retry consumer, dead-letter bila rule throw).
4. Kebocoran data di isi pesan (email, alasan) atau pelaku platform; bisa dimatikan preferensi tenant/user (`email_enabled`, opt-out security)?
5. Idempotency/aggregate outbox, dan apakah event tercatat di audit sebagai sensitif bila perlu.
Test terkait: `src/test/platform-tenant-owner.test.ts`, `src/test/worker-notification-adapters.test.ts`.

## Temuan architect internal yang sudah dibetulkan
Body >1000 karakter, email placeholder `@wa.invalid`, email pelaku, Owner baru ditunjuk sebelum replay. Preferensi/`email_enabled` yang mematikan email security dibetulkan di legend-307w3.

## Format
Temuan konkret `file:baris` + dampak + perbaikan; tulis "tidak ada" bila bersih.

## legend-cz6aq dan legend-md0zx (commit dd3159d2, a2d54c63)
Fallback policy tanpa baris `notification_policies` kini satu fungsi `defaultNotificationPolicy` (`packages/shared/src/notification/schemas.ts`): web push saja, email off, 3 percobaan, backoff 30/120 detik. Dipakai worker, `service-request.service.ts`, `edge-sync-conflict-alert.ts`, `notification-center.ts` (sebelumnya center melapor email on, 5 percobaan). Pertanyaan: ada pembaca policy lain yang masih punya salinan sendiri, atau yang bergantung pada nilai lama center?
