# Brief: engineer — HRIS kecil (6 kartu)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Langkah pertama: spawn subagent paralel dalam satu giliran.

## Worktree
Worktree Ghostex milikmu (base `milestone/m1`). Langkah 0: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Tanpa migrasi (bila ternyata perlu: rentang 0700-0701, pakai `--full`).

## Kartu
Di awal: `ghostex board associate <id>` + `bd update <id> --status in_progress`. Saat lapor: `--status review` + `bd comment`. Baca `bd show` tiap kartu untuk AC.
1. `legend-10tqi` kartu pesangon pakai API 955 (final-settlement-card.tsx:93).
2. `legend-e6xi5` duty meal untuk bawahan langsung.
3. `legend-uese` cursorPair tolak `\u0000` (hris-access.ts:475).
4. `legend-aki7` lampiran SOP dibatasi purpose (hris-sop.service.ts:312) — akses.
5. `legend-pl8hc` queue.ts:125,137 menelan error.
6. `legend-ec8t2` media brand_logo di hris-sop (core-storage-access.ts:134) — akses.

## Aturan
- Cek tabrakan dulu dengan cabang kas aktif: `git diff --stat origin/milestone/m1...origin/ghostex/cek-kas-1102-pinjaman-reimburse-supplier` dan `origin/int/batch90`. Kartu yang filenya disentuh cabang itu: tunda dan laporkan.
- Akses: bila ragu, pilih yang menolak. Test lintas tenant/outlet untuk kartu 2, 4, 6.
- Uang (pesangon kartu 1): tampilkan angka dari API, jangan hitung ulang di klien.
- Teks UI baru: daftarkan ke katalog text-contract.

## Pembagian paralel
- Explore (1): tabrakan file + peta file kartu.
- test-writer (1): test gagal-dulu kartu 2-6.
- implementer per kartu (file terpisah).
- test-runner: pemegang token heavy (setup, test terarah, typecheck API + web sekali).
- architect (effort high, akses): satu review atas diff kartu 2, 4, 6. reviewer sonnet: sisanya.

## Bukti selesai
Test terarah lulus, merah-dulu tercatat, typecheck API + web lulus, text-contract lulus bila teks berubah.

## Batas kerja ulang
Ikuti `~/.agents/team/brief-template.md` bagian "Batas kerja ulang". Jangan `pkill`.

## Sebelum melapor
Pra-gate AGENTS.md. Commit di cabang `ws/1086-hris-kecil`, push tanpa `--force`.

## Laporan
Hasil per kartu, bukti, berkas, commit, cabang, risiko.
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
