# 1270 WFC W1 (skema): brief review K

Worktree `../legend-1270-w1`, diff `7705b4bed..07ba9eb45` di `ws/1270-w1`. Acuan: `docs/briefs/1270-wfc-berbayar.md` (W1, "Revisi keputusan 28") dan keputusan 26-28 di `docs/founder/keputusan-2026-11-21.md`. Read-only; jangan jalankan suite.

Periksa: migrasi 0526 (expand-only, constraint NOT VALID/validasi, backfill, lock tabel besar, journal idx 526 dan prevId 0525, urutan deploy cloud lalu edge); EXCLUDE kursi tidak bocor (zona, waktu, status); harga = kursi + kredit (>0) tidak bisa 0/negatif; klaim hanya sesudah lunas dibuktikan DB, bukan kode saja; settings append-only dua orang (penyusun tidak bisa menyetujui sendiri, SQL langsung pun ditolak); flag bawaan mati dan tanpa angka lengkap = jual mati; shower tetap tertutup (F0); kuota mingguan vs "kuota kursi per jam" keputusan 28; pass terjual tidak berubah bila settings berubah; isolasi outlet dan tenant; tes bermakna.

Keputusan agent yang perlu dinilai: produk WFC selalu nonaktif sampai W1b; `menu_item_id` wajib kosong; kuota mingguan (hari 0-6 x jam).

Laporan maks 12 baris: LULUS / TIDAK, P1-P3 file:baris + perbaikan, dan apakah W1b/W2 boleh mulai di atasnya.
