// Standalone equivalents of the application's Brevo and Kirimdev transports.
// Provider hosts and operator-selected destinations never come from probe data.
const required = (config, key, pattern) => {
  const value = config[key]?.trim();
  if (!value || (pattern && !pattern.test(value)))
    throw new Error(`${key} is required and must be valid`);
  return value;
};
const mailbox = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Use the machine-readable check/status identifiers consistently across the
// relay and direct channels; no tenant-authored content enters the message.
function alertText(alert) {
  return [
    alert.source,
    alert.check,
    alert.status,
    alert.observedAt,
    alert.tenantId,
    alert.outletId,
  ]
    .filter(Boolean)
    .join(" / ");
}

export function createAlertChannels(config, fetcher, relays = []) {
  const channels = new Map(relays);
  for (const [channel, provider, allowed] of [
    ["email", config.ALERT_EMAIL_PROVIDER, "brevo"],
    ["whatsapp", config.ALERT_WHATSAPP_PROVIDER, "kirimdev"],
  ]) {
    if (!provider || provider === "relay") continue;
    if (provider !== allowed)
      throw new Error(
        `ALERT_${channel.toUpperCase()}_PROVIDER must be relay or ${allowed}`,
      );
    if (channels.has(channel))
      throw new Error(`Choose one ${channel} alert provider`);
    if (channel === "email") {
      const apiKey = required(config, "ALERT_BREVO_API_KEY", /^[\x21-\x7e]+$/);
      const from = required(config, "ALERT_EMAIL_FROM", mailbox);
      const to = required(config, "ALERT_EMAIL_TO", mailbox);
      channels.set(channel, async (alert) => {
        const response = await fetcher("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
          headers: {
            "api-key": apiKey,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            sender: { email: from },
            to: [{ email: to }],
            subject: `${alert.source}: ${alert.check} ${alert.status}`,
            textContent: alertText(alert),
            headers: { idempotencyKey: alert.deliveryId },
            tags: ["legend-monitor"],
          }),
        });
        if (response.status >= 200 && response.status < 300) return;
        if (response.status >= 400 && response.status < 500) {
          const body = await response.json().catch(() => null);
          if (body?.code === "duplicate_parameter") return;
        }
        throw new Error(`Brevo alert delivery failed (${response.status})`);
      });
    } else {
      const apiKey = required(
        config,
        "ALERT_KIRIMDEV_API_KEY",
        /^kdv_live_[A-Za-z0-9_-]{24}$/,
      );
      const sender = required(
        config,
        "ALERT_WHATSAPP_PHONE_NUMBER_ID",
        /^\d{6,20}$/,
      );
      const to = required(config, "ALERT_WHATSAPP_TO", /^\+?[1-9]\d{7,14}$/);
      // Scheduled alerts may arrive outside WhatsApp's 24-hour service window.
      // Require an approved template with one body parameter for the summary.
      const template = required(
        config,
        "ALERT_WHATSAPP_TEMPLATE_NAME",
        /^[a-z0-9_]+$/,
      );
      const language = required(
        config,
        "ALERT_WHATSAPP_TEMPLATE_LANGUAGE",
        /^[a-z]{2,3}(?:_[A-Z]{2})?$/,
      );
      channels.set(channel, async (alert) => {
        const response = await fetcher(
          `https://api.kirimdev.com/v1/${encodeURIComponent(sender)}/messages`,
          {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(10000),
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
              "Idempotency-Key": alert.deliveryId,
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              to: `+${to.replace(/^\+/, "")}`,
              type: "template",
              template: {
                name: template,
                language: { code: language },
                components: [
                  {
                    type: "body",
                    parameters: [{ type: "text", text: alertText(alert) }],
                  },
                ],
              },
            }),
          },
        );
        const body = await response.json().catch(() => null);
        if (
          [200, 202].includes(response.status) &&
          typeof body?.data?.id === "string" &&
          body.data.id.length > 0
        )
          return;
        throw new Error(`Kirimdev alert delivery failed (${response.status})`);
      });
    }
  }
  return [...channels];
}
