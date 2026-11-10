# Brief: second-opinion — HPP per baris pesanan (legend-u4js6, legend-n8r5m)

## Peran

Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/cost-snapshot-edge`, cabang `ws/cost-snapshot-edge` (di atas `ws/cost-snapshot-at-sale` ec37dc36).
Rentang diff: `git diff 3517283b HEAD` (basis `milestone/m1` 3517283b).

## Berkas berisiko

- `apps/api/src/services/order-cost-snapshot.service.ts` (helper `computeLineCostSnapshots`, savepoint, pembulatan, NULL vs 0)
- `apps/api/src/services/recipe-bom.service.ts` (refactor; `explodeMenuLinesEach` baru, `explodeMenuLines` harus tetap sama)
- `apps/api/src/services/pos-order.service.ts`, `qr-order.service.ts`, `delivery-inject.ts` (titik sisip)
- `apps/api/src/services/pos-order-support.ts`, `packages/shared/src/pos/schemas.ts` (`costSnapshotIdr` nullable)
- `docs/DECISIONS.md` (entri teratas: keputusan desain)

## Invariant

- `order_items.cost_snapshot_idr` = HPP total baris (qty x HPP porsi), rupiah bulat, setengah ke atas sekali per baris; biaya = `stock_balances.avg_cost_idr` lokasi jual saat baris dimasukkan.
- NULL (bukan 0) bila tidak diketahui: tanpa resep, resep tak aktif/rusak, tanpa lokasi jual, qty < 1, satu bahan tanpa biaya. Tidak ada nilai sebagian.
- Gagal hitung tidak boleh menggagalkan pesanan (savepoint). Snapshot tidak pernah ditulis ulang (void, refund, koreksi, remake).
- Isolasi tenant dan outlet; tidak ada N+1 per baris.
- Pesanan lewat edge tetap NULL: cloud tidak punya titik ingest `order_items` untuk pesanan edge (event `order.*` hanya diparkir di `edge_deferred_events`, backfill menunggu legend-078n).
- Pembaca POS tidak boleh membaca NULL sebagai 0.

## Pertanyaan khusus

- Apakah ada jalur insert `order_items` yang terlewat?
- Apakah biaya rata-rata bisa 0 atau negatif sehingga snapshot salah, dan apakah selisih dengan biaya deduksi bisa menipu laporan?
- Apakah refactor `recipe-bom.service.ts` mengubah hasil deduksi stok untuk kasus tepi (UOM, sub-resep, waste)?

## Effort

xhigh (uang).
