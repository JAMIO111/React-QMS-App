const DashboardCard2 = ({
  title = "Title",
  icon: Icon,
  value = "123,456.78",
  trend = 25,
  isPositiveGood = true, // If true, positive trend is good; if false, negative trend is good
  isSelected = false,
  onClick,
}) => {
  const isPositive = trend > 0;
  const isNeutral = trend === 0;

  let style = "";
  if (isSelected) {
    style = "text-white bg-white/20";
  } else if (isNeutral) {
    style = "text-secondary-text border-border-color bg-transparent";
  } else if (
    (isPositive && isPositiveGood) ||
    (!isPositive && !isPositiveGood)
  ) {
    style = "text-success-color border-success-color bg-success-color/10";
  } else {
    style = "text-error-color border-error-color bg-error-color/10";
  }
  return (
    <div
      onClick={onClick}
      className={`${
        isSelected
          ? "bg-gradient-to-bl from-cta-color to-cta-color/80 "
          : "bg-secondary-bg"
      } flex flex-col justify-around px-4 py-2 h-full w-full`}>
      <div className="flex flex-row justify-start items-center">
        <Icon
          className={`${
            isSelected ? "text-white" : "text-cta-color"
          } h-6 w-6 text-cta-color`}
        />
        <h2
          className={`${
            isSelected ? "text-white" : "text-primary-text"
          } text-md ml-2`}>
          {title}
        </h2>
      </div>
      <div className="flex flex-row justify-start items-center">
        <h3
          className={`${
            isSelected ? "text-white" : "text-primary-text"
          } text-3xl font-semibold`}>
          {value}
        </h3>
        {trend !== undefined && (
          <span className={`ml-3 px-2 rounded-full border text-sm ${style}`}>
            {trend > 0 ? `+${trend}%` : `${trend}%`}
          </span>
        )}
      </div>
    </div>
  );
};

export default DashboardCard2;
