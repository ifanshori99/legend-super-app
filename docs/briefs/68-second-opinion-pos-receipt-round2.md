# Brief: second-opinion — nomor struk dan e-receipt POS (legend-93a)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-receipt`, cabang `ws/pos-receipt`, SHA `d379023`.
Rentang diff: `git diff $(git merge-base main d379023)..d379023` (abaikan drizzle `meta/*.json`).

## Berkas berisiko
- `apps/api/src/services/pos-receipt.service.ts`
- `apps/api/src/services/pos-receipt-document.ts`
- `apps/api/src/services/pos-receipt-delivery.service.ts`
- `apps/api/src/services/pos-receipt-email.ts`
- `apps/api/src/services/pos-receipt-pdf.ts`
- `apps/api/src/routes/pos-receipt.routes.ts`
- Error handler dan `app.ts` (jalur decode URI dan log error)
- Migration `0063_pos_receipts` (nomor bentrok dirapikan saat merge, bukan temuan)

## Invariant (PRD)
- POS-06: nomor struk berurutan tanpa celah per outlet dan per perangkat, termasuk saat offline. Struk yang di-void tetap tercatat dengan nomornya.
- POS-04: transaksi final tidak bisa dihapus. Koreksi lewat void atau refund yang tertaut.
- D40: nomor struk berurutan tanpa celah. E-receipt memuat nama dan alamat outlet.
- F44: nomor struk berurutan tanpa celah dan pencatatan setoran kas.
- Data pribadi: email pelanggan terenkripsi dan tidak pernah masuk log atau respons.
- Isolasi tenant dan outlet dipaksa di tabel baru.

## Effort
high.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
