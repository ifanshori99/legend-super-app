# Brief: engineer — adapter WhatsApp untuk kode reset PIN slip gaji (legend-qih2m)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`, lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree `.worktrees/qih2m-payslip-otp`, cabang `ws/qih2m-payslip-otp`, dari `ws/hris-pii-pin` (8305fdc3). Lalu `pnpm worktree:setup`.

## Tujuan
`bd show legend-qih2m`. Sambungkan port `PayslipPinOtpSender` (`apps/api/src/services/payslip-pin.service.ts`) ke `MessagingProvider.send` yang sudah ada (cari pola OTP WhatsApp login yang sudah dipakai), dengan template OTP. Pasang di `createHrisPayslipRouter` sehingga reset-otp tidak 503 bila provider dikonfigurasi; tetap 503 bila tidak. Jangan pernah log kode atau nomor lengkap. Jangan kirim pesan sungguhan: test pakai provider palsu.

## Kartu
`legend-qih2m`. Awal: `ghostex board associate legend-qih2m`, `bd update legend-qih2m --status in_progress`. Lapor: `--status review` + `bd comment`.

## Scope
Hanya payslip PIN, wiring messaging, test, `.env.example` (nama key saja). Tanpa migrasi. Tanpa UI.

## Bukti selesai
Test gagal-dulu: provider ada -> kode terkirim lewat provider palsu, isi tidak di log; provider tidak ada -> 503; batas 3 kode/jam tetap; isolasi tenant. Test terarah, typecheck via `heavy`, prettier, `pnpm db:generate` kosong. Review tingkat K (auth + data pribadi): satu `architect` effort xhigh.

## Batas kerja ulang
typecheck gagal 2x: baca `~/.claude/state/heavy-fail/<terbaru>` habis, betulkan semua. Tunggu job lewat notifikasi. Jangan `pkill`. Jam dari `date '+%H:%M'`.

## Laporan
Commit, push. Hasil, bukti, file, subagent dan puncak, risiko.
