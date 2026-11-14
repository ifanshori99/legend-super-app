/* State mockup lokal. Semua tanggal, nominal, dan identitas adalah data contoh. */
(() => {
  const requestFields = (invalid = false) => `
    <section class="panel" aria-labelledby="new-time-heading">
      <h2 id="new-time-heading">Jadwal yang diinginkan</h2>
      <div class="field">
        <label for="requested-date">Tanggal baru</label>
        <input id="requested-date" name="requested-date" type="date"
          value="${invalid ? "2026-11-16" : "2026-11-19"}"
          min="2026-11-17" max="2027-05-15"
          ${invalid ? 'aria-invalid="true" aria-describedby="date-error"' : 'aria-describedby="date-help"'}>
        ${
          invalid
            ? '<p id="date-error" role="alert">Tanggal ini sudah lewat. Pilih tanggal dan jam setelah waktu sekarang.</p>'
            : '<p id="date-help" class="muted">Pilih waktu setelah sekarang, maksimal 180 hari ke depan.</p>'
        }
      </div>
      <fieldset class="field">
        <legend>Jam baru · WIB</legend>
        <div class="slots">
          <label class="slot"><input type="radio" name="requested-time" value="18:30">18.30</label>
          <label class="slot"><input type="radio" name="requested-time" value="19:00">19.00</label>
          <label class="slot"><input type="radio" name="requested-time" value="19:30" checked>19.30</label>
          <label class="slot"><input type="radio" name="requested-time" value="20:00">20.00</label>
        </div>
        <p class="muted">Pilihan jam ini belum menjamin meja tersedia. Outlet akan memeriksa permintaan Anda.</p>
      </fieldset>
      <div class="field">
        <label for="request-note">Catatan untuk outlet <span class="muted">(opsional)</span></label>
        <textarea id="request-note" name="request-note" rows="3" maxlength="300"
          aria-describedby="note-help">Ada perubahan rencana, kami ingin datang besok malam.</textarea>
        <p id="note-help" class="muted">Maksimal 300 karakter.</p>
      </div>
    </section>`;

  Object.assign(window.guestStates, {
    detail: {
      title: "Detail reservasi",
      render: (ui) => `
        <span class="pill success">Reservasi terkonfirmasi</span>
        <h1>Kelola reservasi Anda</h1>
        <p class="lead">Periksa jadwal kunjungan atau ajukan perubahan ke outlet.</p>
        ${ui.summary({ updated: false })}
        ${ui.note(
          "Perlu mengubah rencana?",
          "Permintaan jadwal baru perlu disetujui outlet. Jadwal saat ini tetap berlaku sampai permintaan disetujui.",
          "info",
        )}
        <section aria-labelledby="policy-heading">
          <h2 id="policy-heading">Ketentuan DP Anda</h2>
          <p>DP kembali penuh jika pembatalan dilakukan paling lambat <strong>Selasa, 17 November 2026, 19.00 WIB</strong>.</p>
          <p class="muted">Setelah batas tersebut, ada potongan DP sesuai ketentuan saat Anda memesan. Rincian nominal ditampilkan sebelum pembatalan.</p>
        </section>
        <div class="actions">
          ${ui.button("Ajukan jadwal baru", "reschedule", "primary")}
          ${ui.button("Batalkan reservasi", "cancel", "link")}
        </div>`,
    },
    reschedule: {
      title: "Ajukan jadwal baru",
      render: (ui) => `
        <span class="pill">Permintaan jadwal baru</span>
        <h1>Kapan ingin datang?</h1>
        <p class="lead">Pilih tanggal dan jam yang Anda inginkan untuk 4 tamu.</p>
        ${ui.summary({ updated: false })}
        ${requestFields()}
        ${ui.note(
          "Menunggu persetujuan outlet",
          "Jadwal awal dan DP tetap berlaku selama permintaan diperiksa. Jadwal baru berlaku setelah disetujui outlet.",
          "info",
        )}
        <div class="actions">
          ${ui.button("Kirim permintaan", "submitting", "primary")}
          ${ui.button("Kembali ke detail", "detail", "secondary")}
        </div>`,
    },
    validation: {
      title: "Tanggal perlu diperbaiki",
      render: (ui) => `
        <span class="pill warning">Permintaan belum dikirim</span>
        <h1>Periksa tanggal baru</h1>
        <p class="lead">Tanggal yang dipilih sudah lewat. Ganti tanggal sebelum mengirim permintaan.</p>
        ${requestFields(true)}
        <p>Reservasi awal Anda tetap berlaku: <strong>Rabu, 18 November 2026, 19.00 WIB</strong>, untuk 4 tamu.</p>
        <div class="actions">
          ${ui.button("Pilih ulang tanggal", "reschedule", "primary")}
          ${ui.button("Kembali ke detail", "detail", "secondary")}
        </div>`,
    },
    submitting: {
      title: "Mengirim permintaan",
      render: (ui) => `
        <span class="pill">Sedang mengirim</span>
        <h1>Mengirim jadwal baru</h1>
        <p class="lead">Tunggu sebentar. Jangan kirim ulang agar permintaan tidak terkirim dua kali.</p>
        <section class="panel" aria-busy="true" aria-labelledby="sending-heading">
          <h2 id="sending-heading">Jadwal yang diajukan</h2>
          <dl class="rows">
            <div><dt>Tanggal</dt><dd>Kamis, 19 November 2026</dd></div>
            <div><dt>Jam</dt><dd>19.30 WIB</dd></div>
            <div><dt>Jumlah tamu</dt><dd>4 tamu</dd></div>
          </dl>
          <p role="status">Permintaan sedang dikirim ke outlet.</p>
        </section>
        ${ui.note(
          "Jadwal awal tetap berlaku",
          "Rabu, 18 November 2026, 19.00 WIB. DP Anda tidak berubah.",
          "info",
        )}
        <div class="actions"><button class="button primary" type="button" disabled aria-disabled="true">Mengirim permintaan…</button></div>`,
    },
  });
})();
