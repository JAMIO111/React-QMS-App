import { useId, useState } from "react";
import CTAButton from "@/components/CTAButton";

/** One 6-digit authenticator code with a submit button. `onSubmit(code)` may throw to show an error. */
const CodeForm = ({ onSubmit, submitLabel = "Verify", describeError, autoFocus = true }) => {
  const [code, setCode] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const ready = /^\d{6}$/.test(code);

  const submit = async (e) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(code);
    } catch (err) {
      setError(describeError ? describeError(err) : "That code didn't work. Try again.");
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex w-full flex-col gap-3" noValidate>
      <label htmlFor={id} className="text-primary-text" data-required>
        6-digit code from your authenticator app
      </label>
      <input
        id={id}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus={autoFocus}
        maxLength={6}
        placeholder="123456"
        aria-invalid={error ? true : undefined}
        className="w-44 rounded-lg border border-border-color bg-text-input-color p-2 text-center font-mono text-2xl tracking-[0.4em] text-primary-text focus:outline-none focus:border-brand-primary"
      />
      {error && (
        <p role="alert" className="text-sm text-error-color">
          {error}
        </p>
      )}
      <CTAButton
        buttonType="submit"
        disabled={!ready || busy}
        type="main" size="lg" className="self-start">
        {busy ? "Checking…" : submitLabel}
      </CTAButton>
    </form>
  );
};

export default CodeForm;
