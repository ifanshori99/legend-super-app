# Brief: second-opinion — rekonsiliasi id CoA edge (legend-ht6fu, tier K)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/edge-coa-id-align`, cabang `ws/edge-coa-id-align`.
Rentang diff: `git diff d8bc0422..ws/edge-coa-id-align` (base = `ws/tax-p2-fixes` d8bc0422, diperiksa terpisah di 222b). Jangan pakai `merge-base main`. Tidak ada migrasi; `apps/api/drizzle/0147_accounting_coa_backfill_1204.sql` tidak diubah.
Latar: migrasi 0147 menyisipkan akun 1204, 6110, 6111 dan mapping-nya dengan id acak, terpisah di DB cloud dan di tiap DB edge.

## Berkas berisiko
- `apps/api/src/edge/master-sync.ts` (`applyEdgeMasterSnapshotInTransaction`: penanganan akun lokal yang tidak ada di snapshot, penghapusan mapping dan akun lokal, savepoint, pemetaan error FK ke `LOCAL_CONFLICT`, urutan terhadap precheck natural key dan upsert)
- Test: `apps/api/src/test/edge-master-sync.test.ts`, `apps/api/src/test/provisioning-race.test.ts`

## Invariant
- Id master di edge selalu sama dengan id cloud; tidak pernah ada dua id untuk satu akun (tenant, entitas, kode).
- Akun lokal yang dirujuk data lain (journal_lines, budgets, fiscal_period_snapshot_lines) tidak pernah dihapus atau diubah id-nya; apply gagal `LOCAL_CONFLICT` dan tidak ada yang tertulis.
- Akun lokal yang id-nya tidak ada di snapshot tetapi kodenya ada di snapshot dengan id lain (hasil migrasi lokal seperti 0147), dan tidak dirujuk, diganti akun cloud tanpa perbaikan manual; mapping akhir sama persis dengan snapshot cloud. Anak akun yang ada di snapshot dilepas dari induk fork lalu dipasang ke induk cloud oleh upsert.
- Akun lokal yang kodenya tidak ada di snapshot (misal snapshot lama yang di-replay; signature tidak punya versi), atau snapshot dengan chart kosong, tetap ditolak `LOCAL_CONFLICT`: akun cloud yang sah tidak pernah terhapus oleh snapshot basi.
- Chart satu entitas tidak pernah berisi campuran akun cloud dan template lokal setelah apply berhasil.
- Semua perubahan terjadi di bawah lock `edge-master-sync`, CoA, lalu lokasi stok (urutan tetap, tanpa deadlock), dalam satu transaksi; gagal di tengah tidak meninggalkan perubahan sebagian.
- Hanya entitas dan tenant milik snapshot yang tersentuh (TEN-01/TEN-02); tidak ada akses lintas tenant atau lintas entitas.

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
