# Brief: engineer (Codex) — isSystem opsional di snapshot satuan edge (legend-tkc19)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show legend-tkc19` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add -b fix/edge-uom-issystem .worktrees/edge-uom-issystem origin/milestone/m1`. Cabang `ws/edge-sync-resilience` (belum masuk) mungkin menyentuh file sync; cek `git diff origin/milestone/m1...origin/ws/edge-sync-resilience -- packages/shared/src/edge` dan hindari bentrok.

## Tujuan (keputusan CTO)
Tambah `isSystem` ke `edgeMasterUomSchema` (`packages/shared/src/edge/master-sync.ts`) sebagai field OPSIONAL dengan default `false` di protokol snapshot v1. Cloud mengirimnya; edge lama yang tidak mengenalnya dan edge baru yang menerima snapshot tanpa field itu tetap sinkron. Jangan naikkan versi protokol. Konsumen edge memakai nilai itu bila ada.

## Bukti, sebelum melapor
Test gagal-dulu lalu hijau, termasuk kompatibilitas dua arah (snapshot tanpa field diterima; snapshot dengan field diterima skema lama bila skema lama strict, laporkan). Pra-gate AGENTS.md (prettier, eslint, typecheck api dan web lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Jangan ubah `docs/PROGRESS.md`. Push cabang tanpa force. Jangan merge, jangan deploy.
