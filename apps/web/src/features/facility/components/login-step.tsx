// Step 1 of the facility journey: WhatsApp login (PRD §3 F22 Titik Masuk,
// alur S langkah 2: "Pemesanan wajib login dengan WhatsApp terverifikasi").
// The verification port lives in `wa-login.ts`; until AUTH-02 exposes its
// endpoints the gate explains that instead of faking a signed-in customer.
import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { useT } from "@/components/i18n";
import { API_MOCK } from "@/lib/api/mock-flag.ts";
import {
  isValidOtp,
  isValidPhone,
  normalizePhone,
  requestWhatsAppCode,
  verifyWhatsAppCode,
  OTP_LENGTH,
} from "../wa-login";
import { ApiFailure } from "./shared";

export function LoginStep({ onVerified }: { onVerified: () => void }) {
  const t = useT();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState<"send" | "verify" | null>(null);
  const [error, setError] = useState<unknown>(null);

  const phoneError =
    phone.length > 0 && !isValidPhone(phone)
      ? t("facility.login.phoneError")
      : undefined;
  const codeError =
    code.length > 0 && !isValidOtp(code)
      ? t("facility.login.codeError")
      : undefined;

  async function send() {
    setError(null);
    setPending("send");
    try {
      await requestWhatsAppCode(phone);
      setSent(true);
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(null);
    }
  }

  async function verify() {
    setError(null);
    setPending("verify");
    try {
      await verifyWhatsAppCode(phone, code);
      onVerified();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="flex items-center gap-2 text-xl leading-7 font-semibold">
          <ShieldCheck className="size-5" aria-hidden="true" />
          {t("facility.login.title")}
        </h2>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("facility.login.hint")}
        </p>
      </div>

      {!sent ? (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <FormField
            label={t("facility.login.phoneLabel")}
            hint={t("facility.login.phoneHint")}
            error={phoneError}
            required
          >
            <Input
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder={t("facility.login.phoneHint")}
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              onBlur={() => setPhone((value) => normalizePhone(value))}
            />
          </FormField>
          <Button
            type="submit"
            size="lg"
            loading={pending === "send"}
            disabled={!isValidPhone(phone)}
          >
            {t("facility.login.sendCode")}
          </Button>
        </form>
      ) : (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void verify();
          }}
        >
          <FormField
            label={t("facility.login.codeLabel")}
            hint={t("facility.login.codeHint", {
              phone: normalizePhone(phone),
            })}
            error={codeError}
            required
          >
            <Input
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={OTP_LENGTH}
              pattern="\d{6}"
              value={code}
              onChange={(event) =>
                setCode(
                  event.target.value.replace(/\D/g, "").slice(0, OTP_LENGTH),
                )
              }
            />
          </FormField>
          <Button
            type="submit"
            size="lg"
            loading={pending === "verify"}
            disabled={!isValidOtp(code)}
          >
            {t("facility.login.verify")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setSent(false);
              setCode("");
              setError(null);
            }}
          >
            {t("facility.login.changeNumber")}
          </Button>
        </form>
      )}

      {error !== null && (
        <ApiFailure error={error} onRetry={() => (sent ? verify() : send())} />
      )}

      {API_MOCK && (
        <p className="text-sm leading-5 text-muted-foreground">
          {t("facility.login.mockHint")}
        </p>
      )}
    </div>
  );
}
