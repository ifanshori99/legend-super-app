# Brief: second-opinion — framework agent EDC di edge (legend-apt)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/edc-framework`, cabang `ws/edc-framework`, SHA `a6d022d3`.
Rentang diff: `git diff $(git merge-base main a6d022d3)..a6d022d3` (abaikan drizzle `meta/*.json`).

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
