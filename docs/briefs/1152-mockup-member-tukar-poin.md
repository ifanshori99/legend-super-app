# 1152 Mockup member tukar poin di kasir (legend-0ne0z)
Peran: designer (baca ~/.agents/team/roles/designer.md), ikuti `~/.agents/team/ui-standard.md` dan gaya mockup member yang ada di `design/mockups/` (cari layar member/poin). Codex. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Kerja di folder utama, hanya `design/mockups/member-tukar-poin/`. Jangan sentuh kode aplikasi. Jangan commit (CTO commit).

Konteks: kasir mewajibkan QR member yang di-mint untuk order dan jumlah poin yang sama (`apps/api/src/services/pos-points.service.ts:219`, 120 detik, sekali pakai). Klien member di `apps/web/src/features/ws08-member/` (points-page, redeem-dialog) belum punya `orderId`. Thread 1150 membangun QR attach-only (dialog di layar poin).
Tugas: mockup alur member tukar poin untuk tagihan yang sedang dibuka di outlet. Usulan CTO: sesudah QR member dipindai, layar poin menampilkan kartu "Tagihan aktif" (outlet, total, sisa poin), member memilih jumlah poin (batas: saldo, total tagihan, aturan program), lalu QR khusus order itu dengan hitung mundur 120 detik. Sertakan keadaan: tidak ada tagihan aktif, poin kurang, QR kedaluwarsa, gagal/offline, sudah dipakai. Alternatif kedua dalam satu layar perbandingan: kasir menampilkan kode tagihan pendek yang diketik member.
Hasil: HTML + PNG 390 dan 1280 per keadaan, README singkat (rekomendasi satu arah + alasan, kebutuhan API: mis. endpoint member melihat order terbuka atas namanya). Render PNG lewat `heavy`.
Laporan: daftar berkas, rekomendasi, kebutuhan API. Lapor sekali.
