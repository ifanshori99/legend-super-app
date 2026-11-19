# 1196 Second opinion reseal kolom tersegel beku (1189)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree: `git diff`/`git show` dari folder utama, jangan checkout. Selesaikan dan lapor dalam SATU giliran.

Fokus: `git fetch origin`, lalu `git diff origin/milestone/m1...origin/ws/1189-sealed-reseal-frozen` (head 782c4b938; migrasi kerja 0720).
Isi: legend-4vfmn + 49onu. Fungsi `app.reseal_frozen_sealed` SECURITY DEFINER (grup legend_sealed_reseal, EXECUTE hanya grup), 4 kolom beku (orders.payment_link_token_sealed, orders.claim_token_sealed, pos_order_tenders.payment_link_token_sealed, apology_vouchers.code_sealed), compare-and-set nilai lama, envelope lengkap panjang sama dan versi tidak turun, trigger frozen hanya izinkan kolom sealed oleh owner fungsi dengan kolom lain identik, guard trigger apology_vouchers, job reseal pass kedua (cek plaintext sebelum kirim), remaining hitung baris beku, audit provision-roles.
Risiko yang sudah diterima CTO: API terkompromi bisa SET ROLE grup dan menulis envelope sampah sepanjang sama di baris beku tenant sendiri. Nilai apakah ada mitigasi murah.
Cari: search_path/SECURITY DEFINER hijack, kolom lain bisa diubah lewat fungsi atau trigger, lintas tenant, pensiun kunci sebelum remaining 0, voucher aktif hilang/rusak, privilese grup berlebih, backfill/DELETE terblokir tak sengaja.
Hasil: tulis `docs/qa/second-opinion-sealed-reseal-1196.md` di folder utama (P0-P3, berkas:baris, skenario, usul test). JANGAN commit, JANGAN edit file lain.
