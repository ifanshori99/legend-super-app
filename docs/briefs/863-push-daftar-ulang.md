# 863 Push web: status dari server dan pendaftaran ulang otomatis (engineer Sonnet)

Cabang fix/push-reregister-863 dari milestone/m1 (d1ad35802, rantai panic sudah masuk). Langkah 0: `git log --all --oneline --grep=legend-xdlxa`.

Kartu legend-xdlxa (bd show). Masalah: pengguna lama (registered_at NULL atau lewat 30 hari) kehilangan push diam-diam; UI tetap "aktif" karena status hanya dari browser (apps/web/src/features/ws05-notifications/push.ts:207-213). panic-push-control.tsx:113-125 mendaftar ulang hanya di layar facility-staff; push-panel.tsx tidak.
Keputusan CTO: status di UI dari server (endpoint daftar perangkat milik sendiri, sudah ada app.list_own_push_devices) dan pendaftaran ulang otomatis di push-panel.tsx (dan titik masuk umum setelah login) bila browser punya subscription tapi server tidak punya baris terdaftar/aktif. Filter registered_at di web-push-provider.ts:50-51 tetap.
Test gagal-dulu: API (langganan lama tidak terhitung aktif) dan web (UI menampilkan "perlu diaktifkan ulang"/daftar ulang otomatis). Teks UI baru daftarkan di katalog.
Review: satu reviewer sonnet (tingkat S) atau architect high bila menyentuh auth. Pra-gate AGENTS.md (typecheck api + web lewat heavy). Commit + push tanpa force. Lapor sha, test, review, angka subagent.
