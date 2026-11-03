import clsx from "clsx";

const ActionsModalItem = ({ label, icon: Icon, color, item, callback }) => {
  const colorClasses = {
    red: "hover:bg-error-color/80 text-error-color/80 hover:text-white text-error-text",
    blue: "hover:bg-cta-color/70 hover:text-white text-primary-text",
  };

  return (
    <button
      onClick={() => callback(item.id)}
      className={clsx(
        "w-full h-full gap-2 pl-2 flex justify-start items-center font-semibold p-1 cursor-pointer transition-all ease-in-out duration-300 rounded-lg",
        colorClasses[color]
      )}>
      <Icon className="w-5 h-5" />
      <p>{label}</p>
    </button>
  );
};

export default ActionsModalItem;
