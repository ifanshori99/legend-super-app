# Brief: merge train — batch48d ke milestone/m1

Basis: `origin/milestone/m1` 68ad0fa3. Cabang kerja `ws/merge-batch48d`. Proses sama dengan batch48c (merge --no-ff per cabang, renumber migrasi dengan `scripts/migration-renumber.mjs` mulai idx berikut setelah 0246, `when` naik 1000000, `db:generate` kosong, typecheck 3 paket, lint, `pnpm test` penuh dan `pnpm test:e2e` sekali lewat `heavy`, architect xhigh atas migrasi + konflik).

## Urutan cabang (sha minimal)
1. ws/tenant-config-followups 997d4a47
2. ws/owner-self-approve be5163bc (migrasi sementara 0270_sole_owner_self_approval)
3. ws/inbox-self-approve 22198b5c
4. snhxw a9d5aa09 (cari cabangnya: `git branch -a --contains a9d5aa09`)
5. outlet followups: wpgfu 1f67882c, gmcmr d9d4919c, 5lsn5 5f7f85bd
6. ws/duitku-406 10c6e338
7. ps-405 9457f79e (cabang ws/ps-405 atau `--contains`)
8. fix/codex-418-pin 98966d1b (menggantikan payslip-pin-ui dan qih2m; JANGAN gabung keduanya terpisah)
9. fix/codex-411-loyalty-consent d6a99fda (migrasi sementara 0242 backfill marketing_opt_in)
10. fix/codex-414-hris-attendance f0cbea6d
11. fix/codex-415-wifi 72e909a2
12. ws/ekxy2-void-line 9cd7cb56 (berisi fix/codex-419-table-merge 9e4155aa; jangan gabung 419 terpisah)

DITAHAN (jangan gabung di 48d): ws/pti5r-promo-refund (kartu legend-fwe4l + second opinion Codex refund belum selesai), semua cabang WhatsApp (lgfru, s5rgo, 9h2oj, w8dfz.*).

## Aturan
- "Jangan sampai rugi": cabang uang (duitku-406, ps-405, pti5r) tidak boleh berubah perilaku saat resolusi konflik; konflik di file uang -> berhenti, lapor CTO.
- Konflik non-trivial di logika: kembalikan ke CTO (pemilik slice), jangan menebak.
- Test gagal di suite penuh yang lulus sendiri: catat; flake identitas (legend-5opkl) dan access sort (kartu P3) sudah dikenal.
- tsc API butuh `NODE_OPTIONS=--max-old-space-size=6144`; `heavy` membatasi jumlah tsc bersamaan.

## Bersih-bersih 48c dulu
Hapus worktree `.worktrees/merge-batch48c`. Cabang lokal 48c yang ditolak `git branch -d`: hapus dengan `-D` HANYA bila `git merge-base --is-ancestor <cabang> origin/milestone/m1` benar; selain itu biarkan dan sebutkan.

## Laporan
Tabel cabang + sha, tabel migrasi (baru/lama/tag/when), hasil gerbang (typecheck, lint, test penuh angka, e2e), temuan architect, flake, angka subagent. Push m1 fast-forward tanpa force setelah gerbang hijau dan architect bersih.
