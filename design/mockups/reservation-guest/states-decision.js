Object.assign(window.guestStates, {
  pending: {
    title: "Menunggu persetujuan outlet",
    render: (ui) => `
      <span class="pill">Menunggu persetujuan</span>
      <h1>Permintaan sudah terkirim</h1>
      <p class="lead">Outlet akan memeriksa jadwal baru Anda. Jadwal reservasi belum berubah.</p>
      <section class="panel" aria-labelledby="requested-time">
        <h2 id="requested-time">Jadwal yang Anda minta</h2>
        <dl class="rows">
          <div><dt>Tanggal</dt><dd>Kamis, 19 November 2026</dd></div>
          <div><dt>Jam</dt><dd>19.30 WIB</dd></div>
          <div><dt>Jumlah tamu</dt><dd>4 orang</dd></div>
        </dl>
      </section>
      ${ui.note("Jadwal awal tetap berlaku", "Jika belum ada persetujuan, reservasi Anda tetap pada Rabu, 18 November 2026 pukul 19.00 WIB. DP yang sudah dibayar tidak berubah.", "info")}
      ${ui.summary({ updated: false })}
      <p class="muted">Buka kembali tautan ini untuk memeriksa status. Anda tidak perlu mengirim permintaan yang sama lagi.</p>
      <div class="actions">${ui.button("Lihat detail reservasi", "detail", "primary")}</div>
    `,
  },
  approved: {
    title: "Jadwal baru disetujui",
    render: (ui) => `
      <span class="pill success">Disetujui outlet</span>
      <h1>Jadwal baru sudah dikonfirmasi</h1>
      <p class="lead">Reservasi Anda pindah ke Kamis, 19 November 2026 pukul 19.30 WIB.</p>
      ${ui.summary({ updated: true })}
      ${ui.note("DP tetap tercatat", "DP Rp50.000 yang sudah Anda bayar tetap untuk reservasi ini. Tidak ada pembayaran DP baru dari perubahan jadwal ini.", "success")}
      <p class="muted">Jadwal lama pada Rabu, 18 November 2026 pukul 19.00 WIB sudah diganti.</p>
      <div class="actions">${ui.button("Lihat detail terbaru", "detail", "primary")}</div>
    `,
  },
  rejected: {
    title: "Permintaan jadwal ditolak",
    render: (ui) => `
      <span class="pill warning">Ditolak outlet</span>
      <h1>Jadwal baru tidak disetujui</h1>
      <p class="lead">Permintaan untuk Kamis, 19 November 2026 pukul 19.30 WIB tidak disetujui. Reservasi awal Anda tetap aktif.</p>
      ${ui.summary({ updated: false })}
      ${ui.note("Jadwal dan DP tidak berubah", "Anda masih bisa datang sesuai jadwal awal. Untuk membahas pilihan lain, balas pesan konfirmasi reservasi Anda.", "info")}
      <div class="actions">${ui.button("Lihat detail reservasi", "detail", "primary")}</div>
    `,
  },
  late: {
    title: "Batas ubah jadwal terlewati",
    render: (ui) => `
      <span class="pill warning">Batas ubah jadwal terlewati</span>
      <h1>Jadwal sudah tidak bisa diubah</h1>
      <p class="lead">Batas pengembalian DP penuh sudah lewat. Perubahan jadwal tidak dapat disetujui setelah batas ini.</p>
      ${ui.note("Batasnya Selasa, 17 November 2026", "Pukul 19.00 WIB, sesuai ketentuan saat Anda memesan. Reservasi awal Anda masih aktif.", "warning")}
      ${ui.summary({ updated: false })}
      <section aria-labelledby="late-cancellation">
        <h2 id="late-cancellation">Jika Anda memilih batal sekarang</h2>
        <p>Sebagian DP dipotong sebagai penalti pembatalan sesuai ketentuan saat Anda memesan.</p>
        ${ui.money({ refund: 25000, forfeit: 25000 })}
        <p class="muted">Jumlah pengembalian diperiksa kembali sebelum pembatalan dikonfirmasi. Uang belum dikembalikan dari halaman ini.</p>
      </section>
      <div class="actions">
        ${ui.button("Tetap pada jadwal awal", "detail", "primary")}
        ${ui.button("Tinjau pembatalan", "cancel-late", "link")}
      </div>
    `,
  },
});
