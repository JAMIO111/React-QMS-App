import clsx from "clsx";

const IconButton = ({ selected, icon, callback, title, color, count }) => {
  const colorClasses = {
    green: "bg-green-100 ring-green-600",
    blue: "bg-indigo-300/80 ring-blue-600",
    red: "bg-red-100 ring-red-600",
  };
  const baseClass =
    "border hover:border-border-dark-color active:scale-97 border-border-color w-fit box-border h-9 px-2 gap-2 flex justify-center rounded-lg items-center cursor-pointer";

  const selectedClass = selected
    ? clsx(colorClasses[color], "ring-2 border-transparent")
    : "text-primary-text";

  return (
    <button
      title={title}
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
