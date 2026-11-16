# 939 Perkuat test 923 payout (legend-xtj5t, test saja)
Peran: engineer Codex (baca ~/.agents/team/roles/engineer.md). Effort high. HANYA file test; kode produk payout tidak diubah (bila test membuktikan bug produk: berhenti, lapor ke CTO).
Cabang: worktree-mu dari `milestone/m1` (c17c60df7); commit dan push tanpa force. Tidak merge, tidak deploy.
Temuan: `git show origin/qa/architect-923:docs/qa/architect-923.md` (P2-1, P3-1..3) dan `bd show legend-xtj5t`.
- P2-1: `[923-unfreeze-first]` (payroll-payout-923-backfill-unfreeze.test.ts:288) harus memanggil catch-up asli (`catchUpAfterUnfreeze`/`recoverPayoutGlOfBatch`) bertabrakan dengan worker, dan memeriksa GL net/fee tepat sekali. Bukti mutasi: test merah bila salah satu dari dua perbaikan 923 dikembalikan (kembalikan sementara di worktree, jangan commit).
- P3-1: test lintas tenant membuktikan filter `tenant_id` (bukan hanya RLS), mis. lewat koneksi yang melewati RLS sesuai pola test lain.
- P3-2: `[923-worker-first]` membuktikan urutan kunci (merah di basis d06e5a269 atau dengan mutasi), bukan hanya "tetap jalan".
- P3-3: klien pool selalu dilepas (`finally`), timeout pendek, tidak menggantung 120 detik.
Paralel: test-writer per temuan (file sama: berurutan atau satu penulis), test-runner, satu reviewer.
Bukti: file 923 hijau 5x berturut lewat heavy, bukti mutasi tercatat, prettier, eslint.
Laporan: cabang, SHA, bukti mutasi, angka subagent. Komentari legend-xtj5t. Lapor sekali saat selesai.
