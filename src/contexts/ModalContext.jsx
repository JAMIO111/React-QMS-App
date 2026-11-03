// ModalContext.js
import {
  useState,
  useCallback,
  useContext,
  createContext,
  useRef,
  useEffect,
} from "react";
import { createPortal } from "react-dom";
import { CgClose } from "react-icons/cg";
import { motion, useDragControls } from "framer-motion";

const ModalContext = createContext();

export const useModal = () => {
  const context = useContext(ModalContext);
  if (!context) throw new Error("useModal must be used within a ModalProvider");
  return context;
};

export const ModalProvider = ({ children }) => {
  const backdropRef = useRef(null);
  const mouseDownTarget = useRef(null);
  const [modalContent, setModalContent] = useState(null);
  const modalRef = useRef(null);
  const dragControls = useDragControls();

  const openModal = useCallback(({ title, content }) => {
    setModalContent({ title, content });
  }, []);

  const closeModal = useCallback(() => {
    setModalContent(null);
  }, []);

  useEffect(() => {
    if (!modalContent || !modalRef.current) return;
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
        closeModal();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    firstEl?.focus();

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [modalContent, closeModal]);

  return (
    <ModalContext.Provider value={{ openModal, closeModal }}>
      {children}
      {modalContent &&
        createPortal(
          <div
            ref={backdropRef}
            className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center"
            onMouseDown={(e) => {
              if (e.target === backdropRef.current) {
                mouseDownTarget.current = backdropRef.current;
              }
            }}
            onMouseUp={(e) => {
              if (
                e.target === backdropRef.current &&
                mouseDownTarget.current === backdropRef.current
              ) {
                closeModal();
              }
              mouseDownTarget.current = null;
            }}>
            <motion.div
              drag
              dragControls={dragControls}
              dragConstraints={backdropRef}
              dragListener={false}
              dragMomentum={false}
              ref={modalRef}
              onClick={(e) => e.stopPropagation()}
              className="bg-primary-bg shadow-l rounded-2xl p-3 border border-border-color relative w-fit overflow-hidden min-w-[300px]">
              {/* Draggable Header */}
              <div
                className="flex justify-between select-none pb-2 border-b border-border-color items-center cursor-move text-primary-text rounded-t-xl"
                onPointerDown={(e) => dragControls.start(e)}>
                <h3 className="text-lg pl-2 select-none text-primary-text font-semibold">
                  {modalContent.title || "Modal Title"}
                </h3>
                <button
                  onClick={closeModal}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="group flex justify-center items-center p-1.5 cursor-pointer transition-colors duration-300 hover:text-error-color hover:bg-border-color/50 rounded-lg">
                  <CgClose className="h-5 w-5 transition-colors duration-300 group-hover:text-error-color text-primary-text" />
                </button>
              </div>

              <div>{modalContent.content}</div>
            </motion.div>
          </div>,
          document.getElementById("modal-root")
        )}
    </ModalContext.Provider>
  );
};
