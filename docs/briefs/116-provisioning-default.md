# Brief 116: engineer — provisioning default entitas dan outlet baru (legend-a7x7, legend-4ryw)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.
Tingkat: legend-a7x7 = K (mapping akun menentukan ke mana uang dijurnal). legend-4ryw = S.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Folder proyek sedang di cabang lain; jangan checkout di sana.
Buat worktree sendiri: `git worktree add .worktrees/provisioning-default -b ws/provisioning-default milestone/m1`. Jangan pakai `--worktree` Ghostex.

## Tujuan
Tenant, entitas legal, dan outlet yang dibuat lewat panel (bukan seed dev) langsung siap dipakai: punya bagan akun standar F&B beserta mapping default, katalog UOM standar, dan enam lokasi stok per outlet.

## Kartu
`legend-a7x7`, `legend-4ryw`. Di awal: `ghostex board associate <id>` dan `bd update <id> --status in_progress` untuk keduanya. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan bahasa biasa>"`.

## Masukan
- `bd show legend-a7x7`, `bd show legend-4ryw` (deskripsi lengkap dan rujukan PRD).
- PRD v1.7 §3.19 Chart of Accounts, §6 F chart_of_accounts, §16 Lokasi Stok.
- Kontrak akuntansi: `standardFnbChartTemplate` dan default roles-nya. Storage dan route CoA dari legend-kwxj sudah ada.
- `createLegalEntity` di `apps/api/src/routes/org.routes.ts`; tabel `stock_locations` dan UOM sudah ada (legend-98t).

## Tugas
1. a7x7: provisioning CoA standar + mapping default saat entitas legal dibuat, dalam transaksi yang sama. Idempoten (dijalankan dua kali tidak menggandakan), tercatat di audit. Tenant tetap boleh mengubah bagan setelahnya.
2. 4ryw: provisioning katalog UOM standar per tenant dan enam lokasi stok per outlet (gudang, chiller, freezer, bar, kitchen, pastry) saat tenant atau outlet dibuat. Idempoten.
3. Backfill: sediakan cara aman mengisi tenant/entitas/outlet lama yang belum punya data ini (fungsi idempoten yang bisa dipanggil skrip atau migrasi data), tanpa mengubah baris yang sudah ada.
4. Test: entitas baru punya CoA + mapping; outlet baru punya 6 lokasi; panggil ulang tidak menggandakan; isolasi tenant (tenant A tidak melihat atau mengubah milik B).

## Scope
- Boleh diubah: service dan route org/outlet/tenant, service akuntansi dan inventori yang terkait provisioning, `packages/shared` bila kontrak perlu endpoint baru, test di `apps/api/src/test/`, migrasi baru bila perlu.
- Jangan disentuh: modul refund dan pembayaran, `order-promo-refund.ts`, sinkron edge, konfigurasi pajak default (legend-9obf ditahan sampai keputusan founder soal "harga nett").

## Bukti selesai
- Test terarah: `LEGEND_TEST_FILES="<file test baru dan yang terdampak>" pnpm test` dari root worktree.
- Lint dan typecheck paket yang berubah lewat `heavy`.
- `pnpm db:generate` kosong, atau migrasi baru tercatat dengan nomor.
- Review: a7x7 tingkat K, jadi `reviewer` Opus dan `architect` bersamaan sebelum melapor; 4ryw `reviewer` Sonnet.

## Sebelum melapor
Commit lokal di `ws/provisioning-default`, hanya file dalam scope. Jangan push.

## Laporan
SHA awal..akhir, migrasi (nomor), hasil gate, temuan review, file berubah, bead baru, risiko tersisa.
