# 785 Layar input faktur pemasok (legend-0xnm)
Peran: ui-engineer (baca ~/.agents/team/roles/ui-engineer.md). Ikuti ~/.agents/team/ui-standard.md dan DESIGN.md. Gerbang UI: hasilkan screenshot untuk review founder (CTO yang menampilkan).
Basis: worktree dari origin/milestone/m1. Tanpa migrasi; tanpa ubah hitungan pajak di API.
Langkah 0 (Explore paralel): createSupplierInvoice hook+mock, API faktur pemasok (PO lines, PPN, PPh23, 3-way match), layar goods receipt dan 3-way match yang sudah ada (legend-xkk), PRD 3.18 / Alur I. Bila layar faktur sudah ada di m1 atau cabang lain: lapor dan berhenti.
Isi: form faktur dari baris PO/penerimaan, PPN dan PPh23 ditampilkan dari hasil API (web tidak menghitung sendiri angka yang dibukukan), pratinjau 3-way match (PO vs terima vs faktur) dengan selisih jelas, validasi zod bersama. Uang: angka tampil = angka API; tidak ada tombol yang membukukan dua kali (idempotency key dari API bila ada).
Paralel: Explore, test-writer (unit + e2e mock gagal-dulu), implementer form, implementer pratinjau match, ui-auditor.
Bukti: test gagal-dulu, e2e mock, text-contract, screenshot 390 + 1280 (heavy --browser sekali setelah server dev siap), typecheck web sekali lewat heavy, prettier/eslint.
Commit+push ke cabang kerja, jangan merge. Lapor dengan path screenshot dan angka subagent.
