# 1027 Akses: sesi yang pernah bertanda perangkat bersama tetap tertutup di guard HTTP (legend-t7xto)

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat K (akses): review satu subagent architect effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore guard HTTP + penanda, test-writer, implementer).

Base: `ghostex/1026-kelola-perangkat-acting-staff` (432f2e6c2, ujung rantai akses 1006-1026). Cabangmu antre SESUDAH 1026.
Masalah: `closeSessionsOfSharedDevice` best-effort; bila gagal, tanda lapse dan cookie tablet kembali jadi owner lewat HTTP. 1024 sudah fail-closed di websocket KDS dan removePush; `middleware/auth.ts:41` dan `shared-device-auth.ts:85` belum.
Kerja: guard HTTP memperlakukan sesi yang pernah bertanda perangkat bersama sebagai perangkat bersama selamanya (pola 1024), tanpa bergantung pada penutupan sesi. Penanda lapse karena batas waktu tidak membuka akses owner. Perangkat pribadi yang tidak pernah bertanda tidak terdampak.
Test wajib: simulasikan penutupan sesi gagal (stub) lalu tanda lapse -> request backoffice tetap 403 dan route POS tetap minta PIN; sesi pribadi tetap 200; keep-alive tetap jalan; kontrak 1012 hijau. Gagal-dulu di base. Tambahkan asersi nol audit `device.revoked` pada dua test cabut yang ditolak di `device-shared-mode.test.ts` (saran architect 1026).
Tanpa migrasi kecuali perlu (nomor kerja 0644). Bukti: berkas `device-*`, `shared-device-*`, `kds-realtime*`, `acting-staff-*`, `auth-shared-device-guard`, `push-removal-*` hijau; prettier/eslint; typecheck API lewat heavy. Commit, push tanpa force, hapus worktree subagent milikmu.
Laporan sekali di akhir (Monitor, bukan sleep loop; jangan akhiri giliran untuk kabar antara): perilaku, test, temuan architect, SHA, angka subagent.
