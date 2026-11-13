# Brief: designer (Codex) — UI pencairan gaji dan daftar pengecualian finance

## Peran
Baca `~/.agents/team/roles/designer.md`, lalu ikuti. Jangan jalankan `bd`.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree sendiri dari `origin/ws/finance-exceptions`: `git worktree add .worktrees/design-payout-finance -b design/payout-finance origin/ws/finance-exceptions`.

## Tujuan
Mockup untuk gerbang founder, dua area:
1. Pencairan gaji (kartu legend-wnkep.6 dan legend-wnkep.7; CTO menyalin isinya ke `docs/briefs/669-cards.txt`). Keputusan founder: rilis awal bayar gaji lewat Duitku disbursement (mati sampai diaktifkan per PT) atau transfer manual dengan persetujuan dua orang; biaya transfer Rp5.000 ditanggung PT; format berkas bank ditunda setelah rilis. Tampilkan: daftar run siap bayar, persetujuan dua orang, status per karyawan (menunggu, berhasil, gagal, dibayar manual), rekening sumber tidak aktif (ditolak), Duitku belum aktif.
2. Daftar pengecualian finance (legend-4oclu). API: `GET /api/accounting/finance-exceptions?kind=&outletId=&from=&to=` (lihat `packages/shared` dan route accounting di cabang ini). Lima jenis: pajak edge belum tersnapshot, void edge tidak didukung, struk edge dilewati, link edge dead-letter, biaya payout belum dijurnal. Tiap jenis: jumlah dan nilai rupiah, filter outlet/tanggal, kosong, error.
Desktop 1440 dan mobile 390, state normal/kosong/error/memuat. Ikuti `~/.agents/team/ui-standard.md` dan pola `design/mockups/backoffice/`.

## Batas
Hanya `design/mockups/payout/` dan `design/mockups/finance-exceptions/`. Page review per area (`review.html`), dicek `ghostex visual check <file> --out <png>` dan `--width 390`. Commit lalu push `design/payout-finance` tanpa force.

## Laporan
Path page review, daftar state, tiga keputusan desain, asumsi yang perlu dikonfirmasi founder.
