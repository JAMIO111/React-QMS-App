import supabase from "./supabase-client";

// ✅ Now accepts a showToast callback (optional)
export const signUp = async (email, password, showToast) => {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${window.location.origin}/login`,
    },
  });

  if (error) {
    if (showToast) {
      if (error.message.includes("already registered")) {
        showToast({
          type: "error",
          title: "Email Already Registered",
          message:
            "This email is already registered. Please log in or use a different email.",
        });
      } else {
        showToast({
          type: "error",
          title: "Unexpected Error",
          message: error.message,
        });
      }
    }
    throw new Error(error.message);
  }

  return data;
};

export const signIn = async (email, password, showToast) => {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    if (showToast) {
      if (error.message.includes("Invalid login credentials")) {
        showToast({
          type: "error",
          title: "Login Failed",
          message: "Invalid email or password. Please try again.",
        });
      } else {
        showToast({
          type: "error",
          title: "Unexpected Error",
          message: error.message,
        });
      }
    }
    throw new Error(error.message);
  }

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

export const resendVerification = async (email, showToast) => {
  const { error } = await supabase.auth.resend({
    type: "signup",
    email,
    options: {
      emailRedirectTo: `${window.location.origin}/login`,
    },
  });

  if (error) {
    if (showToast) {
      showToast({
        type: "error",
        title: "Verification Failed",
        message: error.message,
      });
    }
    throw new Error(error.message);
  }

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
    redirectTo: `${window.location.origin}/set-password?mode=reset`,
  });
  if (error) throw error;
};

/** Sets a new password for the signed-in user (after an invite or reset link signs them in). */
export const updatePassword = async (password) => {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
};
