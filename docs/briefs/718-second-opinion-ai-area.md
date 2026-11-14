# Brief: second-opinion (Codex) — area AI: Pengaturan AI v2 + kunci platform

## Peran
Baca `~/.agents/team/roles/second-opinion.md`, lalu ikuti. Read-only: jangan ubah kode, jangan commit. Jangan jalankan `bd` selain `bd show`.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, cabang `origin/ui/ai-settings-v2` (29f52256a) dibanding `origin/milestone/m1`. Worktree read-only: `git worktree add --detach .worktrees/so-ai-area origin/ui/ai-settings-v2`.

## Fokus (tingkat K, akses)
Kunci platform AI (founder W16 Q7): bila platform mematikan AI untuk tenant, SEMUA jalur AI ditolak `AI_PLATFORM_DISABLED` (403): route simpan/pakai, gateway, panggilan AI sistem, MCP, permintaan aksi yang sudah disetujui. Pencabutan kunci dan login tetap boleh. Cari jalur yang lolos (job latar, worker, retry, cache, endpoint lain yang memanggil provider), celah lintas-tenant, dan bocor kredensial/token ChatGPT ke browser atau log. Test utama: `apps/api/src/test/ai-platform-lock.test.ts`. Catatan diketahui: modul `mcp` belum ditegakkan terpisah (legend-hbuq3), tenant tanpa modul `ai_assistant` terkunci saat rilis.

## Laporan
Temuan berurut P1/P2/P3 dengan file:line, skenario gagal konkret, dan usulan perbaikan. Tanpa temuan: tulis apa saja yang diperiksa. Hapus worktree read-only di akhir.
