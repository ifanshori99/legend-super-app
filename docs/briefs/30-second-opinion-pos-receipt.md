# Brief: second-opinion — nomor struk dan e-receipt POS (legend-93a)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`. Read-only: jangan ubah kode, jangan commit. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Cabang `ws/pos-receipt` (HEAD `863b3ac`). Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-receipt` bila ada; bila tidak, baca lewat `git show`/`git diff main...ws/pos-receipt` dari checkout utama tanpa checkout cabang.

## Fokus (uang, keamanan, data pribadi)
- Nomor struk tanpa celah dan tanpa duplikat: race antar device/kasir bersamaan, rollback transaksi tidak meninggalkan lubang (atau lubang tercatat sesuai aturan), urutan per outlet/periode.
- Trigger DB immutability: struk yang sudah terbit tidak bisa diubah/dihapus, termasuk oleh role aplikasi; koreksi hanya lewat dokumen baru.
- Token e-receipt: disimpan sebagai hash, entropi cukup, rate limit pada endpoint publik, token dan PII diredaksi dari log, tidak bisa enumerasi.
- Email pelanggan disimpan terenkripsi; kunci tidak di repo; dekripsi hanya di jalur yang perlu.
- RLS 5 tabel baru: isolasi tenant/outlet dipaksa (FORCE), policy benar untuk role app dan worker.
- Merge run offline: nomor dari edge/offline digabung ke cloud tanpa bentrok dan tanpa celah ganda; idempoten bila diulang.
- Migration aman untuk data lama. Nomor yang bentrok dengan cabang lain dirapikan saat merge; itu bukan temuan.
- Test benar-benar membuktikan klaim. Boleh reproduksi dengan DB sementara (`~/.claude/scripts/colima-up`), bersihkan sesudahnya.

## Laporan
Temuan urut paling berat: file:baris, masalah, skenario gagal konkret, fix. "Tidak ada blocker" bila memang tidak ada.
