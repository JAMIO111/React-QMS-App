import supabase from "./supabase-client";

// ✅ Now accepts a showToast callback (optional)
export const signUp = async (email, password, showToast) => {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: "http://localhost:5173/Onboarding",
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
      emailRedirectTo: "http://localhost:5173/Onboarding",
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
