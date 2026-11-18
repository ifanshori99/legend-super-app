# Brief: engineer — deploy: runner gerbang rilis 1 + cek drift migrasi

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Langkah pertama: spawn subagent paralel dalam satu giliran.

## Worktree
Worktree Ghostex milikmu (base `milestone/m1`). Langkah 0: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Tanpa migrasi (0716-0717 tidak dipakai).

## Kartu
Kartu cek data/ops hanya `bd comment`, jangan ditutup.
1. Runner gerbang di `apps/api/src/db/release-gates.ts`, dipanggil dari `runPredeployCheck` (`apps/api/src/db/predeploy-check.ts`), sehingga `deploy/single-vm/deploy.sh` dan first-boot `provision-roles.sh` ikut menahan:
   - DB baru (tanpa `drizzle.__drizzle_migrations` atau nol baris): cetak "gerbang data rilis 1: N/A (DB baru)".
   - Untuk tiap `scripts/preflight/rilis1-*.sql`: parse header. Lewati bila migrasi `before` sudah tercatat (`created_at` = `when` journal tag itu) atau tabel `requires` belum ada. Bila tidak dilewati, jalankan dalam transaksi read-only dengan `row_security=off`. `block` berbaris berarti gagal dengan pesan gate id + jumlah baris saja. `info` hanya dicetak.
2. `legend-fgg1h` (kode). Cek drift: untuk tiap baris `__drizzle_migrations`, cocokkan hash dengan sha256 berkas repo pada `when` yang sama (cara hash drizzle migrator, verifikasi di `node_modules/drizzle-orm`). Hash beda, atau `when` tidak dikenal repo, berarti gagal dengan daftar tag saja. Ini sekaligus menangkap 0239 lama dan 0674 lama (tiw2h).
3. Query `legend-176r3` (before `0456_mcp_flag_backfill`, mode block: tenant aktif dengan klien MCP approved/token aktif tetapi paket tanpa `mcp`) dan `legend-oh2a5` (before `0378_ai_assistant_auto_enable`, mode info: jumlah tenant yang akan dinyalakan). Konvensi berkas sama dengan brief 1097.
4. Test journal di repo: `when` naik ketat dari entri 0004 (0003 lama dikecualikan eksplisit), tag = berkas, idx berurutan (komentar `legend-ir8n8`).
5. Docs: bagian "Gerbang rilis 1" di `docs/deployment.md` (runner, arti N/A, cara resolve per gate). Runbook baru `docs/runbooks/rilis1-urutan-edge-cloud.md` untuk `legend-ir8n8` (sharedMode: edge dulu) vs `legend-zn3wl` + `edge-catalog-deploy-order.md` (katalog: cloud dulu). Isi: instalasi pertama = build sama, ditambah matriks upgrade berikutnya. Tambah juga daftar cek `legend-ofq4f` (env VAPID, uji ponsel nyata).

## Aturan
- Fail-closed: header rusak, tag `before` tidak ada di journal, atau SQL error berarti gagal, bukan dilewati.
- Pesan tidak pernah memuat URL, password, tenant id, atau isi baris (aturan predeploy yang ada).
- Pastikan image migrator memuat `scripts/preflight/` (cek Dockerfile/compose di `deploy/single-vm`; tambah COPY bila perlu) dan journal + berkas drizzle.
- Berkas SQL 1097/1098 belum ada di base. Test harus memvalidasi semua `rilis1-*.sql` yang ada saat jalan (tag ada di journal, mode sah, tabel `requires` ada di skema), supaya train menangkap berkas yang salah sesudah merge.
- Jangan sentuh jalur refund (Q45), `ws/1072`, atau berkas cabang kas aktif. Cek diff `origin/int/batch90`.

## Pembagian paralel
- Explore (2): predeploy-check + deploy.sh + image migrator; cara hash/journal drizzle + 0378/0456.
- test-writer (1): test gagal-dulu runner (DB baru N/A, before-applied dilewati, block gagal, drift gagal, journal).
- implementer (2): runner+drift (TS); query 176r3/oh2a5 + docs/runbook.
- test-runner: pemegang token heavy (test terarah, `test-deploy.sh` bila ringan, typecheck API sekali).
- architect (effort xhigh, migrasi/deploy): satu review runner + drift. reviewer sonnet: docs.

## Bukti selesai
Test terarah runner/journal/preflight lulus, merah-dulu tercatat, typecheck API lulus, predeploy-check terhadap DB test baru mencetak N/A, drift buatan ditolak.

## Batas kerja ulang
Ikuti `~/.agents/team/brief-template.md` bagian "Batas kerja ulang". Jangan `pkill`.

## Sebelum melapor
Pra-gate AGENTS.md. Commit di cabang `ws/1100-gerbang-deploy`, push tanpa `--force`.

## Laporan
Hasil per butir, bukti, berkas, commit, cabang, risiko (khususnya deploy staging yang akan tertahan).
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
