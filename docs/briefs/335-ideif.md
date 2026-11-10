# legend-ideif: edge tidak boleh memegang root STAFF_PIN_PEPPER

Peran: engineer (baca berkas peran dan "Paralel dulu" di TEAM.md). Tingkat K (keamanan, PIN staf): satu subagent architect xhigh review.
Basis: `git worktree add .worktrees/ideif -b ws/ideif-edge-pepper milestone/m1` (d07b6cf8). Jangan checkout folder utama. Jangan push.

## Masalah
`bd show legend-ideif`. Edge memegang root pepper yang menurunkan pepper tiap tenant (header `services/staff-pin-sync.ts`; pemakaian di `config/env.ts`, `edge/access-applier.ts`, `edge/staff-pin-resend.ts`, `routes/staff-pin-sync.routes.ts`). Edge dicuri = PIN semua tenant melemah. Konteks desain: `docs/design/hris-edge-replication.md` §7 dan §12 di cabang `ws/hris-edge-design`.

## Kerja (test gagal-dulu)
1. Edge hanya menerima pepper turunan untuk tenant-nya (dikirim cloud saat provisioning/sinkron, versi pepper ikut), tidak pernah root. Env edge tanpa root pepper tetap bisa verifikasi PIN tenant-nya; tidak bisa menurunkan pepper tenant lain.
2. Rotasi: versi pepper bisa naik; hash PIN lama tetap terverifikasi sampai di-rehash; edge menerima versi baru lewat jalur sinkron yang ada.
3. Startup edge menolak jalan bila root pepper ada di env edge (fail closed, pesan jelas). Cloud tetap memegang root.
4. Pepper turunan disimpan di edge seaman rahasia edge lain yang sudah ada (ikuti pola yang ada, jangan karang penyimpanan baru tanpa alasan). Jangan log nilainya.
5. Catatan rilis/runbook: langkah rotasi dan hapus root pepper dari env edge yang sudah terpasang.
6. Typecheck dan test lewat `heavy`. Typecheck gagal lebih dari 2 kali berturut: berhenti dan lapor. Architect xhigh review, temuan nyata dibetulkan.
7. Commit lokal, `bd comment legend-ideif`, update `docs/PROGRESS.md`.

Migrasi hanya bila perlu: nomor sementara 0225, `when` 1794304000000, jalan sebagai migrator non-superuser. Nama key env baru: tulis di `.env.example`, jangan baca `.env`. Jangan ekspansi array zsh `${(@f)...}`. Jangan pkill proses lain. Stempel waktu pakai `date`.

## Laporan
Sekali di akhir: SHA, test gagal-dulu, temuan architect, langkah deploy.
