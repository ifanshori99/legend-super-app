# Brief: second-opinion — profit share bagian B: registry, statement, skema SQL

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree baca: `git worktree add --detach .worktrees/so-379 0033ea1d`, hapus setelah selesai.
Rentang: `git diff 7d388b02 0033ea1d -- <berkas>`. Bagian A (distribution service) sudah diperiksa di 377; jangan ulang kecuali jejak panggilan.

## Berkas
- `apps/api/src/services/profit-share-registry.service.ts`
- `apps/api/src/routes/profit-share-registry.routes.ts`
- `apps/api/src/services/profit-share-statement.service.ts` (+ `profit-share-statement-pdf.ts` bila perlu)
- `apps/api/src/db/schema/accounting-profit-share.custom.sql`
- `apps/api/drizzle/0219_profit_share.sql`

## Invariant
- Porsi penerima per aturan berjumlah 100% (atau sesuai definisi) dan tidak tumpang tindih periode berlaku; perubahan aturan tidak mengubah distribusi yang sudah final.
- RLS/isolasi tenant dan outlet di tabel dan query baru; constraint SQL sesuai invariant service (tidak lebih longgar, tidak menolak kasus sah).
- Migrasi aman di DB berisi data (tanpa kehilangan data, urutan, idempotensi trigger/fungsi).
- Statement: penerima hanya melihat datanya sendiri; angka statement sama dengan jurnal distribusi; data pribadi (NIK, rekening) tidak bocor di log/PDF yang salah tenant.
- Perubahan registry tercatat di audit dengan pelaku.

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
