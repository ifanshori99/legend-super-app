# Brief: merge train — batch48f ke milestone/m1

Basis: `origin/milestone/m1` 3c7217b2. Cabang kerja `ws/merge-batch48f` di `.worktrees/merge-batch48f`. Proses sama dengan batch48e (`docs/briefs/439-merge-batch48e.md`): merge --no-ff per cabang, renumber migrasi dengan `scripts/migration-renumber.mjs` mulai idx berikut setelah migrasi terakhir m1 (cabang memakai nomor sementara 0250, 0272-0284; samakan journal, buat snapshot lewat `pnpm db:generate`, hasil akhir `db:generate` kosong), typecheck 3 paket + root (API heap 6144), lint, `pnpm test` penuh + `pnpm test:e2e` sekali lewat `heavy` oleh satu `test-runner`. Ada migrasi + akses -> satu architect xhigh atas migrasi gabungan dan konflik.

## Urutan cabang (sha minimal; cek `git log` bila cabang bertumpuk)
1. ws/lgfru-wa-proof 9b41cc6d (migrasi 0272; webhook WA, tantangan)
2. ws/s5rgo-wa-simulator 52a10a81
3. ws/5opkl-identity-test-isolation c19a1f3f (test)
4. ws/w8dfz1-wa-masked b5956fdb (0274/0275)
5. ws/w8dfz2-wa-retention f032c1cd (termasuk eozze)
6. ws/kmndq-wa-login-confirm f6fc4d01 (UI disetujui founder)
7. ws/lnbtp-wa-confirm-required 6eb85838 (0279; release blocker Codex)
8. ws/16iyk-reconcile-recipient 244ce0e4
9. ws/cx3nb-replay-outbox 3c4cfd17
10. ws/o1i9j-root-tests 0b9ce4f2 (test)
11. ws/ptd-menu-recommendation daeb986f (0282, idx 250 sementara)

Catatan: migrasi 0273 dari 9h2oj TIDAK ikut. Kalau ada cabang di atas yang ternyata berisi commit 9h2oj, berhenti dan lapor.

DITAHAN: ws/9h2oj-wa-reset + ur82k (gerbang UI founder W12), ws/9y6ri + ws/5nt2z (perbaikan Codex legend-x0avw), ws/2qq (legend-husxd), ws/97p + 24318 (brief 456), refund pti5r dan lanjutan (G2i7n).

## Aturan
- "Jangan sampai rugi": konflik di file uang -> berhenti, lapor CTO.
- Konflik non-trivial di logika: kembalikan ke CTO, jangan menebak.
- Test identitas bentrok bila jalan bersama (kartu legend-ongp7, sedang dikerjakan G1zia): catat yang gagal, jalankan per file untuk membuktikan bukan regresi.
- Gagal yang sudah ada di m1 3c7217b2: buktikan dengan run di m1, catat, jangan tahan push.
- Commit + push cabang kerja tiap langkah (kuota bisa habis).

## Bersih-bersih dulu
`git worktree prune`. Cabang lokal yang sudah ada di m1 boleh dihapus. Kartu bd 48e yang sudah di m1 dan berstatus review: `bd close` dengan sha m1.

## Laporan
Tabel cabang + sha, peta renumber migrasi, gerbang (typecheck, lint, test penuh angka, e2e), temuan review, angka subagent. Push m1 fast-forward tanpa force setelah gerbang hijau (atau hanya gagal warisan m1 yang terbukti).
