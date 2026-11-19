Object.assign((window.memberViews ||= {}), {
  "tagihan-aktif": (ui) => `
    <div class="flow-grid">
      <aside class="context stack">
        <div>
          <p class="eyebrow">Poin tersedia</p>
          <p class="amount">1.240 <span>poin</span></p>
          <p class="muted">Sari Wulandari · 1 poin = Rp100</p>
        </div>
        ${ui.note("QR member sudah dipindai. Cocokkan outlet dan tagihan sebelum memakai poin.")}
      </aside>
      <section class="panel stack" aria-labelledby="active-title">
        <div>
          <p class="eyebrow">Terhubung ke kasir</p>
          <h2 id="active-title">Tagihan aktif</h2>
          <p class="muted">Pakai sebagian poin, lalu bayar sisanya di kasir.</p>
        </div>
        ${ui.bill()}
        <div class="summary stack">
          <div class="row between"><span>Sisa tagihan</span><strong>Rp185.000</strong></div>
          <div class="row between"><span>Poin yang bisa dipakai</span><strong>Maks. 1.240 poin</strong></div>
          <p class="muted">Nilai maksimal Rp124.000. Minimum penukaran 1 poin.</p>
        </div>
        ${ui.button("Pilih jumlah poin", "pilih-poin")}
        <p class="muted">Poin belum dipotong. Kamu memilih jumlahnya terlebih dahulu.</p>
      </section>
    </div>
  `,
  "pilih-poin": (ui) => `
    <div class="flow-grid">
      <aside class="context stack">
        <div>
          <p class="eyebrow">Tagihan aktif</p>
          <h2>Cocokkan sebelum lanjut</h2>
        </div>
        ${ui.bill()}
        <div class="summary stack">
          <div class="row between"><span>Sisa tagihan</span><strong>Rp185.000</strong></div>
          <div class="row between"><span>Saldo tersedia</span><strong>1.240 poin</strong></div>
        </div>
      </aside>
      <section class="panel stack" aria-labelledby="choose-title">
        <div>
          <p class="eyebrow">Pakai poin di kasir</p>
          <h2 id="choose-title">Berapa poin yang dipakai?</h2>
          <p class="muted">1 poin mengurangi tagihan sebesar Rp100.</p>
        </div>
        <div class="field stack">
          <label for="redeem-points">Jumlah poin</label>
          <input id="redeem-points" name="points" type="number" inputmode="numeric" min="1" max="1240" step="1" value="500" aria-describedby="points-limit" />
          <p id="points-limit" class="muted">Min. 1 · Maks. 1.240 poin, sesuai saldo dan sisa tagihan.</p>
        </div>
        <div class="summary stack" aria-label="Rincian penukaran">
          <div class="row between"><span>Nilai 500 poin</span><strong>Rp50.000</strong></div>
          <div class="row between"><span>Sisa bayar setelah dipakai</span><strong>Rp135.000</strong></div>
          <div class="row between"><span>Perkiraan sisa poin</span><strong>740 poin</strong></div>
        </div>
        ${ui.note("QR berikutnya hanya untuk tagihan ini dan 500 poin. Poin dipotong setelah penukaran berhasil di kasir.")}
        ${ui.button("Buat QR untuk 500 poin", "qr-aktif")}
        ${ui.button("Kembali ke tagihan", "tagihan-aktif", "secondary")}
      </section>
    </div>
  `,
  "qr-aktif": (ui) => `
    <div class="flow-grid">
      <aside class="context stack">
        <div>
          <p class="eyebrow">Konfirmasi penukaran</p>
          <h2>500 poin · Rp50.000</h2>
          <p class="muted">Khusus tagihan yang sedang dibuka ini.</p>
        </div>
        ${ui.bill()}
        <div class="summary stack">
          <div class="row between"><span>Sisa tagihan saat ini</span><strong>Rp185.000</strong></div>
          <div class="row between"><span>Sisa bayar setelah dipakai</span><strong>Rp135.000</strong></div>
          <div class="row between"><span>Perkiraan sisa poin</span><strong>740 poin</strong></div>
        </div>
        ${ui.note("Poin belum dipotong. Tunggu konfirmasi penukaran dari kasir.")}
      </aside>
      <section class="panel stack" aria-labelledby="qr-title">
        <div>
          <p class="eyebrow">QR penukaran · Sekali pakai</p>
          <h2 id="qr-title">Tunjukkan QR ke kasir</h2>
          <p class="muted">Kasir memindai QR ini untuk memakai 500 poin.</p>
        </div>
        ${ui.qr()}
        <div class="summary stack">
          <div class="row between"><span>Berlaku selama</span><strong class="amount">02:00</strong></div>
          <p class="muted">QR berlaku 120 detik dan hanya dapat dipakai satu kali untuk tagihan ini.</p>
        </div>
        ${ui.note("Jangan bagikan QR atau tangkapan layarnya kepada orang lain.")}
        ${ui.button("Kembali ke tagihan", "tagihan-aktif", "secondary")}
      </section>
    </div>
  `,
});
