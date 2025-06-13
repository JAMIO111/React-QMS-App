import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import clsx from "clsx";
import { BsInfoCircleFill } from "react-icons/bs";
import { HiOutlineExclamationTriangle } from "react-icons/hi2";
import { MdError } from "react-icons/md";
import { IoCheckmarkCircle } from "react-icons/io5";
import { CgClose } from "react-icons/cg";

const ToastNotification = ({ type, title, message, onClose, index }) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(true);
    return () => setVisible(false);
  }, []);

  const options = {
    error: {
      icon: <MdError className="text-red-500 h-8 w-8" />,
      color: "text-red-500 bg-red-500/20",
      buttonColor: "active:border-red-500",
      iconWrapper: "bg-red-500/20 p-0.5",
    },
    warning: {
      icon: (
        <HiOutlineExclamationTriangle className="text-yellow-500 h-8 w-8" />
      ),
      color: "text-yellow-500 bg-yellow-500/20",
      buttonColor: "active:border-yellow-500",
      iconWrapper: "bg-green-500/20 p-0.5",
    },
    info: {
      icon: <BsInfoCircleFill className="text-blue-500 h-7 w-7" />,
      color: "text-blue-500 bg-blue-500/20",
      buttonColor: "active:border-blue-500",
      iconWrapper: "bg-blue-500/20 p-1",
    },
    success: {
      icon: <IoCheckmarkCircle className="text-green-500 h-8 w-8" />,
      color: "text-green-500",
      buttonColor: "active:border-green-500",
      iconWrapper: "bg-green-500/20 p-0.5",
    },
  };

  const currentOption = options[type] || options.info;
  const baseClass =
    "flex flex-row items-center bg-secondary-bg justify-between border-border-color border-1 rounded-xl px-4 py-2 w-120";
  const baseButtonClass =
    "cursor-pointer border text-secondary-text hover:text-primary-text border-transparent rounded-lg p-1";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 200 }}
      animate={{
        opacity: 1,
        x: 0,
        y: 0,
        transition: {
          opacity: { duration: 0.2, ease: "easeIn" }, // Quick fade-in (0.2s)
          x: { type: "tween", duration: 0.5, ease: "easeOut" }, // Precise 0.5s slide-in
          y: { type: "spring", stiffness: 500, damping: 30, mass: 1 }, // Slide-up
        },
      }}
      exit={{
        opacity: 0,
        x: 0,
        transition: {
          opacity: { duration: 1, ease: "easeOut" }, // Slow fade-out (1s)
          x: { type: "spring", stiffness: 500, damping: 30, mass: 1 }, // No effect
        },
      }}
      transition={{
        layout: { duration: 0.3 }, // Smooth layout transition
      }}
      style={{ position: "relative" }}
      className={clsx(baseClass, currentOption.color)}>
      <div className="flex flex-row items-center justify-between gap-4 w-full">
        {/* Icon */}
        <div className="relative bg-secondary-bg">
          <div
            className={clsx(
              "flex-shrink-0 p-0.25 rounded-full",
              currentOption.iconWrapper
            )}>
            {currentOption.icon}
          </div>
        </div>

        {/* Text content */}
        <div className="flex flex-col flex-grow min-w-0">
          <p className="font-semibold text-md text-primary-text">{title}</p>
          <p className="text-secondary-text text-sm break-words whitespace-normal">
            {message}
          </p>
        </div>

        {/* Close button */}
        <div className="flex-shrink-0">
          <button
            onClick={onClose}
            className={clsx(baseButtonClass, currentOption.buttonColor)}
            aria-label="Close notification">
            <CgClose className="h-5 w-5" />
          </button>
        </div>
      </div>
    </motion.div>
  );
};

export default ToastNotification;
