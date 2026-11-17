import supabase from "./supabase-client";

/**
 * Where a link in an email lands: the confirm page, which uses the one-time token only when the person presses Continue (company email security
 * that opens links first can't use it up), then goes to `next`. The email templates add `token_hash` and `type` to this address.
 */
export const emailLinkUrl = (next) => `${window.location.origin}/auth/confirm?next=${encodeURIComponent(next)}`;

/** Uses the one-time token from an email link (on the confirm page, when the person presses Continue). Signs the person in. */
export const verifyEmailLink = async (tokenHash, type) => {
  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
  if (error) throw error;
};

/**
 * Creates an account. The name and the accepted terms travel as sign-up metadata (the database keeps them on the profile).
 * Resolves `{ confirmationSent, user }`. An address that already has an account looks the same as a new one (Supabase answers with a user that has
 * no identities), so the screen never reveals whether an email is registered.
 */
export const signUp = async (email, password, { firstName, surname, termsVersion } = {}) => {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: emailLinkUrl("/"),
      data: { first_name: firstName, surname, terms_version: termsVersion },
    },
  });
  if (error) throw error;
  return { user: data.user, session: data.session, confirmationSent: !data.session };
};

export const signIn = async (email, password) => {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
};

export const signOut = async () => {
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(error.message);
};

export const getUser = async () => {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw new Error(error.message);
  return data.user;
};

/** Sends the verification email again. Throws Supabase's error (with `status`, so a rate limit can be told apart). */
export const resendVerification = async (email) => {
  const { error } = await supabase.auth.resend({
    type: "signup",
    email,
    options: { emailRedirectTo: emailLinkUrl("/") },
  });
  if (error) throw error;
  return true;
};

/** Minimum password rules applied in the app (Supabase enforces its own project minimum too). */
export const PASSWORD_MIN_LENGTH = 10;
export const passwordProblems = (password, email) => {
  const problems = [];
  if (!password || password.length < PASSWORD_MIN_LENGTH) problems.push(`At least ${PASSWORD_MIN_LENGTH} characters`);
  if (password && !/[A-Za-z]/.test(password)) problems.push("At least one letter");
  if (password && !/[0-9]/.test(password)) problems.push("At least one number");
  if (password && email && password.toLowerCase().includes(email.split("@")[0].toLowerCase())) {
    problems.push("Must not contain your email name");
  }
  return problems;
};

/**
 * Sends the "reset your password" email. Supabase answers the same whether or not the address has
 * an account, so the UI must not reveal which (avoids account enumeration).
 */
export const requestPasswordReset = async (email) => {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: emailLinkUrl("/set-password?mode=reset"),
  });
  if (error) throw error;
};

/** Sets a new password for the signed-in user (after an invite or reset link signs them in). */
export const updatePassword = async (password) => {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
};
