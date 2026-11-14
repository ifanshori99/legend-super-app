Object.assign(window.guestStates, {
  cancel: {
    title: "Konfirmasi pembatalan",
    render: (ui) => `
      <span class="pill warning">Konfirmasi diperlukan</span>
      <h1>Batalkan reservasi?</h1>
      <p class="lead">Periksa rincian DP sebelum membatalkan kunjungan Anda.</p>
      ${ui.summary({ updated: false })}
      ${ui.money({ refund: 50000, forfeit: 0 })}
      ${ui.note("DP dapat dikembalikan penuh", "Batas pengembalian penuh: Selasa, 17 November 2026 pukul 19.00 WIB. Ketentuan ini mengikuti kebijakan saat Anda memesan.", "info")}
      <div class="field">
        <label for="cancel-reason">Alasan pembatalan <span class="muted">(opsional)</span></label>
        <textarea id="cancel-reason" name="cancelReason" rows="3" maxlength="300" aria-describedby="cancel-reason-hint" placeholder="Tuliskan alasan Anda"></textarea>
        <p id="cancel-reason-hint" class="muted">Maksimal 300 karakter.</p>
      </div>
      <p>Setelah dibatalkan, reservasi ini tidak dapat digunakan. Pengembalian DP diproses terpisah dan belum tentu langsung masuk.</p>
      <div class="actions">
        ${ui.button("Ya, batalkan reservasi", "cancelled", "danger")}
        ${ui.button("Tetap gunakan reservasi", "detail", "secondary")}
      </div>`,
  },
  "cancel-late": {
    title: "Pembatalan dengan potongan DP",
    render: (ui) => `
      <span class="pill warning">Batas pengembalian penuh sudah lewat</span>
      <h1>Batalkan reservasi?</h1>
      <p class="lead">Sebagian DP akan dipotong sesuai kebijakan saat Anda memesan.</p>
      ${ui.summary({ updated: false })}
      ${ui.money({ refund: 25000, forfeit: 25000 })}
      ${ui.note("Periksa potongan sebelum melanjutkan", "Batas pengembalian penuh adalah Selasa, 17 November 2026 pukul 19.00 WIB. Jika dibatalkan sekarang, Rp25.000 dari DP Anda tidak dikembalikan.", "warning")}
      <div class="field">
        <label for="cancel-late-reason">Alasan pembatalan <span class="muted">(opsional)</span></label>
        <textarea id="cancel-late-reason" name="cancelReason" rows="3" maxlength="300" aria-describedby="cancel-late-hint" placeholder="Tuliskan alasan Anda"></textarea>
        <p id="cancel-late-hint" class="muted">Maksimal 300 karakter.</p>
      </div>
      <p>Reservasi yang sudah dibatalkan tidak dapat digunakan. Pengembalian DP diproses terpisah dan belum tentu langsung masuk.</p>
      <div class="actions">
        ${ui.button("Batalkan dengan potongan Rp25.000", "cancelled-late", "danger")}
        ${ui.button("Tetap gunakan reservasi", "late", "secondary")}
      </div>`,
  },
  cancelled: {
    title: "Reservasi dibatalkan",
    render: (ui) => `
      <span class="pill">Reservasi dibatalkan</span>
      <h1>Reservasi Anda dibatalkan</h1>
      <p class="lead">Kunjungan Rabu, 18 November 2026 pukul 19.00 WIB untuk 4 tamu sudah dibatalkan.</p>
      <p class="eyebrow">Cafe Legend · Menteng</p>
      ${ui.money({ refund: 50000, forfeit: 0 })}
      ${ui.note("Pengembalian DP belum selesai", "Nominal yang dikembalikan adalah Rp50.000. Status pembatalan tidak berarti uang sudah masuk. Periksa kembali status pengembalian melalui halaman ini.", "info")}
      <p class="muted">Jika memerlukan bantuan, balas pesan konfirmasi reservasi yang Anda terima.</p>
      <div class="actions">${ui.button("Periksa status pengembalian", "cancelled", "primary")}</div>`,
  },
  "cancelled-late": {
    title: "Dibatalkan dengan potongan DP",
    render: (ui) => `
      <span class="pill">Reservasi dibatalkan</span>
      <h1>Reservasi Anda dibatalkan</h1>
      <p class="lead">Kunjungan Rabu, 18 November 2026 pukul 19.00 WIB untuk 4 tamu sudah dibatalkan.</p>
      <p class="eyebrow">Cafe Legend · Menteng</p>
      ${ui.money({ refund: 25000, forfeit: 25000 })}
      ${ui.note("Pengembalian DP belum selesai", "Rp25.000 dikembalikan dan Rp25.000 dipotong sesuai kebijakan saat pemesanan. Status pembatalan tidak berarti uang sudah masuk.", "info")}
      <p class="muted">Jika memerlukan bantuan, balas pesan konfirmasi reservasi yang Anda terima.</p>
      <div class="actions">${ui.button("Periksa status pengembalian", "cancelled-late", "primary")}</div>`,
  },
  invalid: {
    title: "Tautan tidak berlaku",
    render: () => `
      <span class="pill warning">Tautan tidak berlaku</span>
      <h1>Reservasi belum bisa dibuka</h1>
      <p class="lead">Tautan ini mungkin sudah kedaluwarsa atau tidak lagi berlaku.</p>
      <section class="panel" aria-labelledby="invalid-help">
        <h2 id="invalid-help">Cara membuka reservasi Anda</h2>
        <ol>
          <li>Buka kembali pesan konfirmasi atau pengingat reservasi.</li>
          <li>Gunakan tautan kelola reservasi terbaru dari pesan tersebut.</li>
          <li>Jika masih gagal, balas pesan konfirmasi untuk meminta bantuan.</li>
        </ol>
      </section>
      <p class="muted">Detail reservasi tidak ditampilkan melalui tautan yang tidak berlaku.</p>`,
  },
  loading: {
    title: "Memuat reservasi",
    render: () => `
      <h1>Memuat reservasi Anda</h1>
      <p class="lead" role="status">Sedang memeriksa rincian dan status terbaru.</p>
      <div class="panel" aria-hidden="true">
        <div class="skeleton" style="height:24px;width:62%;margin-bottom:24px"></div>
        <div class="skeleton" style="height:24px;margin-bottom:16px"></div>
        <div class="skeleton" style="height:24px;width:76%;margin-bottom:16px"></div>
        <div class="skeleton" style="height:24px;width:50%"></div>
      </div>
      <div class="skeleton" aria-hidden="true" style="height:104px;margin-top:24px"></div>`,
  },
  error: {
    title: "Gagal memuat",
    render: (ui) => `
      <span class="pill warning">Belum bisa terhubung</span>
      <h1>Status belum bisa dimuat</h1>
      <p class="lead">Periksa koneksi internet Anda, lalu coba lagi.</p>
      ${ui.note("Periksa status sebelum mengirim ulang", "Jika tadi Anda meminta jadwal baru atau membatalkan reservasi, muat ulang statusnya dahulu agar tidak mengirim permintaan dua kali.", "warning")}
      <div class="actions">${ui.button("Muat ulang status", "detail", "primary")}</div>
      <p class="muted">Jika masih gagal, balas pesan konfirmasi reservasi untuk meminta bantuan.</p>`,
  },
  "rate-limit": {
    title: "Terlalu banyak percobaan",
    render: (ui) => `
      <span class="pill warning">Coba lagi sebentar</span>
      <h1>Terlalu banyak percobaan</h1>
      <p class="lead">Permintaan dibatasi sementara. Tunggu sebentar sebelum memeriksa kembali.</p>
      ${ui.note("Tidak perlu mengirim berulang kali", "Setelah jeda selesai, periksa status terbaru sebelum mencoba tindakan yang sama lagi.", "info")}
      <div class="actions">${ui.button("Periksa status kembali", "detail", "primary")}</div>
      <p class="muted">Jika Anda memerlukan bantuan, balas pesan konfirmasi reservasi.</p>`,
  },
});
