# Brief: engineer — payout/rekon: query gerbang rilis 1 (kode)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Langkah pertama: spawn subagent paralel dalam satu giliran.

## Worktree
Worktree Ghostex milikmu (base `milestone/m1`; semua migrasi yang dijaga sudah ada di m1). Langkah 0: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Tanpa migrasi. Rentang 0708-0709 hanya cadangan untuk ofu02 bila CTO menyetujui backfill (lihat Aturan).

## Kartu
Kartu cek data TIDAK dipindah ke review atau ditutup oleh thread ini, karena eksekusinya ops. Hanya `bd comment <id>` dengan path query + cara jalan. Baca `bd show` tiap kartu untuk predikat.
1. `legend-0go0p` query: item payout `returned_by` terisi + `returned_by_2` kosong yang berbagi kunci bukti, atau kuncinya sama dengan bukti konfirmasi/resolusi. Before `0381_payout_pending_settle_return_claims`. Predikat persis: laporan G2ct7 (`fix/payout-second-opinion-870`).
2. `legend-7hg1q` query: klaim return `status='open'` (predikat RAISE PAYOUT-89 di 0463, ditulis dengan kolom pra-0463). Before `0463_payout_990_return_bank_ref`. Ditambah test migrasi 0464: seed exception recon lama berbentuk pra-0464, jalankan 0464, lalu assert fingerprint terisi dan tidak ada flag ganda.
3. `legend-9bfh7` query: operasi payout/bukti historis yang akan membuat 0395 RAISE "legacy duplicate binding" atau backfill 0396 macet. Before `0395_payout_proof_bindings`.
4. `legend-ofu02` query: `payment_reconciliation_cases` dengan `settlement_line_id IS NULL AND source_transaction_id IS NULL` (mode info). Before: tidak ada (0358 sudah jalan).

## Aturan
- Konvensi berkas (sama dengan 1098/1100): `scripts/preflight/rilis1-legend-<id>.sql`. Isinya satu SELECT murni (CTE boleh), tanpa meta psql, tanpa tulis, dan nama tabel tanpa skema supaya test temp-clone bisa membayanginya. Header wajib berurutan: `-- gate: legend-<id>`, `-- before: <tag m1>|none`, `-- requires: public.<tabel>[, ...]`, `-- mode: block|info`, `-- resolve: <satu kalimat>`.
- Kolom yang dipakai harus ada sebelum migrasi `before` dan masih ada di tip m1.
- Keluaran hanya id dan jumlah: tanpa nama, rekening, atau nominal per orang. Nol baris berarti lolos.
- Uang ("jangan sampai rugi"): tiap query block punya test. Data yang bisa membuat pihak dibayar lebih (bukti dipakai dua kali, klaim return terbuka tanpa referensi bank, binding ganda) wajib memunculkan baris. Data bersih wajib nol baris.
- Pola test: `apps/api/src/test/preflight-0301.test.ts` (temp table `LIKE ... EXCLUDING INDEXES` untuk keadaan pra-migrasi). Satu berkas: `apps/api/src/test/preflight-rilis1-payout.test.ts`.
- ofu02: jangan tulis migrasi backfill. Bila menurutmu `source_transaction_id` bisa diturunkan dengan aman, tulis usulannya di laporan. CTO yang memutuskan memakai 0708.
- Tabrakan: cek `git diff --stat origin/milestone/m1...origin/int/batch90`, `...origin/ghostex/legend-tiw2h-recon-clearance-restriktif`, dan `...origin/ghostex/cek-kas-1102-pinjaman-reimburse-supplier`. Jangan menyentuh berkas yang mereka ubah.
- Jangan ubah `docs/deployment.md` dan `apps/api/src/db/predeploy-check.ts` (milik 1100).

## Pembagian paralel
- Explore (2): predikat 0381/0395/0396/0463/0464 dan laporan G2ct7; skema payout/recon pra-migrasi.
- test-writer (1): test gagal-dulu kartu 1-3 (seed data berbahaya, harapkan baris).
- implementer (2): kartu 1+2 dan kartu 3+4, berkas SQL terpisah.
- test-runner: pemegang token heavy (setup, test terarah, typecheck API sekali).
- architect (effort xhigh, uang): satu review atas predikat vs migrasi asli. Fokus: tidak ada kasus bayar-lebih yang lolos dengan nol baris.

## Bukti selesai
`LEGEND_TEST_FILES=apps/api/src/test/preflight-rilis1-payout.test.ts heavy pnpm test` lulus, merah-dulu tercatat, test 0464 lulus, typecheck API lulus, `bd comment` di 4 kartu.

## Batas kerja ulang
Ikuti `~/.agents/team/brief-template.md` bagian "Batas kerja ulang". Jangan `pkill`.

## Sebelum melapor
Pra-gate AGENTS.md. Commit di cabang `ws/1097-gerbang-payout-rekon`, push tanpa `--force`.

## Laporan
Hasil per kartu, predikat yang dipakai, bukti, berkas, commit, cabang, risiko (predikat yang ragu).
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
