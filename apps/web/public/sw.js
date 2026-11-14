/* global self */
/* Push payloads contain public-facing text only; endpoint and keys stay server-side. */
function notificationTarget(value) {
  if (typeof value !== "string" || !/^\/(?!\/)[^\s\\]*$/.test(value))
    return "/";
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin ? value : "/";
  } catch {
    return "/";
  }
}

self.addEventListener("push", (event) => {
  let message;
  try {
    message = event.data?.json();
  } catch {
    return;
  }
  if (
    !message ||
    typeof message.title !== "string" ||
    !message.title.trim() ||
    typeof message.body !== "string" ||
    typeof message.tag !== "string" ||
    !message.tag
  )
    return;
  event.waitUntil(
    self.registration.showNotification(message.title, {
      body: message.body,
      tag: message.tag,
      renotify: false,
      data: { url: notificationTarget(message.data?.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const target = new URL(
        notificationTarget(event.notification.data?.url),
        self.location.origin,
      ).href;
      const existing = windows.find((client) => client.url === target);
      if (existing) return existing.focus();
      return self.clients.openWindow(target);
    })(),
  );
});
