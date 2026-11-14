# Brief: engineer Codex — 4 kartu kecil terpisah

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan menjalankan `bd`; CTO memindah kartu.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree baru dari `origin/milestone/m1`, satu cabang per kartu: `fix/pii-salary-false-positive`, `fix/leave-form-pdf-capabilities`, `fix/edge-selfie-scanner`, `fix/domain-verify-limiter-shared`.

## Kartu (masing-masing satu implementer, file tidak bertumpuk)
1. legend-0a1r1: masker PII pola gaji false positive ('Slip gaji Oktober 2026' jadi 'Slip [salary amount]'). Nominal tetap disamarkan; kata/tanggal tidak.
2. legend-3e8p0: form cuti HRIS menawarkan PDF tanpa cek `GET /api/storage/capabilities`; sembunyikan/tolak PDF bila pemindai tidak tersedia (pola sama dengan layar lain yang sudah cek capabilities).
3. legend-xn214: selfie edge pakai NoopMalwareScanner (`storage-api.routes.ts:291/404`); suntik scanner bersama bila tersedia, tetap jalan bila tidak (kebijakan sama dengan unggah lain).
4. legend-8y5fc: batas laju verifikasi domain tenant pakai penyimpanan bersama (DB, tanpa Redis baru) agar berlaku lintas instance/restart. Migrasi bila perlu: hanya 0382.

## Bukti selesai
- Test gagal-dulu per kartu, lalu `LEGEND_TEST_FILES="..." heavy pnpm test` hijau per kartu.
- Pra-gate AGENTS.md pada file yang diubah; typecheck paket tersentuh sekali lewat heavy.
- Push tiap cabang tanpa force. Laporan: sha per cabang, test, angka subagent.
