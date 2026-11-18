# Brief: engineer — fix SO refund ronde 9 (tingkat K uang)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`, lalu ikuti. Langkah pertama: spawn subagent paralel dalam satu giliran.

## Worktree
Cabang `ws/1072-refund-ronde6-q45` (head 306010aba), worktree yang sama dengan 1084. Migrasi bila perlu: 0696-0697. Push tanpa `--force`.

## Masukan
- Temuan: `docs/qa/second-opinion-refund-ronde9-1088.md` (folder utama). Kerjakan ketiganya (2 P1, 1 P2).
- Invarian I1-I10: `docs/briefs/1072-invarian.md` di cabang. Tambah I11+ bila aturan baru.

## Keputusan CTO (sudah diambil, jangan tanya lagi)
- P1-1 hold mismatch kecil menelan kenaikan: hold terbuka dengan identitas sama dinaikkan ke `greatest(lama, baru)` di bawah kunci intent/DP yang sudah dipegang. Tidak pernah turun. Kredit DP memotong nominal yang sudah naik. Selesaikan juga `it.todo` DP + dua urutan kunci di `refund-1077-r2-*`.
- P1-2 alias ID invalid dengan ID penyedia: pisahkan domain dedup bukti invalid dari ID penyedia (mis. kind refund tersendiri `invalid_report`, bukan `provider`), sehingga ID penyedia literal apa pun (termasuk `invalid:...`/`invalid-h:...`) tidak pernah cocok dengan placeholder. Hold lama ber-kind `provider` dengan prefix invalid tetap dikenali untuk dedup laporan invalid yang sama, tetapi tidak boleh menyerap laporan ber-ID penyedia literal. Bila ragu: laporan ber-ID literal yang cocok dengan placeholder lama = hold baru (membatasi).
- P2 identitas fallback tanpa refund ID: pakai identitas tetap dari R (`refund:<R>`) bila event tidak membawa refund ID, tanpa memakai `providerRef` yang muncul kemudian. Hold lama yang sudah tersimpan tetap dedup. Varian retry worker sesudah commit hold sebelum event ditandai: tidak boleh membuka hold kedua.
- Refund otomatis penyedia tetap MATI (Q45). Jangan sentuh flag.

## Pembagian paralel
- test-writer (1): test gagal-dulu tiga temuan (nama `refund-1088-r*`), pakai skenario persis dari laporan (L = "L".repeat(93), H hasil hash).
- implementer: satu per temuan bila file terpisah; berurutan bila file sama.
- test-runner: pemegang token heavy (test terarah, regresi refund sekali di akhir, typecheck API sekali).
- architect (effort xhigh, uang): satu review atas diff akhir. Temuan nyata dibetulkan sebelum lapor.

## Bukti selesai
Test 1088 merah di 306010aba dan hijau di head; regresi refund hijau; typecheck API lulus; `db:generate` kosong (atau migrasi baru tercatat); architect tanpa P0-P2 terbuka.

## Batas kerja ulang
Ikuti `~/.agents/team/brief-template.md` bagian "Batas kerja ulang". Jangan `pkill`. Jangan akhiri giliran untuk "Menunggu" (founder Q10).

## Laporan
Hasil per temuan, invarian baru, bukti, berkas, commit, head SHA, risiko.
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
