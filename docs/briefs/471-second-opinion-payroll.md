# Brief: second-opinion Codex — area payroll + pajak (6pha, 2upj, in4m)

Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti. Read-only. Effort xhigh (uang).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Basis `origin/milestone/m1` (3c7217b2).

## Cabang
- `origin/ws/6pha-payroll-tax-bundle` 397bb1c5: approver HR dan final != pembuat run (reducer, `payrollRunSchema`, guard `lock` di `packages/shared/src/hris/payroll/run.ts`), versi statutory kedua di tanggal efektif sama ditolak (`statutory.ts`), ekspor rekap PBJT per outlet ke tabel baru `tax_report_exports` (migrasi 0288 sementara, append-only) + `POST /api/tax/reports/pbjt/export`. Architect xhigh di thread.

## Fokus
Jalur yang membuat satu orang bisa membuat + menyetujui run, bypass lewat jalur lain (mock, API, role custom), versi statutory ambigu yang mengubah potongan pajak/BPJS, total CSV vs `amount_idr` beda, idempotensi ekspor, izin per outlet / lintas tenant, append-only benar-benar ditegakkan, migrasi 0288 (snapshot drizzle belum ada, nilai `when` jurnal).

## Laporan
Temuan P0..P3: file:baris, skenario (input -> hasil salah), saran. Sebut yang bersih. Angka subagent.
