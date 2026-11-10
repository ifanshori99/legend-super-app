# Brief: second-opinion — profit share bagian A: distribusi

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree baca: `git worktree add .worktrees/so-377 ws/8s992-profit-rules` (detached: tambahkan `--detach`), hapus setelah selesai.
Rentang: `git diff 7d388b02 ws/8s992-profit-rules -- <berkas>`. Bagian B (registry, statement, skema SQL) diperiksa terpisah.

## Berkas
- `apps/api/src/services/profit-share-distribution.service.ts` (1717 baris baru, fokus utama)
- `apps/api/src/routes/profit-share-distribution.routes.ts`
- (jejak saja) `apps/api/src/db/schema/accounting-profit-share.ts`, `apps/api/drizzle/0219_profit_share.sql`

## Invariant
- Jumlah bagian semua penerima = laba yang dibagi persis (pembulatan rupiah, sisa dialokasikan deterministik, tidak hilang atau dobel).
- Distribusi satu periode hanya sekali; jalan ulang/balapan tidak menghasilkan payout dobel (kunci + idempotensi).
- Basis laba dari jurnal yang sudah dikunci periodenya; koreksi sesudah distribusi lewat penyesuaian, tidak mengubah distribusi lama diam-diam.
- Jurnal distribusi seimbang dan tidak dijurnal dua kali.
- Approval sesuai matriks; penyetuju beda dari pembuat.
- Isolasi tenant/outlet di tiap query; penerima tidak bisa melihat bagian penerima lain kecuali berhak.

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
