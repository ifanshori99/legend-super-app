# Second opinion refund ronde 15 — 1143

Tanggal: 19 November 2026. Hasil pemeriksaan statis: **2 temuan P2**; tidak ditemukan P0/P1 baru pada delta yang diperiksa. Dua penyebab P1 ronde 14 telah ditangani di kode, dengan batas verifikasi di bawah.

## Ruang pemeriksaan

- Sesudah `git fetch origin` berhasil, delta utama: `origin/ws/1126-refund-unmatched-hold..origin/ws/1139-refund-ronde14-fix`, mengecualikan `':!**/meta/*snapshot.json'`.
- Base: `f73faddb9d532729c27da73f022f9a8b4f0a336d`; head: `2c6dc862e01d498b60af573337b473918442e4bd`. Head memuat commit 1135 `aff345126`.
- Dua belas berkas, 2.247 penambahan dan 69 penghapusan; tidak ada migrasi baru pada delta utama. Nomor baris mengacu pada head tersebut.
- Konteks `origin/milestone/m1...origin/ws/1139-refund-ronde14-fix` memberi peringatan beberapa merge base; Git memilih `4418628e0dd002d2fb5af07a6bc15f74390af162`. Konteks itu dipakai hanya untuk penelusuran sekitar, bukan memperluas ruang audit.
- Tiga subagent read-only berjalan paralel: hold/accounting, mapper/reference/isolasi tenant, serta test/gerbang rilis. Parent memeriksa silang kedua temuan. Risiko yang diterima CTO dalam brief 1143 dan 1134 tidak dilaporkan ulang.

## Temuan

### P2-1 — Payment id yang dibuang parser dianggap tidak pernah hadir

`apps/api/src/services/payment-webhook.service.ts:1505` — Fallback reference membedakan hanya nilai payment id yang tersisa, sehingga payload dengan payment id bertentangan dapat menahan intent ketiga; simpan pembeda payment id benar-benar tidak hadir versus hadir tetapi invalid pada facts yang disimpan untuk retry.

**Skenario:** Tiga intent T, V, U berada pada tenant dan integrasi DOIT penanda tangan yang sama; payment id P milik T, Q milik V. Tidak ada refund Legend yang cocok dengan id eksternal X. Integrasi mengirim signed `refund.succeeded` berikut:

```json
{
  "payment_id": "P",
  "refund": {
    "id": "X",
    "payment_id": "Q",
    "reference": "<UUID intent U>",
    "status": "succeeded",
    "amount": 60000
  }
}
```

Parser membuang P dan Q karena konflik (`payment-doit-refund-webhook.ts:168`, `:173`), menyimpan `invalid: ["payment_id"]`, tetapi mempertahankan reference U (`:213`). Normalisasi payload tersimpan juga mempertahankan reference serta marker invalid (`:246`, `:253`). `readProviderInitiatedRefund` menolak facts invalid (`:304`), tetapi jalur unmatched tetap memanggil helper hold (`payment-webhook.service.ts:2746`). Guard fallback baru melihat `facts.paymentId` dan `readPaymentId` sama-sama kosong (`:1505`), lalu memetakan U, meloloskan signature integrasinya, dan membuat hold Rp60.000 pada U.

**Dampak:** U tidak disebut oleh payment id mana pun, tetapi refund dan pemakaian kredit DP U dapat tertahan sampai finance menyelesaikan hold. Tidak ditemukan kebocoran lintas tenant atau pembayaran tambahan dari skenario ini. Ini melanggar pembatasan fallback pada event yang tidak membawa payment id; konflik seharusnya mengikuti jalur unmapped/alert, bukan memilih intent ketiga.

**Usul test:** Tambahkan signed payload tersebut pada test mapper, periksa U tidak berubah pada menit 0 dan pada retry payload tersimpan sesudah 15 menit. Pertahankan test reference-only yang sah. Jangan sekadar menolak semua `invalid: ["payment_id"]`: parser juga memberi marker itu pada reference-only yang sah karena payment id memang tidak tersedia. Canonical facts perlu menyimpan alasan invalid atau penanda kehadiran/konfliknya.

### P2-2 — Gerbang menganggap auto-close CONFLICT sebagai hold legacy yang mengklaim fact

`scripts/preflight/rilis1-legend-26ro5.sql:84` — Binding sah oleh hold lain membuat auto-close CONFLICT baru dilaporkan `fact_shared`; bedakan auto-close CONFLICT yang tidak mengklaim fact dari hold legacy jalur `rowOf`, sambil mempertahankan deteksi binding ganda yang berbahaya.

**Skenario:** T dibayar Rp100.000. Refund R Rp40.000 sempat dikirim tetapi timeout tanpa provider ref; lookup kemudian menjawab `failed`, sehingga R gagal dan menyisakan hold anonim H2 `own_refund_failed_unverified`. Signed success eksternal X Rp40.000/P datang tanpa cocok dengan R yang tidak memiliki provider ref. Menit 0 membuat H1 CONFLICT. Sesudah jendela retry, fact X dicatat; helper baru menutup H1 sebagai `counted_against_intent` tanpa `matched_fact_id` (`payment-webhook.service.ts:1893`).

