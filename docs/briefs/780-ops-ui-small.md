# 780 UI operasional kecil (legend-v4ht, legend-3wyd, legend-7tuml)
Peran: ui-engineer (baca ~/.agents/team/roles/ui-engineer.md), tugas kecil. Ikuti ~/.agents/team/ui-standard.md dan DESIGN.md.
Basis: worktree dari origin/milestone/m1. Tidak ada migrasi.
Kartu (berkas terpisah, satu implementer per kartu, paralel):
1. legend-v4ht: components/ui/segmented-control.tsx opsi boleh punya count/badge (chip angka tabular), semantik radio-group tetap. Pakai di tab stasiun KDS ganti teks 'Kopi (1)'.
2. legend-3wyd: OperationsShell terima judul layar + slot aksi dari route (AreaFrame); halaman kitchen tidak lagi menduplikasi judul.
3. legend-7tuml: staff-chrome.tsx tab 44px juga di tablet portrait sentuh (>=640px); hapus baris basi di docs/briefs/sub-panic-alert-wiring.md.
Jangan sentuh berkas edge sync/API (thread lain sedang di ws/edge-kds-stations).
Bukti: test unit komponen gagal-dulu, e2e mock yang tersentuh, ui-auditor subagent, satu screenshot 390 + 1280 per layar berubah (heavy --browser, satu kali, setelah server dev siap). Typecheck web sekali lewat heavy. prettier/eslint, text-contract bila ada teks baru.
Commit+push ke cabang kerja, jangan merge. Lapor dengan angka subagent.
