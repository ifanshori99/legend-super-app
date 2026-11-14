# 787 Foto dan tanda tangan sungguhan di fasilitas (legend-wf37, legend-xxx6; cek legend-0una)
Peran: ui-engineer (baca ~/.agents/team/roles/ui-engineer.md). Ikuti ~/.agents/team/ui-standard.md dan DESIGN.md. Gerbang UI: screenshot untuk review founder.
Basis: worktree dari origin/ws/media-screens-upload (di atas ws/media-web-storage-client; belum di m1, merge train mengurutkan). Tanpa migrasi kecuali perlu (nomor 0373; lapor dulu).
Langkah 0 (Explore paralel): klien storage media dan transport upload di kedua cabang media + docs/media-transport-design; apakah legend-0una (transport receiving/petty cash) sudah selesai di cabang itu (bila ya: catat untuk CTO, jangan kerjakan ulang); layar fasilitas: cleaning, breakdown ticket, checklist (bukti foto/tanda tangan) yang masih memakai placeholder.
Isi: sambungkan upload sungguhan ke ketiga layar fasilitas memakai klien yang sama dengan layar stok. Progres, gagal-coba-lagi, batas ukuran/jenis dari API; foto dokumen karyawan/bukti TIDAK dikirim ke pihak ketiga (founder Q30: scan di server sendiri).
Paralel: Explore, test-writer (unit + e2e mock gagal-dulu), satu implementer per layar, ui-auditor.
Bukti: test gagal-dulu, e2e mock, text-contract, screenshot 390 + 1280 (heavy --browser sekali), typecheck web sekali lewat heavy, prettier/eslint.
Commit+push ke cabang kerja, jangan merge. Lapor dengan path screenshot dan angka subagent.
