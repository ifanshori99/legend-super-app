Object.assign((window.memberViews ||= {}), {
  "perbandingan-alur": (ui) => `
  <div class="context">
    <p class="eyebrow">Dua cara menemukan tagihan</p>
    <h2>Bandingkan alurnya</h2>
    <p class="muted">Tagihan dan jumlah poin perlu sesuai sebelum QR penukaran dibuat.</p>
  </div>
  <div class="compare-grid">
    <section class="panel stack recommend" aria-labelledby="alur-a">
      <div>
        <p class="eyebrow">A · Rekomendasi</p>
        <h2 id="alur-a">Tagihan muncul setelah dipindai</h2>
        <p class="muted">Kasir memindai QR member Sari. Tagihan yang sudah terhubung muncul di halaman Poin saya.</p>
      </div>
      <ol class="steps">
        <li>Tunjukkan QR member kepada kasir.</li>
        <li>Periksa outlet dan total tagihan.</li>
        <li>Pilih jumlah poin yang ingin ditukar.</li>
        <li>Tunjukkan QR penukaran khusus tagihan ini.</li>
      </ol>
      <div class="summary">
        <div class="row between"><span>Tagihan Sari</span><strong>Rp185.000</strong></div>
        <div class="row between"><span>500 poin × Rp100</span><strong>−Rp50.000</strong></div>
        <div class="row between"><span>Sisa dibayar</span><strong>Rp135.000</strong></div>
      </div>
      ${ui.note("Lebih sedikit langkah di ponsel. Member tetap memeriksa tagihan sebelum menyetujui penukaran.")}
      ${ui.button("Lihat tagihan aktif", "tagihan-aktif")}
    </section>
    <section class="panel stack" aria-labelledby="alur-b">
      <div>
        <p class="eyebrow">B · Alternatif usulan</p>
        <h2 id="alur-b">Masukkan kode dari kasir</h2>
        <p class="muted">Kasir menunjukkan kode tagihan pendek. Member mengetiknya untuk menemukan tagihan.</p>
      </div>
      <ol class="steps">
        <li>Minta kode tagihan kepada kasir.</li>
        <li>Masukkan kode di halaman Poin saya.</li>
        <li>Periksa outlet dan total tagihan.</li>
        <li>Pilih poin, lalu tunjukkan QR penukaran.</li>
      </ol>
      <div class="summary">
        <p class="eyebrow">Contoh kode tagihan</p>
        <p class="amount" aria-label="Kode tagihan L G 7 K 2 P">LG7K2P</p>
        <p class="muted">Kode hanya untuk menemukan tagihan. Tetap perlu konfirmasi member dan QR penukaran.</p>
      </div>
      ${ui.note("Alternatif bila tagihan belum muncul. Perlu aturan masa berlaku dan percobaan kode dari server.")}
      ${ui.button("Lihat contoh input kode", "kode-tagihan", "secondary")}
    </section>
  </div>
`,
  "kode-tagihan": (ui) => `
  <div class="context">
    <p class="eyebrow">Alternatif usulan</p>
    <h2>Masukkan kode tagihan</h2>
    <p class="muted">Minta kode kepada kasir di outlet tempat Anda membayar.</p>
  </div>
  <div class="flow-grid">
    <section class="panel stack" aria-labelledby="judul-kode">
      <div>
        <h2 id="judul-kode">Temukan tagihan Anda</h2>
        <p class="muted">Kode ini tidak memotong poin.</p>
      </div>
      <div class="field">
        <label for="kode-tagihan">Contoh kode tagihan</label>
        <input id="kode-tagihan" name="kodeTagihan" type="text" readonly value="LG7K2P" maxlength="6" autocapitalize="characters" autocomplete="off" spellcheck="false" aria-describedby="bantuan-kode">
        <p class="muted" id="bantuan-kode">Contoh 6 karakter dari layar kasir.</p>
      </div>
      ${ui.button("Periksa tagihan", "kode-hasil", "secondary")}
      ${ui.note("Simulasi kode contoh. Setelah diperiksa, cocokkan outlet dan total tagihan sebelum melanjutkan.")}
    </section>
  </div>
`,
  "kode-hasil": (ui) => `
  <div class="flow-grid">
    <section class="context stack">
      <p class="eyebrow">Alternatif kode tagihan</p>
      <h2>Periksa hasilnya</h2>
      <p class="muted">Kode hanya menemukan tagihan. Anda belum menyetujui penukaran poin.</p>
      ${ui.note("Jangan lanjutkan jika outlet atau total tidak sesuai dengan tagihan Anda.")}
    </section>
    <section class="panel stack" aria-labelledby="hasil-kode">
      <div>
        <p class="eyebrow">Contoh hasil · LG7K2P</p>
        <h2 id="hasil-kode">Ini tagihan Anda?</h2>
        <p class="muted">Periksa rinciannya bersama kasir sebelum memilih poin.</p>
      </div>
      ${ui.bill()}
      <div class="summary">
        <div class="row between"><span>Member</span><strong>Sari</strong></div>
        <div class="row between"><span>Poin tersedia</span><strong>1.240 poin</strong></div>
      </div>
      ${ui.button("Ya, pilih jumlah poin", "pilih-poin")}
      ${ui.button("Bukan tagihan saya", "tanpa-tagihan", "secondary")}
    </section>
  </div>
`,
});
