# Brief: engineer (Sonnet) — nomor panggil berhuruf di order takeaway dan delivery

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/pickup-call-letters` dari `ws/pickup-feed-service` (6fee08e3 atau lebih baru; legend-mzhr0, antre merge train). Worktree `.worktrees/pickup-call-letters`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

Nomor migrasi bila perlu: `0175`, `when` 1794254000000. Hanya bila format kolom nomor panggil harus berubah (mis. integer ke teks); perubahan tipe kolom yang berisi data = tingkat K.

## Tujuan
`legend-ggpoe`. Pasang `allocatePickupCall` ke alur order POS takeaway dan delivery di akhir transaksi order. Keputusan founder Q51: pesanan tidak pernah ditolak karena nomor habis. Format nomor panggil berhuruf: A-001..A-999, lalu B-001 dst, reset harian per outlet. Keputusan CTO: sesudah Z-999 lanjut AA-001, AB-001, dst. Ubah `allocatePickupCall` dan semua pembaca/tampilan API yang memakai nomor panggil (pickup display feed, expo, struk bila ada) supaya memakai format ini. Konkuren: dua order bersamaan tidak boleh dapat nomor sama.

## Kartu
Awal: `ghostex board associate legend-ggpoe`, `bd update legend-ggpoe --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Scope
Boleh: service pickup/expo/kitchen, alur order POS takeaway dan delivery (bagian alokasi nomor saja), validator/tipe di `packages/shared`, test, migrasi 0175 bila perlu. Jangan: payment/refund, delivery platform call (thread lain di `ws/delivery-ops-fixes`), UI (sebut perubahan tampilan yang perlu di laporan).

## Bukti selesai
- Test gagal-dulu: order ke-999 = A-999, ke-1000 = B-001, sesudah Z-999 = AA-001; reset hari berikut; dua order konkuren beda nomor; order takeaway dan delivery POS dapat nomor, dine-in tidak (cek perilaku yang ada).
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes. Test contract root bila `packages/shared` berubah: lewat `pnpm test`.
- Bila ada migrasi: `db:generate` kedua kosong, test migrasi untuk data lama.
- Typecheck paket yang berubah lewat `heavy` sekali di akhir, eslint + prettier berkas berubah. Jangan `pnpm check` penuh.
- Review (Q48): satu `reviewer` sonnet; bila migrasi mengubah tipe kolom berisi data, satu `architect` sebagai gantinya.

## Laporan
Sekali di akhir: hasil, SHA, migrasi (ada/tidak, `when`, prevId), bukti, file berubah, perubahan UI yang perlu, risiko, jumlah subagent dan puncak bersamaan.
