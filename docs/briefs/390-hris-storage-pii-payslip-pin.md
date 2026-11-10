# Brief: engineer — HRIS: signer storage, rotasi kunci PII, PIN slip gaji (2ect, 33mj, 2ap3)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit; jangan baca TEAM.md utuh), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree baru `.worktrees/hris-pii-pin`, cabang `ws/hris-pii-pin`, dari `milestone/m1`. Lalu `pnpm worktree:setup`.

## Tujuan
Satu workstream HRIS keamanan, urut:
1. legend-2ect + legend-33mj: pasang signer storage produksi (fileSigner) untuk `hrisRouter` dan `hrisLeaveRouter`; rotasi kunci PII (beberapa versi kunci, kolom versi, job enkripsi ulang yang idempoten dan bisa dilanjutkan).
2. legend-2ap3: PIN slip gaji per karyawan (hash, set + reset oleh HR, penghitung percobaan + lockout, audit). Kontrak di `bd show legend-2ap3`: `POST /api/hris/me/payslips/:payslipId/view {pin}`, error `PAYSLIP_PIN_INVALID` (403) / `PAYSLIP_PIN_LOCKED` (423). Reset lewat OTP WhatsApp: siapkan port saja bila adapter belum ada, jangan kirim pesan sungguhan.

## Kartu
`legend-2ect`, `legend-33mj`, `legend-2ap3`. Di awal tiap kartu: `ghostex board associate <id>` dan `bd update <id> --status in_progress`. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan bahasa biasa>"`. Sebelum mulai: `git log --all --oneline | grep <id>` (kartu bisa sudah dikerjakan di cabang lain; bila ada, lapor dan lewati).

## Masukan
- PRD §3 D.30 (slip gaji ber-PIN). Pola PIN yang sudah ada: PIN absen outlet dan pepper per outlet (cabang `ws/jmsdx-pepper`, `ws/aruta-pos-pin`) — pakai ulang pola hash/pepper/lockout, jangan menulis ulang.
- AGENTS.md "Security rules" dan "Adding a resource end to end".

## Scope
- Boleh diubah: modul HRIS di `apps/api` (routes, services, schema), storage signer, `packages/shared` validator/tipe HRIS, test terkait, docs kontrak HRIS.
- Jangan disentuh: modul uang (pembayaran, refund, profit share, loyalty), web UI (kartu ini BE + kontrak saja; layar PIN slip gaji butuh gerbang UI founder, buat kartu FE terpisah).
- Migrasi: rentang 0256-0258 khusus kartu ini. `when` harus di atas semua migrasi di m1 dan di atas 0255 (cek `drizzle/meta/_journal.json`). Jangan menomori ulang migrasi lain.

## Bukti selesai
- Test gagal-dulu per kartu (PIN salah, lockout, reset, isolasi antar karyawan dan antar tenant; enkripsi ulang idempoten dan bisa dilanjutkan; file signer menolak URL kedaluwarsa).
- `LEGEND_TEST_FILES="..." pnpm test` untuk file terkait; lint + typecheck paket berubah lewat `heavy`; `pnpm exec prettier --check <berkas berubah>`; `pnpm db:generate` kosong setelah migrasi.
- Review tingkat K (data pribadi + auth): satu subagent `architect` atas diff akhir, temuan nyata dibetulkan.

## Batas kerja ulang (Retro 11)
- `typecheck` atau `tsc` gagal 2 kali di kartu yang sama: berhenti menebak. Baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan SEMUA error sekaligus, jalankan sekali lagi. Gagal ketiga: lapor dengan isi log.
- Jangan `pkill`/`killall` proses test, dev server, atau tsc.
- Jam di laporan: ambil dari `date '+%H:%M'`.
- Di zsh, jangan pakai pola `F=("${(@f)$(git diff --name-only)}")` (memicu approval palsu); pakai `git diff --name-only | while read f`.

## Sebelum melapor
Commit di `ws/hris-pii-pin` (satu commit per kartu), push cabang ke `origin`. Selesaikan ketiga kartu, lalu lapor sekali.

## Laporan
Hasil, bukti (perintah dan hasilnya), file berubah, commit per kartu, nomor migrasi + `when`, jumlah subagent dan puncak bersamaan, risiko tersisa, keputusan yang butuh CTO.
