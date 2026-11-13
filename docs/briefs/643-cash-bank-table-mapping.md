# Brief: ui-engineer (tugas kecil) — tabel Kas & Bank di layar sempit + cek peta akun saat submit

Peran: baca `~/.agents/team/roles/ui-engineer.md` dan `~/.agents/team/ui-standard.md`. Model Sonnet (tugas kecil). Dua kartu, file terpisah: satu `implementer` per kartu.

## Repo
Worktree baru dari `origin/fix/petty-fund-required` (0abf250ce; ikut batch57): `git worktree add .worktrees/cash-643 -b fix/cash-bank-table-mapping origin/fix/petty-fund-required`, `pnpm worktree:setup`. Tanpa migrasi (bila ternyata perlu: lapor CTO dulu).

## Kartu
1. `legend-wjyps` (P1, UI) — tabel entri Kas & Bank lebar 1103px: kolom Tindakan terpotong 150px di 1280, di 390 harus geser 784px. Di mobile jadikan kartu/list, di desktop aksi selalu terlihat (sticky atau kolom ringkas). Toast setujui/tolak pakai label jenis entri yang benar (top-up bukan "Kas keluar"). Sembunyikan Setujui/Tolak untuk entri buatan sendiri (API sudah 403 `CASH_OUT_SELF_APPROVAL`). UI Kas & Bank sudah disetujui founder (Q6): jangan ubah arah visual, hanya tata letak responsif.
2. `legend-e61s5` (P2, uang) — top-up kas kecil tanpa peta akun `petty_cash`: tolak saat submit dengan `ACCOUNT_MAPPING_MISSING` (bukan gagal saat disetujui lalu tetap pending). Test gagal-dulu.

## Bukti selesai
Screenshot 390 dan 1280 (`ghostex visual check` atau Playwright lewat `heavy`), subagent `ui-auditor` atas layar itu. Test terarah lewat `heavy`, typecheck api + web lewat `heavy` sekali, prettier + eslint, `node --test tests/text-contract.test.mjs` bila ada teks baru. Push tanpa force. `bd update --status review` + `bd comment`.

## Batas
Jangan merge, deploy, `pkill`, atau `pnpm test` penuh. Hemat token.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
