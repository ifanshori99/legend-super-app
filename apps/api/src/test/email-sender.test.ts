// legend-k2l SMTP sender (SumoPod): transport options, mail fields, error
// redaction and env mapping. Uses a fake createTransport; no real server.
import { describe, expect, it } from "vitest";
import {
  createSmtpSender,
  smtpConfigFromEnv,
  type EmailMessage,
  type SmtpConfig,
} from "../lib/email-sender";

type TransportOptions = Record<string, unknown>;
type Mail = Record<string, unknown>;

const PASSWORD = "s3cret-pass-value";
const RECIPIENT = "user@x.test";

const config: SmtpConfig = {
  host: "smtp.sumopod.com",
  port: 465,
  secure: true,
  user: "mailer-user",
  pass: PASSWORD,
};

const message: EmailMessage = {
  from: "noreply@brand.example.test",
  to: RECIPIENT,
  subject: "Masuk ke Legend",
  text: "Buka tautan: https://x.test/masuk/email#token=abc",
  html: "<p>Buka tautan</p>",
};

function fakeTransport(failWith?: unknown) {
  const captured: { options: TransportOptions[]; mails: Mail[] } = {
    options: [],
    mails: [],
  };
  const createTransport = (options: unknown) => {
    captured.options.push(options as TransportOptions);
    return {
      async sendMail(mail: unknown) {
        captured.mails.push(mail as Mail);
        if (failWith !== undefined) throw failWith;
        return { accepted: [RECIPIENT] };
      },
    };
  };
  return { captured, createTransport: createTransport as never };
}

describe("createSmtpSender", () => {
  it("opens the transport with implicit TLS, auth and 10s timeouts", async () => {
    const { captured, createTransport } = fakeTransport();
    await createSmtpSender(config, { createTransport }).send(message);

    expect(captured.options).toHaveLength(1);
    expect(captured.options[0]).toEqual({
      host: "smtp.sumopod.com",
      port: 465,
      secure: true,
      auth: { user: "mailer-user", pass: PASSWORD },
      requireTLS: false,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });
  });

  it("requires STARTTLS when secure is false", async () => {
    const { captured, createTransport } = fakeTransport();
    await createSmtpSender(
      { ...config, port: 587, secure: false },
      { createTransport },
    ).send(message);

    expect(captured.options[0]).toMatchObject({
      port: 587,
      secure: false,
      requireTLS: true,
    });
  });

  it("passes from, to, subject, text and html to sendMail", async () => {
    const { captured, createTransport } = fakeTransport();
    await createSmtpSender(config, { createTransport }).send(message);

    expect(captured.mails).toHaveLength(1);
    expect(captured.mails[0]).toEqual({
      from: message.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  });

  it("throws a redacted error carrying only the nodemailer code", async () => {
    const failure = Object.assign(
      new Error(`535 bad pass for ${RECIPIENT} (${PASSWORD})`),
      {
        code: "EAUTH",
        response: `535 5.7.8 Authentication failed for ${RECIPIENT}`,
      },
    );
    const { createTransport } = fakeTransport(failure);
    const sender = createSmtpSender(config, { createTransport });

    const error = await sender.send(message).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const text = (error as Error).message;
    expect(text).toContain("EAUTH");
    expect(text).not.toContain(RECIPIENT);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("bad pass");
    expect(text).not.toContain("Authentication failed");
  });

  it("throws a generic error when the failure has no code", async () => {
    const { createTransport } = fakeTransport(
      new Error(`boom for ${RECIPIENT}`),
    );
    const error = await createSmtpSender(config, { createTransport })
      .send(message)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("SMTP send failed");
    expect((error as Error).message).not.toContain(RECIPIENT);
  });
});

describe("smtpConfigFromEnv", () => {
  const full = {
    SMTP_HOST: "smtp.sumopod.com",
    SMTP_USER: "mailer-user",
    SMTP_PASS: PASSWORD,
  };

  it("returns null when the host is missing", () => {
    expect(
      smtpConfigFromEnv({
        SMTP_USER: full.SMTP_USER,
        SMTP_PASS: full.SMTP_PASS,
      }),
    ).toBeNull();
  });

  it("returns null when the user is missing", () => {
    expect(
      smtpConfigFromEnv({
        SMTP_HOST: full.SMTP_HOST,
        SMTP_PASS: full.SMTP_PASS,
      }),
    ).toBeNull();
  });

  it("returns null when the password is missing", () => {
    expect(
      smtpConfigFromEnv({
        SMTP_HOST: full.SMTP_HOST,
        SMTP_USER: full.SMTP_USER,
      }),
    ).toBeNull();
  });

  it("returns null for an empty environment", () => {
    expect(smtpConfigFromEnv({})).toBeNull();
  });

  it("defaults port 465 and secure true", () => {
    expect(smtpConfigFromEnv(full)).toEqual({
      host: "smtp.sumopod.com",
      port: 465,
      secure: true,
      user: "mailer-user",
      pass: PASSWORD,
    });
  });

  it("honours an explicit port and secure flag", () => {
    expect(
      smtpConfigFromEnv({ ...full, SMTP_PORT: 587, SMTP_SECURE: false }),
    ).toMatchObject({ port: 587, secure: false });
  });
});
