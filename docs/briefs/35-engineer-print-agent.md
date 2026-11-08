# Brief: engineer — print agent di edge (legend-46p)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/AGENT_PLAYBOOK.md`, `docs/plan/contracts.md`. Prosedur migration: `/Users/ifanshori99/Projects/legend super app/HANDOFF.md` §5.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/print-agent`, cabang `ws/print-agent` (dari `main`). Jangan pindah cabang.

## Tujuan
Agent cetak ESC/POS di mode edge (EDG-05, PRD v1.7 §3 F5 Print Agent + Fallback Berlapis, §3 F12 Fallback Cetak, `docs/PRD.md`): printer jaringan/USB lewat antarmuka transport yang bisa di-fake, antrean per printer, cetak ulang, deteksi printer offline ≤30 detik lewat heartbeat, template struk / tiket stasiun / laporan shift, fallback otomatis cetak tiket dapur bila layar KDS mati, dan event peringatan supervisor. Detail: `bd show legend-46p`.

## Kartu
`legend-46p`. Di awal: `ghostex board associate legend-46p` dan `bd update legend-46p --status in_progress`. Saat melapor: `bd update legend-46p --status review` dan `bd comment legend-46p "<ringkasan bahasa biasa>"`.

## Catatan
- Cabang lain yang belum merge: `ws/pos-receipt` (dokumen struk), `ws/kds` (tiket KDS), `ws/pos-shift` (laporan shift), `ws/edge-hardening` (allowlist edge di `edge/mode.ts`). Jangan sentuh file mereka. Template menerima data lewat antarmuka sempit; sambungan ke service mereka dicatat sebagai bead lanjutan.
- Tanpa dependensi baru bila bisa (ESC/POS byte builder sendiri). Bila perlu dependensi, sebut alasannya di laporan.
- Migration: drizzle-kit, jangan edit `_journal.json`; nomor dirapikan saat merge. Rahasia: jangan baca `.env*`.

## Scope
- Boleh: modul baru `apps/api/src/edge/print/`, `apps/api/src/db/schema/edge-print*.ts`, migration baru, service/route print, test `apps/api/src/test/edge-print*.test.ts`, kontrak `packages/shared` untuk print.
- Jangan: `apps/web/`, `design/`, file cabang lain di atas.

## Bukti selesai
- Test dengan printer palsu: antre dan urutan, cetak ulang, printer offline terdeteksi ≤30 detik, fallback KDS-mati, byte ESC/POS template sesuai (snapshot), isolasi tenant/outlet.
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus. `git status` bersih.
- Subagent reviewer konteks segar cek diff; temuan nyata dibetulkan.

## Sebelum melapor
Commit lokal di `ws/print-agent`, pesan merujuk `legend-46p`. Jangan push, jangan merge.

## Laporan
Hasil, bukti, file berubah, commit, bead lanjutan, risiko tersisa.
