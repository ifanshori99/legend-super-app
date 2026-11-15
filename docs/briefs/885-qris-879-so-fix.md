# 885 Perbaikan second opinion QRIS 879 (4 P1) + legend-05pjx + legend-m8jax
Lanjutan di `fix/qris-hold-so-879` (tip fd4427fd1), worktree yang sama (bila hilang, buat ulang dari origin). Baca seluruh `docs/qa/second-opinion-qris-879.md` (folder utama repo). Kartu: legend-m7tnt legend-tqkbb legend-0owye legend-adiov legend-05pjx legend-m8jax (associate + in_progress; review + comment saat lapor). Migrasi baru: 0628-0630 sementara. FORCE RLS tanpa FK NOT VALID.

## Keputusan CTO (aturan paling membatasi; jangan ditanyakan ulang)
- Prinsip: waktu lokal (expiry, timeout 24 jam, grace) tidak pernah dihitung sebagai bukti kode mati. Kode dianggap mati hanya bila penyedia menjawab final (expired/failed/cancelled) atau uangnya sudah direkonsiliasi sekali.
- Provider-proof DP: periksa semua intent yang mungkin memegang uang (pending, expired, superseded, failed) dan dana tak teralokasi yang belum selesai. Jawaban penyedia pending di status lokal apa pun, penyedia tak terjangkau, atau dana mismatch terbuka: penutupan reservasi ditolak/tertahan sampai bukti final dan rekonsiliasi di bawah kunci.
- VA: penggantian kode dan perubahan split ditolak sampai bukti final penyedia, sama dengan QR. Timeout lokal boleh mengubah tampilan, tetapi tidak membuka penggantian dan tidak mengeluarkan intent dari poll.
- Backfill 0381: intent failed dengan dana tak teralokasi yang belum selesai ikut ditahan; tagihan tertahan sampai dana itu dikembalikan atau dialokasikan.
- Force release (pengecualian founder Q93 tetap): setiap release tanpa bukti penyedia membuat baris antrean rekonsiliasi yang tahan lama; worker terus menanyai penyedia sampai jawaban final; uang yang ditemukan dicatat tepat sekali (evidence, dana tak teralokasi, alert staf, jurnal), aman terhadap replay webhook/poll. Antrean terlihat staf.
- legend-05pjx: refund failed pada order QR awaiting_payment tetap menahan order; tampil di alert/daftar staf; staf dapat mengajukan ulang lewat approval refund yang ada; retry otomatis idempoten tanpa refund ganda.
- legend-m8jax: sweep memakai kursor adil (paling lama dulu, order tertahan tidak menyumbat jatah), seperti payout la22h.

## Daftar periksa invarian uang (TEAM.md Retro 32)
Cek ulang status dan bukti di dalam kunci; semua state instrumen bayar yang mungkin masih tertagih ikut dibekukan; sweep pemulihan terlihat dan adil; tidak ada nilai ditandai selesai tanpa bukti/jurnal.

## Bukti selesai
- Test merah dulu di fd4427fd1 sesuai "Test" tiap temuan, hijau sesudah; ditambah semua berkas QRIS hold/qr-order/payment/reservasi/registry (`LEGEND_TEST_FILES=... heavy pnpm test`). Migrasi diuji dari fixture m1 dengan dana mismatch nyata.
- Pra-gate AGENTS.md (prettier, eslint, `pnpm db:generate` kosong, typecheck API; web bila shared berubah).
- Review: architect xhigh atas diff; temuan nyata dibetulkan.
- Paralel: Explore per temuan, test-writer, implementer per temuan (berkas tumpang tindih berurutan), satu test-runner pemegang heavy.
- Commit + push tanpa force. Lapor sekali saat selesai (tunggu job dengan Monitor di giliran yang sama). Jangan merge, jangan deploy.
