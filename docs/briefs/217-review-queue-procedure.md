# Prosedur antrean second opinion sesudah keputusan founder Q42 (9 Nov 2026)

Keputusan Q42: Codex hanya memeriksa uang, pajak, login/akses (termasuk izin, RLS, data pribadi) dan migrasi database, digabung per area. Semua review lain diperiksa architect Claude dengan konteks segar.

## Aturan untuk setiap peninjau (Codex atau architect)
- Read-only. Jangan mengubah kode, jangan commit, jangan `git add`, jangan checkout di folder utama `/Users/ifanshori99/Projects/legend super app/legend`.
- Banyak cabang dan worktree yang disebut di brief lama sudah digabung ke `milestone/m1` lalu dihapus. Pakai SHA/rentang yang ditulis di brief dengan `git diff`/`git show` dari folder utama. Bila brief hanya menyebut nama cabang, cari commit merge-nya: `git log milestone/m1 --merges --oneline --grep <nama-cabang>`.
- Periksa juga apakah kode yang sama sudah berubah sesudahnya di `milestone/m1` (`git log <tip>..milestone/m1 -- <file>`). Laporkan temuan hanya bila masih ada di `milestone/m1` saat ini.
- Untuk tiap brief di kelompokmu, jawab pertanyaan di brief itu. Jangan laporkan ulang temuan yang sudah punya kartu bd terbuka (cek `bd search <kata kunci>`).
- Tulis hasil ke `docs/briefs/<id brief>.result.md` (Codex) atau `docs/briefs/<id brief>.result-architect.md` (architect), satu berkas per brief, di folder utama. Berkas ini tidak di-commit.
- Untuk temuan nyata P1/P2 yang masih ada di m1: buat kartu `bd create "<judul>" -t bug -p <1|2> -l <area>,second-opinion -d "<sumber brief, file:baris, skenario gagal, saran perbaikan>"`. Temuan P3 cukup di berkas hasil.
- Bila semua kartu brief itu terbukti benar dan tidak ada temuan P1/P2: tulis "Bersih" di berkas hasil. Jangan menutup kartu; CTO yang menutup.

## Laporan
Satu tabel: id brief | kartu | hasil (bersih / temuan) | kartu baru yang dibuat | catatan singkat. Lalu daftar temuan P1/P2 dengan file:baris.
