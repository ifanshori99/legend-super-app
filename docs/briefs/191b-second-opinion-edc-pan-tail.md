# Brief 191b: second-opinion — sisa PAN di ujung pesan EDC 200 karakter (legend-lg45)

## Peran
Second opinion Codex, tingkat K (data kartu, skrip yang mengubah data). Baca `~/.agents/team/roles/second-opinion.md`. Read-only; laporkan temuan dengan file:line, string masukan konkret, dan skenario gagal.

## Rentang diff
Repo `/Users/ifanshori99/Projects/legend super app/legend`, cabang `ws/edc-pan-tail` (worktree `.worktrees/edc-pan-tail`), basis `milestone/m1` f5438770.
`git diff f5438770..ws/edc-pan-tail` (lihat `git log f5438770..ws/edc-pan-tail` untuk commit perbaikan review bila ada).

## Berkas berisiko
- `apps/api/drizzle/0143_edc_pan_scrub_separators.sql` — diubah di tempat (0143 hanya ada di `milestone/m1`, belum di `main`): klausa `message` (CASE dan WHERE) kini juga menjalankan aturan ujung, dengan syarat 200 dihitung pada pesan ASLI sebelum rantai 0143 (rantai 0143 bisa memendekkan pesan, mis. PAN berpemisah ganda di awal menjadi `[disamarkan]`).
- `apps/api/scripts/edc-pan-scrub-tail.sql` — skrip cadangan di luar migrator, hanya untuk DB yang sudah menjalankan 0143 lama: satu blok `DO` (lock_timeout 5s, NO FORCE RLS, UPDATE `message`, FORCE RLS), `psql -1 -v ON_ERROR_STOP=1 -f …`. Celah yang diketahui: baris yang sudah dipendekkan 0143 lama tidak bisa dikenali lagi.
- `packages/shared/src/edc/index.ts` — `maskStoredMessage` (hanya jalur baca `edcTransactionSchema.message`): rantai lama + `tailAfterMask` dan `tailCardRun` bila panjang UTF-16 masukan tepat 200, lalu potong 200 code point. Jalur tulis `safeMessage` tetap `maskCardNumbers` (rantai saja) seperti sebelumnya.
- `docs/runbooks/edc-pan-scrub.md` — bagian 6 (deteksi, urutan rilis, verifikasi).
- Test: `apps/api/src/test/edc-pan-patterns.test.ts`, `apps/api/src/test/edc-pan-scrub-migration.test.ts`, `apps/api/src/test/edc-pan-scrub-tail.test.ts`.

## Konteks
- Jalur tulis lama (sebelum legend-tjwb) memasking dengan `[0-9]([ -]?[0-9]){11,}` (satu spasi atau satu strip) lalu `.slice(0, 200)` (unit UTF-16). Kolom `message` varchar(200).
- Rantai 0143 memasking run 12+ digit berpemisah `[ \t-]*` dan melipat sisa 0135 (7+ digit sebelum / 5+ sesudah `[disamarkan]` lewat pemisah yang tidak bisa dilewati pola lama). Rantai itu tidak berubah; aturan ujung ditambahkan sesudahnya. Jalur tulis lama memakai pola 0135 persis sebelum memotong, jadi 0135 tidak pernah memendekkan baris lama.
- Aturan struk: maksimal 6 digit awal dan 4 digit akhir boleh tampil.

## Invariant
1. Pesan dengan panjang asli selain 200: hasil sama persis dengan sebelum perubahan (0143, skrip, JS baca). Jalur tulis tidak berubah sama sekali.
2. Pesan tepat 200: tidak ada sisa PAN di ujung dari pola (a) run berpemisah ganda/tab di bawah 12 digit (7+ digit), (b) 7+ digit + pemisah lebar + potongan awal `[disamarkan]`, (c) `[disamarkan]` + pemisah lebar + digit berapa pun.
3. Tidak ada positif palsu pada nominal rupiah (`Rp 1.500.000`, `Rp 50.000  …`), ID transaksi (`TRX 12345678`, `P261109-1234`), tanggal/jam di ujung pesan.
4. 0143, skrip, query deteksi runbook, dan JS baca memberi hasil sama (0143 pada pesan asli = JS baca pada pesan asli) (termasuk pesan berisi karakter di luar BMP: syarat 200 dihitung UTF-16, potong 200 code point).
5. Idempoten: run kedua 0143 dan skrip mengubah 0 baris; `maskCardNumbers` dua kali tidak mengubah apa pun. Hasil ≤ 200 karakter.
6. FORCE RLS tidak pernah tertinggal mati; policy tidak diubah; baris yang tidak berubah tidak di-UPDATE.

## Efek yang diterima (sudah dicatat runbook)
- `… [disamarkan] - 51` tepat di ujung pesan 200 karakter: kode respons ikut terhapus.
- Potongan sebelum pemisah lebar pertama (`…4111 1111`, `…41111111`) tidak bisa dibedakan dari angka biasa dan tetap tersisa.

## Yang diminta
Cari bug nyata terhadap invariant di atas: beda semantik regex PostgreSQL ARE vs JS (lookbehind `(?<!…)`, lookahead, lazy `*?` di dalam lookahead, `$`, `\u` escape dalam bracket), titik potong lain yang masih membocorkan digit di luar 6 awal/4 akhir, interaksi dengan rantai 0143, pesan dengan banyak mask, risiko skrip di luar migrator (edge node, urutan rilis, DB yang belum menjalankan 0143), dan test yang lulus padahal invariant dilanggar. Tulis hasil ke `docs/briefs/191b-second-opinion-edc-pan-tail.result.md`.
