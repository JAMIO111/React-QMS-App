import RHFComboBox from "./RHFComboBox";

/**
 * The custom combo box for a plain list: options are `{ value, label, hint?, disabled? }` (the shape the native `SelectField` took), the value is an option's `value`, and `onChange`
 * gets the chosen `value` or `null` when it is cleared. The order of the options is kept. A required field cannot be cleared.
 */
const ComboField = ({ label, value, onChange, options, required = false, disabled = false, placeholder = "Select...", hint, error, className = "", clearable, ...rest }) => (
  <RHFComboBox
    label={label}
    value={value ?? null}
    onChange={(id) => onChange(id ?? null)}
    options={options.map((o) => ({ id: o.value, name: o.label, hint: o.hint, disabled: o.disabled }))}
    required={required}
    disabled={disabled}
    placeholder={placeholder}
    hint={hint}
    error={error}
    className={className}
    sort={false}
    clearable={clearable ?? !required}
    {...rest}
  />
);

export default ComboField;
