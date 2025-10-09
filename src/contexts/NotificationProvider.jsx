// NotificationContext.jsx
import { createContext, useContext, useState, useCallback } from "react";

const NotificationContext = createContext();

export const NotificationProvider = ({ children }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [content, setContent] = useState(null);

  const openPane = useCallback((jsxContent) => {
    setContent(jsxContent);
    setIsOpen(true);
  }, []);

  const closePane = useCallback(() => {
    setIsOpen(false);
    setContent(null);
  }, []);

  return (
    <NotificationContext.Provider
      value={{ isOpen, content, openPane, closePane }}>
      {children}
    </NotificationContext.Provider>
  );
};

export const useNotification = () => useContext(NotificationContext);
