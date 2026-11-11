# Brief: perbaikan temuan second-opinion katalog edge (legend-0mus6)

Di cabang 24318 yang sama (setelah atau bersama 24318/d0ipm). Keputusan CTO: semua nyata. Harga = uang: architect xhigh.

## Keputusan desain CTO (P1 1+2)
Ganti kursor waktu dengan versi monoton aman-commit: kolom `sync_txid xid8` (atau bigint) diisi trigger `pg_current_xact_id()` saat insert/update di tiap tabel stream; server hanya mengirim baris dengan `sync_txid < pg_snapshot_xmin(pg_current_snapshot())`, urut `(sync_txid, id)`; checkpoint = (sync_txid, id). Apply edge menolak versi dengan sync_txid lebih kecil dari yang tersimpan (bukan timestamp `<=`). Settle window waktu dihapus. Bila architect menemukan alasan kuat untuk pola lain yang setara, catat di laporan.

## Temuan (Codex G6kee, pada 6343a727)
1. P1 `edge-catalog-sync.ts:75`, `catalog-puller.ts:213`: commit terlambat di luar overlap 10 menit terlewat permanen.
2. P1 `edge-catalog-sync.ts:175`, `edge-catalog-apply.ts:590`: dua versi dalam milidetik sama; pull paralel mengembalikan data lama.
3. P1 `edge-catalog-apply.ts:584`, `edge-catalog-sync.ts:440`: daftar harga A dihapus + B dibuat (kunci unik sama) -> B ditolak, retry macet, harga A tetap. Lepas kunci unik (terapkan tombstone dulu) sebelum insert, termasuk lintas halaman.
4. P2 `catalog-puller.ts:224`: repair parent kategori hanya di memori; simpan durable atau rekonstruksi setelah restart.
5. P2 `catalog-puller.ts:213`: backlog > 100.000 baris berulang di halaman yang sama; simpan posisi lanjutan (selesai otomatis dengan desain sync_txid).

## Bukti
Test gagal-dulu per temuan (termasuk dua transaksi bersamaan untuk 1+2), lint paket, typecheck API 6144, migrasi nomor sementara 0284. Commit + push tiap langkah.
