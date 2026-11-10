# Brief: engineer (Sonnet) — kebijakan keuangan dan register aset tetap (migrasi 0174)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/finance-policy-asset-register` dari `milestone/m1` terbaru (d8ea5e0b atau lebih baru). Worktree `.worktrees/finance-policy-asset-register`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

Nomor migrasi dipesan: `0174`, `when` 1794253000000, satu migrasi untuk kedua kartu. Hanya menambah (tabel/kolom baru), tidak mengubah atau menghapus data. Nomor lain sudah dipakai cabang lain: jangan ambil nomor sesudahnya.

## Tujuan
1. `legend-pxcs`: kebijakan keuangan per tenant. Tabel baru `finance_policies` (tenant; legal entity bila model akuntansi memakainya, putuskan dari kode) berisi toleransi tanggal bank matching (default 2 hari) dan batas hari kas belum disetor (`maxDaysUndeposited`). GET/PUT dengan izin akuntansi yang sudah ada, validator strict di `packages/shared`. Alert ACC-05 kas belum disetor memakai batas tenant, bukan angka tetap. Default bila belum ada baris.
2. `legend-dux2`: register aset tetap. Kolom `code` unik per entity di `fixedAssets`, tabel `asset_categories` per tenant (daftar kategori), `categoryId` di aset, dan ringkasan surplus revaluasi di bacaan register (surplus sudah dihitung per revaluasi di `fixedAssetRevaluations`, `accounting-ap-fa.ts:413`; nilai di atas cost harus bisa ditampilkan). Data lama: `code` diisi backfill deterministik (mis. dari urutan dibuat) supaya unik bisa dipasang. `fixedAssetSchema` di `packages/shared` diperbarui.

Baca komentar kedua kartu (`bd show`): hasil cek di m1 d8ea5e0b ada di sana.

## Kartu
Awal tiap kartu: `ghostex board associate <id>`, `bd update <id> --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Scope
Boleh: schema/migrasi 0174, service/route accounting kas-bank dan aset, validator dan tipe di `packages/shared`, test. Jangan: auto-journal, refund, payroll, UI (layar kas-bank dan aset-tetap dikerjakan nanti; sebut kontrak barunya di laporan).

## Bukti selesai
- `pnpm db:generate` lalu periksa SQL; `db:generate` kedua harus kosong. Test migrasi: backfill code unik pada data lama.
- Test gagal-dulu: GET default, PUT lalu alert ACC-05 memakai batas baru, isolasi tenant; aset dengan code ganda ditolak, kategori milik tenant lain ditolak, surplus tampil.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes. Test contract root bila `packages/shared` berubah: lewat `pnpm test`, bukan `node --test`.
- Typecheck paket yang berubah lewat `heavy` sekali di akhir, eslint + prettier berkas berubah. Jangan `pnpm check` penuh.
- Review (Q48): satu `reviewer` sonnet (migrasi hanya menambah = tingkat S; bila backfill ternyata mengubah data yang ada, pakai satu `architect`).

## Laporan
Sekali di akhir: per kartu (hasil, SHA), `when` dan prevId migrasi, bukti, file berubah, kontrak baru untuk UI, risiko, jumlah subagent dan puncak bersamaan.
