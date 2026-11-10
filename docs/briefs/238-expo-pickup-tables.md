# Brief: engineer — tabel pickup_calls dan expo_assignments + RLS (legend-aiksz)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/expo-pickup-tables` dari `ws/expo-pickup-contract` 4fe23687 (kontrak legend-usw3, di atas m1 42ee5c28). Worktree `.worktrees/expo-pickup-tables`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-aiksz` (P2, tingkat K: migrasi). Baca `bd show legend-aiksz`, `bd comments legend-vm6` (triase), dan kontrak `packages/shared/src/kitchen/schemas.ts` (sekitar :545 dan :567, plus `PICKUP_CALL_TRANSITIONS` dan `expoDeliveryBlock` dari 4fe23687).
- Tabel `pickup_calls` dan `expo_assignments` (atau nama yang sejalan dengan skema kitchen/KDS yang sudah ada): `tenant_id NOT NULL` + `app.enforce_tenant_rls`, `outlet_id`, unique yang menyertakan `tenant_id`, kolom status dan waktu yang dibutuhkan kontrak (`calledAt`, `pickedUpAt`, `deliveredAt`, runner).
- Constraint DB yang menjaga invarian kontrak bila murah (contoh: diantar wajib punya runner).
- Hanya skema, migrasi, dan test isolasi. Service/route ada di `legend-mzhr0` dan `legend-him8j`: jangan dikerjakan.

## Kartu
`legend-aiksz`. Di awal: `bd update legend-aiksz --status in_progress`. Saat melapor: `bd update legend-aiksz --status review` dan `bd comment legend-aiksz "<ringkasan>"`.

## Scope
Boleh: `apps/api/src/db/schema/` (berkas kitchen/KDS/pickup), `apps/api/drizzle/` (satu migrasi), test isolasi. Jangan: service/route, kontrak shared (kecuali bug nyata: lapor dulu), UI, payroll, refund, akses, edge.
Migrasi: 0168, `when` 1794247000000. Satu berkas migrasi saja.

## Bukti selesai
- Test isolasi tenant (RLS) untuk kedua tabel, unique per tenant, constraint invarian.
- `LEGEND_TEST_FILES` daftar eksplisit (path `src/test/...`) lewat `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="..." pnpm test'`, sertakan `src/test/edge-received-events-migration.test.ts` dan `src/test/migration-fk-force-rls.test.ts`; `db:generate` harus kosong.
- tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh.
- Review K: subagent reviewer Opus + architect paralel. Brief Codex `docs/briefs/238b-second-opinion-expo-pickup-tables.md` (tidak di-commit).

## Laporan
Sekali: tabel dan constraint, bukti, file berubah, SHA, nomor migrasi, risiko tersisa, jumlah subagent dan puncak bersamaan. Jangan menunggu proses global atau loop sleep. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
