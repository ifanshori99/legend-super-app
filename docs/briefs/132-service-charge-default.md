# Brief 132: engineer kecil — service charge default 5% (legend-2qz7)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.
Tingkat K (uang dan pajak): `reviewer` Opus dan `architect` bersamaan sebelum melapor.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Folder proyek sedang di cabang lain; jangan checkout di sana.
Base: `ws/tax-default` (9a057246, berisi seed pajak default legend-9obf di atas provisioning).
`git worktree add .worktrees/service-charge-default -b ws/service-charge-default ws/tax-default`. Jangan pakai `--worktree` Ghostex.

## Keputusan
- Founder (9 Nov, Q25): service charge default **5%** untuk outlet baru. Owner tetap bisa mengubah per outlet.
- Founder (Q13): harga tidak nett; service dan pajak ditambahkan di struk, rincian tampil sebelum bayar.
- CTO: berlaku hanya untuk dine-in (termasuk QR dine-in), tidak untuk takeaway dan delivery. Tenant dan outlet lama TIDAK di-backfill (tagihan yang sudah berjalan tidak boleh berubah diam-diam). Laporkan jumlah tenant lama tanpa aturan service.

## Tujuan dan kartu
`legend-2qz7` (baca `bd show legend-2qz7`). Tenant baru dari panel Platform dan outlet baru otomatis punya aturan service charge 5% dine-in, sebagai data (owner bisa mengubah dan mematikan), dalam transaksi yang sama dengan pembuatan tenant/outlet, idempoten, beraudit. Seed di `tax-provisioning.service.ts` (pola 9obf). Pastikan urutan hitung pajak atas service mengikuti engine yang ada; jangan ubah engine.
Di awal: `ghostex board associate legend-2qz7`, `bd update legend-2qz7 --status in_progress`. Saat melapor: `--status review` dan `bd comment`.

## Scope
- Boleh: `tax-provisioning.service.ts`, `platform-org.service.ts` (hanya pemanggilan seed), jalur pembuatan outlet (hanya pemanggilan seed), test di `apps/api/src/test/`.
- Jangan: `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`, engine perhitungan pajak/service, UI, skrip backfill untuk tenant lama.

## Bukti selesai
- Test: tenant baru dapat aturan 5% dine-in; outlet baru di tenant lama dapat aturan; takeaway tidak kena service; `/api/tax/preview` dine-in menunjukkan subtotal + service 5% + pajak; panggil ulang tidak menggandakan; aturan yang diubah owner tidak ditimpa; isolasi tenant.
- `LEGEND_TEST_FILES="<file terkait>" pnpm test` dari root worktree, typecheck dan lint lewat `heavy`, `pnpm db:generate` kosong.

## Sebelum melapor
Commit lokal di `ws/service-charge-default`. Jangan push. Tulis `docs/briefs/133-second-opinion-service-charge-default.md` di folder proyek (jangan commit): rentang diff, maks 800 baris non-test per run, berkas berisiko, invariant. Jangan sebut temuan review Claude.

## Laporan
SHA awal..akhir, hasil gate, temuan review K, jumlah tenant lama tanpa aturan service, bead baru.
