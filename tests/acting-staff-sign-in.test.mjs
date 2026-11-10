// legend-5u03q: a successful sign-in lifts this tab's POS cashier hold
// (endActingStaffMode), so a new login does not inherit the previous one's
// "PIN required". The behaviour of endActingStaffMode is covered in
// acting-staff-path.test.mjs; this checks that every browser sign-in success
// path calls it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SIGN_IN_SUCCESS = [
  "apps/web/src/components/auth-form.tsx",
  "apps/web/src/features/ws01-login/components/sign-in-screen.tsx",
  "apps/web/src/features/ws01-login/components/verify-link.tsx",
  // Google: the success lands through an API redirect with no client code,
  // so the hold is lifted before leaving for the provider.
  "apps/web/src/features/ws01-login/components/google-login.tsx",
];

for (const file of SIGN_IN_SUCCESS)
  test(`${file} lifts the cashier hold on sign-in success`, () => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(
      source,
      /import \{[^}]*\bendActingStaffMode\b[^}]*\} from "@\/lib\/api\/acting-staff"/,
    );
    assert.match(source, /\bendActingStaffMode\(\)/);
  });
