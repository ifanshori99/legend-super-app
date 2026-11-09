# Brief: second-opinion — urutan sisip stock ledger (legend-bsw9)

## Peran

Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/stock-ledger-sequence`, cabang `ws/stock-ledger-sequence`, SHA `3f30797e`.
Rentang diff: `git diff 3517283b 3f30797e` (isi cabang saja di atas `milestone/m1` 3517283b; abaikan `apps/api/drizzle/meta/0186_snapshot.json`).

## Berkas berisiko

- `apps/api/drizzle/0186_stock_ledger_posting_seq.sql` (migrasi data: mengangkat trigger append-only dan FORCE RLS sementara, isi urutan baris lama, identity restart)
- `apps/api/src/db/schema/inventory.ts` (kolom `posting_seq`, indeks baru)
- `apps/api/src/services/inventory.service.ts` (`rebuildStockBalances` melipat menurut `postingSeq`; `recordStockMovementInTransaction` dan applier edge menyisipkan baris di bawah advisory lock lokasi + kunci baris saldo)
- `packages/shared/src/inventory/schemas.ts` (`foldStockLedger` urutan `"posting"`)
- Tes: `apps/api/src/test/inventory-ledger-sequence.test.ts`, `stock-ledger-posting-seq-migration.test.ts`

## Invariant (PRD)

- INV-01: saldo diturunkan dari ledger; kartu stok append-only (trigger menolak UPDATE/DELETE untuk semua role).
- PRD v1.7 §16 Metode Biaya: rata-rata bergerak per lokasi; posting mundur tanggal (EOD, opname, impor) tetap boleh.
- Rebuild harus sama dengan saldo live (`stock_balances`) untuk satu (lokasi, item).
- Isolasi tenant (RLS FORCE) tetap utuh sesudah migrasi; migrasi tidak boleh meninggalkan trigger atau RLS dalam keadaan mati.

## Yang diminta

1. Apakah urutan identity sama dengan urutan penerapan rata-rata live di tiap jalur sisip (posting biasa, applier edge, retry idempoten yang kalah balapan)? Cari jalur yang menyisip tanpa kunci lokasi.
2. Migrasi: aman bila gagal di tengah (transaksi)? Baris lama diberi nomor `(occurred_at, id)`; risiko pada database yang sudah punya posting mundur tanggal. Tabel besar: waktu kunci.
3. Nomor urut bigint identity GENERATED ALWAYS: ada kode yang menyisip nilai eksplisit, kloning tabel, atau ekspor/impor ledger yang pecah?
4. Pembaca lain yang berurut `(occurred_at, id)` dan seharusnya ikut urutan sisip (`inventory-gl-consumer.ts` ~:453, `inventory-count.shared.ts` ~:165 harga terakhir, replay F5 `metric-sources/inventory-purchasing.ts` di `ws/ws11-inventory-purchasing`).

## Effort

xhigh (uang + migrasi).

## Laporan

Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan

Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
