import { forwardRef, useId, useState } from "react";
import { EyeIcon, EyeOffIcon, LockIcon } from "@/components/icons";
import { authInputClass } from "./AuthCard";

/** Password field with a show/hide toggle (a real toggle button, keyboard accessible). */
const PasswordInput = forwardRef(({ label, error, hint, autoComplete = "new-password", ...rest }, ref) => {
  const [visible, setVisible] = useState(false);
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="flex flex-col gap-1 w-full">
      <label htmlFor={id} className="text-left text-primary-text">
        {label} <span className="text-error-color">*</span>
      </label>
      <div className="relative w-full">
        <LockIcon className="absolute left-2.5 top-2.5 h-5 w-5 text-secondary-text pointer-events-none" />
        <input
          id={id}
          ref={ref}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          aria-invalid={error ? true : undefined}
          aria-describedby={hint || error ? hintId : undefined}
          className={`${authInputClass} pl-10 pr-11`}
          {...rest}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          className="absolute right-2 top-1.5 rounded p-1 text-secondary-text hover:text-primary-text cursor-pointer">
          {visible ? <EyeIcon className="h-5 w-5" /> : <EyeOffIcon className="h-5 w-5" />}
        </button>
      </div>
      {(error || hint) && (
        <p id={hintId} className={`text-sm ${error ? "text-error-color" : "text-secondary-text"}`}>
          {error || hint}
        </p>
      )}
    </div>
  );
});
PasswordInput.displayName = "PasswordInput";

export default PasswordInput;
