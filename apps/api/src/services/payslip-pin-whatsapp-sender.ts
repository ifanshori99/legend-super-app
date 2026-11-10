// WhatsApp adapter for the payslip PIN reset code (legend-qih2m). Connects the
// `PayslipPinOtpSender` port to `MessagingProvider.send`.
//
// The one-time code and the phone number are secrets: this module never logs,
// never puts them in an error, and never rethrows the provider's error (which
// may echo the request). Any failure is a plain "not delivered" error; the
// service turns it into a 503 and rolls the challenge back.
import type { MessagingProvider } from "@starter/shared/adapters";
import { outletIdSchema } from "@starter/shared/core";
import { PAYSLIP_PIN_OTP_TTL_MINUTES } from "@starter/shared/hris/payroll";
import type { PayslipPinOtpSender } from "./payslip-pin.service.ts";

/** The OTP message template (WhatsApp text; the provider has no template type). */
export function renderPayslipPinOtpText(code: string): string {
  return [
    `Kode reset PIN slip gaji Anda: ${code}`,
    `Berlaku ${PAYSLIP_PIN_OTP_TTL_MINUTES} menit.`,
    "Jangan bagikan kode ini kepada siapa pun, termasuk HR.",
  ].join("\n");
}

export function createPayslipPinWhatsappSender(
  provider: MessagingProvider,
): PayslipPinOtpSender {
  return {
    async send(context, message) {
      let accepted: boolean;
      try {
        const result = await provider.send(context, {
          tenantId: context.tenant.tenantId,
          outletId: outletIdSchema.parse(message.outletId),
          reference: `payslip-pin-otp:${message.challengeId}`,
          recipient: message.phoneE164.replace(/\D/g, ""),
          text: renderPayslipPinOtpText(message.code),
        });
        accepted = result.accepted;
      } catch {
        throw new Error("Payslip PIN code was not delivered");
      }
      if (!accepted) throw new Error("Payslip PIN code was not delivered");
    },
  };
}
