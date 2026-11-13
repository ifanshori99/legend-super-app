# Brief: second-opinion — area auth/akses: login ChatGPT + provider AI

Baca `~/.agents/team/roles/second-opinion.md`, lalu ikuti. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (maks 3). Tidak mengubah file.

Repo: `/Users/ifanshori99/Projects/legend super app/legend` (read-only; `git fetch origin` dulu).

## Rentang diff
`git diff origin/milestone/m1...origin/fix/ai-login-review -- apps/api/src packages/shared/src apps/api/drizzle` (migrasi 0417-0418).

Berkas berisiko: `services/ai-chatgpt.service.ts`, `ai-provider-config.service.ts`, `ai-gateway.service.ts`, `lib/ai/chatgpt-codex.ts`, `lib/ai/model-capabilities.ts`, `lib/ai/request-policy.ts`, routes AI, migrasi 0417-0418.

## Invariant
- Login ChatGPT device code hanya owner tenant; impersonasi ditolak; persetujuan risiko tercatat (Q88).
- Token/API key terenkripsi, tidak pernah ke log, DTO, atau browser.
- Kill switch platform dan tenant menghentikan pemakaian ChatGPT di semua jalur.
- Provider kustom OpenAI-compatible: base URL tidak bisa dipakai untuk SSRF (localhost, IP privat, metadata cloud).
- Owner penyetuju yang kehilangan peran owner -> koneksi diputus.
- Anggaran AI tenant tidak bisa terlampaui (reservasi atomik); fallback ke API key berbayar tidak boleh menggandakan biaya.
- RLS tenant pada tabel baru.

## Laporan
Format peran: satu baris per temuan.
