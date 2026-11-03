import supabase from "../supabase-client";

/**
 * Two-factor authentication (TOTP authenticator apps) through Supabase Auth.
 * Assurance levels: "aal1" = password only, "aal2" = passed a second factor.
 */

const unwrap = ({ data, error }) => {
  if (error) throw error;
  return data;
};

/** { currentLevel, nextLevel }: nextLevel "aal2" with currentLevel "aal1" means "ask for the code". */
export async function getAssurance() {
  const data = unwrap(await supabase.auth.mfa.getAuthenticatorAssuranceLevel());
  return { currentLevel: data.currentLevel ?? "aal1", nextLevel: data.nextLevel ?? "aal1" };
}

/** The user's verified authenticator-app factors. */
export async function verifiedTotpFactors() {
  const data = unwrap(await supabase.auth.mfa.listFactors());
  return (data.totp ?? []).filter((f) => f.status === "verified");
}

/**
 * Starts adding an authenticator app: returns { factorId, qrCode (SVG data URL), secret }.
 * Abandoned set-ups (unverified factors) are removed first, so trying again always works.
 */
export async function startEnrolment() {
  const factors = unwrap(await supabase.auth.mfa.listFactors());
  for (const factor of (factors.all ?? []).filter((f) => f.status === "unverified")) {
    unwrap(await supabase.auth.mfa.unenroll({ factorId: factor.id }));
  }
  const data = unwrap(
    await supabase.auth.mfa.enroll({ factorType: "totp", issuer: "QMS", friendlyName: `Authenticator ${new Date().toISOString().slice(0, 16)}` })
  );
  return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
}

/** Confirms a 6-digit code for a factor; on success the session is upgraded to aal2. */
export async function verifyCode(factorId, code) {
  unwrap(await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.replace(/\s+/g, "") }));
}

export async function removeFactor(factorId) {
  unwrap(await supabase.auth.mfa.unenroll({ factorId }));
}

/** Turns Supabase MFA errors into short, user-facing text. */
export function describeMfaError(error) {
  const code = error?.code ?? "";
  if (code === "mfa_verification_failed" || /invalid totp|invalid code/i.test(error?.message ?? "")) {
    return "That code isn't right. Check the time on your phone and try the newest code.";
  }
  if (code === "mfa_challenge_expired") return "The code expired. Enter the newest code from your app.";
  if (error?.status === 429) return "Too many attempts. Wait a minute and try again.";
  return "Something went wrong. Please try again.";
}
