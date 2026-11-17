/**
 * Optimistic guesses for the command-style mutation hooks (`mutate({ action, id, body, show })`): the actions listed as guessed change the cached
 * data at once (lib/optimistic.js `guessCache`), are put back if the server refuses, and the refusal is told in a toast (the dialog that sent it
 * has usually closed already). The server's answer (`mergeResponse`) and the refetch after every action correct the guess.
 */
import { describeApiError } from "./api-client";
import { guessCache, rollbackGuess } from "./optimistic";

/** `obj` with the values of `body` for the keys it already has (rowVersion and undefined values left out); `rename` maps body keys to object keys. */
export const setFields = (obj, body = {}, rename = {}) => {
  let changed = false;
  const out = { ...obj };
  for (const [k, v] of Object.entries(body ?? {})) {
    if (k === "rowVersion" || v === undefined) continue;
    const target = rename[k] ?? k;
    if (!(target in obj) || obj[target] === v) continue;
    out[target] = v;
    changed = true;
  }
  return changed ? out : obj;
};

/** The current time as the server stamps it. */
export const nowIso = () => new Date().toISOString();

/**
 * `onMutate` / `onError` for a command hook. `guess(data, vars)` returns the new data (or the same object); only actions in `guessed` are guessed,
 * and only they toast on failure (the others keep their dialog open with the error in it). A cancelled edit conflict is not an error to tell.
 */
export const commandGuessHandlers = ({ queryClient, prefix, guess, guessed, showToast, failed = "Not saved" }) => ({
  onMutate: (vars) => (guessed.has(vars?.action) ? guessCache(queryClient, prefix, (data) => guess(data, vars)) : { optimistic: false }),
  onError: (error, vars, context) => {
    rollbackGuess(queryClient, context);
    if (guessed.has(vars?.action) && !error?.cancelled) showToast?.({ type: "error", title: failed, message: describeApiError(error) });
  },
});

/**
 * Send a command and run `onDone` (usually: close the dialog): straight away for a guessed command (the screen already shows the result; a
 * refusal is told in a toast), else once the server has answered (the dialog stays open and shows the error). `options` go to `mutate`.
 */
export const sendCommand = (mutation, guessed, vars, onDone, options = {}) => {
  if (guessed.has(vars?.action)) {
    mutation.mutate(vars, options);
    onDone?.();
    return;
  }
  mutation.mutate(vars, { ...options, onSuccess: (...args) => { options.onSuccess?.(...args); onDone?.(); } });
};
