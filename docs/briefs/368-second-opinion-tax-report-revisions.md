# Brief: second-opinion — laporan pajak rantai revisi (legend-r3i8w, legend-5nhkp)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/r3i8w-tax-reports`, cabang `ws/r3i8w-tax-reports`, SHA `feb4f6bb`.
Rentang diff: `git diff dd4db5d2 feb4f6bb` (abaikan drizzle `meta/*.json`, fixtures, mock web, dan test).

## Berkas berisiko
- `apps/api/src/services/accounting-tax-reports.service.ts`
- `apps/api/src/services/accounting-tax-line-source.ts`
- `apps/api/src/services/accounting-coretax-xml.ts`
- `apps/api/src/db/schema/accounting-tax.custom.sql`
- `apps/api/drizzle/0242_*.sql`
- `apps/api/src/routes/accounting.routes.ts` (bagian tax report)

## Invariant (PRD dan UU KUP Pasal 8)
- Tepat satu laporan berlaku per (entitas, jenis, periode); pembetulan berantai 0, 1, 2, ... tanpa celah.
- Laporan final/superseded tidak bisa diubah; berkas lama tetap bisa diunduh, hanya laporan berlaku bisa diekspor.
- Finalize hanya di periode tertutup; sum(lines.tax) = amount_idr.
- Idempotensi finalize; tidak ada pembetulan kosong.
- Isolasi tenant di setiap query dan tabel; data pajak (NPWP) tidak bocor di log/respons.

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
