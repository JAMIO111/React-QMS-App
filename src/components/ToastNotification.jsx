import { useState, useEffect } from "react";
import clsx from "clsx";
import { RxCrossCircled } from "react-icons/rx";
import { IoCheckmarkCircleOutline } from "react-icons/io5";
import {
  HiOutlineExclamationCircle,
  HiOutlineExclamationTriangle,
} from "react-icons/hi2";
import { PiWarningOctagon } from "react-icons/pi";
import { CgClose } from "react-icons/cg";

const ToastNotification = ({ type, title, message, onClose }) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timeout = requestAnimationFrame(() => setVisible(true));

    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(onClose, 500); // wait for animation
    }, 4500);
    return () => {
      cancelAnimationFrame(timeout);
      clearTimeout(timer);
    };
  }, [onClose]);

  const options = {
    error: {
      icon: <PiWarningOctagon className="text-error-color h-10 w-10" />,
      color: "bg-error-color/20 border-error-color text-error-color",
      buttonColor: "hover:border-error-color/80",
    },
    warning: {
      icon: (
        <HiOutlineExclamationTriangle className="text-warning-color h-10 w-10" />
      ),
      color: "bg-warning-color/20 border-warning-color text-warning-color",
      buttonColor: "hover:border-warning-color/80",
    },
    info: {
      icon: (
        <HiOutlineExclamationCircle className="text-info-color h-10 w-10" />
      ),
      color: "bg-info-color/20 border-info-color text-info-color",
      buttonColor: "hover:border-info-color/80",
    },
    success: {
      icon: (
        <IoCheckmarkCircleOutline className="text-success-color h-10 w-10" />
      ),
      color: "bg-success-color/20 border-success-color text-success-color",
      buttonColor: "hover:border-success-color/80",
    },
  };
  const currentOption = options[type] || options.info;
  const baseClass =
    "flex-row items-center justify-between border-2 rounded-xl px-4 py-2 w-120";
  let customClass = currentOption.color;
  let customButtonClass = currentOption.buttonColor;
  const baseButtonClass =
    "cursor-pointer border border-transparent rounded-lg p-1";
  return (
    <div
      className={clsx(
        "fixed top-4 left-1/2 transform -translate-x-1/2 z-50 transition-all duration-500",
        visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-10"
      )}>
      <div className={clsx(baseClass, customClass)}>
        <div className="flex flex-row items-center gap-5">
          {currentOption.icon}
          <div className="flex flex-col flex-1">
            <p className="font-semibold">{title}</p>
            <p>{message}</p>
          </div>
          <button
            onClick={() => {
              setVisible(false);
              setTimeout(onClose, 300);
            }}
            className={clsx(baseButtonClass, customButtonClass)}>
            <CgClose className="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default ToastNotification;
