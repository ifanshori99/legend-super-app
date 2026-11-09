# Brief: tes event notifikasi outbox (legend-9p0k)

Worktree: /Users/ifanshori99/Projects/legend super app/legend/.worktrees/notification-outbox-events (cabang ws/notification-outbox-events). Hanya tulis `apps/api/src/test/notification-outbox-events.test.ts` (file baru). Jangan edit kode produksi.

## Perilaku yang diimplementasi (engineer, paralel)

- Helper baru `apps/api/src/services/notification-events.ts`:
  `appendNotificationEvent(tx, context, definition, { aggregateId /*uuid*/, outletId: string|null, actorUserId: string|null, payload, now })`
  menulis tepat satu baris `domain_event_outbox` (destination "cloud-sync", sequence = max+1 per tenant+aggregateType+aggregateId, dengan advisory lock) di tx pemanggil. definition = `notificationCreated|notificationRead|notificationPreferenceUpdated` dari `@starter/shared/notification`.
- `createNotificationService(...).execute(...)` di `services/notification-center.ts`:
  - `markRead`: bila notifikasi belum dibaca -> satu event `notification.read` (aggregate `notification`, aggregateId = uuid notifikasi, payload {notificationId(ulid), userId, category}). Sudah dibaca -> tidak ada event baru (panggilan ke-2 no-op, respons tetap data notifikasi).
  - `markAllRead`: satu event `notification.read` per notifikasi yang berubah (yang sudah dibaca tidak).
  - `updatePreferences`: satu event `notification_preference.updated` (aggregate `notification_preference`, aggregateId = user uuid, payload {userId, changedCategories[], quietHoursChanged}) tiap panggilan; changedCategories = kategori yang berbeda dari baris sebelumnya (atau semua kategori di body bila belum ada baris), quietHoursChanged = quiet hours berbeda dari sebelumnya.
- `createNotificationConsumer` (`services/notification-consumer.ts`): tiap notifikasi baru yang benar-benar tersisip -> satu `notification.created` (aggregateId = uuid notifikasi, payload {notificationId, userId, category, realtime}), di tx consume yang sama. Replay (onConflictDoNothing) tidak menambah event.

## Tes yang wajib (tulis gagal-dulu; harus gagal sebelum implementasi ada)

1. Tiap aksi (markRead, markAllRead dengan 2 notifikasi, updatePreferences, consumer create) menulis tepat jumlah baris outbox yang benar; envelope valid (parse dengan envelopeSchema), nama/aggregate/payload sesuai.
2. Rollback: panggil `appendNotificationEvent` di `withTenant` lalu lempar error -> nol baris outbox; begitu juga perubahan data di-rollback.
3. Urutan: dua preference update untuk user sama -> sequence 1,2; dua event untuk notifikasi sama (created lalu read) -> 1,2; agregat berbeda mulai dari 1. Tidak berulang. Concurrent (Promise.all dua updatePreferences user sama) -> {1,2} tanpa error.
4. markRead dua kali -> hanya satu event read.
5. Isolasi tenant: tenant B tidak melihat baris outbox tenant A (RLS) dan sequence agregat tenant B tidak terpengaruh.

## Pola

Tiru setup di `apps/api/src/test/notification-service.test.ts` dan `notification-consumer.test.ts` (Pool APP_DATABASE_URL, `withTenant`, `establishScopedTenantContext`, `seedTenantOutlets` bila perlu). Baca baris lewat `domainEventOutbox` / SQL `domain_event_outbox`.
Jalankan: `bash -c 'cd "<worktree>" && pwd && LEGEND_TEST_FILES="src/test/notification-outbox-events.test.ts" pnpm test'` (lewat `heavy` bila hook minta). Laporkan hasil singkat; tes yang bergantung pada helper yang belum ada boleh gagal import, itu wajar sampai engineer selesai.
