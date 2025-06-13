import {
  useState,
  useCallback,
  useContext,
  createContext,
  useRef,
  useEffect,
} from "react";
import { createPortal } from "react-dom";
import {
  IoWarningOutline,
  IoCheckmarkCircleOutline,
  IoInformationCircleOutline,
} from "react-icons/io5";
import { TiWarning } from "react-icons/ti";
import { CgClose } from "react-icons/cg";
import CTAButton from "../components/CTAButton";

// -- Context to manage global confirm modal --
const ConfirmContext = createContext(() => Promise.resolve(false));

export const useConfirm = () => useContext(ConfirmContext);

// -- Provider component --
export const ConfirmProvider = ({ children }) => {
  const [options, setOptions] = useState(null);
  const [resolveFn, setResolveFn] = useState(() => {});
  const modalRef = useRef(null);

  const confirm = useCallback((opts) => {
    setOptions(opts);
    return new Promise((resolve) => {
      setResolveFn(() => resolve);
    });
  }, []);

  const handleClose = (value) => {
    if (resolveFn) resolveFn(value);
    setOptions(null);
  };

  // Focus trap logic
  useEffect(() => {
    if (!options || !modalRef.current) return;

    const focusableSelectors = [
      "button",
      "a[href]",
      "input",
      "select",
      "textarea",
      '[tabindex]:not([tabindex="-1"])',
    ];
    const focusableEls = modalRef.current.querySelectorAll(
      focusableSelectors.join(",")
    );
    const firstEl = focusableEls[0];
    const lastEl = focusableEls[focusableEls.length - 1];

    const handleKeyDown = (e) => {
      if (e.key === "Tab") {
        if (e.shiftKey) {
          if (document.activeElement === firstEl) {
            e.preventDefault();
            lastEl.focus();
          }
        } else {
          if (document.activeElement === lastEl) {
            e.preventDefault();
            firstEl.focus();
          }
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        handleClose(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    firstEl?.focus();

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [options]);

  const getIcon = (type) => {
    switch (type) {
      case "warning":
        return <TiWarning className="h-10 w-10 text-white mx-auto" />;
      case "success":
        return (
          <IoCheckmarkCircleOutline className="h-10 w-10 text-green-500 mx-auto" />
        );
      case "info":
      default:
        return (
          <IoInformationCircleOutline className="h-10 w-10 text-blue-500 mx-auto" />
        );
    }
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {options &&
        createPortal(
          <div className="fixed bg-gradient-to-br from-primary-bg/40 to-border-color/40 inset-0 flex items-center justify-center z-50">
            <div
              ref={modalRef}
              className="bg-secondary-bg/5 backdrop-blur-sm rounded-2xl shadow-lg border border-primary-text/20 max-w-sm w-full p-6 relative"
              onClick={(e) => e.stopPropagation()}>
              <div className="absolute top-2 right-2">
                <button
                  className="cursor-pointer text-secondary-text/70 hover:text-primary-text"
                  onClick={() => handleClose(false)}
                  aria-label="Close">
                  <CgClose className="h-6 w-6" />
                </button>
              </div>
              <div className="flex justify-center items-center p-2 mx-auto w-14 h-14 bg-error-color rounded-full mb-4">
                {getIcon(options.type)}
              </div>
              {options.title && (
                <h2 className="text-xl text-primary-text font-semibold mb-4 px-2 text-center">
                  {options.title}
                </h2>
              )}
              <p className="mb-6 text-secondary-text text-center">
                {options.message}
              </p>
              <div className="flex flex-row w-full h-10 justify-center gap-6">
                <CTAButton
                  type="neutral"
                  width="w-1/2"
                  text={options.cancelText || "Cancel"}
                  callbackFn={() => handleClose(false)}
                />
                <CTAButton
                  type="cancel"
                  width="w-1/2"
                  text={options.confirmText || "Confirm"}
                  callbackFn={() => handleClose(true)}
                />
              </div>
            </div>
          </div>,
          document.getElementById("modal-root")
        )}
    </ConfirmContext.Provider>
  );
};
