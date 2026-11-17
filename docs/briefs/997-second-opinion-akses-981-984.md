# 997 Second opinion akses 981 dan 984 (K akses + migrasi; gerbang rilis area akses)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree (disk sempit): pakai `git diff`/`git show <ref>:<path>` dari folder utama, jangan checkout.
Diff (berurutan):
(1) `git diff origin/milestone/m1...origin/ghostex/981-ulasan-ai-11-modul-mcp` (tip 83dd3da01; migrasi 0545 tabel, 0546 backfill flag mcp).
(2) `git diff origin/ghostex/981-ulasan-ai-11-modul-mcp...origin/ghostex/984-akses-outlet-asing-perangkat` (tip e35c4a41a; tanpa migrasi).
(3) `git diff origin/ghostex/984-akses-outlet-asing-perangkat...origin/ghostex/984-f586w-shared-device-wip` (tip 839500696; migrasi kerja 0575 drop kolom 0561, `when` 1795000000053 perlu dinaikkan monoton; edge sync tanpa banding updatedAt).
Kartu: legend-vqicf, legend-39d.5, legend-hbuq3 (981); legend-xloqn, legend-xqkr7 (984); f586w: jqurl, xrbjv, ypwsp (shared_mode, shared_device_ids).
Diterima CTO (jangan dilaporkan): revoke tetap terbuka saat modul mati; discovery/authorize tenant modul mati dianggap tenant tak dikenal; edge sync tanpa banding updatedAt (keputusan CTO); gerbang upgrade edge sebelum cloud (legend-ir8n8).
Cari: kebocoran lintas tenant atau outlet (cek SQL dan RLS, bukan route); RLS tenant/outlet pada customer_reviews yang kurang atau FORCE mati; get_review_summary yang membocorkan PII; token exchange atau bearer yang lolos saat modul mcp mati; backfill 0546 yang mengaktifkan tenant salah; assertKnownOutlets yang terlewati pada jalur baru; sesi support melihat perangkat di luar tenant grant; shared_device_id atau shared_mode yang bisa diset tanpa ACTING_STAFF_REQUIRED; migrasi 0575 yang menghilangkan data 0561 atau tidak idempoten.
Usul test: akses silang tenant dan outlet asing per endpoint, token mcp saat modul mati, backfill dengan data campuran.
Hasil: tulis `docs/qa/second-opinion-akses.md` di folder utama (P0-P3, berkas:baris, skenario, usul test). JANGAN commit, JANGAN edit file lain. Lapor hanya saat selesai.
