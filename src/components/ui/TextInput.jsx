import { HiMiniXMark } from "react-icons/hi2";

const TextInput = ({
  value,
  onChange,
  placeholder = "Enter text...",
  label,
  icon: Icon,
}) => {
  return (
    <div className="w-full h-17">
      {label && <label className="block text-primary-text">{label}</label>}
      <div
        className="relative flex items-center border border-border-color rounded-lg pl-2 pr-10 py-2 bg-text-input-color
        hover:border-border-dark-color focus-within:border-brand-primary focus-within:hover:border-brand-primary">
        {Icon && (
          <Icon className="w-5 h-5 text-primary-text mr-2 flex-shrink-0 pointer-events-none" />
        )}

        <input
          type="text"
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          className="flex-grow bg-transparent outline-none text-primary-text placeholder:text-sm placeholder:text-muted"
        />

        {value && (
          <button
            type="button"
            onClick={() => onChange({ target: { value: "" } })}
            className="absolute right-2 text-primary-text hover:bg-border-color rounded-sm p-0.5"
            aria-label="Clear">
            <HiMiniXMark className="w-5 h-5" />
          </button>
        )}
      </div>
    </div>
  );
};

export default TextInput;
