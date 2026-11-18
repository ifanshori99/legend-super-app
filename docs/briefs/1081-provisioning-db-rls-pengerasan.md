# Brief: engineer — pengerasan provisioning DB dan RLS (5 kartu, tingkat K akses/migrasi)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Worktree
Worktree Ghostex milikmu (base `milestone/m1`). Langkah 0: `node ~/.claude/scripts/worktree-slim.mjs --full && heavy pnpm worktree:setup` (thread ini bisa membuat migrasi, jadi snapshot penuh).
Migrasi: rentang kerja 0692-0695 (merge train menomori ulang). `pnpm db:generate` harus kosong sesudahnya; registry/referensi test pakai nomor yang sama.

## Kartu
Di awal: `ghostex board associate <id>` + `bd update <id> --status in_progress` untuk kelimanya. Saat lapor: `--status review` + `bd comment`.
1. `legend-e75zl` sisa FORCE RLS (tests/db-role-provisioning*.mjs:668).
2. `legend-su9c` pgboss di allowlist (apps/api provision-roles.ts:986).
3. `legend-ecgfy` privtype `e` (provision-roles.ts:616,645).
4. `legend-eyscy` SECURITY DEFINER tanpa penjaga (provision-roles.ts:1086).
5. `legend-7jrh7` customer_reviews tanpa `app.enforce_member_rls` (0455_customer_reviews.sql:28,30): migrasi baru, jangan ubah migrasi yang sudah ada.
Baca `bd show` tiap kartu untuk AC lengkap. Bukti dari `docs/qa/2026-11-18-bd-stale-cleanup.md` bagian "Yang tersisa benar-benar SIAP".

## Aturan
- Aturan yang membatasi akses bila ragu. Jangan longgarkan test RLS/provisioning yang ada.
- Tiap perilaku baru: test gagal-dulu (catat merah di base, hijau di head).
- `provision-roles-audit.test.ts` mengubah keanggotaan role tingkat klaster: jalankan terarah sendiri, bukan paralel dengan test lain.
- Jangan sentuh area aktif: refund (ws/1072), kas (cek-kas-1102), edge (ws/1073), int/batch90.

## Pembagian paralel
- Explore (1): peta provision-roles.ts + test provisioning + pola RLS migrasi member.
- test-writer (1): test gagal-dulu untuk 5 kartu.
- implementer: satu untuk provision-roles.ts (kartu 2-4, berurutan dalam satu file), satu untuk migrasi 7jrh7, satu untuk e75zl (test mjs).
- test-runner: pemegang token heavy (setup, test terarah, typecheck API sekali).
- architect (effort xhigh, akses/migrasi): satu review atas diff akhir. Temuan nyata dibetulkan sebelum lapor.

## Bukti selesai
Test terarah lulus (daftar file), merah-dulu tercatat, typecheck API lulus, `db:generate` kosong, `check-journal` hijau, architect tanpa P0-P2 terbuka.

## Batas kerja ulang
Ikuti `~/.agents/team/brief-template.md` bagian "Batas kerja ulang". Jangan `pkill`.

## Sebelum melapor
Pra-gate AGENTS.md (prettier, eslint, migrasi). Commit di cabang `ws/1081-provisioning-rls`, push tanpa `--force`.

## Laporan
Hasil per kartu, bukti, berkas, commit, cabang, nomor migrasi, risiko.
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
