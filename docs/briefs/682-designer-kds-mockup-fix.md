# Brief: designer (Codex) — rapikan mockup stasiun dan scanner dapur (legend-sonf, legend-uqfu)

## Peran
Baca `~/.agents/team/roles/designer.md`, lalu ikuti. Jangan jalankan `bd`.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree sendiri: `git worktree add -b design/kds-config-scanner .worktrees/design-kds milestone/m1`.

## Tujuan
Dua mockup lama siap gerbang founder:
- `design/mockups/pos/pos-extra-kds-sonf-konfigurasi.html` (urutan, aktif, cetak cadangan stasiun dapur)
- `design/mockups/pos/pos-extra-kds-uqfu-scanner.html` (input scanner KDS)

`ghostex show` menolak tampilan HP 390: kolom `div.layout`/`div.station` tidak menumpuk, pill/tag patah di tengah kata. Perbaiki (aturan stacking sendiri `@media (max-width:600px)`, pill `white-space:nowrap; flex:none`), cek sesuai `~/.agents/team/ui-standard.md`, lengkapi state yang kurang (kosong, memuat, error, scanner terputus). Brief asal: `docs/briefs/493-mockups-kds-hr-inventory.md`.

Satu page review `design/mockups/pos/kds-review.html` berisi keduanya, dicek `ghostex visual check <file> --out <png>` dan `--width 390` tanpa peringatan.

## Batas
Hanya kedua file itu dan `kds-review.html` di `design/mockups/pos/`. Commit lalu push `design/kds-config-scanner` tanpa force.

## Laporan
Path page review, state yang ditambah, asumsi untuk founder.
