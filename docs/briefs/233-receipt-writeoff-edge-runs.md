# Brief: engineer — write-off nomor struk untuk run milik edge (legend-drzaf)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/receipt-writeoff-edge-runs` dari `integ/m1-batch31` (d7a95d0c, sudah memuat 5eed1767). Worktree `.worktrees/receipt-writeoff-edge-runs`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-drzaf` (P2, tingkat K: migrasi, nomor dokumen). Detail: `docs/briefs/210b-second-opinion-receipt-writeoff-edge-sync.result-architect.md`. Reviewer kedua (`.result-architect2.md`) menyebut bersih, jadi reproduksi dulu lewat jalur nyata (run yang terikat ke edge, bukan `last_number` disetel manual).
Klaim: cek write-off cloud (`pos-receipt-writeoff.service.ts:104`) dan trigger 0156 hanya menerima nomor sampai `lastNumber` cloud; untuk run yang dinomori edge, `lastNumber` cloud tetap 0 (`pos-receipt.service.ts:690`, applier legend-ol6v belum ada), sehingga Owner mendapat "Nomor struk di luar rentang yang sudah terbit" dan `edge-device-sync.ts:809` tidak pernah menyalin apa pun. Runbook `docs/runbooks/receipt-number-writeoff.md:54-64` menyuruh write-off di cloud lalu tutup hari di edge, dan fallback lama sudah dihapus.
- Bila terbukti: untuk run terikat edge, service dan trigger menerima nomor sampai batas tertinggi yang sudah dilaporkan edge (cek apakah kolom/sumber seperti `edge_reported_number` sudah ada; bila tidak, pilih sumber yang aman dan jelaskan). Write-off tetap tidak boleh mencakup nomor yang masih bisa terbit. Pulihkan teks fallback di runbook untuk outlet yang belum upgrade.
- Bila tidak terbukti: test yang membuktikan jalur nyata bekerja, komentar di kartu, tanpa ubah kode.

## Kartu
`legend-drzaf`. Di awal: `bd update legend-drzaf --status in_progress`. Saat melapor: `bd update legend-drzaf --status review` dan `bd comment legend-drzaf "<ringkasan>"`.

## Scope
Boleh: `pos-receipt-writeoff.service.ts`, `edge-device-sync.ts` bagian write-off, skema/trigger write-off, runbook di atas, test. Jangan: PIN edge, link cursor edge (legend-a9iby, thread lain), refund, pajak, akses/Owner, UI.
Migrasi bila perlu: 0166, `when` 1794245000000.

## Bukti selesai
- Test reproduksi lewat run terikat edge yang gagal di basis, lalu lulus; test write-off dan day-close lama tetap lulus.
- `LEGEND_TEST_FILES` daftar eksplisit (path `src/test/...`) lewat `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="..." pnpm test'`; bila ada migrasi, sertakan `src/test/edge-received-events-migration.test.ts` dan `src/test/migration-fk-force-rls.test.ts`, dan `db:generate` harus kosong.
- tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh.
- Review K: subagent reviewer Opus + architect paralel. Brief Codex `docs/briefs/233b-second-opinion-writeoff-edge-runs.md` (tidak di-commit).

## Laporan
Sekali: terbukti atau tidak, hasil, bukti, file berubah, SHA, nomor migrasi, risiko tersisa, jumlah subagent dan puncak bersamaan. Jangan menunggu proses global atau loop sleep. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
