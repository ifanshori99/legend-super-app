# Brief: engineer — supplier, PR/PO dengan approval, kirim PO (legend-9yz)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/AGENT_PLAYBOOK.md`, `docs/plan/contracts.md`. Prosedur migration: `/Users/ifanshori99/Projects/legend super app/HANDOFF.md` §5.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/procurement`, cabang `ws/procurement` (dari `main`). Jangan pindah cabang.

## Tujuan
Backend pengadaan: supplier, katalog dan riwayat harga, Purchase Request dan Purchase Order dengan approval (pakai service approval generik dari legend-y5q), dokumen PO (PDF, email lewat worker job, share link). Kontrak sudah ada dari legend-ejk (`packages/shared`): implementasikan sesuai kontrak itu. Acuan: PRD v1.7 §3 F18 (`docs/PRD.md`). Detail: `bd show legend-9yz`.

## Kartu
`legend-9yz`. Di awal: `ghostex board associate legend-9yz` dan `bd update legend-9yz --status in_progress`. Saat melapor: `bd update legend-9yz --status review` dan `bd comment legend-9yz "<ringkasan bahasa biasa>"`.

## Catatan
- Area uang: nominal integer IDR. Share link PO: simpan hash token saja, rate limit, token tidak masuk log (pola `pos-receipt` di cabang `ws/pos-receipt` dan QR meja). Email supplier lewat worker job, alamat tidak tercetak di log.
- Migration: drizzle-kit, jangan edit `_journal.json`. Cabang lain memakai 0063–0065; nomor dirapikan saat merge.
- Rahasia: jangan baca `.env*`.

## Scope
- Boleh: `apps/api/src/db/schema/inventory*.ts` / `purchasing*.ts`, migration baru, `apps/api/src/services/inventory*.ts` / `purchasing*.ts`, routes terkait, worker job PO email, test `apps/api/src/test/purchasing*.test.ts` / `inventory*.test.ts`.
- Jangan: `apps/web/`, `design/`, POS, payment, kontrak `packages/shared` kecuali celah nyata (sebut di laporan).

## Bukti selesai
- Test: CRUD supplier + riwayat harga, alur PR→approval→PO, penolakan approval, dokumen PO, share link (token salah/kedaluwarsa ditolak), isolasi lintas tenant/outlet.
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus. `git status` bersih.
- Subagent reviewer konteks segar cek diff; temuan nyata dibetulkan.

## Sebelum melapor
Commit lokal di `ws/procurement`, pesan merujuk `legend-9yz`. Jangan push, jangan merge.

## Laporan
Hasil, bukti, file berubah, commit, risiko tersisa, kebutuhan dari CTO.
