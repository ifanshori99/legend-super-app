# Brief: second-opinion — nomor struk dan e-receipt POS (legend-93a)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/prep-pos-receipt`, cabang `prep2/pos-receipt` HEAD `39296fae`, berisi `ws/pos-receipt` (1657797e) plus fix shift (`bd5885b6`: cash sale mengikuti aturan pos-shift). Cabang ini BELUM digabung ke `milestone/m1`.
Rentang diff isi receipt saja: `git diff 2d0f7f4a 39296fae` (29 file; abaikan drizzle `meta/*.json`). `2d0f7f4a` adalah parent kedua `39296fae` (chain head `prep4/fix-whitelabel`). Jangan pakai `git diff milestone/m1...`: merge-base `1e2ab930` menyeret isi ws02-edge dan whitelabel yang belum merge.
Sudah digabung ke `milestone/m1` sebagai merge `726515a4` (09-11); rentang di m1: `git diff cc3e778c 726515a4` (isi sama dengan rentang di atas).
Migration pada rantai ini: 0101/0102 (diregen di atas chain ws02-edge).

## Berkas berisiko
- `apps/api/src/services/pos-receipt.service.ts`
- `apps/api/src/services/pos-receipt-document.ts`
- `apps/api/src/services/pos-receipt-delivery.service.ts`
- `apps/api/src/services/pos-receipt-email.ts`
- `apps/api/src/services/pos-receipt-pdf.ts`
- `apps/api/src/routes/pos-receipt.routes.ts`
- Error handler dan `app.ts` (jalur decode URI dan log error)
- Migration `0101_reflective_sue_storm.sql` dan `0102_pos_receipts_rls.sql` (nomor diregen saat merge, bukan temuan)
- `apps/api/src/worker/pos-receipt-email.job.ts`

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
