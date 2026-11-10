# Brief: second-opinion — kasir aktif POS per perangkat (legend-aruta)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/aruta-pos-pin`, cabang `ws/aruta-pos-pin`, SHA `f609a047`.
Rentang diff: `git diff 29ddcbf7 f609a047` (abaikan drizzle `meta/*.json`, mock web, dan test).

## Berkas berisiko
- `apps/api/src/services/pos-acting-staff.service.ts`
- `apps/api/src/services/pos-acting-staff-revoke.ts`
- `apps/api/src/middleware/acting-staff.ts`
- `apps/api/src/routes/pos-acting-staff.routes.ts`, `apps/api/src/routes/device-pin.routes.ts`
- `apps/api/src/lib/permissions.ts` (atau path setara), `apps/api/src/services/core-audit.ts`
- `apps/api/src/services/staff-pin-sync.ts`, `pos-shift.service.ts`, `pos-day.service.ts`
- `apps/api/drizzle/0243_pos_acting_staff.sql`
- `apps/web/src/lib/api/acting-staff.ts`

## Invariant (PRD)
- Tindakan POS (shift, order, tender, diskon, void, refund) tercatat atas nama kasir yang mengetik PIN; izin dihitung untuk kasir itu.
- Token kasir aktif terikat device + outlet + staf + sesi; tidak bisa dipakai di device/outlet/sesi lain; dicabut saat ganti kasir, reset PIN (termasuk sinkron edge), tutup shift, tutup hari; TTL maks 12 jam.
- MFA pemilik sesi tidak boleh dipinjam kasir aktif; write-off menolak header.
- Isolasi tenant dan outlet di setiap query dan tabel baru (RLS FORCE).
- Token hanya disimpan sebagai hash; tidak bocor di log/respons/localStorage.

## Effort
high.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
