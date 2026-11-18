# 1135 Refund lanjutan: gerbang hold lama, kredit DP saat hold, jurnal refund penyedia penuh (tingkat K uang)
Peran: engineer. Cabang baru `ws/1135-refund-lanjutan` dari `ws/1126-refund-unmatched-hold` (f73faddb9), worktree yang sama `legend-2ad4d9ab`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore per kartu, test-writer, implementer per kartu, berkas terpisah). Push tanpa `--force`. Migrasi: hindari; bila wajib, berhenti dan lapor dulu (nomor diberikan CTO).

Keputusan CTO atas laporan 1126:
- Saklar mati: refund penyedia bertanda tangan yang cocok penuh (refund id, nominal, payment id terbaca, lewat jendela retry) TETAP dicatat sebagai fact (jalur 30hfs, tes 1072-b). Itu mencatat uang yang memang sudah keluar di penyedia dan membatasi refund berikutnya. Semua yang tidak cocok penuh: hold. Tulis keputusan ini sebagai komentar singkat di titik saklar.
- Hold palsu dari echo refund kita sendiri dan dua hold dari laporan ganda tanpa refund id: diterima untuk rilis 1 (membatasi). Buat bead P2 dan P3, jangan dikerjakan sekarang.

Kartu:
1. Gerbang rilis (bead baru, P1): hold yang ditutup lewat jalur rowOf sebelum 1126 dengan `matched_fact_id` NULL bisa dihitung ganda. Tambah SQL baca-saja di `scripts/preflight/` (pola `1118-shared-cash-mapping.sql`) yang mendaftar baris itu; baris = blokir. Test positif/negatif. Catat di `docs/deployment.md`. Daftarkan ke runner release-gates bila runner (`apps/api/src/db/release-gates.ts`, ws/1100) sudah ada di base; bila belum, tulis di deployment.md untuk didaftarkan saat landing.
2. `legend-obgj5` (P1): kredit DP dipakai saat refund sumber masih dikarantina hold (`reservation-deposit-remainder.ts:564`). Kredit DP harus menunggu hold sumber tertutup (membatasi). Cek dulu apakah sudah tertutup oleh cabang 1033 (`origin/ghostex/1033-kredit-dp-pool-net-bersama`) atau m1; bila sudah, buktikan dengan test dan tutup bead.
3. `legend-gjt5q` (P1): refund penyedia PENUH (`markProviderRefunded`, `payment-webhook.service.ts:898-912`, `payment.service.ts:3355-3376,3412`) tidak menulis `payment_provider_refunds` dan tidak dijurnal. Tulis fact dan event `payment.provider_refunded` untuk jalur penuh, termasuk sisa setelah refund parsial. Tidak ada uang keluar baru. Lihat juga `origin/ghostex/1025-refund-provider-celah-uang` 55e8599d6.
4. `system-refund-followup` (weuo2-F, 7 notifikasi, diharapkan 6) gagal di ccd688e11: cek apakah juga gagal di `origin/milestone/m1`. Bila hanya di cabang refund, perbaiki di sini. Bila juga di m1, buat bead dan lewati.

Bukti: test gagal-dulu per kartu (merah di f73faddb9). Regresi terarah refund/hold/DOIT/DP lewat `heavy`. Typecheck API sekali lewat `heavy` (heap 8 GB). Prettier/eslint. `db:generate` kosong. Architect xhigh sekali per putaran.
Laporan: commit, head SHA, kartu selesai/dilewati, risiko. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.
