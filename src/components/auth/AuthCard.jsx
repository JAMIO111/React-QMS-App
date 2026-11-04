/** Shared layout for the sign-in family of pages (inside AuthPage). */
export const AuthCard = ({ title, subtitle, children }) => (
  <div className="flex w-full flex-col items-start justify-center gap-6">
    <div className="flex flex-col gap-2">
      <h1 className="text-3xl text-left text-primary-text font-semibold">{title}</h1>
      {subtitle && <p className="text-left text-md font-light text-secondary-text">{subtitle}</p>}
    </div>
    {children}
  </div>
);

export const authInputClass =
  "border w-full text-primary-text placeholder:text-secondary-text border-border-color hover:border-border-dark-color p-2 bg-text-input-color rounded-lg focus:outline-none focus:border-brand-primary";

/** Primary action on the sign-in pages: Fortress QMS blue, whatever an organisation's theme colour. */
export const authButtonClass =
  "w-full rounded-lg bg-[#2563eb] p-2.5 text-lg font-semibold text-white shadow-sm hover:bg-[#1d4ed8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563eb] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";

export const AuthNotice = ({ tone = "info", children }) => (
  <div
    role={tone === "error" ? "alert" : "status"}
    className={`w-full rounded-lg border p-3 text-sm ${
      tone === "error" ? "border-error-color/40 bg-error-color/10 text-primary-text" : "border-border-color bg-tertiary-bg text-primary-text"
    }`}>
    {children}
  </div>
);
