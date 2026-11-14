# 826 AIG-02: masker data pribadi di hasil tool MCP ke klien luar (engineer, tingkat K data pribadi)

## Peran
engineer (baca ~/.agents/team/roles/engineer.md dan bagian "Paralel dulu" di ~/.agents/team/TEAM.md lewat Grep + Read offset/limit).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `origin/fix/ai-tool-result-pii` (de5af1cf8, berisi `redactToolResultContent`/`redactJson` di `apps/api/src/lib/ai/pii.ts`). Cabang akhir `fix/mcp-tool-result-pii` (rename dari ghostex/..., push tanpa --force).

## Kartu
`legend-zafqj`. Di awal `bd update legend-zafqj --status in_progress`; saat lapor `--status review` + `bd comment`.

## Keputusan CTO
Klien MCP eksternal (ChatGPT, Claude, dll. yang disambungkan tenant) dihitung "penyedia AI" menurut AIG-02 (docs/PRD.md:1085). Semua hasil tool yang keluar lewat `apps/api/src/services/mcp-server.service.ts` wajib lewat masker yang sama dengan gateway AI, di satu titik bersama tepat sebelum respons dikirim. Jangan membuat pola masker kedua; pakai helper yang ada. Bila ragu, masker.

## Scope
- Boleh: `mcp-server.service.ts` dan titik keluarnya, `lib/ai/pii.ts` (bila helper perlu diekspor/diperluas), test MCP dan AI.
- Jangan: migrasi, scope/token MCP, gateway AI selain pemakaian helper, pembayaran, edge, panik.

## Paralel
- Explore x1: semua jalur keluar hasil tool MCP (tools/call, resources, prompts, error yang membawa data).
- test-writer: matriks 4 jenis PII (email, telepon, NIK, rekening) x minimal tiga tool MCP, plus data terstruktur (key `phone`, `accountNumber`); gagal-dulu di basis.
- implementer x1.
- Pemegang token heavy: test-runner.

## Bukti selesai
- Test terarah file `mcp-*` dan `ai-pii*` lewat `heavy`; gagal-dulu tercatat.
- Pra-gate AGENTS.md (prettier, eslint, `heavy pnpm --filter @starter/api typecheck`).
- Satu subagent architect effort high atas diff; temuan nyata dibetulkan.
- Lapor hanya saat selesai atau butuh keputusan.

## Laporan
SHA, cabang akhir, titik masker, test, hasil architect, baris `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
