# 798 Second opinion area pajak PBJT, FK resep menu, rotasi kunci
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Migrasi dan kunci: effort xhigh. Read-only, tanpa edit kode produk.
Cakupan: diff `origin/milestone/m1...origin/ws/tax-menu-keyrotation` (ujung 98a959b74):
- Rekap PBJT per (aturan, tarif, mode harga): gross inklusif dan eksklusif tidak dijumlah, pajak dan DPP tepat, CSV web.
- Migrasi `0374_menu_recipe_fk`: FK komposit (tenant_id, recipe_id) di tiga tabel, NULL-kan recipe_id yatim, FORCE RLS dilepas dan dipulihkan dalam satu transaksi, FK modifier dilewati bila `legend.edge_mode=on`. Urutan stream katalog edge (recipes sebelum menu_items/item_variants).
- Job pg-boss `data-key-rotation.job.ts` (cron 03:15 Asia/Jakarta): advisory lock sesi pada koneksi tersendiri, rotasi per tenant, log tanpa kunci.
Cari: pajak salah lapor (lebih atau kurang), data hilang atau RLS terbuka saat migrasi, migrasi gagal di data produksi nyata (yatim, lintas tenant), lock bocor atau job ganda, kunci atau plaintext bocor ke log, rotasi setengah jalan yang membuat data tidak bisa dibuka, edge macet.
Tanpa heavy kecuali benar perlu satu test terarah (LEGEND_TEST_FILES=... heavy pnpm test).
Hasil: tulis `docs/qa/second-opinion-pajak-fk-rotasi.md` di worktree-mu (P0-P3, berkas:baris, skenario gagal konkret, usul test). Lapor ringkasannya.
