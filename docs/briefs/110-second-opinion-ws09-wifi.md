# Brief 110: second opinion untuk WS-09 Wi-Fi backend dan agent edge (legend-hsk)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`.
- Read-only: jangan ubah kode, jangan commit.
- Langkah pertama: pecah tugas, lalu spawn subagent paralel dalam satu giliran.

## Repo
- Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ws09-wifi`, cabang `ws/ws09-wifi`, HEAD `b9d7e40b`.
- Diff: `git diff 9ed513cf b9d7e40b` (abaikan drizzle `meta/*.json`). Basisnya adalah gabungan `ws/ws-09-ws`.

## Fokus (tingkat K: tabel baru, RLS, alamat MAC sebagai data pribadi)
1. `wifi_device_grants`:
   - RLS tenant dan outlet;
   - migrasi 0099/0100 (FORCE RLS di outlets diangkat sementara, lalu dipulihkan);
   - trigger baris final.
2. Agent Wi-Fi di edge:
   - kuota habis menurunkan kecepatan, bukan memutus koneksi (FAC-13);
   - walled garden (FAC-11);
   - pencabutan akses, terutama grant yang tersambung terlambat (legend-nffy);
   - masa berlaku dihitung dari percobaan pertama;
   - pemulihan setelah koneksi database putus.
3. Data pribadi: MAC dan `device_hash` (brute-force), retensi (legend-y2dg), dan log.
4. Rute terbit dan cabut akses: auth, permission, idempotensi, dan isolasi outlet.
5. Test benar-benar membuktikan klaimnya. Boleh reproduksi dengan DB sementara; bersihkan sesudahnya.

## Laporan
Temuan diurutkan dari yang paling berat. Tiap temuan: file:baris, masalah, skenario gagal konkret, fix. Tulis "Tidak ada blocker" bila memang tidak ada.

## Run tambahan: hardening Wi-Fi (tingkat K: migrasi, hapus data, data pribadi)
Cabang `ws/ws09-wifi-hardening` d2710c47, basis `ws/ws09-wifi` b9d7e40b. Diff: `git diff b9d7e40b d2710c47`.
Cek: trigger pembekuan baris final (0101), CHECK `revoke_retry_at` (0102), purge 30 hari (RLS, FK `superseded_by`), retry revoke dan race authorize-setelah-revoke.
Tulis ke `docs/reviews/codex-ws09-wifi-hardening.md`.
