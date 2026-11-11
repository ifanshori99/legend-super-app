# Brief: second-opinion Codex — area HPP recompute + food cost

Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti. Read-only: jangan edit, jangan commit. Effort high.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Basis pembanding `origin/milestone/m1`.

## Cabang
- `origin/ws/2qq-hpp-recompute` 80321fdc — tabel menu_costs + hpp_recompute_queue (RLS), migrasi 0278, job tiap 60 detik, endpoint menu-costs/food-cost/menu-engineering/recipe-coverage (izin recipe.cost.view).

## Aturan
Biaya bahan hilang/0 = resep tidak lengkap (null, bukan 0). Varians food cost = waste + penyesuaian + duty meal; biaya aktual tidak negatif.

## Fokus
Margin terlihat lebih bagus dari kenyataan (biaya terlalu rendah/basi), antrean hilang saat worker mati (sudah kartu legend-i8ou8), deadlock dengan posting stok, kebocoran lintas tenant/outlet, izin endpoint, migrasi 0278 di data yang ada, import melingkar inventory.service.

## Laporan
Temuan P0..P3: file:baris, skenario (input -> hasil salah), saran. Sebut yang bersih. Angka subagent: total, puncak bersamaan.
