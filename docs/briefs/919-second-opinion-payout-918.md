# 919 Second opinion payout 918 (bukan saya + bekukan batch; gerbang rilis uang + akses)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Effort xhigh. Read-only.
Diff: `git diff cbc98a31f..origin/ghostex/918-payout-3-p2-l2zru-bekukan-batch` (tip ffd47408f; migrasi sementara 0660-0661). Laporan SO sebelumnya (jangan diulang): `git show origin/qa/second-opinion-payout-911-915:docs/qa/second-opinion-payout-911-915.md`.
Diterima CTO (jangan dilaporkan): legend-7gghu (deteksi, bukan cegah), pengecualian edge lewat EDGE_MODE, persetujuan utama approvedBy belum lewat grant (kartu sendiri).
Cari: langkah payout yang masih lolos saat batch beku (termasuk batch saudara, pembatalan run, retry, export, settle, koreksi), pembukaan beku oleh pelaku/penyetuju atau tanpa peran Owner/Finance Manager, "Bukan saya" oleh orang selain penyetuju asli atau tanpa step-up, log beku bisa diubah/dihapus `legend_app`, finance exception ganda/hilang, lock order baru, lintas tenant.
Hasil: `docs/qa/second-opinion-payout-918.md` di worktree-mu (P0-P3, berkas:baris, skenario, usul test), commit dan push cabang qa tanpa force. Lapor hanya saat selesai.
