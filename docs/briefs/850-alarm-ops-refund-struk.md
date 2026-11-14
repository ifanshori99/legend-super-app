# 850 Alarm ops: refund fasilitas macet dan struk terlambat (engineer Sonnet, tingkat K)

Kartu: legend-weuo2 (antrean refund system:facility yang gagal/kedaluwarsa, misalnya sarapan dan QR, tidak diajukan ulang otomatis; butuh daftar tindak lanjut + alarm), legend-refx7 (struk terlambat untuk nomor yang sudah di-write-off: mergeDeviceReceiptRun di pos-receipt.service.ts ~1415 menyimpan tanpa melihat write-off; tambah audit/alarm dan kunci baris sequence agar tidak berpacu dengan write-off).

- Langkah 0: `git log --all --oneline --grep=<id>`; bila sudah dikerjakan, berhenti dan lapor cabangnya.
- weuo2: backend saja. Pengajuan ulang otomatis harus idempoten (tidak pernah refund dua kali; test bukti tidak ada pihak dibayar lebih). Batas percobaan, lalu masuk daftar tindak lanjut (API list untuk ops) + alarm lewat adapter notifikasi yang ada. Layar baru TIDAK dibuat (butuh mockup dulu); lapor usulan layarnya.
- refx7: audit + alarm saat struk tiba untuk nomor write-off; kunci baris sequence (FOR UPDATE) di jalur merge dan write-off dengan urutan kunci yang sama, test balapan.
- Paralel: Explore per kartu, test-writer gagal-dulu, satu implementer per kartu.
- Jangan sentuh EDC, cash-out (ws/cash-out-approval), payroll, edge link.
- Migrasi: bila perlu 0390.
- Review: satu subagent architect effort xhigh (uang dan nomor dokumen).
- Pra-gate AGENTS.md. Commit + push tanpa force. Lapor dengan angka subagent.
