# Brief: second-opinion — tabel pickup_calls dan expo_assignments (legend-aiksz)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/expo-pickup-tables`, cabang `ws/expo-pickup-tables`.
Rentang diff: `git diff 4fe23687 ws/expo-pickup-tables` (abaikan `apps/api/drizzle/meta/*.json`). Basis 4fe23687 = kontrak legend-usw3 di atas m1 42ee5c28.

## Berkas berisiko
- `apps/api/drizzle/0168_expo_pickup_tables.sql` (migrasi, termasuk trigger dan RLS)
- `apps/api/src/db/schema/expo-pickup.ts`
- `apps/api/src/db/schema/expo-pickup.custom.sql`
- `apps/api/src/test/expo-pickup-rls.test.ts`

## Invariant (PRD dan kontrak)
- Kontrak: `packages/shared/src/kitchen/schemas.ts` (`expoTicketSchema`, `expoDeliveryBlock`, `pickupCallSchema`, `PICKUP_CALL_TRANSITIONS`) dan `endpoints.ts` (`assignExpoRunner`, `markExpoOrderDelivered`, `callPickupNumber`, pickup).
- Nomor pickup harian per outlet, 1..999, tidak dobel di outlet dan hari yang sama.
- Status pickup: assigned -> called -> picked_up; picked_up final; ulang aksi menyimpan waktu pertama.
- Pesanan yang sudah diantar punya runner; runner tidak bisa diganti setelah diantar.
- Isolasi tenant dan outlet dipaksa di setiap tabel baru (`app.enforce_tenant_rls`, `app.enforce_outlet_rls`, FORCE RLS). Unique menyertakan `tenant_id`.
- Migrasi harus jalan sebagai owner non-superuser (pola FK ke tabel FORCE RLS).

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
