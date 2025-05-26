import supabase from "./supabase-client";

export const signUp = async (email, password) => {
  return await supabase.auth
    .signUp({
      email,
      password,
      options: {
        emailRedirectTo: "http://localhost:5173/Onboarding",
      },
    })
    .then(({ data, error }) => {
      if (error) {
        throw new Error(error.message);
      }
      return data;
    });
};

export const signIn = async (email, password) => {
  return await supabase.auth
    .signInWithPassword({ email, password })
    .then(({ data, error }) => {
      if (error) {
        throw new Error(error.message);
      }
      return data;
    });
};

export const signOut = async () => {
  return await supabase.auth.signOut().then(({ error }) => {
    if (error) {
      throw new Error(error.message);
    }
  });
};

export const getUser = async () => {
  const { data } = await supabase.auth.getUser();
  return data.user;
};

export const resendVerification = async (email) => {
  const { error } = await supabase.auth.resend({
    type: "signup",
    email,
    options: {
      emailRedirectTo: "http://localhost:5173/Onboarding",
    },
  });

  if (error) {
    throw new Error(error.message);
  }

  return true;
};
