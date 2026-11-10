# Brief: engineer — kontrak katalog tool AI/MCP (legend-1zxo)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/contracts.md`, `docs/plan/AGENT_PLAYBOOK.md`.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ai-tool-catalog`, cabang `ws/ai-tool-catalog` (dari `main`). Jangan pindah cabang.
Setup dulu: `pnpm install --offline --frozen-lockfile` (gagal: `--prefer-offline`). Jangan pernah symlink `node_modules` dari checkout lain (legend-meki).

## Tujuan
Kontrak WS-12: satu katalog tool yang dipakai Tanya AI dan MCP. PRD v1.7 §3 F38, F39, F40 dan §6 J (`docs/PRD.md`). Isi: skema I/O TL-01..TL-20, anotasi read/write, role minimum dipetakan ke scope, skema `action_request` yang tertaut ke `approval_requests` yang sudah ada, conversations, setelan tata kelola AI (kuota, batas, kill-switch), MCP clients/tokens. Kriteria AIG-03, MCP-01 (tingkat kontrak). Detail: `bd show legend-1zxo`.

## Kartu
`legend-1zxo`. Di awal: `ghostex board associate legend-1zxo` dan `bd update legend-1zxo --status in_progress`. Saat melapor: `bd update legend-1zxo --status review` dan `bd comment legend-1zxo "<ringkasan bahasa biasa>"`.

## Catatan
- Kontrak saja: Zod + tipe inferensi, subpath ekspor di `packages/shared/package.json`, event domain didaftarkan di katalog event WS-00, fixture mock realistis Cafe Legend yang lolos parse di unit test. Konvensi §6: uang BIGINT rupiah `*_idr`, id UUID, ULID untuk event operasional, field `tenant_id`/`outlet_id`. Tanpa kode khusus Node/browser.
- Token MCP: kontrak hanya menyimpan hash/prefix, tidak pernah nilai token mentah. Tool write wajib lewat action_request + approval.
- Jangan baca `.env*`.

## Scope
- Boleh: `packages/shared/src/ai/**`, entri exports di `packages/shared/package.json`, registrasi katalog event, test kontrak di `packages/shared`.
- Jangan: `apps/`, schema DB, kontrak domain lain selain menambah referensi.

## Bukti selesai
- Unit test: semua fixture lolos parse, input tidak sah ditolak, tiap tool punya anotasi dan scope, tool write menghasilkan action_request.
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus. `git status` bersih.
- Subagent reviewer konteks segar cek diff; temuan nyata dibetulkan.

## Sebelum melapor
Commit lokal di `ws/ai-tool-catalog`, pesan merujuk `legend-1zxo`. Jangan push, jangan merge.

## Laporan
Hasil, bukti, file berubah, commit, bead lanjutan, risiko tersisa.
