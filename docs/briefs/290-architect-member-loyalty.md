# Brief: architect — desain identitas pelanggan dan buku poin (WS-08 fondasi member)

## Peran
Baca `~/.agents/team/roles/architect.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu"), lalu ikuti. Kamu tidak mengubah kode produk.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Baca dari `milestone/m1` (`git show milestone/m1:<path>` atau worktree baca-saja `.worktrees/arch-member` dari m1; hapus sesudah selesai, disk Mac sempit). Tulis dokumen di cabang baru `docs/arch-member-loyalty` dari `milestone/m1`, commit lokal. Jangan push, jangan merge.

## Tujuan
API halaman member (`legend-u57q`, UI sudah ada di `apps/web/src/features/ws08-member`) tertahan karena fondasinya belum ada. Rantai kartu: `legend-k2l` (magic link, Google OAuth, graf identitas, gerbang WA terverifikasi) → `legend-111j` (profil pelanggan, consent, buku poin append-only: earn saat paid sesudah diskon sebelum pajak/servis, balik saat refund, anti-fraud, batas harian, liability_idr per entri) → `legend-m4p5` (katalog hadiah, penukaran atomik, misi, voucher), `legend-ts50` (masukan/keluhan), `legend-3zd1` (tier, kedaluwarsa poin) → `legend-u57q`.

Hasilkan desain yang cukup untuk engineer membangun tanpa menebak:
1. Model data dan migrasi (tabel, kunci unik dengan tenant_id, RLS, outlet_id untuk tabel operasional), dibagi per kartu dengan urutan migrasi. Nomor migrasi dipesan: `0193` sampai `0197`, `when` 1794272000000 sampai 1794276000000, naik ketat sesuai urutan merge.
2. Identitas pelanggan terpisah dari user staf Better Auth: cara login member PWA, sesi, dan cara API member memastikan member hanya melihat datanya sendiri. Bandingkan dengan `user_identities` yang sudah ada sebagian di m1 (audit 9 Nov di komentar `legend-k2l`).
3. Buku poin: invarian saldo sama dengan jumlah ledger, idempoten per pembayaran, pembalikan refund parsial, batas harian, larangan staf melayani diri sendiri, liabilitas. Kaitkan ke event pembayaran dan outbox yang ada.
4. Consent berversi dengan sumber `member_pwa` (layanan consent sekarang hanya untuk staf) dan versi kebijakan aktif per tujuan.
5. Daftar pertanyaan bisnis untuk founder, masing-masing dengan rekomendasi (contoh: cara login member, rasio poin awal dan apakah diatur per tenant; asumsi A15 di PRD diuji 30 November). Jangan menunggu jawaban: pakai default yang bisa diubah lewat konfigurasi.
6. Pembagian kerja: brief engineer per kartu (tujuan, berkas, tes gagal-dulu, tingkat K atau S), urutan, dan mana yang bisa paralel.

Masukan: PRD v1.7 (`docs/prd/`) bagian F6, F20, 3.20, 6G; kontrak `packages/shared/src/crm/*` (legend-zk25, sudah selesai); `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/CONTRACT.md`.

## Bukti selesai
- `docs/ARCHITECTURE.md` bagian baru WS-08 fondasi member, entri `docs/DECISIONS.md`, dan draf brief `docs/briefs/290a-...md` dan seterusnya per kartu.
- Satu subagent `architect` kedua menantang desainmu (uang dan identitas); temuan dibahas di laporan.

## Laporan
Sekali di akhir: keputusan utama, urutan kartu dan migrasi, brief yang ditulis, pertanyaan founder dengan rekomendasi, risiko, SHA dokumen, jumlah subagent dan puncak bersamaan.
