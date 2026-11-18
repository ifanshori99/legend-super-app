# Brief: engineer — worktree hemat disk (legend-jjg6i)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Thread ini dimulai TANPA worktree Ghostex (disk 16 GB; satu worktree penuh 1,9 GB). Jangan edit di folder utama (milik CTO).
Langkah 0: buat worktree sendiri yang sudah hemat, sekaligus prototipe kartu ini:
`git worktree add --no-checkout -b ws/1069-worktree-hemat ../legend-1069 milestone/m1`, lalu `git sparse-checkout` (mode non-cone atau cone) yang membuang `apps/api/drizzle/meta/*_snapshot.json` lama (simpan snapshot TERBARU saja) dan `docs/design/` (screenshot), lalu `git checkout`. Kerja di `../legend-1069`. Catat ukurannya (`du -sh`) dibanding worktree biasa (~1,9 GB).

## Tujuan
Worktree baru untuk thread yang tidak membuat migrasi memakan jauh lebih sedikit disk (target hemat >= 1 GB per worktree), tanpa merusak `pnpm db:generate`, `pnpm test`, typecheck, atau merge train. Thread yang membuat migrasi tetap bisa memakai snapshot penuh.

## Kartu
`legend-jjg6i`. Di awal: `ghostex board associate legend-jjg6i` dan `bd update legend-jjg6i --status in_progress`. Saat melapor: `bd update legend-jjg6i --status review` dan `bd comment legend-jjg6i "<ringkasan>"`.

## Masukan
- Retro 48 (`~/.agents/team/RETRO.md`): 723 MB tiap worktree adalah `apps/api/drizzle/meta`.
- Cara Ghostex membuat worktree: `ghostex coordinator start-thread --help` (`--worktree --base-branch`). Cari apakah repo punya hook/skrip setelah worktree dibuat (`.ghostex/`, `scripts/`, `package.json` script `worktree*`, `~/.claude/scripts/`).
- drizzle-kit butuh snapshot TERBARU untuk `db:generate`; cek apakah snapshot lama dibaca oleh test (`tests/*.test.mjs`, `check-journal.mjs`).

## Scope
- Boleh: skrip repo baru (mis. `scripts/worktree-slim.sh`), dokumentasi `docs/local-development.md`, dan bila perlu skrip di `~/.claude/scripts/` (tulis ke berkas sementara lalu `mv`, atomik).
- Jangan: mengubah isi `apps/api/drizzle/` atau migrasi, menghapus worktree milik thread lain, mengubah hook ram-guard/heavy.
- Migrasi: tidak ada.

## Pembagian paralel (giliran pertama)
- Explore (2): (a) siapa yang membaca `drizzle/meta/*_snapshot.json` dan `docs/design/` (test, skrip, drizzle-kit, check-journal); (b) bagaimana worktree Ghostex dibuat dan apakah ada titik kait setelah checkout.
- implementer (1-2): skrip slim worktree + dokumen; satu per berkas.
- test-runner: pemegang token heavy. Di worktree hemat jalankan `heavy pnpm --filter @starter/api typecheck`, `pnpm db:generate` (harus kosong), dan satu test terarah (`LEGEND_TEST_FILES="<satu test api>" heavy pnpm test`).
- reviewer (sonnet): diff akhir.

## Bukti selesai
- `du -sh` worktree hemat vs biasa.
- typecheck API lulus, `db:generate` kosong, satu test terarah lulus di worktree hemat.
- Cara pakai satu baris untuk CTO (perintah yang dipakai sebelum/sesudah `start-thread --worktree`, atau alternatif bila Ghostex tidak punya titik kait).

## Batas kerja ulang
Ikuti `~/.agents/team/brief-template.md` bagian "Batas kerja ulang". Jangan `pkill`.

## Sebelum melapor
Commit di `ws/1069-worktree-hemat`, push tanpa `--force`. Pra-gate AGENTS.md (prettier, eslint pada berkas berubah).

## Laporan
Hasil, ukuran, bukti, berkas, commit, cabang, risiko, yang dibutuhkan CTO.
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
