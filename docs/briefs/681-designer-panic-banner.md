# Brief: designer (Codex) — layar alert panik staf (legend-alovk)

## Peran
Baca `~/.agents/team/roles/designer.md`, lalu ikuti. Jangan jalankan `bd`.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree sendiri: `git worktree add -b design/panic-alert .worktrees/design-panic-alert milestone/m1`.

## Tujuan
Mockup untuk gerbang founder: layar/banner penuh alert panik di perangkat staf fasilitas. Klien WS sudah ada (tanpa UI) di cabang `ws/panic-alert` 6bf7beb1b: `apps/web/src/features/facility-staff/panic-realtime.ts` (onAlert, onStatus open/reconnecting/unreachable, onRevoked, ack); layar mock sekarang `emergency-screen.tsx`. Brief backend terkait: `docs/briefs/674-panic-alert.md`.

State wajib: alert masuk (layar penuh, lokasi/ruang, jam, tombol "Saya tangani"), sudah di-ack orang lain, menyambung ulang (reconnecting), tidak terjangkau (arahkan ke layar PIN), perangkat dicabut (revoked), beberapa alert beruntun. Desktop 1280 dan mobile 390. Ikuti `~/.agents/team/ui-standard.md`; aksesibel untuk darurat (kontras tinggi, teks besar, tidak bergantung warna saja, hormati reduced motion).

1. Buat state lewat subagent Codex paralel (maks 6) di `design/mockups/panic/`.
2. Satu page review `design/mockups/panic/review.html`, cek `ghostex visual check design/mockups/panic/review.html --out design/mockups/panic/review.png` dan `--width 390`.

## Batas
Hanya `design/mockups/panic/`. Commit lalu push `design/panic-alert` tanpa force.

## Laporan
Path page review, daftar state, tiga keputusan desain, asumsi yang perlu dikonfirmasi founder.
