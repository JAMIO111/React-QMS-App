import { useEffect, useState } from "react";
import CodeForm from "./CodeForm";
import { describeMfaError, startEnrolment, verifyCode } from "../../lib/mfa";

/**
 * Adds an authenticator app: shows a QR code (and the key for manual entry), then confirms a code.
 * Calls onDone() once the factor is verified (the session is then aal2).
 */
const EnrolAuthenticator = ({ onDone, onCancel }) => {
  const [enrolment, setEnrolment] = useState(null);
  const [failed, setFailed] = useState(null);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    let active = true;
    startEnrolment()
      .then((e) => active && setEnrolment(e))
      .catch((err) => active && setFailed(describeMfaError(err)));
    return () => {
      active = false;
    };
  }, []);

  if (failed) {
    return (
      <p role="alert" className="text-sm text-error-color">
        Couldn't start set-up: {failed}
      </p>
    );
  }
  if (!enrolment) {
    return (
      <p role="status" className="text-secondary-text">
        Preparing…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ol className="list-decimal pl-5 text-sm text-primary-text flex flex-col gap-1">
        <li>Open an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password…).</li>
        <li>Scan this QR code, or enter the key manually.</li>
        <li>Type the 6-digit code it shows.</li>
      </ol>
      <div className="flex flex-wrap items-start gap-4">
        <img src={enrolment.qrCode} alt="QR code for your authenticator app" className="h-44 w-44 rounded-lg bg-white p-2" />
        <div className="flex flex-col gap-2 text-sm">
          <button
            type="button"
            onClick={() => setShowKey((s) => !s)}
            className="self-start text-link-color hover:underline cursor-pointer"
            aria-expanded={showKey}>
            {showKey ? "Hide key" : "Can't scan? Show the key"}
          </button>
          {showKey && (
            <code className="break-all rounded bg-tertiary-bg px-2 py-1 font-mono text-primary-text select-all">{enrolment.secret}</code>
          )}
        </div>
      </div>
      <CodeForm
        submitLabel="Turn on two-factor"
        describeError={describeMfaError}
        onSubmit={async (code) => {
          await verifyCode(enrolment.factorId, code);
          await onDone?.();
        }}
      />
      {onCancel && (
        <button type="button" onClick={onCancel} className="self-start text-sm text-secondary-text hover:underline cursor-pointer">
          Cancel
        </button>
      )}
    </div>
  );
};

export default EnrolAuthenticator;
