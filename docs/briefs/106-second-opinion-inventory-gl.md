# Brief: second-opinion — jembatan stok ke buku besar (inventory-gl, brief 87)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti. Read-only: jangan edit atau commit.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/prep-inventory-gl`, cabang `ws/inventory-gl` lewat `prep/inventory-gl` 296ec728. Tip tes terakhir `bf5c895f` (sweep tes memakai test clock tetap).
Digabung ke `milestone/m1` sebagai merge `982c2e0a` (migration diregen 0086/0087). Parent merge: `4a040820` (m1) dan `296ec728`.
Rentang diff isi cabang di atas m1: `git diff 4a040820 982c2e0a` (abaikan drizzle `meta/*.json`). Jangan pakai `merge-base main`. Brief engineer asal: `docs/briefs/87-inventory-gl-bridge.md`.

## Berkas berisiko
- `apps/api/src/services/inventory-gl-consumer.ts`
- `apps/api/src/db/schema/inventory-gl.ts`
- `apps/api/src/services/inventory.service.ts`
- `apps/api/src/worker-main.ts` (sweep)
- `apps/api/drizzle/0086_light_crusher_hogan.sql`, `0087_inventory_gl_rls.sql`

## Fokus (uang dan RLS)
- Jurnal stok ke GL: debit sama dengan kredit, nominal integer IDR dari server, pembulatan tanpa selisih yang hilang.
- Idempotensi: event stok yang sama (retry outbox, sweep ulang) tidak membuat jurnal ganda; event gagal tidak meninggalkan jurnal setengah jadi.
- Periode terkunci atau ditutup: jurnal tidak masuk ke periode tertutup; koreksi lewat jurnal baru, tanpa edit jurnal lama.
- Isolasi tenant dan outlet di consumer, sweep worker, dan setiap query; sweep tidak memproses tenant lain.
- RLS ENABLE + FORCE + policy `tenant_id = app.require_tenant_id()` pada tabel baru; unique constraint menyertakan `tenant_id`.
- Migration 0086/0087 aman untuk data lama dan memakai login migrator NOBYPASSRLS.
- Test membuktikan klaim; waspadai tes yang bergantung jam sistem.

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal konkret, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
