import { createContext, useContext, useState, useCallback } from "react";
import ToastNotification from "../components/ToastNotification";

const ToastContext = createContext();

export const useToast = () => useContext(ToastContext);

export const ToastProvider = ({ children }) => {
  const [toast, setToast] = useState(null);

  const showToast = useCallback(({ type, title, message }) => {
    setToast({ type, title, message });

    // Auto-dismiss after 5s
    setTimeout(() => setToast(null), 5000);
  }, []);

  const closeToast = () => setToast(null);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toast && (
        <div className="fixed bottom-4 right-4 z-500 transition-all">
          <ToastNotification
            type={toast.type}
            title={toast.title}
            message={toast.message}
            onClose={closeToast}
          />
        </div>
      )}
    </ToastContext.Provider>
  );
};
