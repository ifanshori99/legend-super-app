# Kelola reservasi tamu · legend-g12il

Mockup HTML untuk gerbang founder, bukan implementasi transaksi. Hanya folder ini boleh diubah. Jangan jalankan bd, jangan commit sendiri (integrator yang commit). Acuan: docs/briefs/676-reservation-reschedule.md, design/mockups/README-qr.md, ~/.agents/team/ui-standard.md. Arah visual sudah ditentukan brief, sehingga tidak membuka pilihan arah baru.

## Pembagian dan bentuk keluaran

Tiga modul state dibuat paralel: `states-booking.js` (detail, reschedule, validasi, submitting), `states-decision.js` (pending, approved, rejected, late), `states-recovery.js` (cancel, cancelled, invalid, loading, error, rate-limit). Integrator membuat shell, review dan screenshot. Ini urutan kerja dalam brief, bukan pelacak tugas.

Setiap modul: `Object.assign(window.guestStates, { key: { title: 'Nama di pemilih', render: (ui) => \`HTML\` } });`. Global sudah disiapkan shell. Gunakan `ui.summary({updated:false})`untuk ringkasan reservasi,`ui.money({refund:50000,forfeit:0})`untuk DP dibayar/kembali/dipotong,`ui.button('Teks', 'state', 'primary|secondary|danger|link')`, `ui.note('Judul', 'Isi', 'info|warning|success')`. Class tersedia: `pill`, `pill.success`, `pill.warning`, `lead`, `panel`, `rows`(dl),`actions`, `field`, `slots`, `slot`, `muted`, `amount`, `timeline`, `skeleton`, `divider`, `eyebrow`. Semua state boleh berisi h1. Tidak perlu header app atau outer main.

## Isi contoh yang konsisten

Cafe Legend · Menteng. Kode R-181126-042 (contoh tampilan, belum ada field kode pada DTO). Rabu, 18 November 2026, 19.00 WIB; 4 tamu; DP dibayar Rp50.000. Permintaan Kamis, 19 November 2026, 19.30 WIB, 4 tamu. Batas refund penuh Selasa, 17 November 2026, 19.00 WIB. Semua angka dan identitas adalah data contoh, bukan kebijakan universal. Late: waktu contoh Selasa 17 Nov 20.00 WIB; refund Rp25.000 dan DP dipotong Rp25.000. Jam outlet WIB hanya data contoh.

## Kontrak terverifikasi e73f0649e

GET tamu berisi outletName, guestName, partySize, reservedFor, status, DP dibayar, kebijakan booking, cancellation.freeUntil dan pratinjau refund. Jadwal lama tetap aktif selama pending, DP tidak berubah. Reschedule setelah sekarang dan maksimal 180 hari, catatan opsional 300 karakter. Tidak perlu edit jumlah tamu untuk slice terkecil ini. Pembatalan perlu konfirmasi nominal; refund belum berarti uang masuk. Tautan invalid/kedaluwarsa/dicabut semua 404 yang sama: satu state “Tautan tidak berlaku”, jangan ungkap detail reservasi. Tidak ada kontak outlet di DTO: arahkan untuk membalas pesan konfirmasi yang sudah dimiliki, tanpa nomor/CTA kontak buatan. Jangan tampilkan token di UI atau query.

## Gap yang WAJIB ditandai di review/README

Guest DTO hanya latest PENDING, belum hasil approved/rejected atau alasan penolakan. Dua state hasil merupakan usulan untuk perluasan kontrak, jangan karang alasan outlet. Guard RESERVATION_RESCHEDULE_LATE baru dipanggil saat persetujuan staf, belum pada request tamu. Late adalah arah UX wajib brief yang memerlukan penyelarasan backend. Kode reservasi contoh juga membutuhkan sumber field bila dipakai implementasi.

## Mutu

Body mobile 16px, target >=44px, fokus terlihat, status pakai teks. Satu CTA utama tiap state. Cancel destructive selalu halaman konfirmasi sebelum berhasil; jangan menjanjikan refund instan. Actions state simulator lokal, tanpa jaringan/API. Mobile 390 utama, desktop 1280; solid form dan money panel, tanpa foto dekoratif atau ikon emoji. Gunakan bahasa Indonesia lengkap, sederhana. State hasil dapat ditandai melalui catatan review di luar tampilan tamu. Subagent tidak menjalankan browser: integrator memegang satu browser/heavy.