Finance mengonfirmasi H2 adalah refund X yang sama melalui resolve `counted_against_intent` dengan `identity: "same_as_counted"`. Jalur ini sah (`refund-recon-hold.service.ts:918`, `:730`); `pickUnbound` sengaja tidak menganggap H1 CONFLICT sebagai pemilik fact (`payment-provider-partial-refund.ts:194`). Resolver mengikat H2 ke X (`refund-recon-hold.service.ts:763`, `:966`), tanpa menambah fact atau uang keluar. Total fact tetap Rp40.000.

SQL memasukkan H1 ke kandidat legacy karena resolusinya counted dan binding kosong (`rilis1-legend-26ro5.sql:66`). Binding H2 ke X kemudian membuat `m.shared` benar (`:84`), cakupan H1 menjadi nol (`:108`), dan gerbang mengeluarkan H1 sebagai `fact_shared` (`:155`). Rilis tertahan meskipun rekonsiliasi sah dan uang dibatasi oleh satu fact. Pola API H2 anonim lalu fact penyedia sudah ada di `apps/api/src/test/refund-1055-a-anonymous-and-txn.test.ts:1757`; kontrol `:1801` memastikan `same_as_counted` dapat menutup H2 tanpa fact tambahan. Ini referensi kode test, bukan klaim test dijalankan ulang.

**Usul test:** Lanjutkan pola `refund-1139-c-hold-closed-by-fact.test.ts` dengan H2 Rp40.000 melalui `declineWithoutRef` sebelum mengirim X. Setelah H1 otomatis tertutup, resolve H2 `same_as_counted`; pastikan satu fact Rp40.000, tidak ada jurnal tambahan dari resolve, dan SQL gerbang menghasilkan nol baris. Pertahankan fixture hold legacy non-CONFLICT yang berbagi fact agar tetap memblokir.

## Status dua P1 ronde 14 dan invariant uang

- P1-1: Jalur unmatched sukses kini memanggil hold juga dalam jendela retry (`payment-webhook.service.ts:2738`), sebelum event ditandai failed/retry (`:2762`). Test `refund-1139-a-first-pass-hold.test.ts` mengunci hold awal dan penolakan refund manual. Ini menutup lokasi penyebab lama pada pemeriksaan statis.
- P1-2: Reference flat/nested dipetakan dalam tenant penerima, integrasi penanda tangan diperiksa, dan provider/ref/integrasi diperiksa ulang di bawah intent lock (`payment-webhook.service.ts:1504`, `:1553`, `:1263`). Payment id yang terbaca tetap menang atas reference. P2-1 di atas mencakup varian payment id yang dibuang parser.
- Penutupan oleh fact memeriksa tenant, intent, refund id/kind, payment ref, dan cakupan nominal penuh (`payment-webhook.service.ts:1901`; `refund-hold-coverage.ts:28`). Fact kurang, transaksi lain, atau fact yang terikat hold lain tidak memenuhi predikat penutupan.
- Penutupan ketika retry cocok R berjalan setelah updater berhasil, di bawah intent/deposit lock, hanya untuk payment ref yang sama dan hold tidak melebihi nominal R (`payment-webhook.service.ts:3049`, `:1823`). Interval antara commit fact/R dan penutupan masih ditahan hold; tidak ditemukan celah baru yang membuka pembayaran berlebih pada delta ini.
- Perubahan delapan test lama tidak ditemukan melemahkan assertion uang: 1025-c menambah pemeriksaan fact sekali dan cakupan nominal; 1033-xmtih memindahkan race ke delivery yang sekarang membuat hold; 967-r3d tetap memeriksa refund tidak dihitung dua kali dan menambah hold. Gerbang SQL dan mapper membutuhkan regresi tambahan yang diusulkan di atas.

## Verifikasi dan batas

- Dijalankan: fetch, pencocokan SHA dan ancestry commit 1135, pembacaan diff/sumber/test pada head, serta pemeriksaan silang tiga subagent. Tidak checkout atau membuat worktree.
- Pemeriksaan format memakai binary Prettier 3.9.6 yang terpasang: `node node_modules/.pnpm/prettier@3.9.6/node_modules/prettier/bin/prettier.cjs --check docs/qa/second-opinion-refund-ronde15-1143.md`. Wrapper `pnpm exec prettier` gagal menemukan `node_modules/prettier/bin/prettier.cjs`; tidak ada dependensi atau symlink diubah.
- Tidak dijalankan: test database, reproduksi API kedua temuan, reproduksi dua koneksi, suite regresi, typecheck, atau build. Kesimpulan adalah review statis; tidak menyatakan test lulus atau invariant telah dibuktikan ulang secara runtime.
- Hanya laporan ini ditulis; tidak mengubah kode, dokumen lain, status Beads, commit, push, atau merge. Tidak ada job latar milik pemeriksaan ini yang masih berjalan.
