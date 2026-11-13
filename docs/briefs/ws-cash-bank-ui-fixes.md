# UI fixes ws07 (ui-auditor, 13 Nov) — semua dikerjakan
1. Touched per field (blur/submit); select tidak memicu error nominal. cash-entry-dialog.tsx:161-165, petty-cash-movement-dialog.tsx:126-130.
2. Tombol submit tetap aktif; validasi saat submit dengan pesan di tiap field wajib (deskripsi, akun lawan, outlet). cash-entry-dialog.tsx:406, petty-cash-movement-dialog.tsx:281.
3. fundsQuery pending: skeleton saldo, jangan hitung overBalance dari 0; error: tombol coba lagi. petty-cash-movement-dialog.tsx:104-105.
4. Empty state: aksi utama hanya sekali (actions hanya saat ready). cash-entries-section.tsx:120+124, petty-cash-card.tsx:98+102.
5. Pemilih riwayat outlet: gaya terpilih terlihat (bukan hanya aria-pressed). petty-cash-card.tsx:125-133.
6. Jangan tampilkan potongan UUID; skeleton/"—" saat lookup pending, "Rekening tidak ditemukan" saat miss. cash-entries-section.tsx:64,73; petty-cash-card.tsx:65-67,205.
7. Tanpa rekening bank: hint "Tambah rekening bank dulu" + tautan ke bagian rekening. cash-entries-section.tsx:59,83; petty-cash-card.tsx:75,139-165.
8. Item transfer disabled: tampilkan alasan ("Butuh 2 rekening"). cash-entries-section.tsx:99-104.
9. "Kembalikan ke bank" disabled saldo 0: tampilkan alasan. petty-cash-card.tsx:156.
10. serverError: fokus/scroll ke pesan; petakan kode error (PETTY_CASH_INSUFFICIENT, CASH_BANK_COUNTER_ACCOUNT_INVALID, IDEMPOTENCY_KEY_REUSED, ACCOUNT_MAPPING_MISSING, PERIOD_CLOSED) ke teks i18n.
11. (UANG) Akun lawan TANPA default: placeholder kosong, wajib dipilih. cash-entry-dialog.tsx:132.
12. Label bulan periode terlihat di daftar (cash-entries-section.tsx:48, petty-cash-card.tsx:191).
13. Saldo di petty dialog jadi hint field outlet / role="status".
Setelah ubah: `node --test` tidak boleh; jalankan ulang hanya bila engineer minta. Tanpa tsc.
