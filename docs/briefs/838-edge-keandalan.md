# Brief: engineer Codex — area edge sync dan keandalan (6 kartu)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan menjalankan `bd` (CTO memindah kartu); baca kartu lewat `.beads/issues.jsonl` (grep id).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `milestone/m1`, cabang `ws/edge-reliability`. Satu worktree saja (disk tipis), satu commit per kartu.

## Kartu
legend-fjpxq (retensi `edge_txn_ledger_events`), legend-gzwhg (purge audit di edge), legend-g1799 (rotasi `instance_id` saat DB edge hasil restore), legend-tmar2 (deteksi restore DB edge), legend-x2c0x (`defaultLastSequence`), legend-vj7ma (bersihkan printer retired). Cek dulu `git log --all --grep <id>`; yang sudah dikerjakan dilaporkan, jangan diulang.

## Aturan
- Hindari migrasi. Bila kartu benar-benar butuh migrasi, lewati dan laporkan.
- Jangan sentuh `apps/api/src/edge/master-sync.ts`, `edge-catalog-sync.routes.ts`, `edge-bootstrap.routes.ts`, dan `apps/api/src/edge/edc/**` (cabang lain belum digabung).
- Retensi/purge tidak boleh menghapus baris yang belum ter-ack ke cloud atau alarm panik yang belum terkirim.

## Pembagian paralel
Subagent bawaan maks 6: Explore per kelompok (retensi+purge, restore+instance_id, sequence+printer), test-writer gagal-dulu, implementer per kartu dengan file tidak bertumpuk, satu pemegang heavy.

## Bukti selesai
Test terarah hijau (`LEGEND_TEST_FILES=... heavy pnpm test`), pra-gate AGENTS.md, typecheck API sekali lewat heavy, push tanpa force. Laporan: sha per kartu, test merah-dulu, angka subagent.
