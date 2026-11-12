# sub-539-u1 fix 4 (ui-auditor final, commit 3735ccd0)

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-cashier-captain`. Path relatif `apps/web/src/features/ws04-pos-order/`. Jangan commit; jangan tsc/build; jangan ubah AreaFrame `_ops`, `components/ui/*`, `styles/tokens.css`. Cek di dev server mock http://localhost:3241 (jangan start server lain). Setelah selesai boleh jalankan subset ui-check-mu sekali: `UI_CHECK_URL=http://localhost:3241 heavy node scripts/ui-check-pos-u1.mjs <filter>` (filter: `kasir` atau `captain`), lalu lihat PNG 390 dan 1280 hasilnya. Teks yang dicari ui-check tetap sama. Laporan ≤8 baris.

## K2 kasir: components/cashier/*, components/modifier-dialog.tsx, i18n pos-order-{catalog,cart}.ts

1. Keranjang HP (`kasir-keranjang-mobile-390`): footer sticky menimpa baris; baris 2 tak terlihat. Daftar harus scroll sendiri di atas footer (tinggi tetap view keranjang mobile, atau footer tidak sticky di < 701 px). Semua baris dapat dijangkau, kontrol −/+/Tahan tidak terpotong.
2. Desktop 1280×800 (`kasir-main-1280`): daftar hanya ±130 px. Beri ruang min. 2 baris penuh: hapus petunjuk "Periksa pesanan…" di footer (cart-pane ±177), rapatkan baris (chip Tahan sejajar stepper).
3. Urungkan hapus (cashier-main-screen 104-153, cart-pane 273): simpan beberapa baris terhapus (urungkan memulihkan yang terakhir, lalu berikutnya) atau satu entri yang memulihkan semua; jangan bersihkan saat `pick`/`changeMeta`; setelah hapus fokus pindah ke kontrol baris berikut atau tombol "Urungkan".
4. Tombol Tahan per baris (cart-pane 305-324): label aksesibel stabil yang memuat teks terlihat (mis. "Tahan {name}") + `aria-pressed`; jangan ganti label saat aktif.
5. Kolom nomor pesanan online (channel-toggle 182-196): label kecil terlihat di atas input (bukan sr-only).
6. Copy "kamu" di `pos-order-cart.ts` (`parkedSheet.emptyDescription`) jadi "Anda".

## C2 captain: components/captain/*, i18n pos-captain-{tables,order}.ts

1. `captain-main-390`: konten melebar ke samping (chip "Contoh data" terpotong, tombol "Lihat" banner terpotong, ubin meja kedua keluar layar). Baris filter `grid grid-cols-3` dengan tombol `min-w-0` (teks boleh 2 baris); anak grid `min-w-0` / `grid-cols-[minmax(0,1fr)]` (captain-shell ±93, tables-screen ±89); hapus `whitespace-nowrap` call-banner ±34. Cek 320 dan 390 tanpa geser samping.
2. Bottom bar (captain-shell ±116) melayang ±16 px di atas tepi bawah; teks daftar terlihat di bawahnya. Tempelkan rapat ke bawah viewport (mis. `sticky -bottom-4 -mx-4` + padding bawah, atau `fixed inset-x-0 bottom-0` dengan lebar maks sama + padding bawah konten).
3. Dialog "Ubah item" (review-screen ±314): `data-density="kontras"` seperti dialog kasir.
4. Kurangi di jumlah 1 / "Hapus item" (add-order-screen 318-327, review-screen ±374) menghapus baris bermodifier/catatan tanpa jalan kembali: beri Notice "Item dihapus" + "Urungkan" seperti kasir (atau konfirmasi bila baris punya modifier/catatan).
5. Jumlah stepper (add-order-screen 328-333) diumumkan: `sr-only` `role="status"` atau hapus `aria-hidden` + `aria-live="polite"`.
6. call-banner 23-25: alasan kosong → pakai label jenis panggilan seperti calls-screen ±323.
7. Urutan heading: h1 → h2 (bukan h3) di table-order-screen ±122, add-order-screen ±295, review-screen ±247.
