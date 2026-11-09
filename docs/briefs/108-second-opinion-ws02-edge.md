# Brief: second-opinion — edge hardening dan sinkron konflik (ws02-edge, brief 90)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti. Read-only: jangan edit atau commit.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/prep-ws02-edge`, cabang `prep3/ws02-edge` HEAD `5cb07d8d` (isi `ws/ws02-edge` 756b45ae, rantai tanpa ws11). Cabang ini BELUM digabung ke `milestone/m1`.
Rentang diff: `git diff 1e2ab930 5cb07d8d` (merge-base dengan m1 `1e2ab930`; 70 file; abaikan drizzle `meta/*.json`). Jangan pakai `merge-base main`. Brief engineer asal: `docs/briefs/90-ws02-edge-hardening.md`.
Migration 0099/0100 (diregen di atas chain doit; nomor bentrok bukan temuan).

## Berkas berisiko
- `apps/api/src/edge/` (`bootstrap.ts`, `cloud-http.ts`, `db-link-store.ts`, `link-server.ts`, `runtime.ts`, `qr-order-applier.ts`, `qr-order-forwarding.ts`, `stock-moved-applier.ts`, `applier-registry.ts`)
- `apps/api/src/services/edge-bootstrap.service.ts`, `edge-node.service.ts`, `edge-queue.service.ts`
- `apps/api/src/services/edge-sync-conflict.service.ts`, `edge-sync-conflict-alert.ts`
- `apps/api/src/routes/edge-bootstrap.routes.ts`, `edge-nodes.routes.ts`, `edge-sync-conflicts.routes.ts`
- `apps/api/src/db/schema/edge-sync-conflict.ts`, `edge-sync-conflict.custom.sql`
- `apps/api/drizzle/0099_nosy_warbird.sql`, `0100_ws02_edge_rls.sql`
- UI: `apps/web/src/features/ws02-devices/` (dialog token, enroll, reissue)

## Fokus (auth, RLS, migration)
- Bootstrap dan enroll node: token sekali pakai atau berumur pendek, disimpan sebagai hash, tidak dicetak ke log atau respons ulang; reissue mencabut token lama; rate limit (`fixed-window-counter`) tidak bisa dilewati.
- Otorisasi endpoint node dan konflik: node hanya mengakses tenant dan outlet miliknya; node yang dicabut ditolak segera.
- Applier offline (qr-order, stock.moved): idempoten, urutan sequence tidak bisa dipalsukan, tidak ada order atau mutasi stok ganda saat replay; tidak ada lintas tenant.
- Konflik sinkron: pencatatan tidak kehilangan data, resolusi hanya oleh peran berhak dan tercatat di audit; alert tidak membocorkan data pribadi.
- Training device (`device-training.ts`): transaksi training tidak masuk ke angka produksi.
- RLS ENABLE + FORCE + policy `tenant_id = app.require_tenant_id()` pada tabel baru; unique constraint menyertakan `tenant_id`; FK inline aman untuk migrator NOBYPASSRLS.
- Migration 0099/0100 aman untuk data lama.
- Test membuktikan klaim.

## Effort
xhigh (auth dan migration).

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal konkret, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
