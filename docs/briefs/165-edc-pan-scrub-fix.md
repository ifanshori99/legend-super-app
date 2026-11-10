# Brief: engineer — perbaikan temuan Codex 150 (EDC PAN scrub)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/edc-pan-fix` dari `milestone/m1` a8c90378, worktree `.worktrees/edc-pan-fix`, `worktree:setup`. Jangan checkout di folder utama.

## Tujuan
Nomor kartu (PAN) di data EDC terhapus untuk semua bentuk penulisan, termasuk pemisah berulang atau campuran (`4111  1111  1111  1111`, `4111 - 1111-1111 1111`), konsisten di migrasi SQL, scrub JS, dan query deteksi. Runbook aman dijalankan manual. Test benar-benar menangkap PAN pendek dan pemisah berulang.

## Kartu
`legend-tjwb`. Di awal: `ghostex board associate legend-tjwb` dan `bd update legend-tjwb --status in_progress`. Saat melapor: `bd update legend-tjwb --status review` dan `bd comment legend-tjwb "<ringkasan bahasa biasa>"`.

## Masukan
- Temuan: `docs/briefs/150-second-opinion-edc-pan-scrub.result.md` (path baris merujuk cabang lama `ws/edc-pan-scrub`; di m1 migrasi `0113_edc_pan_scrub.sql` sudah dinomori ulang, cari dengan `git log --diff-filter=A --name-only milestone/m1 -- 'apps/api/drizzle/*edc_pan*'`).
- Runbook: `docs/runbooks/edc-pan-scrub.md`.
- Migrasi ini belum pernah rilis ke production. Apakah memperbaiki file migrasi yang sama atau menambah migrasi baru: putuskan bersama subagent architect (aturan AGENTS.md: migrasi yang sudah diterapkan tidak ditulis ulang; DB dev dan staging mungkin sudah menerapkannya). Catat alasannya.

## Scope
- Boleh diubah: migrasi EDC PAN (atau migrasi baru), helper scrub/deteksi PAN di API dan edge, `docs/runbooks/edc-pan-scrub.md`, test `edc-pan-*`.
- Jangan disentuh: `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts` (kecuali helper scrub yang memang dipakai di sana: lapor dulu), modul refund, auto-journal.

## Bukti selesai
- Test reproduksi dulu (gagal sebelum fix): pemisah berulang/campuran di `message`, `rrn`, `masked_pan`; PAN 12-19 digit dengan ambang per kolom; migrasi dijalankan dengan autocommit gagal di tengah tidak meninggalkan FORCE RLS mati.
- `LEGEND_TEST_FILES` berisi daftar eksplisit `src/test/edc-pan*.test.ts` dan test lain yang menyentuh helper (bash nullglob); laporkan jumlah file yang jalan dan lulus/gagal. tsc api lewat `heavy`, eslint, prettier, kontrak node (`^ℹ pass`).
- Runbook mewajibkan `psql -1 -v ON_ERROR_STOP=1` (atau transaksi eksplisit di file).
- Review K: subagent reviewer Opus + architect paralel; temuan nyata dibetulkan.
- Brief Codex lanjutan `docs/briefs/150b-second-opinion-edc-pan-fix.md` (tidak di-commit, hanya diff perbaikan, tanpa temuan Claude).

## Sebelum melapor
Commit lokal di `ws/edc-pan-fix`, termasuk catatan di `docs/PROGRESS.md` worktree. Pesan commit merujuk legend-tjwb. Jangan push, jangan merge.

## Laporan
Hasil, bukti (perintah, jumlah file test yang jalan, hasil), file berubah, commit SHA, keputusan migrasi dan alasannya, risiko tersisa, catatan rilis (urutan backfill di luar jam operasional), yang dibutuhkan dari CTO.
