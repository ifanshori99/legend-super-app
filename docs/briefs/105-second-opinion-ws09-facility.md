# Brief 105: second opinion untuk WS-09 fasilitas dan Wi-Fi

## Peran
Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`.
- Read-only: jangan ubah kode, jangan commit.
- Langkah pertama: pecah tugas, lalu spawn subagent paralel dalam satu giliran.

## Repo
- Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ws-09-ws`, cabang `ws/ws-09-ws`, HEAD `1e94f33f`.
- Diff: `git diff f77e18d8 1e94f33f` (abaikan drizzle `meta/*.json`).
- Laporan agent ada di `docs/PROGRESS.md` (CTO), bagian WS-09.

## Fokus (tingkat K: akses data publik, idempotensi, notifikasi)
1. Endpoint publik, termasuk daftar paket langganan: tidak ada data internal atau lintas tenant yang bocor, dan rate limit tidak bisa dibypass.
2. Idempotensi:
   - Insiden dan klaim antrean aman dari race antara penyapu dan klaim.
   - Kunci yang sama di dua outlet saat ini menghasilkan 500. Nilai risikonya.
3. Notifikasi insiden darurat:
   - sampai ke staf yang berhak;
   - jatuh ke pemilik bila tidak ada staf pemegang izin booth;
   - tidak bocor ke outlet lain.
4. Pemindahan unit atau area saat ada tiket aktif, audit (id perangkat), dan konflik 412.
5. RLS (ENABLE, FORCE, dan policy tenant/outlet) pada tabel baru. Untuk migration: FK ke tabel ber-FORCE RLS harus di dalam CREATE TABLE atau mengangkat FORCE sementara.
6. Test benar-benar membuktikan klaimnya. Boleh reproduksi dengan DB sementara; bersihkan sesudahnya.

## Laporan
Temuan diurutkan dari yang paling berat. Tiap temuan: file:baris, masalah, skenario gagal konkret, fix. Tulis "Tidak ada blocker" bila memang tidak ada.
