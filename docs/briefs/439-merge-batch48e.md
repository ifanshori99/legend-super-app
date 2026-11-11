# Brief: merge train — batch48e ke milestone/m1

Basis: `origin/milestone/m1` a5d58300. Cabang kerja `ws/merge-batch48e` di `.worktrees/merge-batch48e`. Proses sama dengan batch48d (`docs/briefs/432-merge-batch48d.md`): merge --no-ff per cabang, renumber migrasi dengan `scripts/migration-renumber.mjs` mulai idx berikut setelah 0249 bila ada migrasi, `db:generate` kosong, typecheck 3 paket + root (API: `NODE_OPTIONS=--max-old-space-size=6144`), lint, `pnpm test` penuh dan `pnpm test:e2e` sekali lewat `heavy` oleh satu `test-runner`, reviewer sonnet atas konflik (architect xhigh hanya bila ada migrasi atau konflik di file uang/akses).

## Urutan cabang (sha minimal)
1. ws/flake-suite-isolation 399e99b0 (test saja)
2. ws/dfvpq-access-order 9cef4e2c
3. ws/36t01-created-at-tiebreak 8a397e10 (37 file test)
4. ws/hbaml-pin-timestamps d59343c5
5. ws/5cwrq-config-codec-kind f20863d7
6. ws/pos-discount-cap-5000 ae213bc2 (berisi 5cwrq; uang: perilaku tidak boleh berubah saat resolusi konflik)

DITAHAN: ws/pti5r-promo-refund dan lanjutan refund (G2i7n masih kerja), semua cabang WhatsApp (menunggu review UI founder), ws/16iyk, ws/9y6ri.

## Aturan
- "Jangan sampai rugi": konflik di file uang -> berhenti, lapor CTO.
- Konflik non-trivial di logika: kembalikan ke CTO, jangan menebak.
- Flake yang lulus sendiri: catat. Setelah 48e, flake menu-print/tax/access seharusnya hilang — laporkan bila masih ada.

## Bersih-bersih dulu
`git worktree prune`. Cabang lokal 48d yang sudah ada di `origin/milestone/m1` (`git merge-base --is-ancestor`) boleh `git branch -d`/`-D`; selain itu biarkan. Kartu bd 48d yang cabangnya sudah di m1 dan berstatus review: `bd close` dengan komentar sha m1.

## Laporan
Tabel cabang + sha, migrasi (bila ada), gerbang (typecheck, lint, test penuh angka, e2e), temuan review, flake, angka subagent. Push m1 fast-forward tanpa force setelah gerbang hijau.
