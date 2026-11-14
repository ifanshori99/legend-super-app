// Local review simulation only. No network, credentials, PIN entry, or real ACK.
document.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const target = button.closest(".queue-item") || button.parentElement;
  let message = target.querySelector(".mock-feedback");
  if (!message) {
    message = document.createElement("p");
    message.className = "mock-feedback";
    message.setAttribute("role", "status");
    message.tabIndex = -1;
    target.append(message);
  }
  if (action === "ack") {
    button.disabled = true;
    button.textContent = "Respons tercatat";
    button.removeAttribute("aria-label");
    target.dataset.responded = "true";
    const screen = button.closest(".panic-screen");
    if (target.classList.contains("queue-item")) {
      target.querySelector(".eyebrow").textContent = "Respons Anda tercatat";
      const remaining = screen.querySelectorAll(
        ".queue-item:not([data-responded])",
      ).length;
      screen.querySelector(".screen-title").textContent = remaining
        ? remaining + " lokasi perlu bantuan"
        : "Semua alert sudah direspons";
      screen.querySelector(".screen-top .status-label").textContent =
        "Darurat · " + remaining + " alert menunggu";
      if (remaining === 0) {
        screen.querySelector(".screen-body > .lead").textContent =
          "Respons untuk ketiga alert tercatat. Insiden belum dinyatakan selesai.";
      }
    } else {
      const status = screen.querySelector(".details > div:last-child dd");
      if (status) status.textContent = "Anda menuju lokasi";
    }
    message.textContent =
      "Simulasi: Anda menuju lokasi. Insiden belum dinyatakan selesai.";
  } else if (action === "pin") {
    message.textContent =
      "Simulasi perpindahan ke layar PIN. Masukkan PIN hanya di aplikasi asli. Mockup ini tidak meminta atau memeriksa PIN.";
  } else if (action === "monitor") {
    message.textContent =
      "Simulasi kembali ke pemantauan. Respons rekan tercatat; keadaan aman belum dikonfirmasi.";
  }
  message.focus();
});
