# Brief: second-opinion (Codex) — atribusi intent POS per tender (legend-9z1vm, 45bs9, 8v2yl)

Tingkat K (uang). Read-only. Jangan edit, commit, push.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/intent-attribution-tender`, cabang `ws/intent-attribution-tender` (dari `milestone/m1` 12c91f6b). Diff: `git diff milestone/m1...HEAD`.

## Yang berubah
`apps/api/src/services/pos-intent-attribution.ts`:
- `netPosTendersOfIntentSql`: baris refund POS dengan `tenderId` (ditulis `refundLinesByTender`, `pos-order-corrections.ts`) mengembalikan jumlahnya ke intent hanya bila tender itu tender intent tersebut pada pesanan dan metode yang sama DAN `paymentIntentId` baris = intent (CTE `allocated`). Baris lama tanpa `tenderId` tetap aturan per metode (CTE `returned`). Jumlah keduanya dibatasi `on_intent`. Baris id yang tidak cocok: tidak mengembalikan apa-apa (fail closed).
- `posRefundsOfIntentSql`: baris dengan `tenderId` hanya menghitung refund untuk intent bila menyebut tender intent itu dan intent itu.
Pemanggil: `payment-admin.service.ts` (`posSaleInUseOfIntent`, mode held) dan `accounting-auto-journal-guards.ts` (`intentBackedAt`, mode ledger).

## Periksa
1. Ada jalan intent dibebaskan (refund atau payout) untuk uang yang tidak benar-benar dikembalikan? Campuran baris lama + baris tender, mode held (tender authorized pada payment link), tender dibind ulang ke intent lain, refund yang journal-nya belum posted.
2. Konsistensi dua builder SQL (refund dihitung di satu, tidak di yang lain).
3. Perbandingan uuid sebagai teks (`->>'paymentIntentId' = $1::uuid::text`, `tenderId = t.id::text`).
4. Perilaku baris lama tidak berubah.

## Test
`apps/api/src/test/payment-refund-pos-tender-guard.test.ts` (describe legend-9z1vm), `apps/api/src/test/accounting-auto-journal.test.ts` (AJ-9Z1VM-01..04).

## Laporan
Temuan nyata dengan file:baris dan skenario angka. Tanpa gaya.
