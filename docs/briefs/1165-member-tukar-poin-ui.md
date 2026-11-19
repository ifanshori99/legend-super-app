# 1165 Member tukar poin, alur A: UI (ui-engineer, 19 Nov)

Peran: `~/.agents/team/roles/ui-engineer.md`. Standar UI: `~/.agents/team/ui-standard.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Langkah 0 worktree: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`.

Base: `ghostex/member-qr-token-klien-1150` (3ad22a061, SIAP batch96: QR attach-only member, kontrak body). Cabang kerja: `ws/1165-member-tukar-poin-ui`. Kartu: `legend-0ne0z`.

## Keputusan founder
Q52 (19 Nov): alur A. Kasir memindai QR identitas member; tagihan terbuka atas nama member muncul di aplikasi member; member memilih jumlah poin; aplikasi menampilkan QR `{orderId, points}` yang dipindai kasir. Alur B (kode tagihan) TIDAK dibangun.

## Mockup (gerbang mockup lewat)
`/Users/ifanshori99/Projects/legend super app/legend/design/mockups/member-tukar-poin/` (folder ini belum di-commit, hanya ada di worktree utama; baca dari path absolut ini, salin yang perlu). `README.md` berisi kebutuhan API; PNG 390/1280 untuk 15 keadaan (termasuk 740 -> saldo 500, kedaluwarsa/timer, gagal). Ikuti keadaan alur A saja.

## Tugas (tahap UI, sebelum gerbang UI founder)
1. Kontrak di `packages/shared`: DTO tagihan terbuka member dan quote poin (aditif, sesuai README mockup). Server `pos-points.service.ts:219` sudah menerima tukar poin member_qr hanya untuk QR yang di-mint untuk orderId dan jumlah poin yang sama: kontrak harus cocok.
2. Layar member di `apps/web` (area member): daftar/kartu tagihan terbuka, pemilih poin, QR hasil, semua keadaan mockup alur A. Data lewat `features/<x>/{api,queries,hooks}.ts` dengan mock (MSW atau mock lokal yang sudah dipakai repo) sampai backend ada.
3. Teks UI baru didaftarkan di katalog (`node --test tests/text-contract.test.mjs`).
4. Screenshot 390 dan 1280 tiap keadaan untuk review founder (lewat subagent, `heavy`), simpan di `docs/review/img/member-tukar-poin-*.png`.

Jangan bangun endpoint backend dan jangan tulis test backend: itu sesudah gerbang UI founder (brief terpisah). Jangan sentuh `pos-points.service.ts` selain membaca.

## Bukti selesai
`ui-auditor` bersih, typecheck shared + web lewat `heavy` sekali, prettier + eslint file berubah, test kontrak teks lulus, screenshot lengkap. Commit dan push ke cabang kerja.

## Laporan
SHA, daftar screenshot (path), jumlah subagent dan puncak bersamaan, hasil gate, kebutuhan API final untuk backend (ringkas), yang belum teruji.
