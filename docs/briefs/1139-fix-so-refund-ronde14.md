# 1139 Fix dua P1 SO refund ronde 14 (tingkat K uang)
Peran: engineer. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore, test-writer, implementer per temuan, berkas terpisah).
Kerjakan SESUDAH 1135 di-commit dan di-push. Cabang `ws/1139-refund-ronde14-fix` dari head 1135, worktree yang sama. Push tanpa `--force`. Tanpa migrasi (bila wajib: berhenti dan lapor dulu).
Laporan SO: `docs/qa/second-opinion-refund-ronde14-1134.md` (di folder utama).

Keputusan CTO (membatasi pembayaran):
1. P1-1 `payment-webhook.service.ts:2332`: sukses refund yang terpetakan ke pembayaran Legend tapi tidak cocok R mana pun membuat hold SAAT PEMROSESAN PERTAMA, tidak menunggu jendela retry 15 menit. Retry pencocokan tetap jalan dengan kunci hold stabil (satu hold per refund id/event, tidak dihitung ganda). Bila retry kemudian cocok R, hold ditutup lewat jalur fact biasa.
2. P1-2 `payment-webhook.service.ts:1463`: mapper juga memakai `reference` (intent) bila payment id tidak ada: cari intent dalam tenant penerima, integrasi penanda tangan harus sama, periksa ulang di bawah kunci intent. Reference yang bertentangan dengan payment id: payment id menang, buat alert. Bentuk `object: "refund"` flat dan nested `refund.reference`, termasuk payload tersimpan untuk retry.

Bukti: test gagal-dulu (merah di head 1135) sesuai usul test di laporan SO: menit 0 dan 14, saklar mati/hidup, sesudah menit 15; refund manual Rp100.000 sesudah refund dashboard Rp60.000 ditolak, total keluar tidak melebihi Rp100.000; reference tenant lain/integrasi lain/bertentangan tidak menyentuh intent lain. Regresi terarah refund/hold/DOIT lewat `heavy`. Typecheck API sekali lewat `heavy`. Prettier/eslint. `architect` xhigh sekali.
Laporan: head SHA, temuan tertutup, risiko. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali, gabung dengan laporan 1135.
