# Brief 128: engineer kecil — pajak default untuk tenant baru (legend-9obf)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.
Tingkat K (pajak): `reviewer` Opus dan `architect` bersamaan sebelum melapor.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Folder proyek sedang di cabang lain; jangan checkout di sana.
Base: `ws/provisioning-default` (d82041ee, sudah mengubah `platform-org.service.ts` createTenant).
`git worktree add .worktrees/tax-default -b ws/tax-default ws/provisioning-default`. Jangan pakai `--worktree` Ghostex.

## Keputusan founder (9 Nov 2026, Q13)
Harga menu BUKAN nett: pajak dan service ditambahkan di struk, dan rinciannya (subtotal, service, pajak, total) tampil ke tamu dan kasir sebelum bayar, seperti ESB. Jadi default = harga eksklusif.

## Tujuan dan kartu
`legend-9obf` (baca `bd show legend-9obf`). Tenant yang dibuat dari panel Platform langsung punya konfigurasi pajak default dari `cafeLegendTaxFixtures`: PBJT-FNB 10% tenant-wide, harga eksklusif, pembulatan half_up, alokasi fixed_bp. Dalam transaksi yang sama dengan createTenant, sebagai data (owner bisa mengubah), idempoten, beraudit. Tambahkan juga ke backfill `pnpm db:backfill-defaults` untuk tenant lama yang belum punya `tax_settings` (jangan ubah tenant yang sudah punya).
Di awal: `ghostex board associate legend-9obf`, `bd update legend-9obf --status in_progress`. Saat melapor: `--status review` dan `bd comment`.
Periksa juga: apakah layar bayar POS dan checkout QR sudah menampilkan rincian service dan pajak sebelum bayar. Jangan ubah UI; laporkan temuannya saja (bead baru bila kurang).

## Scope
- Boleh: `platform-org.service.ts` (createTenant), modul pajak (seed default), skrip backfill, test di `apps/api/src/test/`.
- Jangan: `app.ts`, `routes/index.ts`, `worker-main.ts`, engine perhitungan pajak, UI.

## Bukti selesai
- Test: tenant baru dari panel dapat konfigurasi default dan `/api/tax/preview` tidak lagi `TAX_SETTINGS_NOT_FOUND`; panggil ulang tidak menggandakan; tenant yang sudah punya config tidak berubah; backfill idempoten; isolasi tenant.
- `LEGEND_TEST_FILES="<file terkait>" pnpm test`, typecheck dan lint lewat `heavy`, `pnpm db:generate` kosong.

## Sebelum melapor
Commit lokal di `ws/tax-default`. Jangan push. Tulis `docs/briefs/130-second-opinion-tax-default.md` di folder proyek (jangan commit): rentang diff, maks 800 baris non-test per run, berkas berisiko, invariant. Jangan sebut temuan review Claude.

## Laporan
SHA awal..akhir, hasil gate, temuan review K, temuan layar rincian sebelum bayar, bead baru.
