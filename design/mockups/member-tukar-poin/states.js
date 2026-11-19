/* Static review states. No endpoint, transaction, or redeem token is called. */
Object.assign((window.memberViews ||= {}), {
  "tanpa-tagihan": (ui) => `
    <div class="flow-grid">
      <section class="context stack">
        <p class="eyebrow">Sari · Poin saya</p>
        <h2>Tukar poin di kasir</h2>
        <p class="muted">Pilih poin untuk tagihan Anda yang sedang dibuka.</p>
        <div class="summary"><span>Poin tersedia</span><p class="amount">1.240 poin</p><p class="muted">Contoh program: 1 poin = Rp100</p></div>
      </section>
      <section class="panel stack">
        <p class="eyebrow">Tagihan aktif</p>
        <h2>Belum ada tagihan terhubung</h2>
        <p>Tunjukkan QR member Anda kepada kasir. Setelah dipindai dan dihubungkan ke tagihan, rinciannya muncul di sini.</p>
        ${ui.note("QR member hanya menghubungkan akun. Poin belum digunakan.")}
        ${ui.button("Tampilkan QR member", "qr-member")}
        ${ui.button("Periksa tagihan lagi", "tagihan-aktif", "secondary")}
      </section>
    </div>`,
  "poin-kurang": (ui) => `
    <div class="flow-grid">
      <section class="context stack">${ui.bill()}</section>
      <section class="panel stack">
        <p class="eyebrow">Pilih jumlah poin</p>
        <h2>Jumlah poin melebihi saldo</h2>
        <div class="summary"><span>Poin tersedia</span><p class="amount">1.240 poin</p></div>
        <div class="field"><label for="invalid-points">Poin yang ingin digunakan</label><input id="invalid-points" type="text" inputmode="numeric" value="1.500" readonly aria-invalid="true" aria-describedby="points-error" /><p id="points-error" role="alert">Saldo Anda 1.240 poin. Kurangi jumlah poin untuk melanjutkan.</p></div>
        ${ui.note("Batas akhir mengikuti saldo, sisa tagihan, dan aturan program. Tidak ada poin yang digunakan.", "warning")}
        ${ui.button("Gunakan 500 poin", "pilih-poin")}
      </section>
    </div>`,
  "qr-kedaluwarsa": (ui) => `
    <div class="flow-grid">
      <section class="context stack">${ui.bill()}</section>
      <section class="panel stack">
        <p class="eyebrow">Masa berlaku berakhir · 00:00</p>
        <h2>QR sudah kedaluwarsa</h2>
        <p>QR 500 poin untuk tagihan ini tidak dapat dipakai lagi. Status penukaran belum dikonfirmasi.</p>
        <div class="summary"><div class="row between"><span>Poin dipilih</span><strong>500 poin</strong></div><div class="row between"><span>Nilai potongan</span><strong>Rp50.000</strong></div></div>
        ${ui.note("Masa berlaku QR tidak memastikan hasil penukaran. Periksa status, tagihan, dan saldo sebelum membuat QR baru.", "warning")}
        ${ui.button("Periksa status", "loading")}
      </section>
    </div>`,
  offline: (ui) => `
    <div class="flow-grid">
      <section class="context stack">
        <p class="eyebrow">Sari · Poin saya</p>
        <h2>Koneksi terputus</h2>
        <p class="muted">Saldo dan tagihan perlu diperiksa langsung sebelum poin dapat digunakan.</p>
        <div class="summary"><span>Saldo terakhir · Belum diperbarui</span><p class="amount">1.240 poin</p><p class="muted">Angka ini bukan konfirmasi saldo saat ini.</p></div>
      </section>
      <section class="panel stack">
        <p class="eyebrow">Offline</p>
        <h2>Tukar poin sementara tidak tersedia</h2>
        <p>Sambungkan kembali internet, lalu periksa status tagihan. QR tidak ditampilkan saat offline.</p>
        ${ui.note("Jika kasir baru memindai QR, periksa hasilnya setelah terhubung. Jangan mengulang penukaran sebelum statusnya jelas.", "warning")}
        ${ui.button("Periksa koneksi & status", "loading")}
      </section>
    </div>`,
  gagal: (ui) => `
    <div class="flow-grid">
      <section class="context stack">${ui.bill()}</section>
      <section class="panel stack">
        <p class="eyebrow">Status belum dapat dipastikan</p>
        <h2>QR belum dapat ditampilkan</h2>
        <p>Permintaan belum mendapat jawaban. Periksa status penukaran sebelum mencoba lagi.</p>
        ${ui.note("QR disembunyikan sampai hasil dari server diterima. Jika kasir sudah memindai, minta kasir menunggu pemeriksaan status.", "warning")}
        <div class="summary"><div class="row between"><span>Jumlah diminta</span><strong>500 poin</strong></div><p class="muted">Tagihan dan saldo akan diperiksa ulang.</p></div>
        ${ui.button("Periksa status penukaran", "loading")}
      </section>
    </div>`,
  "sudah-dipakai": (ui) => `
    <div class="flow-grid">
      <section class="context stack">
        <p class="eyebrow">Sari · Poin saya</p>
        <h2>500 poin sudah digunakan</h2>
        <p class="muted">Penukaran dikonfirmasi oleh server untuk tagihan Cafe Legend.</p>
        <div class="summary"><span>Sisa poin tersedia</span><p class="amount">740 poin</p><p class="muted">1.240 − 500 poin</p></div>
      </section>
      <section class="panel stack">
        <p class="eyebrow">Berhasil · QR sekali pakai</p>
        <h2>Potongan masuk ke tagihan</h2>
        <div class="summary"><div class="row between"><span>Sisa tagihan sebelum poin</span><strong>Rp185.000</strong></div><div class="row between"><span>Potongan 500 poin</span><strong>−Rp50.000</strong></div><div class="row between"><span>Sisa tagihan</span><strong>Rp135.000</strong></div></div>
        <p>Lanjutkan pembayaran Rp135.000 di kasir. Status ini mengonfirmasi penukaran poin, bukan pelunasan tagihan.</p>
        ${ui.note("QR ini tidak dapat dipakai lagi. Saldo sudah berkurang tepat 500 poin.", "success")}
        ${ui.button("Kembali ke poin saya", "poin-setelah")}
      </section>
    </div>`,
  "poin-setelah": (ui) => `
    <div class="flow-grid">
      <section class="context stack">
        <p class="eyebrow">Sari · Poin saya</p>
        <h2>Poin setelah penukaran</h2>
        <p class="muted">Penukaran terakhir sudah dikonfirmasi.</p>
        <div class="summary"><span>Poin tersedia</span><p class="amount">740 poin</p><p class="muted">Saldo sesudah penggunaan 500 poin.</p></div>
      </section>
      <section class="panel stack">
        <p class="eyebrow">Tagihan aktif · Cafe Legend</p>
        <h2>Lanjutkan pembayaran di kasir</h2>
        <div class="summary"><div class="row between"><span>Poin sudah digunakan</span><strong>500 poin</strong></div><div class="row between"><span>Potongan tercatat</span><strong>Rp50.000</strong></div><div class="row between"><span>Sisa tagihan</span><strong>Rp135.000</strong></div></div>
        ${ui.note("Penukaran poin telah selesai. Pembayaran sisa tagihan masih menunggu kasir.", "success")}
        <p>QR sebelumnya sudah tidak berlaku dan tidak perlu dipindai lagi.</p>
      </section>
    </div>`,
  "qr-member": (ui) => `
    <div class="flow-grid">
      <section class="context stack">
        <p class="eyebrow">Sari · QR identitas</p>
        <h2>Hubungkan member ke tagihan</h2>
        <p class="muted">Tunjukkan QR ini kepada kasir agar akun member terhubung ke tagihan Anda.</p>
        ${ui.note("Hanya untuk menautkan member. Ini bukan QR penukaran poin.")}
      </section>
      <section class="panel stack">
        <p class="eyebrow">QR member · Ilustrasi</p>
        <h2>Kasir memindai QR member</h2>
        ${ui.qr()}
        <p class="muted">Simulasi desain: QR ilustratif, tidak dapat dipakai untuk transaksi.</p>
        <p>QR ini tidak menyetujui penukaran. Pilih jumlah poin setelah tagihan terhubung.</p>
        ${ui.button("Lihat contoh tagihan terhubung", "tagihan-aktif")}
      </section>
    </div>`,
  loading: (ui) => `
    <div class="flow-grid" aria-busy="true">
      <section class="context stack">
        <p class="eyebrow">Sari · Poin saya</p>
        <h2>Memeriksa tagihan & poin</h2>
        <p class="muted">Menunggu data terbaru dari server.</p>
        <div class="summary"><span>Poin tersedia</span><p class="amount" aria-label="Sedang dimuat">— poin</p></div>
      </section>
      <section class="panel stack">
        <p class="eyebrow">Memuat</p>
        <h2 aria-live="polite">Tunggu sebentar</h2>
        <div class="summary" aria-hidden="true"><p class="muted">────────────</p><p class="amount">────────</p><p class="muted">────────────────</p></div>
        <p>Tagihan, saldo poin, dan hasil penukaran diperiksa sebelum QR ditampilkan.</p>
        ${ui.note("Jangan pindai ulang atau mengulangi penukaran selama pemeriksaan berlangsung.")}
        <p class="muted">Simulasi mockup: tombol berikut menampilkan contoh hasil pemeriksaan, tanpa menghubungi server.</p>
        ${ui.button("Lihat contoh status terbaru", "sudah-dipakai", "secondary")}
      </section>
    </div>`,
});
