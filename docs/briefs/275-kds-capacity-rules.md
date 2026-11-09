# Brief lanjutan G6yqg: bukti gagal-dulu, lalu aturan kapasitas dapur

Lanjutan di thread yang sama. Aturan sama dengan brief 264.

## 1. Bukti gagal-dulu yang kurang (dulu, sebelum kerja baru)
- Tes untuk perbaikan review `6bbcb6cc` (refund manual 422, comp ganda bersamaan, `idempotencyKey` wajib, comp hanya di baris void, tipe input QR): jalankan terhadap kode `2a75a8c4` (sebelum perbaikan), sebut merah/hijau per tes.
- Tes `legend-tsp5` dan `legend-rutl`: jalankan terhadap basis `d8ea5e0b`, sebut merah/hijau.
- Tes yang tetap hijau di kode lama: perkuat sampai merah di kode lama, atau jelaskan.
Sesudah itu laporkan SHA cabang `ws/kds-issues-station` yang siap antre merge train, lalu lanjut ke bagian 2 di cabang baru (bagian 1 tidak menunggu bagian 2).

## 2. `legend-w4nq4` lalu `legend-44jm`
Cabang baru `ws/kds-capacity-rules` dari `ws/kds-issues-station` (HEAD sesudah bagian 1), worktree `.worktrees/kds-capacity-rules`, `worktree:setup`. Nomor migrasi dipesan: `0184`, `when` 1794263000000. Tabel `kitchen_capacity_rules` (pola `tenantIdColumn`, unik (tenant, id), FK komposit outlet/stasiun, RLS lewat `.custom.sql`), service, GET dan PUT dengan izin outlet yang sudah mengelola KDS, `requireTrustedOrigin`, body strict. Lalu `legend-44jm` memakai tabel itu. Tanpa UI baru.

## Kartu
Awal tiap kartu: `ghostex board associate <id>`, `bd update <id> --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Bukti selesai bagian 2
- Test gagal-dulu: isolasi tenant/outlet, validasi body, aturan kapasitas dipakai oleh 44jm sesuai kartu.
- `pnpm db:generate` lalu periksa SQL, generate kedua kosong, test migrasi RLS.
- Tes terarah, sebut jumlah file dan tes. Typecheck api + shared lewat `heavy` sekali; eslint + prettier.
- Review (Q48, tingkat S): satu `reviewer` sonnet.
- Tulis brief Codex `docs/briefs/264b-second-opinion-kds.md` untuk area KDS (refund ditolak, comp, potong stok, 0180, 0184) bila belum ada, jangan dijalankan.

## Laporan
Bagian 1: pesan singkat sesudah selesai (bukti + SHA). Bagian 2: sekali di akhir (SHA, migrasi `when`/prevId, bukti, kontrak UI, risiko, jumlah subagent dan puncak bersamaan).
