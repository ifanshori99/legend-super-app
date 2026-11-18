# Brief: engineer — akses perangkat bersama, sisa (3 kartu, tingkat K akses+uang)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Langkah pertama: spawn subagent paralel dalam satu giliran.

## Worktree
Worktree Ghostex milikmu, base `ghostex/pin-kasir-tablet-bersama` a20420a6f (SIAP batch91, memuat rantai 1006-1027 + 1054, belum di m1). Cabang ini mendarat SESUDAH pin-kasir. Jangan merge m1 atau `ghostex/8b2dc0b1` (1043): train menyelesaikan konflik itu di batch91. Langkah 0: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Migrasi diharapkan tidak ada; bila perlu, rentang 0704-0705 dengan `--full`. Cabang: `ws/1094-akses-perangkat-bersama-sisa`.

## Kartu
Di awal: `ghostex board associate <id>` + `bd update <id> --status in_progress`. Saat lapor: `--status review` + `bd comment`. Baca `bd show` tiap kartu (termasuk komentar) untuk AC.
1. `legend-13vhb` sisa route uang: `apology-voucher.routes.ts` dan `delivery-orders.routes.ts` belum memakai `resolveActingStaff` + `requireActingStaffOnSharedDevice` dan memakai `getAuth(req).user.id`. Pasang guard dan `actorOf`, dengan pola yang sama seperti `open-bill.routes.ts`. Tambah test uang yang belum ada di tablet bersama: comp, collect-at-pos, waive, voucher maaf. Tanpa PIN kasir: 401/403. Dengan PIN: aktor = kasir.
2. `legend-tlr6p` aktor = kasir ber-PIN, bukan pemilik sesi. Sisa pemakai `getAuth(req).user.id`: `service-request.routes.ts` (acknowledge/resolve/delete), `order-issues.routes.ts`, `expo.routes.ts` (helper actor baris ~47), dan `menu.routes.ts` (handler availability status). Ganti ke `actorOf(req)` untuk aktor, izin, dan audit. `getAuth` tetap dipakai untuk MFA/support/"self". Wajib ada test: kasir outlet A tidak bisa collect charge outlet B.
3. `legend-ypwsp` audit sisa. "Stempel pertama" sudah ditutup 5pipx/7yvmm/vzvok (1027). "Satu kolom" sudah ditutup 0459 `shared_device_ids`. Yang tersisa: lintas tenant. Sesi yang ditandai di perangkat bersama tenant A lalu dipakai ke tenant B harus tetap ditolak atau diperlakukan bertanda. Kalau sudah tertutup: test pengunci + `bd comment` bukti. Kalau belum: perbaiki (migrasi 0704-0705 hanya bila tak terhindar).

## Aturan
- Keputusan CTO 18 Nov (1054): aksi uang di tablet bersama WAJIB PIN kasir. Perangkat pribadi tidak berubah.
- Jangan sentuh `app.ts`, `middleware/auth.ts`, `device-shared-mode.test.ts` (konflik 1043) dan `order-recovery-charge.routes.ts` (sudah memakai actorOf; konflik dengan m1).
- Akses: bila ragu, pilih yang menolak. Test lintas tenant/outlet untuk ketiga kartu.
- Hindari area aktif: refund ws/1072, kas cek-kas-1102, edge ws/1073, int/batch90.

## Pembagian paralel
- Explore (1): peta handler yang masih memakai `getAuth(req).user.id` di route tablet bersama + jalur tenant pada stempel sesi.
- test-writer (1): test gagal-dulu kartu 1-3 (nama `acting-staff-w4-1094-*`, `shared-device-tenant-ypwsp`).
- implementer per berkas route (tidak bertumpuk).
- test-runner: pemegang token heavy (setup, test terarah + `acting-staff-*`/`shared-device-*` lama, typecheck API sekali).
- architect (effort xhigh, akses+uang): satu review atas diff akhir.

## Bukti selesai
Test terarah lulus dan merah-dulu tercatat, regresi `acting-staff-*` + `shared-device-*` hijau, typecheck API lulus, `db:generate` kosong (atau migrasi tercatat), architect tanpa P0-P2 terbuka.

## Batas kerja ulang
Ikuti `~/.agents/team/brief-template.md` bagian "Batas kerja ulang". Jangan `pkill`. Jangan akhiri giliran untuk "Menunggu" (founder Q10).

## Sebelum melapor
Pra-gate AGENTS.md. Commit di cabang `ws/1094-akses-perangkat-bersama-sisa`, push tanpa `--force`.

## Laporan
Hasil per kartu, bukti, berkas, commit, cabang, risiko, urutan merge (SESUDAH pin-kasir).
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
