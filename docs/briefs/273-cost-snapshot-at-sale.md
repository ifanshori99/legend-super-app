# Brief: engineer (Sonnet) — HPP per baris pesanan saat penjualan

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/cost-snapshot-at-sale` dari `milestone/m1` (3517283b). Worktree `.worktrees/cost-snapshot-at-sale`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

Migrasi hanya bila benar perlu: nomor dipesan `0183`, `when` 1794262000000. Kolom `cost_snapshot_idr` sudah ada.

## Tujuan
`legend-u4js6` (P2, tingkat K uang). `cost_snapshot_idr` di baris pesanan tidak pernah ditulis, sehingga `menu_gross_margin` dan pecahan `cogs` per menu (WS-11 F3) tidak berangka. Titik sisip: `pos-order.service.ts:746`, `qr-order.service.ts:1804`, `delivery-inject.ts:411`, `edge/qr-order-applier.ts:98` (nomor baris dari kartu, cek ulang).

Langkah:
1. `Explore` dulu: dari mana HPP menu berasal sekarang (resep, biaya rata-rata bahan, deduksi stok), apakah dihitung di cloud saja atau juga tersedia di edge, dan apakah ada kerja KDS `legend-4b5` (cabang `ws/kds-issues-station`, thread G6yqg) yang menyentuh area deduksi resep yang sama. Bila bertumpuk, jangan ubah berkas itu; tulis di laporan.
2. Satu subagent `architect` memutuskan, dicatat di `docs/DECISIONS.md`: per unit atau per baris; sumber biaya dan momen pengambilan (saat pesanan dibuat atau saat lunas); modifier dan varian; menu tanpa resep (NULL, bukan 0, supaya laporan bisa menandai unavailable); pesanan dari edge yang tidak punya biaya (diisi saat sinkron di cloud, atau NULL); koreksi, void, refund tidak menulis ulang snapshot; pembulatan rupiah.
3. Satu helper bersama dipakai keempat titik sisip (tanpa salin logika). Implementasi di empat jalur bisa lewat `implementer` paralel bila berkasnya tidak bertumpuk.
4. Backfill untuk baris lama tidak dikerjakan; tulis kartu bd sendiri bila architect menganggap perlu.

## Kartu
Awal: `ghostex board associate legend-u4js6`, `bd update legend-u4js6 --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Scope
Boleh: service pesanan POS/QR/delivery/edge applier, helper biaya, test, migrasi 0183 bila perlu. Jangan: `services/metric-sources/*`, `metrics-query.service.ts`, `packages/shared/src/metrics/*` (milik thread WS-11), jurnal akuntansi otomatis, refund, UI.

## Bukti selesai
- Test gagal-dulu: keempat jalur menulis snapshot sesuai keputusan; modifier ikut; menu tanpa resep NULL; harga bahan berubah sesudah penjualan tidak mengubah snapshot lama; void/refund tidak menulis ulang; isolasi tenant.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes. Reader F3 (cabang `ws/ws11-menu-cogs`) belum ada di m1; cukup kontrak kolomnya.
- Migrasi (bila ada): `pnpm db:generate` lalu periksa SQL, generate kedua kosong, test migrasi RLS.
- Typecheck api (dan shared bila berubah) lewat `heavy` sekali di akhir; eslint + prettier berkas berubah. Jangan `pnpm check` penuh.
- Review (Q48, tingkat K): satu subagent `architect` untuk diff (boleh yang sama dengan langkah 2 bila konteksnya masih segar, jika tidak, yang baru).

## Laporan
Sekali di akhir: keputusan desain, hasil, SHA, migrasi (ada/tidak, `when`, prevId), bukti, file berubah, tumpang tindih dengan KDS, kartu baru, risiko, jumlah subagent dan puncak bersamaan.
