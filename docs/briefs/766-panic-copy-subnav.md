# 766 Alert panik: teks respons + subnav HP 2x2 (keputusan founder Q31, Q32)
Peran: ui-engineer (Sonnet, tugas kecil). Base: ui/panic-alert-wiring (e57b5fa3d). Cabang: ui/panic-copy-subnav. Tanpa migrasi, tanpa API.
Keputusan founder 14 Nov:
- Q31: saat rekan sudah merespons alert, teks menjadi "{nama} sudah menuju lokasi" (ganti "Sudah ditangani {nama}"). Perbarui katalog teks (node --test tests/text-contract.test.mjs) dan test/e2e yang mencocokkan teks lama.
- Q32: menu tab fasilitas di layar HP (<640 px) jadi grid 2 baris x 2 kolom supaya tab "Darurat" tidak terpotong; desktop tetap satu baris. Target sentuh >= 44 px, urutan fokus tetap.
Ikuti ~/.agents/team/ui-standard.md. Bukti: e2e panic (heavy, sekali di akhir), screenshot 390 dan 1280 ke docs/screenshots/panic-alert/. Pra-gate AGENTS.md (prettier, eslint, text-contract, typecheck web).
Baca ~/.agents/team/roles/ui-engineer.md dan "Paralel dulu" di ~/.agents/team/TEAM.md. Commit, push cabang tanpa force, jangan merge. Lapor angka subagent.
