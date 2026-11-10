# Brief: second-opinion — framework agent EDC di edge (legend-apt)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/edc-framework`, cabang `ws/edc-framework` a6d022d3, digabung ke `milestone/m1` lewat `prep/edc-framework` SHA `81038feb` (merge m1 `658b055b`, migration diregen jadi 0082/0083).
Rentang diff: `git diff fd2616f4 658b055b` (isi cabang saja di atas m1; abaikan drizzle `meta/*.json`). Jangan pakai `merge-base main`: menyeret isi m1 lain.

## Berkas berisiko
- `apps/api/src/db/schema/edc.ts`
- `apps/api/src/lib/secrets.ts`
- Layanan EDC agent dan adapter `EdcProvider` (daftar lengkap dari `git diff --name-only`, saring jalur yang mengirim, membatalkan, atau memeriksa transaksi)
- Simulator ECR (hanya dev dan test)

## Invariant (PRD)
- D36 dan F10a: kasir tidak mengetik ulang nominal. POS mengirim nominal ke EDC.
- EDC Terintegrasi: hasil bank (status, approval code, nomor referensi) tercatat otomatis. Void hari yang sama dikirim lewat ECR.
- Mode standalone (ECR bermasalah): wajib PIN supervisor dan ditandai untuk rekonsiliasi.
- EDC Agent: bila koneksi putus di tengah transaksi, status diperiksa. Pembatalan hanya untuk transaksi yang sedang berjalan.
- Data kartu tidak pernah menyentuh server platform. POS hanya menerima status, approval code, jenis kartu, dan nomor kartu yang disamarkan.
- Nominal integer IDR di semua jalur.

## Effort
high.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
