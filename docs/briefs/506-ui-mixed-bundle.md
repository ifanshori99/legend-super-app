# Brief: ui-engineer — UI campuran: bagi tagihan, payroll, notifikasi, sarapan, label prep (mockup Q34, Q36-Q40 disetujui founder 11 Nov)

## Peran
Baca `~/.agents/team/roles/ui-engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read offset/limit), lalu ikuti. UI mengikuti `~/.agents/team/ui-standard.md`.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Langkah 0: `git -C <repo> fetch origin milestone/m1 && git -C <repo> worktree add .worktrees/ui-mixed-q36 -b ws/ui-mixed-q36 origin/milestone/m1`. Kerja hanya di worktree itu, PORT dan nama DB sendiri.

## Tujuan
Bangun UI web sesuai mockup yang sudah disetujui founder, semua keadaan (normal, loading, kosong, error, validasi) seperti di mockup, desktop dan ponsel.

## Kartu
`legend-wwyyk`, `legend-wpqs`, `legend-rp3fk`, `legend-ijv8`, `legend-wjz1`. Di awal: `ghostex board associate <id>` dan `bd update <id> --status in_progress`. Saat melapor: `bd update <id> --status review` + `bd comment <id> "<ringkasan>"`.

## Masukan
- Mockup: design/mockups/split-claim-wwyyk.html (hanya ponsel), design/mockups/hris/payroll-wpqs.html (kebijakan + jadwal THR), design/mockups/platform/notification-preferences-rp3fk.html, design/mockups/pos/pos-extra-ijv8-sarapan.html, design/mockups/pos/pos-extra-wjz1-label-prep.html (+ PNG per keadaan). Baca satu layar saat membangun layar itu.
- Deskripsi kartu di `bd show <id>` (kontrak API yang sudah ada).

## Scope
- Boleh: apps/web/** (fitur terkait), test web/e2e terkait. API hanya bila kartu menyebut endpoint yang belum ada; laporkan dulu bila ragu.
- Jangan: migrasi DB, apps/api logic uang (wpqs: hanya UI sumber legal-entity, tanpa ubah hitungan payroll), cabang lain. Bila app ponsel/POS bukan di apps/web, ikuti lokasi fitur yang ada.

## Pembagian paralel (giliran pertama)
- Explore (2): customer/split + POS (ijv8, wjz1); HRIS payroll + platform notifikasi.
- implementer (5, paralel, file terpisah): wwyyk, wpqs, rp3fk, ijv8, wjz1.
- test-writer: test komponen/e2e mock per kartu (gagal-dulu).
- Pemegang token heavy: satu test-runner.
- Akhir: ui-auditor (read-only) membandingkan screenshot dengan mockup, lalu reviewer sonnet.

## Bukti selesai
- `heavy pnpm --filter web typecheck`, lint, test web terkait, e2e mock terkait.
- Screenshot desktop 1280 + ponsel 390 tiap layar di `design/screens/ui-mixed-q36/` untuk review founder (gerbang UI). Jangan publikasikan page; taruh path di laporan.
- Commit per kartu, push `ws/ui-mixed-q36`. Laporan: sha, angka subagent (total, puncak, pemegang heavy), temuan ui-auditor.

## Batas kerja ulang (Retro 11)
- typecheck/tsc gagal 2x di kartu sama: baca `~/.claude/state/heavy-fail/<terbaru>` sampai habis, betulkan semua sekaligus, sekali lagi. Gagal ketiga: lapor.
- Jangan `pkill`/`killall` proses test, dev server, atau tsc.
