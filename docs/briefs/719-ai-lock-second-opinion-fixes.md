# Brief: engineer (Claude Sonnet) — perbaiki temuan second opinion kunci platform AI (legend-c8dmr)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep, Read offset/limit), lalu ikuti. Pakai subagent: satu implementer per temuan (file tidak bertumpuk), test-writer untuk test gagal-dulu.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add -b fix/ai-lock-second-opinion .worktrees/ai-lock-second-opinion origin/ui/ai-settings-v2`.

## Tujuan
Keputusan CTO: semua temuan diperbaiki, aturan yang membatasi (tolak) menang. Founder W16 Q7: kunci semua AI. Kontrak: jalur AI saat terkunci menjawab `403 AI_PLATFORM_DISABLED`; pencabutan kunci dan login tetap boleh.
1. P1 `apps/api/src/services/ai-gateway.service.ts:850` dan `ai-action-request.service.ts:827`: cek kunci dan mulai operasi (panggilan provider berbayar, eksekusi aksi disetujui) diserialkan dengan perubahan kunci platform memakai lock yang sama (mis. baris tenant/flag FOR SHARE vs FOR UPDATE saat mengunci, atau advisory lock per tenant). Setelah kunci commit, tidak ada operasi baru yang mulai. Test urutan transaksi deterministik (dua koneksi).
2. P2 `ai-action-request.service.ts:827`, `:1001`, `:543`: error kunci tidak ditelan jadi `failed`; aksi tetap belum dieksekusi dan bisa jalan setelah kunci dibuka bila kontrak mengizinkan (bila ragu: tetap `pending`/ditolak dengan alasan kunci, bukan `failed` generik), read-through dan worker mendapat 403 `AI_PLATFORM_DISABLED`.
3. P2 `ai-system-call.ts:94`: outcome dan kode khusus platform (bukan `feature_disabled`/`provider_unavailable`), dipropagasikan ke caller; worker ringkasan harian mencatat alasan kunci. Perbarui test yang mengharapkan `feature_disabled` hanya untuk kasus kunci platform.
4. P2 `mcp-oauth.service.ts:117`, `:319`, `:339`, `:409`: cek kunci eksplisit sebelum memproses atau membakar kode; authorize, token, registrasi menjawab 403 `AI_PLATFORM_DISABLED` (untuk redirect authorize: ikuti cara OAuth yang aman, jelaskan pilihanmu). Test ketiganya.
Tanpa migrasi (bila butuh, berhenti dan lapor).

## Bukti, sebelum melapor
Test gagal-dulu tiap temuan, test terarah hijau lewat `heavy` (termasuk `ai-platform-lock.test.ts`), pra-gate AGENTS.md (prettier, eslint, typecheck api lewat `heavy`). Review: satu subagent architect effort xhigh (akses) atas diff. Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push `fix/ai-lock-second-opinion` tanpa force. Jangan merge, jangan deploy.
