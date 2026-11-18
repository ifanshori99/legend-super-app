# Brief: engineer — fix review 1098 + DOIT recurring mati di rilis 1 (tingkat K uang)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`, lalu ikuti. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Worktree
Cabang `ws/1098-gerbang-doit-duitku` (head 12c381480). Tanpa migrasi (bila perlu flag DB, lapor dulu). Push tanpa `--force`.

## Keputusan CTO (sudah diambil, jangan tanya lagi)
1. `scripts/preflight/rilis1-legend-47rgt.sql:10`: hitung promo AI ganda dengan `status IN ('active','paused','draft')`, bukan hanya `active` (draft sisa retry bisa di-resume = diskon dobel). Sesuaikan test "clears after extra promotions are deactivated".
2. DOIT recurring MATI di rilis 1: adapter `payment-doit-recurring-wire.ts` memanggil `/v1/recurring/*`, padahal dok resmi DOIT `/v1/billing/{plans,subscriptions}` (semua panggilan 404). Pasang flag env (default mati, validasi di `apps/api/src/config/env.ts`) yang tidak me-mount / menolak `/payments/recurring` (`apps/api/src/routes/index.ts:263`) dengan 503 kode jelas; UI yang memanggilnya menampilkan "belum tersedia" bila ada. Test: flag mati = tidak ada panggilan ke DOIT, tidak ada baris baru.
3. Probe DOIT: ganti hasil `recurring-unavailable-in-sandbox` (`payment-doit-recurring-sandbox.test.ts:226`) jadi `adapter-path-mismatch` dan jangan dihitung lulus.
4. Probe Duitku (`payment-duitku-sandbox.test.ts:19`): tambah opt-in kedua `DUITKU_SANDBOX_PROBE=1`; berkas bukti ditulis `mode: 0o600`.
5. Rancang ulang wire DOIT ke `/v1/billing/*` BUKAN di brief ini (kartu architect terpisah sesudah rilis 1).

## Pembagian paralel
- implementer: (1)+(3)+(4) test/SQL; implementer lain: (2) flag + route + test.
- test-runner: pemegang token heavy (test terarah sekali, typecheck API sekali).
- reviewer sonnet: satu review diff akhir.

## Bukti selesai
Test baru merah di 12c381480 dan hijau di head; typecheck API lulus; prettier/eslint berkas berubah; `node --test tests/text-contract.test.mjs` bila ada teks UI baru.

## Laporan
Hasil per butir, berkas, commit, head SHA, risiko. Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
Jangan akhiri giliran untuk "Menunggu" (founder Q10).
