# legend-bod: emergency button relay on outlet LAN

Peran: engineer (baca berkas peran dan "Paralel dulu" di TEAM.md). Tingkat K: satu subagent architect review.
Basis: `git worktree add .worktrees/bod-emergency-relay -b ws/bod-emergency-relay milestone/m1` (29ddcbf7). Push cabang kerja ke origin tiap commit. Jangan push main, jangan --force.

## Kerja
Ikuti `bd show legend-bod`. Baru ada tipe perangkat panic_button (db/schema/device.ts:43, facility.ts:172). Perlu ingest, fan-out ke staf jaga <=5 s, jalan offline di edge, tabel insiden. Jangan sentuh file allowlist edge dan HRIS (dikerjakan j6cyb); bila perlu, tambahkan prefix di berkas sendiri dan catat untuk merge train.
1. Cek dulu apa yang sudah ada di m1; jangan tulis ulang. Kartu terlalu besar: kerjakan irisan pertama yang utuh, buat kartu bd untuk sisanya.
2. Test gagal-dulu tiap butir.
3. Typecheck dan test terarah lewat `heavy`. Typecheck gagal lebih dari 2 kali berturut: berhenti dan lapor. Review, temuan nyata dibetulkan.
4. Commit, push, `bd comment legend-bod`, update `docs/PROGRESS.md`.

Migrasi bila perlu: nomor sementara 0238, `when` 1794343000000, FK inline di CREATE TABLE (tanpa angkat NO FORCE), migrator non-superuser. Edit pakai tool Edit, bukan sed. Jangan pkill proses lain. Stempel waktu pakai `date`.

## Laporan
Sekali di akhir: SHA, test gagal-dulu, temuan review, kartu sisa.
