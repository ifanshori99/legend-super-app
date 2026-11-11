# 497 Temuan second-opinion ledger WS-07 + keputusan CTO

Sumber: Codex G8mjq, review e916b037. Kerjakan di cabang yang berbasis `origin/ws/ledger-integrity`. Test gagal-dulu tiap temuan (konkurensi: dua koneksi PostgreSQL nyata). Aturan: tidak ada jurnal masuk ke periode tertutup lewat jalur apa pun, nilai buku tidak ganda.

P1
1. `0310_journal_closed_period_guard.sql:36` snapshot REPEATABLE READ basi saat close. Keputusan: close periode meng-UPDATE baris legal entity (naikkan `ledger_version`), dan trigger jurnal mengunci baris itu, sehingga penulis RR dengan snapshot lama gagal serialisasi. Test dua koneksi.
2. `0310...:28` kolom `period` dan `legal_entity_id` periode bisa diganti. Keputusan: immutable setelah insert (trigger tolak UPDATE kolom itu).
3. `accounting-fixed-assets.service.ts:720` revaluasi mundur membalik depresiasi tanpa posting ulang. Keputusan (membatasi): posting ulang bulan terdampak dalam transaksi revaluasi yang sama; bila ada bulan terdampak yang sudah ditutup, tolak revaluasi 409 `PERIOD_CLOSED` tanpa menulis apa pun.
4. `accounting-fixed-assets.service.ts:615` early return melewati cek revaluasi lebih baru. Keputusan: cek revaluasi/disposal lebih baru sebelum early return; tolak bila ada.

P2
5. `0311...:47` generasi aktif tidak diserialisasi. Keputusan: unique partial index (tenant, aset, bulan) WHERE aktif (belum dibalik).
6. `0311...:20` baris pembalikan bisa menunjuk jurnal sembarang. Keputusan: INSERT ke tabel reversal hanya lewat fungsi DB yang memvalidasi jurnal koreksi (aset, bulan, jumlah sama, debit/kredit terbalik); cabut INSERT langsung dari `legend_app`.
7. `metric-catalog.ts:284` rasio mengiklankan `legal_entity` padahal tidak didukung. Keputusan: hapus `legal_entity` dari `gross_margin_pct`, `labor_cost_pct`, `prime_cost_pct` dulu; buat kartu P3 untuk dukungan sebenarnya.
