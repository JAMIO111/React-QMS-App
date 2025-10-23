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
              className="bg-primary-bg rounded-xl border border-border-color shadow-xl relative w-fit min-w-[300px]">
              {/* Draggable Header */}
              <div
                className="flex justify-between select-none items-center cursor-move border-b border-border-color bg-secondary-bg text-primary-text rounded-t-xl"
                onPointerDown={(e) => dragControls.start(e)}>
                <h3 className="pl-4 text-lg select-none text-primary-text font-semibold">
                  {modalContent.title || "Modal Title"}
                </h3>
                <button
                  onClick={closeModal}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="group flex justify-center items-center w-10 h-10 hover:text-white hover:bg-error-color rounded-tr-xl">
                  <CgClose className="h-5 w-5 group-hover:text-white text-primary-text" />
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
