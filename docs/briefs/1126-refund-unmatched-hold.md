# 1126 Webhook refund unmatched wajib hold (tingkat K uang)
Peran: engineer (`~/.agents/team/roles/engineer.md`). Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Base `origin/ws/1072-refund-ronde6-q45` (ccd688e11). Cabang baru `ws/1126-refund-unmatched-hold`, landing SESUDAH 1072. Push tanpa `--force`. Tanpa migrasi bila bisa (bila perlu: nomor sesudah 0493, lapor; akan dinomori ulang).
## Masalah (laporan 1119)
Webhook refund bertanda tangan yang tidak cocok kandidat (payment-object tanpa kandidat, atau sukses flat tanpa refund id) diabaikan tanpa hold. Refund dari dashboard penyedia lalu tidak mengurangi ruang refund; refund manual finance bisa membayar dua kali.
## Keputusan CTO (membatasi)
1. Setiap sukses refund bertanda tangan yang menyebut pembayaran Legend (payment id/reference yang bisa dipetakan ke pembayaran) tetapi tidak cocok R mana pun: buat satu hold CONFLICT per event tersimpan (kunci stabil), nilai penuh laporan, masuk antrean finance. Tidak membuat fact/jurnal/refund.
2. Bila pembayaran pun tidak bisa dipetakan: simpan event + alert finance (pola yang sudah ada), tanpa hold; catat di laporan berapa jalur seperti ini.
3. Juga P3-4 (laporan 1119): satu fact tidak boleh menutup dua hold berbeda lewat cabang rowOf dengan id dari finance; ikat satu fact ke satu hold (cakupan dihitung per hold, fact yang sudah dipakai menutup hold lain tidak dihitung lagi).
## Bukti
Test merah di ccd688e11, hijau di head: unmatched payment-object -> hold CONFLICT, refund manual sisa ditolak; flat tanpa refund id -> hold; satu fact dua hold -> hold kedua tetap terbuka. Test tabel total keluar <= dibayar diperluas. Regresi 1072/1119 terarah. Typecheck API sekali lewat heavy. Prettier/eslint. Architect xhigh delta sekali.
## Laporan
Commit, head SHA, risiko. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.
