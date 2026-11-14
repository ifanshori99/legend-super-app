# 812 Status bar shell operasional ringkas di HP (ui-engineer, tugas kecil)

## Peran
ui-engineer (baca ~/.agents/team/roles/ui-engineer.md, `~/.agents/team/ui-standard.md`, dan bagian "Paralel dulu" di ~/.agents/team/TEAM.md lewat Grep + Read offset/limit).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `origin/fix/ops-statusbar-contrast` (b1af31c1b, brief 803; belum di m1, ada di antrean merge train). Cabang akhir `ui/ops-statusbar-mobile` (rename dari ghostex/..., push tanpa --force).

## Kartu
`legend-0xx06`. Di awal `bd update legend-0xx06 --status in_progress`; saat lapor `--status review` + `bd comment`.

## Tujuan
Status bar shell operasional (`apps/web`, layout `_ops`) saat ini 154px tinggi di lebar 390px dan nama outlet terpotong; di 1280px 78px. Jadikan satu baris di HP (target <= 56px): picker outlet pindah ke ikon/tombol yang membuka sheet, nama outlet utuh atau elipsis dengan nama lengkap di sheet. Desktop tidak berubah. Kontras dari 803 tetap. Teks baru masuk katalog text-contract.

## Scope
- Boleh: komponen status bar / picker outlet shell `_ops` dan test-nya, katalog teks.
- Jangan: logika sesi/outlet, API, layar lain, alarm panik.

## Paralel
- Explore x1: komponen status bar + picker + pemakaian Sheet shadcn yang ada.
- implementer x1: komponen.
- ui-auditor: audit akhir terhadap ui-standard.
- Pemegang token heavy: satu test-runner (typecheck web, screenshot).

## Bukti selesai
- Screenshot sebelum/sesudah di 390px dan 1280px (`heavy ghostex visual check` atau Playwright lewat `heavy`), simpan di `docs/screenshots/812-*.png`, ukur tinggi bar.
- Pra-gate AGENTS.md: prettier, eslint, `node --test tests/text-contract.test.mjs`, `heavy pnpm --filter @starter/web typecheck`.
- Butuh review UI founder: sertakan path screenshot di laporan.

## Laporan
SHA, cabang akhir, tinggi bar sebelum/sesudah, path screenshot, baris `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
