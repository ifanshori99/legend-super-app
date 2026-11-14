# 815 AIG-02: data pribadi dari hasil tool tidak boleh terkirim ke provider AI (engineer, tingkat K data pribadi)

## Peran
engineer (baca ~/.agents/team/roles/engineer.md dan bagian "Paralel dulu" di ~/.agents/team/TEAM.md lewat Grep + Read offset/limit).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `origin/ws/criteria-ai-mcp` (ac44632ce, berisi reproduksi). Cabang akhir `fix/ai-tool-result-pii` (rename dari ghostex/..., push tanpa --force).

## Kartu
`legend-70xou`. Di awal `bd update legend-70xou --status in_progress`; saat lapor `--status review` + `bd comment`.

## Masalah
Kriteria AIG-02 (docs/PRD.md:1085): data sensitif yang dilarang tidak pernah terkirim ke penyedia AI. Terbukti: pertanyaan SOP yang bersih membuat email pribadi di snippet hasil tool `search_sop` terkirim utuh pada request provider berikutnya. Reproduksi `it.fails` di `apps/api/src/test/ai-acceptance.test.ts:381` (assertion gagal di :466).

## Keputusan CTO
Masker PII yang sudah dipakai untuk pesan pengguna juga wajib berlaku untuk SEMUA hasil tool sebelum masuk konteks provider (bukan hanya search_sop), di satu titik bersama di gateway AI. Hasil yang ditampilkan ke pengguna yang berwenang boleh tetap utuh; yang dibatasi hanya yang dikirim ke provider. Bila ragu, masker.

## Scope
- Boleh: gateway/orchestrator AI di `apps/api/src` (cari titik penyusunan request provider dan masker PII), test AI.
- Jangan: migrasi, MCP token/scope, pembayaran, edge, panik.

## Paralel
- Explore x2: (a) alur hasil tool -> pesan provider, (b) masker PII yang ada + polanya (email, telepon, NIK, rekening).
- test-writer: ubah `it.fails` jadi `it`; tambah test per jenis PII x minimal tiga tool berbeda; jalankan di basis (harus merah).
- implementer: satu, titik masker bersama.
- Pemegang token heavy: test-runner.

## Bukti selesai
- Test terarah semua file `ai-*` yang tersentuh lewat `heavy`; gagal-dulu tercatat.
- Pra-gate AGENTS.md (prettier, eslint, `heavy pnpm --filter @starter/api typecheck`).
- Satu subagent architect effort high atas diff; temuan nyata dibetulkan.

## Laporan
SHA, cabang akhir, titik masker, test, hasil architect, baris `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
