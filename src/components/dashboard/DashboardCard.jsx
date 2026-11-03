import { FiTrendingUp } from "react-icons/fi";
import { LuTrendingDown } from "react-icons/lu";
import currencyCodes from "@/currencyCodes";
import { useOrganisation } from "@/contexts/OrganisationProvider";

const DashboardCard = ({
  title = "Title",
  icon: Icon,
  currencyItem = false,
  value = "123,456.78",
  trend = 25,
  isSelected = false,
  onClick,
  color = "cta-color",
  isLoading = false,
  isPositiveGood = true,
  previousPeriodLabel = "Previous Period",
}) => {
  const colorMap = {
    lime: {
      text: "text-lime-500",
      bg: "bg-lime-500/10",
    },
    pink: {
      text: "text-pink-400",
      bg: "bg-pink-500/10",
    },
    orange: {
      text: "text-orange-400",
      bg: "bg-orange-500/10",
    },
    cyan: {
      text: "text-cyan-500",
      bg: "bg-cyan-500/10",
    },
    fuchsia: {
      text: "text-fuchsia-500",
      bg: "bg-fuchsia-500/10",
    },
    "cta-color": {
      text: "text-cta-color",
      bg: "bg-cta-color/10",
    },
  };

  const currentColor = colorMap[color] || colorMap["cta-color"];

  if (isLoading) {
    return (
      <div className="flex relative flex-row justify-start p-4 h-full w-full rounded-2xl bg-secondary-bg">
        <div className="flex flex-col justify-center items-left gap-2 flex-grow">
          <div className="h-8 w-32 rounded shimmer" />
          <div className="h-4 w-24 rounded shimmer" />
          <div className="h-4 w-28 rounded shimmer" />
        </div>
        <div
          className={`absolute top-2 right-2 h-12 w-12 rounded-full ${currentColor.bg} flex items-center justify-center`}>
          <div className="h-7 w-7 rounded-full shimmer" />
        </div>
      </div>
    );
  }

  const { organisation } = useOrganisation();
  const base_currency = organisation?.base_currency || "GBP";

  function getCurrencyFormatter(currencyCode) {
    const currency = currencyCodes[currencyCode];

    if (
      !currency ||
      typeof currency.code !== "string" ||
      typeof currency.decimal_digits !== "number"
    ) {
      console.warn(
        `Invalid or missing currency data for code: ${currencyCode}, falling back to GBP`
      );
      return new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: "GBP",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format;
    }

    try {
      return new Intl.NumberFormat("en", {
        style: "currency",
        currency: currency.code,
        minimumFractionDigits: currency.decimal_digits,
        maximumFractionDigits: currency.decimal_digits,
      }).format;
    } catch (err) {
      console.error("Error creating formatter:", err);
      // fallback
      return new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: "GBP",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format;
    }
  }

  const currencyFormatter = getCurrencyFormatter(base_currency);
  return (
    <div
      onClick={onClick}
      className={`${
        isSelected
          ? "bg-gradient-to-b from-cta-color/40 to-cta-color/70 "
          : "bg-secondary-bg"
      } flex relative flex-row justify-start p-4 h-full w-full rounded-2xl`}>
      <div className="flex flex-col justify-center items-left">
        <p
          className={`${
            isSelected ? "text-white" : "text-primary-text"
          } text-3xl font-semibold`}>
          {currencyItem ? currencyFormatter(value) : value}
        </p>
        <p className={`${isSelected ? "text-white" : "text-primary-text/80"}`}>
          {title}
        </p>
        <div className="flex flex-row items-center gap-2">
          {trend !== undefined && trend !== null ? (
            <>
              <span
                className={`text-md flex items-center gap-1 ${
                  isSelected
                    ? "text-white"
                    : trend === 0
                    ? "text-primary-text"
                    : isPositiveGood
                    ? trend > 0
                      ? "text-success-color/70"
                      : "text-error-color"
                    : trend > 0
                    ? "text-error-color"
                    : "text-success-color/70"
                }`}>
                {Math.abs(trend).toFixed(1)}%{trend > 0 && <FiTrendingUp />}
                {trend < 0 && <LuTrendingDown />}
              </span>
              <span
                className={`${
                  isSelected ? "text-white" : "text-sm text-muted"
                }`}>
                vs {previousPeriodLabel}
              </span>
            </>
          ) : (
            <span
              className={`text-sm ${isSelected ? "text-white" : "text-muted"}`}>
              No trend data
            </span>
          )}
        </div>
      </div>

      <div
        className={`${
          isSelected ? "bg-white/10" : ""
        } flex absolute top-2 right-2 justify-center items-center h-12 w-12 rounded-full ${
          currentColor.bg
        }`}>
        <Icon
          className={`${isSelected ? "text-white" : currentColor.text} h-7 w-7`}
        />
      </div>
    </div>
  );
};

export default DashboardCard;
