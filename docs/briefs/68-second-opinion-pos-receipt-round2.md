# Brief: second-opinion — nomor struk dan e-receipt POS putaran 2 (legend-93a) — PRIORITAS

## Peran
Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`. Read-only: jangan ubah kode, jangan commit. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-receipt`, cabang `ws/pos-receipt` (HEAD `8d85436 (putaran 2 + struk tanpa pajak f0ac0a1/8d85436; HEAD terbaru cabang)`). Diff: `git diff main...ws/pos-receipt` (abaikan snapshot drizzle `meta/*.json` yang besar). Temuan putaran 1 ada di `docs/briefs/30-second-opinion-pos-receipt.md`; perbaikannya di `docs/briefs/55-fix-pos-receipt-round2.md`. Migration `0063_pos_receipts` sudah diregenerasi; nomor 0063 bentrok dengan cabang lain, itu dirapikan saat merge dan bukan temuan.

## Fokus (uang, keamanan, data pribadi; wajib diverifikasi ulang)
- Tiga temuan putaran 1 benar-benar tertutup:
  - (P1) Merge run offline: counter batch offline hanya maju bila nomor `1..lastNumber` semua hadir; bila ada celah, gagal dengan `RECEIPT_SEQUENCE_GAP`. Replay batch idempoten. Cek `pos-receipt.service.ts` sekitar merge offline.
  - (P2) `outlet_snapshot` dibekukan saat terbit (issue/merge). Cetak, PDF, email, e-receipt publik, dan invoice memakai snapshot, bukan data outlet terkini. Cek `pos-receipt-document.ts` dan semua pemanggilnya.
  - (P3) Token `%ZZ` yang rusak → 400. Token tidak pernah masuk log (`URIError.message`, stack, serializer error). Cek `app.ts` dan `error-handler.ts`.
- Tambahan putaran 2 yang wajib diverifikasi:
  - Batas `lastNumber` 0..999999999; nilai di luar rentang ditolak.
  - Pencarian celah dibatasi 21 nomor; cek tidak ada jalur yang bisa memicu pencarian tak terbatas atau melewati batas.
  - Header outlet dari device divalidasi terhadap outlet pemilik sesi/device; device outlet lain tidak bisa menulis struk outlet ini.
  - Void race: update memakai `AND status='issued'`; void kedua pada struk yang sudah void adalah no-op, tidak menulis ulang snapshot atau nomor.
  - Hanya decode error dari router yang menjadi 400; error lain tetap 500 tanpa echo input.
- Race: dua device/kasir terbit bersamaan; nomor unik per outlet/periode, tidak ada duplikat, tidak ada celah yang tidak tercatat. Rollback transaksi tidak meninggalkan lubang tanpa catatan.
- Trigger DB immutability: struk `issued` tidak bisa diubah/dihapus, termasuk oleh role aplikasi; koreksi hanya lewat dokumen baru.
- Token e-receipt: disimpan sebagai hash, entropi cukup, rate limit pada endpoint publik, tidak bisa enumerasi.
- Email pelanggan terenkripsi; kunci tidak di repo; dekripsi hanya di jalur yang perlu.
- RLS tabel baru di migration `0063_pos_receipts`: isolasi tenant/outlet dipaksa (FORCE), policy benar untuk role app dan worker.
- Migration 0063 aman untuk data lama; tandai migration yang tidak bisa dibatalkan.
- Test benar-benar membuktikan klaim. Boleh reproduksi dengan DB sementara (`~/.claude/scripts/colima-up`), bersihkan sesudahnya.

## Laporan
Temuan urut paling berat: file:baris, masalah, skenario gagal konkret, fix. Tandai untuk tiap dari tiga temuan putaran 1: tertutup atau belum. Tandai juga tiap poin tambahan putaran 2. "Tidak ada blocker" bila memang tidak ada.
