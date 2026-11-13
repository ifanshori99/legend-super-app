# Brief: ui-engineer — sambungkan layar pengaturan AI ke API nyata

## Peran
Baca `~/.agents/team/roles/ui-engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti. Ikuti `~/.agents/team/ui-standard.md`.

## Repo
Worktree baru dari `ui/ai-settings` (cd782c33, sudah dibuat Ghostex). Langkah pertama: `git merge --no-ff origin/ws/ai-login-autodetect` (eb1df93a, backend Tanya AI A+B, migrasi 0417-0418). Konflik di luar `apps/web`: hentikan dan lapor.

## Tujuan
Layar admin pengaturan provider AI tenant (legend-nnufz) memakai API nyata dari backend, bukan data contoh, dan dua perbedaan kontrak di legend-nnufz.1 dibetulkan:
1. `ai-settings-page.tsx`: kunci `platformDisabled` hanya berlaku untuk koneksi ChatGPT. CustomModelPanel dan BudgetCard tetap bisa dipakai (provider kustom adalah cadangan).
2. `custom-model-panel.tsx`: simpan dengan PATCH berisi field override yang berubah saja, bukan PUT snapshot gabungan.

## Kartu
`legend-nnufz.1` (dan `legend-nnufz` bila ini menuntaskannya). Di awal: `ghostex board associate <id>` dan `bd update <id> --status in_progress`. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan bahasa biasa>"`.

## Masukan
- `bd show legend-nnufz.1`, `bd show legend-nnufz`.
- Kontrak: `packages/shared` di cabang backend (DTO status delapan field; start device code `{riskAccepted:true}`, poll `{}`).
- Bukti backend: `docs/briefs/sub-ai-login-autodetect.md` di cabang backend.

## Scope
- Boleh diubah: `apps/web/src/features/ai*`, `apps/web/src/routes/**` untuk layar pengaturan AI, test web/e2e layar ini, katalog teks UI bila ada teks baru.
- Jangan disentuh: `apps/api/**`, `packages/shared/**` (kontrak backend; perbedaan kontrak dilaporkan ke CTO), migrasi.

## Pembagian paralel (giliran pertama)
- Explore (2): (a) API client/queries/hooks AI yang ada vs endpoint backend; (b) komponen layar dan titik data contoh yang harus diganti.
- implementer (2, file terpisah): (a) `features/ai*` api/queries/hooks ke endpoint nyata; (b) perbaikan dua komponen nnufz.1.
- test-writer: test komponen untuk kunci platformDisabled dan payload PATCH (gagal-dulu).
- Pemegang token heavy: satu `test-runner`.

## Bukti selesai
- `heavy` typecheck web hijau, test terkait hijau, Playwright layar pengaturan AI (bila ada spec) hijau.
- Pra-gate AGENTS.md: prettier, eslint, `node --test tests/text-contract.test.mjs` bila ada teks baru.
- Screenshot layar di lebar 390 dan 1280 (`ghostex visual check` atau Playwright) disimpan di `docs/screenshots/ai-settings/`.
- Satu `ui-auditor` atas layar.

## Batas kerja ulang (Retro 11)
- `typecheck`/`tsc` gagal 2 kali: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan semua sekaligus, jalankan sekali lagi. Gagal ketiga: lapor dengan isi log.
- Jangan `pkill`/`killall` proses test, dev server, atau tsc.
- Jam di laporan: `date '+%H:%M'`.
- Jangan merge ke milestone/m1 atau main; jangan deploy; jangan login ChatGPT nyata.

## Sebelum melapor
Commit di cabang kerja, hanya file dalam scope, lalu push cabang kerja ke `origin`.

## Laporan
Hasil, bukti, file berubah, commit, risiko tersisa, yang dibutuhkan dari CTO.
Wajib satu baris: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
