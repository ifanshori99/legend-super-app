# Brief: second-opinion — fix edge Codex 108 (legend-ddoy, legend-12ku, legend-aor4)

## Peran

Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti. Read-only: jangan edit atau commit.

## Repo

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/fix-edge-codex`, cabang `ws/fix-edge-codex`. Rentang: `git diff milestone/m1...ws/fix-edge-codex -- apps/api/src ':!apps/api/src/test'` (kode, sekitar 450 baris). Test hanya dibaca bila perlu bukti.

## Berkas

- `apps/api/src/services/inventory.service.ts` (`lockStockSource`, `sourceBelongsToOtherOutlet`, `recordReplicatedStockMovementInTransaction`)
- `apps/api/src/edge/link-server.ts`, `apps/api/src/lib/fixed-window-counter.ts`
- `apps/api/src/routes/edge-bootstrap.routes.ts`
- Test: `apps/api/src/test/inventory-edge-source-race.test.ts`, `edge-link-hardening-2.test.ts`, `edge-bootstrap-rate-limit.test.ts`

## Fokus

- Dua outlet mengirim source stok yang sama serentak: hanya satu yang mengubah stok; tidak ada deadlock yang membuat sinkron macet; tidak ada 500 untuk input edge yang salah.
- Batas gagal-auth link-server tidak bisa dilewati lewat burst paralel, dan NAT berisi banyak node sah tidak terkunci.
- Bootstrap edge tidak bisa di-flood sampai ke query database; node sah tetap bisa bootstrap.

## Effort

xhigh (auth dan stok/GL).

## Laporan

Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal konkret, saran. Tidak ada temuan: satu baris.

## Larangan

Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
