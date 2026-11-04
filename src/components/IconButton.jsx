import clsx from "clsx";

const IconButton = ({ selected, icon, callback, title, color, count }) => {
  const colorClasses = {
    green: "bg-success-color/15 ring-success-color text-primary-text",
    blue: "bg-brand-primary/20 ring-brand-primary text-primary-text",
    red: "bg-error-color/15 ring-error-color text-primary-text",
  };
  const baseClass =
    "border hover:border-border-dark-color active:scale-97 border-border-color w-fit box-border h-9 px-2 gap-2 flex justify-center rounded-lg items-center cursor-pointer";

  const selectedClass = selected
    ? clsx(colorClasses[color], "ring-2 border-transparent")
    : "text-primary-text";

  return (
    <button
      type="button"
      title={title}
      aria-pressed={!!selected}
      onClick={() => callback(title)}
      className={clsx(baseClass, selectedClass)}>
      {count > 0 ? (
        <div className="rounded-full bg-cta-color text-white w-5 h-5 p-1 text-sm font-semibold flex items-center justify-center">
          {count}
        </div>
      ) : (
        icon
      )}
      <p>{title}</p>
    </button>
  );
};

export default IconButton;
