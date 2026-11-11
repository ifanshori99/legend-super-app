# Brief: engineer — perbaikan temuan second-opinion HPP (legend-husxd, termasuk legend-i8ou8)

Lanjut di cabang `ws/2qq-hpp-recompute` (80321fdc), worktree baru `.worktrees/2qq`. Kartu: `legend-husxd` + `legend-i8ou8`. Keputusan CTO: semua temuan nyata, betulkan. Aturan "jangan sampai rugi": biaya tidak diketahui = null/pending, tidak pernah 0; margin tidak boleh tampak lebih baik dari kenyataan.

## Temuan (Codex G1i5i)
1. P1 `hpp-recompute.service.ts:815`: dua worker commit terbalik, hasil lama menimpa baru. Serialisasi per outlet (advisory lock) atau versi yang menolak hasil lebih lama.
2. P1 `:143,249`: antrean menu A sebelum tick pertama membuat first fill melewati outlet; B, C tidak pernah di-backfill. Penanda backfill eksplisit + rebuild penuh atomik per outlet.
3. P1 `:249` + `menu.service.ts:1310`: ganti link resep menu, katalog, harga, pengaturan terkait tidak memicu recompute. Invalidasi di semua jalur itu.
4. P1 `hpp-report.service.ts:465`: order selesai dengan pengurangan stok pending -> biaya aktual Rp0. Pisahkan pending/unknown dari nol; rekonsiliasi hanya ledger yang cocok.
5. P1 `:199` + legend-i8ou8: recompute gagal lalu re-enqueue gagal (error ditelan) atau worker mati -> kerja hilang. Claim ber-lease + ack atomik.
6. P2 `hpp-report.service.ts:323`: penyebut coverage semua brand; hitung outlet per brand menu dan sesuai cakupan akses.
7. P2 `hpp-math.ts:47`: surplus yang dibatasi tidak selaras dengan komponen varians; buat dua invariant (aktual >= 0, varians = jumlah komponen) konsisten, sebut aturannya di laporan.

## Kerja
Test gagal-dulu per temuan (test-writer), implementer maks 3 file terpisah, architect high setelahnya. `pnpm --filter @starter/api lint` hijau. Typecheck API heap 6144. Commit + push tiap langkah (kuota bisa habis).

## Laporan
sha, bukti per temuan, angka subagent (total, puncak, pemegang heavy).
