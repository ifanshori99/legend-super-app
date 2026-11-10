# Brief: engineer — verifikasi EDC tender dan standalone, buka test e2e yang di-skip (legend-dahk, legend-m4fv)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/edc-tender-verify` dari `milestone/m1` terbaru (42ee5c28 atau lebih baru). Worktree `.worktrees/edc-tender-verify`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
Dua kartu P1 dari e2e WS-13 (detail: `bd show legend-dahk`, `bd show legend-m4fv`, komentar terbaru). Test yang menunggu: `az-e-cashier-shift.test.ts` EDC-01, EDC-02 (approved dan declined), EDC-04, di-skip di 263ce1ec dengan id kartu.
- `legend-dahk`: tender EDC menjawab 503 karena `setPosEdcTenderPort` tidak dipasang di luar test. Triase terbaru menyebut wiring kini ada di `apps/api/src/app.ts:97`. Buktikan: unskip EDC-01/02 dan jalankan. Bila masih 503, pasang port di bootstrap yang benar (cloud API; edge node bila PRD Alur W 1300-1306 mengharuskan) dan jelaskan pilihannya.
- `legend-m4fv`: keputusan CTO sudah ada di catatan kartu: action `edc_standalone` di `POS_OVERRIDE_ACTIONS` (+ `ApprovalActionType`), permission `pos.edc_standalone.approve` (supervisor). Cek apakah sudah dibangun; bila belum, bangun sesuai PRD EDC-04 (PIN supervisor + nomor referensi + tanda rekonsiliasi) dan sambungkan ke jalur tender EDC. Unskip EDC-04.

## Kartu
`legend-dahk`, `legend-m4fv`. Di awal: `bd update <id> --status in_progress`. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan>"`.

## Scope
Boleh: wiring port EDC, `packages/shared/src/access/override.ts`, `staff-override.service.ts`, jalur tender EDC, katalog i18n/kode error, test e2e az-e yang disebut, test API terkait. Jangan: refund, PIN edge, pajak, akses Owner/platform, Better Auth, UI kasir (kecuali label bila wajib), migrasi (tanya CTO bila perlu).

## Bukti selesai
- Test e2e EDC-01, EDC-02 (dua kasus), EDC-04 lulus tanpa skip. Cara menjalankan e2e az-e: lihat `package.json` dan `docs/`; e2e lewat `heavy` di latar, sekali per perbaikan.
- Test API terkait EDC dan override lewat `LEGEND_TEST_FILES` daftar eksplisit (path `src/test/...`) dengan `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="..." pnpm test'`.
- tsc lewat `heavy`, eslint, prettier. Jangan jalankan `pnpm check` penuh.
- Bila ada perubahan kode produk: reviewer Opus (uang dan auth override) + architect paralel; tulis brief Codex `docs/briefs/235b-second-opinion-edc-tender.md` (tidak di-commit). Bila hanya unskip test: reviewer Sonnet cukup.

## Laporan
Sekali: hasil per kartu (sudah ada atau dibangun), bukti, file berubah, SHA, risiko tersisa, jumlah subagent dan puncak bersamaan. Jangan menunggu proses global atau loop sleep. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
