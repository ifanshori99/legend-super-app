# WS-14 peralatan dan perawatan (legend-o032) - brief subagent

Worktree: /Users/ifanshori99/Projects/legend super app/legend/.worktrees/equipment-maintenance (cabang ws/equipment-maintenance). Jangan cd ke luar. Jangan push, merge, atau ubah berkas di luar bagianmu. Tes gagal-dulu: tulis tes, lihat gagal, baru implementasi. Jalankan tes: `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/<file>" pnpm test'` (dari folder apps/api bila skrip ada di sana; cek package.json). Jangan jalankan tsc/build (agent induk yang menjalankan lewat `heavy`).

## Sudah ada (jangan diulang)

- Skema: `apps/api/src/db/schema/operations.ts` equipment, maintenance_schedules (baru: kolom `remindedForDueAt` nullable, migrasi 0198 sudah dibuat), maintenance_tickets, shift_handovers. RLS di operations.custom.sql.
- Service `apps/api/src/services/operations-equipment.service.ts` (equipment, schedules list :955 dan create :1017, tickets, handovers; helper `assertOutletPermission`, `EQUIPMENT_PERMISSION`, `auditOperations`, idempotensi `replay*`/`storeIdempotentResult`). Auto-86 sudah ada (createMaintenanceTicket, transisi complete_maintenance).
- Route `apps/api/src/routes/operations-equipment.routes.ts`. Kontrak `packages/shared/src/operations/` (endpoints.ts, schemas.ts, events.ts). Event `equipment_service.reminded` dengan payload `equipmentServiceRemindedEventPayloadSchema` (scheduleId, equipmentId, nextDueAt, vendorId, remindedAt) sudah ada di events.ts tetapi belum dipancarkan siapa pun.
- Pola sapu: `operations-escalation.service.ts` (`sweepMissedChecklistRuns`: tenant-tx, FOR UPDATE SKIP LOCKED, batas, event lewat `emitOperationsEvent` dengan destination `OPERATIONS_NOTIFICATION_DESTINATION`, actor system). Dipanggil dari `apps/api/src/worker-main.ts` ~baris 480.

## Potongan A: pengingat servis (OPS-04)

Berkas milikmu: BARU `apps/api/src/services/operations-equipment-reminder.service.ts`, `apps/api/src/worker-main.ts` (tambah satu blok try/catch fail-closed setelah sweepMissed), `apps/api/src/worker/notification-adapters.ts` (tambah case `equipment_service.reminded` di `ruleFor` + rule; tanpa itu event dead-letter; audiens: pemegang peran OPS_ALERT_TEMPLATE_KEYS lingkup outlet, cadangan owner, seperti `checklistRule`), tes BARU `apps/api/src/test/operations-equipment-reminder.test.ts`.
Aturan: `sweepEquipmentServiceReminders(tx, context, now = new Date())` memilih jadwal `next_due_at <= now + 7 hari` (konstanta REMINDER_HORIZON_DAYS) dan `reminded_for_due_at IS DISTINCT FROM next_due_at`, peralatan tidak berstatus retired, batas 200 per tick, FOR UPDATE SKIP LOCKED, filter outletScope eksplisit. Per jadwal: update `reminded_for_due_at = next_due_at` (guard di WHERE agar eksak sekali) lalu emit event ke notification, aggregateId = scheduleId. Jalan dua kali berturut-turut: tidak ada event kedua. Tes: tepat sekali, di luar horizon tidak, jadwal di-advance (next_due_at diubah) memicu lagi, retired dilewati, isolasi tenant (tenant lain tidak tersentuh), event masuk outbox destination notification, rule notifikasi menyelesaikan penerima.

## Potongan B: servis selesai majukan jadwal

Berkas milikmu: `packages/shared/src/operations/endpoints.ts` dan `schemas.ts` (tambah input `completeMaintenanceScheduleInputSchema`: idempotencyKey, completedAt opsional; ikuti gaya input lain), `apps/api/src/services/operations-equipment.service.ts` (fungsi baru `completeMaintenanceSchedule`: izin `ops.equipment.maintain` + outlet scope, kunci baris, `next_due_at = max(completedAt, now) + interval_days`, `reminded_for_due_at` dibiarkan agar pengingat berikut menyala karena due beda; audit `maintenance_schedule.completed`; idempotensi; 404 jika lintas tenant/outlet), `apps/api/src/routes/operations-equipment.routes.ts` (POST `/maintenance-schedules/:id/complete`, Zod ketat, mirror route lain, daftarkan endpoint di kontrak bila pola ada), tes BARU `apps/api/src/test/operations-equipment-schedule.test.ts`. Juga tambah `PATCH`-nya TIDAK diperlukan. Tes: advance benar, replay idempoten, 403 tanpa izin, 404 jadwal outlet lain/tenant lain, audit tertulis.
Bila `packages/shared` berubah, cek apakah ada tes kontrak root yang menghitung endpoint (`tests/operations-contract.test.mjs`) dan perbarui bila perlu (itu juga milikmu).

## Potongan C: tes isolasi dan izin (test-writer)

Berkas milikmu: BARU `apps/api/src/test/operations-equipment-isolation.test.ts` saja. Tidak mengubah kode produksi. Isi tes perilaku API/service (bukan teks SQL) untuk equipment, maintenance_schedules, maintenance_tickets, shift_handovers: (1) tenant B tidak bisa list/get/ubah baris tenant A (404/kosong), (2) pengguna dengan lingkup outlet X tidak melihat/ubah outlet Y, (3) tanpa izin `ops.equipment.maintain` / `ops.handover.record` mutasi ditolak 403, (4) tiket kerusakan `marksEquipmentBroken` -> menu terhubung masuk `disabled_item_ids` (assert eksplisit kolom dan status ketersediaan), complete_maintenance mengembalikan, 86 manual tidak terangkat, (5) handover tidak bisa ditutup sebelum diakui penerima dan pengakuan oleh pengirim ditolak. Ikuti harness `operations-equipment.test.ts`. Bila sebuah tes mengungkap bug produksi, jangan perbaiki: tandai jelas di laporan.

## Laporan subagent

Berkas berubah, perintah tes dan hasil (jumlah tes), temuan/bug. Singkat.
