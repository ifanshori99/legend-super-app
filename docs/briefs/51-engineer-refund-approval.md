# Brief: engineer — alur persetujuan refund dan refund ke provider (legend-hvvn, legend-rbjw)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/contracts.md`.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/refund-approval`, cabang `ws/refund-approval` (dari `main`). Setup: `pnpm install --offline --frozen-lockfile` (gagal: `--prefer-offline`); jangan symlink `node_modules`.

## Tujuan
PAY-04 (`docs/PRD.md`). Saat ini `approveRefund` di `apps/api/src/services/payment-admin.service.ts:380` stub 503, jadi refund berhenti di `pending`.
1. legend-hvvn: penyelesaian dana tak teralokasi lewat refund membuat refund request yang mengikuti alur approval refund (bukan aksi langsung); refund pending mengurangi jumlah yang bisa di-refund sampai disetujui/ditolak.
2. legend-rbjw: lengkapi approve/reject refund lewat `approval_requests` (matriks approval), lalu panggil provider refund lewat port/interface payment provider. Payout idempoten (kunci idempotensi per refund, replay aman, webhook refund/status). Adapter DOIT nyata ada di cabang `ws/doit-provider` yang belum di-merge: di sini pakai port + fake provider di test; catat bead untuk menyambung adapter DOIT setelah merge.
Detail: `bd show legend-hvvn`, `bd show legend-rbjw`.

## Kartu
Di awal: `ghostex board associate legend-hvvn`, `ghostex board associate legend-rbjw`, `bd update <id> --status in_progress`. Saat melapor: status `review` + `bd comment` bahasa biasa.

## Catatan (uang)
- Uang integer IDR. Total refund tidak boleh melebihi yang dibayar dikurangi refund pending+selesai, dicek di bawah lock pembayaran.
- Approver tidak boleh peminta; sekali pakai; terikat nilai dan pembayaran; tenant/outlet terisolasi.
- Refund gagal di provider tidak boleh dicatat selesai; retry aman.
- Cabang `ws/pos-payment-fixes` membuat refund pending untuk pembayaran terlambat; jangan ubah file POS-nya, cukup pastikan alurmu memproses refund pending apa pun sumbernya.
- Migration: drizzle-kit, jangan edit `_journal.json`. Jangan baca `.env*`.

## Scope
- Boleh: `payment-admin.service.ts`, service/route refund, port provider di `apps/api/src/services/payment*`, schema refund, migration baru, test `apps/api/src/test/*refund*`, kontrak `packages/shared` bagian refund.
- Jangan: `pos-order*.ts`, `qr-order.service.ts`, adapter DOIT, `apps/web/`.

## Bukti selesai
- Test: refund request → approve → provider sukses; reject; provider gagal lalu retry; replay/idempotensi; approve bersamaan dua kali; refund pending menahan sisa; dana tak teralokasi lewat alur approval; isolasi tenant.
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus (satu kali gerbang penuh setelah perubahan terakhir; jangan ulang run basi). `git status` bersih.
- Subagent reviewer konteks segar cek diff; temuan nyata dibetulkan.

## Sebelum melapor
Commit lokal merujuk kartu. Jangan push, jangan merge.

## Laporan
Hasil, bukti, file berubah, commit, bead lanjutan, risiko tersisa.
