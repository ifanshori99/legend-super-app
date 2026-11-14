# Brief: ui-engineer — layar alert panik staf, Arah A (legend-alovk)

## Peran
Baca `~/.agents/team/roles/ui-engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep, Read offset/limit), lalu ikuti. Semua kerja UI ikut `~/.agents/team/ui-standard.md`.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `ws/panic-alert`. Cabang akhir `ui/panic-alert`.

## Tujuan
Founder memilih **Arah A** (W10 Q8, 14 Nov) dari mockup `design/mockups/panic/review.html` di cabang `design/panic-alert` 96a4be040: lokasi paling besar di layar; tombol "Saya tangani" berarti staf menuju lokasi. Ikut disetujui: alert beruntun diantre urut datang; saat akses dicabut staf diarahkan ke perangkat lain yang aktif.

Bangun di atas klien WS yang sudah ada: `apps/web/src/features/facility-staff/panic-realtime.ts` (onAlert, onStatus open/reconnecting/unreachable, onRevoked, ack); ganti layar mock `emergency-screen.tsx`. Keadaan: alert masuk (layar penuh), sudah ditangani rekan, menyambung ulang, tidak terjangkau (ke layar PIN), akses dicabut, alert beruntun. Darurat: kontras tinggi, teks besar, tidak bergantung warna saja, hormati reduced motion, tombol besar untuk sentuhan. Jangan ubah server; celah kontrak jadi kartu bd baru (discovered-from legend-alovk).

## Kartu
`legend-alovk` (aturan kartu: `~/.agents/team/brief-template.md`). Teks UI baru didaftarkan ke katalog (`node --test tests/text-contract.test.mjs`).

## Bukti selesai
Screenshot tiap keadaan 1280 dan 390 (`docs/screenshots/panic-alert/`), test komponen untuk antrean beruntun + ack + revoked, ui-auditor sebelum lapor, pra-gate AGENTS.md (prettier, eslint, typecheck web lewat heavy).

## Sebelum melapor
Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Jangan merge, jangan deploy.
