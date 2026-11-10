# Brief: engineer (Sonnet) — WS-01 jejak audit RBAC dan login staf

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/auth-audit-trail` dari `milestone/m1` terbaru (d8ea5e0b atau lebih baru). Worktree `.worktrees/auth-audit-trail`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge. Tanpa migrasi (pakai `audit_logs` yang ada); bila ternyata perlu, berhenti dan lapor.

## Kartu (P2, tingkat K: auth)
1. `legend-wt33` dan `legend-9by4` (duplikat): RBAC `AuditWriter` memakai `core-audit` `recordAudit` (writer sudah terpasang di `app.ts` sekitar :51). Sisa kerja: test commit/rollback (audit ikut rollback bila transaksi gagal), hapus writer uji di `platform-access-api.test.ts` sekitar :101. Tutup salah satu sebagai duplikat dengan `bd comment`.
2. `legend-wq3f`: jejak audit/event login (`login_challenge.created`, selesai, gagal, kedaluwarsa, dll. sesuai kartu) di `identity-login.service.ts` dan `identity-wa-*`. Tambah panggilan audit di titik sukses/gagal saja; jangan ubah logika pemilihan tenant WhatsApp (milik legend-mbd2 di `ws/tenant-claims`, sedang dikerjakan). Jangan mencatat kode OTP, token, atau nomor lengkap (mask).

## Kartu
Awal tiap kartu: `ghostex board associate <id>`, `bd update <id> --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Scope
Boleh: `services/audit-writer.ts`, `services/core-audit-writer.ts`, `services/identity-login.service.ts`, `services/identity-wa-*`, test. Jangan: Better Auth inti, MFA/passkey (legend-omp4, legend-jemg), `tenant_integrations`, UI.

## Bukti selesai
- Test gagal-dulu: audit RBAC tertulis saat commit dan hilang saat rollback; tiap event login tercatat dengan tenant, aktor/subjek, dan hasil; tidak ada OTP/token/nomor penuh di baris audit; tenant lain tidak bisa membaca audit login tenant ini.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes.
- Typecheck api lewat `heavy` sekali di akhir; eslint + prettier berkas berubah. Jangan `pnpm check` penuh.
- Review (Q48, tingkat K): satu subagent `architect`, lensa penyerang + `~/.agents/team/review-checklist.md`.
- Tulis brief Codex `docs/briefs/265b-second-opinion-auth-audit.md`, jangan dijalankan.

## Laporan
Sekali di akhir: per kartu (hasil, SHA), bukti, file berubah, risiko, jumlah subagent dan puncak bersamaan.
