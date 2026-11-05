/**
 * iOS-style toggle switch. Renders a real checkbox (role="switch"), so `onChange` receives the
 * normal change event (`e.target.checked`). Children become the label text.
 */
const Switch = ({ checked, onChange, disabled = false, children, className = "", ...rest }) => (
  <label
    className={`inline-flex items-center gap-2 ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"} ${className}`}>
    <input
      type="checkbox"
      role="switch"
      className="peer sr-only"
      checked={!!checked}
      onChange={onChange}
      disabled={disabled}
      {...rest}
    />
    <span
      aria-hidden="true"
      className="relative inline-block h-6 w-10 shrink-0 rounded-full bg-border-color transition-colors duration-200 peer-checked:bg-brand-primary peer-focus-visible:ring-2 peer-focus-visible:ring-brand-primary peer-focus-visible:ring-offset-2 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition-transform after:duration-200 after:content-[''] peer-checked:after:translate-x-4"
    />
    {children != null && <span>{children}</span>}
  </label>
);

export default Switch;
