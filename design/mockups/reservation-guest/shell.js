(() => {
  const formatMoney = (n) => `Rp${n.toLocaleString("id-ID")}`;
  let context = "";
  let scheduleUpdated = false;
  let timer;
  const initial =
    new URLSearchParams(location.search).get("state") ||
    document.body.dataset.state ||
    "detail";
  const ui = {
    summary: ({ updated = false } = {}) => {
      updated = updated || scheduleUpdated;
      return `<section class="panel reservation-summary" aria-label="Rincian reservasi"><div class="outlet"><span class="outline-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 10h16M5 10v10h14V10M3 10l2-6h14l2 6M9 20v-6h6v6"/></svg></span><div><strong>Cafe Legend</strong><small>Outlet Menteng</small></div></div><div class="visit-time"><div class="calendar" aria-hidden="true"><span>NOV</span><b>${updated ? "19" : "18"}</b></div><div><p>${updated ? "Kamis, 19 November 2026" : "Rabu, 18 November 2026"}</p><small>${updated ? "19.30" : "19.00"} WIB · Waktu outlet</small></div></div><dl class="rows"><div><dt>Jumlah tamu</dt><dd>4 orang</dd></div><div><dt>DP sudah dibayar</dt><dd>Rp50.000</dd></div></dl></section>`;
    },
    money: ({ refund, forfeit }) =>
      `<section class="panel money-panel" aria-label="Rincian DP"><h2>Rincian DP</h2><dl class="rows"><div><dt>DP sudah dibayar</dt><dd>Rp50.000</dd></div><div><dt>Potongan DP</dt><dd>${formatMoney(forfeit)}</dd></div><div><dt>DP dikembalikan</dt><dd>${formatMoney(refund)}</dd></div></dl></section>`,
    button: (label, state, kind = "primary") =>
      `<button class="button ${kind}" type="button" data-state="${state}">${label}</button>`,
    note: (title, text, kind = "info") =>
      `<div class="note ${kind}"><strong>${title}</strong><p>${text}</p></div>`,
  };
  const notes = {
    approved:
      "Usulan state hasil keputusan. DTO tamu saat ini belum memuat hasil persetujuan.",
    rejected:
      "Usulan state hasil keputusan. DTO tamu saat ini belum memuat hasil penolakan; alasan outlet tidak dikarang.",
    late: "Perlu penyelarasan backend: guard batas waktu saat ini berjalan saat staf menyetujui, belum saat tamu meminta.",
  };
  function show(state, fromNavigation = false) {
    clearTimeout(timer);
    if (!window.guestStates[state]) state = "detail";
    if (fromNavigation) scheduleUpdated = state === "approved";
    if (state === "approved") scheduleUpdated = true;
    if (fromNavigation)
      context = [
        "approved",
        "pending",
        "late",
        "cancel-late",
        "cancelled-late",
      ].includes(state)
        ? state
        : "";
    if (
      ["approved", "pending", "late", "cancel-late", "cancelled-late"].includes(
        state,
      )
    )
      context = state;
    let markup = window.guestStates[state].render(ui);
    if (state === "detail" && scheduleUpdated) {
      markup = markup.replace(
        "Selasa, 17 November 2026, 19.00 WIB",
        "Rabu, 18 November 2026, 19.30 WIB",
      );
    }
    if (state === "detail" && context === "pending") {
      markup = markup
        .replace("Ajukan jadwal baru", "Periksa permintaan")
        .replace('data-state="reschedule"', 'data-state="pending"');
      markup = markup.replace(
        "Reservasi terkonfirmasi",
        "Permintaan sedang diperiksa",
      );
    }
    if (state === "detail" && ["late", "cancel-late"].includes(context)) {
      markup = markup
        .replace("Ajukan jadwal baru", "Lihat batas ubah jadwal")
        .replace('data-state="reschedule"', 'data-state="late"')
        .replace('data-state="cancel"', 'data-state="cancel-late"');
    }
    if (scheduleUpdated && state !== "approved") {
      markup = markup
        .replaceAll(
          "Rabu, 18 November 2026, 19.00 WIB",
          "Kamis, 19 November 2026, 19.30 WIB",
        )
        .replaceAll(
          "Rabu, 18 November 2026 pukul 19.00 WIB",
          "Kamis, 19 November 2026 pukul 19.30 WIB",
        )
        .replaceAll(
          "Selasa, 17 November 2026 pukul 19.00 WIB",
          "Rabu, 18 November 2026 pukul 19.30 WIB",
        );
    }
    document.getElementById("content").innerHTML = markup;
    document.querySelector("#content h1")?.setAttribute("tabindex", "-1");
    document.getElementById("content").dataset.state = state;
    document
      .querySelectorAll("[data-nav-state]")
      .forEach((button) =>
        button.setAttribute(
          "aria-current",
          String(button.dataset.navState === state),
        ),
      );
    const note = document.getElementById("contract-note");
    if (note) {
      note.hidden = !notes[state];
      note.textContent = notes[state] || "";
    }
    const stateLabel = document.getElementById("state-label");
    if (stateLabel) stateLabel.textContent = window.guestStates[state].title;
    document.title = `${window.guestStates[state].title} · Kelola reservasi`;
  }
  const nav = document.getElementById("state-nav");
  if (nav)
    nav.innerHTML = Object.entries(window.guestStates)
      .map(
        ([key, item], i) =>
          `<button type="button" data-nav-state="${key}">${String(i + 1).padStart(2, "0")} · ${item.title}</button>`,
      )
      .join("");
  document.addEventListener("click", (event) => {
    const navButton = event.target.closest("[data-nav-state]");
    if (navButton) {
      show(navButton.dataset.navState, true);
      return;
    }
    const button = event.target.closest("[data-state]");
    if (!button) return;
    let target = button.dataset.state;
    show(target);
    document.querySelector("#content h1")?.focus({ preventScroll: true });
    if (target === "submitting")
      timer = setTimeout(() => show("pending"), 1000);
    if (target === "cancelled" || target === "cancelled-late") {
      const status = document.querySelector("#content .note");
      status?.setAttribute("role", "status");
    }
  });
  show(initial, true);
  const details = document.getElementById("review-controls");
  if (details) {
    const narrow = matchMedia("(max-width:760px)");
    const syncNavigation = () => {
      details.open = !narrow.matches;
    };
    syncNavigation();
    narrow.addEventListener("change", syncNavigation);
  }
})();
