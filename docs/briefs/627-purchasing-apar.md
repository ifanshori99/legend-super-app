# Brief: engineer — purchasing, AP/AR, akuntansi (WS-06/07)

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti. Tingkat K (uang + migrasi). Desain 3-way match baru: mulai dengan satu subagent `architect` effort xhigh untuk desain singkat.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `milestone/m1` (origin). Push ke `origin` sebagai `ws/purchasing-apar`.

## Kartu (baca `bd show <id>`; cek `git log --all --oneline --grep <id>` agar tidak dobel)
1. `legend-lspfy`: faktur pemasok + 3-way match (PO, penerimaan, faktur).
2. `legend-nz13`: toleransi 3-way match per tenant.
3. `legend-uyk2`: purchasing/AR memanggil AP/AR di transaksi yang sama.
4. `legend-179bw`: debit note retur membuat open item AP.
5. `legend-a5wl`: registry deep-link jurnal (ACC-03).
6. `legend-xysyi`: Coretax XML memakai NPWP sungguhan.
Kartu terblokir/butuh keputusan bisnis: lewati dan laporkan. Jangan sentuh payroll, kas bank, settlement, QRIS.

## Migrasi
Rentang `0490-0491` saja. `db:generate` kosong setelahnya.

## Aturan uang (founder)
Test gagal-dulu: faktur melebihi PO/penerimaan di luar toleransi ditolak/ditahan (pemasok tidak dibayar lebih); debit note mengurangi utang tepat sekali; posting AP/AR gagal = transaksi purchasing batal (tidak setengah tercatat); tenant lain ditolak.

## Pembagian paralel
architect (desain, xhigh), Explore, test-writer, implementer per kartu (maks 4 mengedit, file terpisah), architect xhigh atas diff akhir, satu `test-runner` (run_in_background + Monitor, tanpa loop sleep). Typecheck api lewat `heavy` sekali sebelum lapor. Test terarah dari ROOT worktree.

## Batas
Jangan `pkill`; jangan merge ke m1; jangan deploy. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
