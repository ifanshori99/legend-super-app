# sub-539-u1 fix 2 (temuan ui-auditor, commit 2fb7b4e5)

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-cashier-captain`. Path relatif ke `apps/web/src/features/ws04-pos-order/` kecuali disebut. Jangan commit; jangan tsc/build/Playwright. Hanya berkas kelompokmu. Dev server mock jalan di http://localhost:3241 (boleh dibuka untuk cek, jangan start server lain). Toast: `components/ui/toast`. Laporan ≤10 baris.

## G1 kasir: components/cashier/*, components/modifier-dialog.tsx, routes/\_ops/pos.kasir.tsx, i18n pos-order-{catalog,cart}.ts

1. Indikator konektivitas di kepala layar kasir dari `useOrderingConnectivity` (mockup cashier-main-offline-\*: pil "⚠ Offline"; online: tidak ada pil atau "Terhubung" tenang).
2. Tampilan menu/keranjang mobile di search param (`validateSearch` di pos.kasir.tsx, `?v=keranjang`), supaya tombol Back browser kembali ke menu.
3. Error validasi (meja/ojol): fokus + scrollIntoView ke field pertama yang error; pesan `role="alert"`.
4. 390 px: tombol aksi keranjang `px-3`, label tidak meluber; "Dine-in" `whitespace-nowrap`.
5. Hapus baris (ikon sampah): toast "Item dihapus" + aksi "Urungkan" (kembalikan baris di posisi semula).
6. ModifierDialog "Tambah ke keranjang": gaya normal (bukan pudar); ketukan tanpa pilihan wajib menampilkan pesan + fokus ke grup.
7. Tombol "Tahan" per baris: pil outline kecil seperti mockup ("Tahan · Course 2"), bukan ghost.
8. Kolom cari: `spellCheck={false}`, `name`, `autoComplete="off"`; umumkan jumlah hasil filter lewat live region tenang.

## G2 captain: components/captain/*, routes \_ops/pos.captain.\*, i18n pos-captain-{tables,order}.ts

1. CaptainShell ringkas: hapus baris brand "Legend / Captain"; satu header (kembali + judul sebagai `<h1>` + badge konektivitas); jangan ada `<h1>` kedua dengan judul sama di isi. Judul pendek saat memuat (kode meja bila ada).
2. Bottom bar `pb-[max(1rem,env(safe-area-inset-bottom))]`.
3. calls-screen: "Selesaikan" → toast + "Urungkan" (tunda resolve 5 s atau panggil ulang); setelah aksi fokus ke kartu berikut / judul daftar; notice sukses hilang setelah ±4 s dan direset tiap aksi; "Terima" memberi konfirmasi singkat. Gagal polling: pertahankan `data`, tampilkan Notice "Daftar mungkin belum terbaru".
4. call-banner: wrapper `aria-live="polite"` yang selalu ada di tables-screen; banner dirender di dalamnya.
5. table-order-screen: 404 meja sama seperti add-order (EmptyState + kembali ke daftar meja); satu tombol "Kirim {course} ke dapur" per kelompok course (bukan per baris).
6. add-order-screen: sembunyikan bottom bar bila meja tidak ditemukan; strip kategori geser horizontal seperti kasir (bukan flex-wrap).
7. review-screen: hapus `aria-label` switch; nama dari `Label htmlFor` (WCAG 2.5.3).

## G3 konektivitas: hooks.ts (hanya `useOrderingConnectivity`), demo-seed.ts, dan bila perlu mock ws02-edge (`apps/web/src/features/ws02-edge/**`, cari seed/demo offline)

1. Satu sumber kebenaran: `useOrderingConnectivity` membaca status ws02-edge (cloud putus, edge lokal hidup → `edge_only`) di luar demo; `?demo=offline` juga membuat status ws02-edge di mock menjadi cloud-putus, sehingga badge shell `_ops` ("Terhubung") ikut berubah dan tidak bertentangan. Jangan ubah perilaku ws02-edge untuk route lain tanpa seed.
2. Cek apakah banner "Sesi akses dukungan · Hanya baca" di mock POS muncul karena bawaan mock (di mana) — laporkan saja, jangan ubah.
