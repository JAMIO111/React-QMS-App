import { createContext, useContext, useState, useCallback } from "react";
import { AnimatePresence } from "framer-motion";
import ToastNotification from "../components/ToastNotification";

const ToastContext = createContext();

export const useToast = () => useContext(ToastContext);

let toastId = 0;

export const ToastProvider = ({ children }) => {
  const [toasts, setToasts] = useState([]);

  const showToast = useCallback(
    ({ type, title, message, duration = 10000 }) => {
      const id = toastId++;
      setToasts((prev) => [...prev, { id, type, title, message, duration }]);

      setTimeout(() => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
      }, duration);
    },
    []
  );

  const closeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-999 flex flex-col gap-2">
        <AnimatePresence initial={false}>
          {toasts.map(({ id, type, title, message }, index) => (
            <ToastNotification
              key={id}
              type={type}
              title={title}
              message={message}
              onClose={() => closeToast(id)}
              index={index}
            />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
};
