/** Shared layout for the sign-in family of pages (inside AuthPage). */
export const AuthCard = ({ title, subtitle, children }) => (
  <div className="flex flex-col items-start justify-center h-full w-full max-w-md p-10 gap-6">
    <img
      src="/Logo-black-on-yellow.png"
      alt="Logo"
      className="w-14 h-14 absolute top-5 left-5 rounded-lg mb-4 border border-primary-text/50"
    />
    <div className="flex flex-col gap-2">
      <h1 className="text-3xl text-left text-primary-text font-semibold">{title}</h1>
      {subtitle && <p className="text-left text-md font-light text-secondary-text">{subtitle}</p>}
    </div>
    {children}
  </div>
);

export const authInputClass =
  "border w-full text-primary-text placeholder:text-secondary-text border-border-color hover:border-border-dark-color p-2 bg-text-input-color rounded-lg focus:outline-none focus:border-brand-primary";

export const authButtonClass =
  "w-full bg-cta-btn-bg border border-cta-btn-border hover:border-cta-btn-border-hover hover:bg-cta-btn-bg-hover text-primary-text p-2 rounded-lg cursor-pointer text-lg disabled:opacity-50 disabled:cursor-not-allowed";

export const AuthNotice = ({ tone = "info", children }) => (
  <div
    role={tone === "error" ? "alert" : "status"}
    className={`w-full rounded-lg border p-3 text-sm ${
      tone === "error" ? "border-error-color/40 bg-error-color/10 text-primary-text" : "border-border-color bg-tertiary-bg text-primary-text"
    }`}>
    {children}
  </div>
);
