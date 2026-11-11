# Brief: ui-engineer — UI backoffice konfigurasi (mockup Q29-Q34, Q35 disetujui founder 11 Nov)

## Peran
Baca `~/.agents/team/roles/ui-engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read offset/limit), lalu ikuti. UI mengikuti `~/.agents/team/ui-standard.md`.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Langkah 0: `git -C <repo> fetch origin milestone/m1 && git -C <repo> worktree add .worktrees/ui-bo-config -b ws/ui-bo-config origin/milestone/m1`. Kerja hanya di worktree itu, PORT dan nama DB sendiri.

## Tujuan
Bangun UI web sesuai mockup yang sudah disetujui founder, semua keadaan (normal, loading, kosong, error, validasi) seperti di mockup, desktop dan ponsel.

## Kartu
`legend-woc1` + `legend-d5pz` (satu implementer: halaman pajak sama), `legend-j0kd`, `legend-0frf`, `legend-5ac3`, `legend-s7szu`. Di awal: `ghostex board associate <id>` dan `bd update <id> --status in_progress`. Saat melapor: `bd update <id> --status review` + `bd comment <id> "<ringkasan>"`.

## Masukan
- Mockup: design/mockups/backoffice/tax-woc1.html, pajak-peringatan-d5pz.html, settings-hub-j0kd.html, menu-stasiun-0frf.html, jurnal-outlet-5ac3.html, receipt-run-s7szu.html (+ PNG per keadaan di folder yang sama). Baca satu layar saat membangun layar itu.
- Keputusan founder/CTO: nama menu "Pajak & layanan" (bukan "Pajak & biaya layanan"); tombol "Buat aturan" konsisten di woc1 dan d5pz.
- Deskripsi kartu di `bd show <id>` (kontrak API yang sudah ada).

## Scope
- Boleh: apps/web/** (fitur terkait), test web/e2e terkait. API hanya bila kartu menyebut endpoint yang belum ada; laporkan dulu bila ragu.
- Jangan: migrasi DB, apps/api logic uang, cabang lain.

## Pembagian paralel (giliran pertama)
- Explore (2): pola halaman pengaturan + komponen tabel/form yang ada; jalur jurnal manual/recurring + menu admin.
- implementer (5, paralel, file terpisah): woc1+d5pz, j0kd, 0frf, 5ac3, s7szu.
- test-writer: test komponen/e2e mock per kartu (gagal-dulu).
- Pemegang token heavy: satu test-runner.
- Akhir: ui-auditor (read-only) membandingkan screenshot dengan mockup, lalu reviewer sonnet.

## Bukti selesai
- `heavy pnpm --filter web typecheck`, lint, test web terkait, e2e mock terkait.
- Screenshot desktop 1280 + ponsel 390 tiap layar di `design/screens/ui-bo-config/` untuk review founder (gerbang UI). Jangan publikasikan page; taruh path di laporan.
- Commit per kartu, push `ws/ui-bo-config`. Laporan: sha, angka subagent (total, puncak, pemegang heavy), temuan ui-auditor.

## Batas kerja ulang (Retro 11)
- typecheck/tsc gagal 2x di kartu sama: baca `~/.claude/state/heavy-fail/<terbaru>` sampai habis, betulkan semua sekaligus, sekali lagi. Gagal ketiga: lapor.
- Jangan `pkill`/`killall` proses test, dev server, atau tsc.
