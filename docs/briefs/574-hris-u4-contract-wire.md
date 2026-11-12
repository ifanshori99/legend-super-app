# Brief: engineer (Codex) — kontrak nama pemohon + rincian shift HRIS U4, lalu sambung layar (legend-hvh9x)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu", "Kerja berat" di `~/.agents/team/TEAM.md`. Konteks: `docs/briefs/568-hris-u4-backend.md`, `docs/briefs/569-hris-u4-wire.md`.

## Repo
Worktree dari Ghostex basis `ui/hris-u4-wire` (6e580652; sudah berisi ws/hris-u4-be 8f3f8a01 + migrasi 0406). Buat cabang `ws/hris-u4-full`. Commit lokal, push cabang boleh. Migrasi baru bila perlu: **0407-0409** saja.

## Tujuan
1. Backend (`bd show legend-hvh9x`): kandidat tukar shift mengembalikan assignment rekan yang dibutuhkan untuk membuat tukar shift; penerima dan antrean supervisor mendapat nama pemohon + tanggal/shift. Pembacaan terotorisasi, dibatasi outlet; jangan buka direktori/roster karyawan penuh. Test isolasi: outlet lain dan tenant lain tidak bisa membaca.
2. UI: sambungkan keputusan supervisor dan tukar shift yang tadinya ditahan. Layar sudah disetujui founder (Q72-Q79): jangan ubah desain. UI tetap menahan keputusan bila data kurang.
3. Bereskan gagal lint yang ditemukan merge train: `owner-requests-page.tsx:252` (`react-hooks/purity`), `tests/539-u4-ui-check.mjs:345` (`no-unexpected-multiline`), Prettier 12 file. Hanya mekanis.

## Review
Tingkat K (akses + migrasi): SATU subagent architect effort xhigh mereview seluruh diff backend HRIS U4 (termasuk 0406 dari ws/hris-u4-be yang belum direview); temuan nyata dibetulkan.

## Bukti selesai
- Test terarah lulus, typecheck api+web, ESLint + Prettier lulus, satu screenshot layar supervisor dan tukar shift (`ghostex visual check`, 390 dan 1280).
- Jangan jalankan `pnpm check` penuh; jangan sentuh milestone/m1 atau main; jangan deploy.
- Lapor SHA, test, temuan architect.
