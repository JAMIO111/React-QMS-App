import { useRef, useState } from "react";
import { useStatusOptions } from "../../hooks/useCategoryOptions";
import StatusPreviewCard from "./StatusPreviewCard";
import TextInput from "../ui/TextInput";
import TextArea from "../ui/TextArea";
import { LuCircleDashed } from "react-icons/lu";
import { CiTextAlignCenter } from "react-icons/ci";
import { HiOutlinePencil } from "react-icons/hi2";
import { RiSave3Fill } from "react-icons/ri";
import StatusPill from "../StatusPill";
import ToggleButton from "../ui/ToggleButton";
import CTAButton from "../CTAButton";

const SettingsStatus = () => {
  const inputRef = useRef(null);
  const [editing, setEditing] = useState([]);

  const {
    data: statusOptions,
    error: statusError,
    isLoading: isStatusLoading,
  } = useStatusOptions();
  return (
    <div className="flex flex-col grow-1 w-full">
      {isStatusLoading ? (
        <p className="text-secondary-text">Loading status options...</p>
      ) : statusError ? (
        <p className="text-error-color">
          Error loading status options: {statusError.message}
        </p>
      ) : (
        <ul className="flex flex-col mt-4 gap-4">
          {statusOptions?.map((status) => (
            <li key={status.id}>
              {editing.includes(status.id) ? (
                <div className="flex gap-5 h-46 items-center border border-border-color rounded-2xl pt-2 pb-4 px-6">
                  <div className="flex flex-col justify-between h-full">
                    <span className="text-primary-text">Preview</span>
                    <div className="flex w-full h-full flex-col border border-border-color rounded-lg overflow-clip">
                      <StatusPreviewCard status={status} mode="light" />
                      <StatusPreviewCard status={status} mode="dark" />
                    </div>
                  </div>
                  <div className="flex flex-col h-full justify-between items-start w-full">
                    <TextInput
                      dataType="text"
                      value={status.name}
                      onChange={(e) => console.log(e.target.value)}
                      placeholder="Enter status name"
                      label="Status Name"
                      icon={LuCircleDashed}
                    />
                    <div className="flex items-center gap-5">
                      <ToggleButton
                        checked={status.active}
                        label="Active?"
                        trueLabel="Active"
                        falseLabel="Disabled"
                      />
                    </div>
                  </div>
                  <TextArea
                    placeholder="Enter a short description of the status"
                    label="Description"
                    rows={5}
                    value={status.description}
                    icon={CiTextAlignCenter}
                  />
                  <div className="flex flex-col pt-6 justify-between h-full">
                    <div
                      onClick={(e) => {
                        e.stopPropagation();
                        inputRef.current.click();
                      }}
                      style={{ backgroundColor: status.color }}
                      className="w-10 h-10 rounded-lg border border-border-color flex items-center justify-center cursor-pointer hover:border-brand-primary hover:scale-110 transition-all">
                      <input
                        className="border-none w-full h-full rounded-xl cursor-pointer opacity-0"
                        ref={inputRef}
                        value={status.color}
                        type="color"
                        onChange={(e) => {
                          // handle color change (optional)
                          console.log("New color:", e.target.value);
                        }}
                      />
                    </div>
                    <CTAButton
                      icon={RiSave3Fill}
                      iconSize="h-7 w-7"
                      type="success"
                      height="h-10"
                      width="w-10"
                      callbackFn={() =>
                        setEditing((prev) =>
                          !prev.includes(status.id)
                            ? [...prev, status.id]
                            : prev.filter((id) => id !== status.id)
                        )
                      }
                    />
                  </div>
                </div>
              ) : (
                <div className="flex h-20 gap-5 items-center border border-border-color rounded-2xl px-6 overflow-clip hover:bg-hover-bg transition-all">
                  <div className="w-45 shrink-0">
                    <StatusPill status={status} />
                  </div>

                  <span className="text-secondary-text text-md w-full">
                    {status.description || "No description provided"}
                  </span>
                  {status.type !== "in_progress" && (
                    <div
                      className={`${
                        status.type === "omit"
                          ? "border-pink-700 text-pink-700 bg-pink-700/10"
                          : status.type === "terminal"
                          ? "border-purple-700 text-purple-700 bg-purple-700/10"
                          : status.type === "initial"
                          ? "border-cyan-500 text-cyan-500 bg-cyan-500/10"
                          : ""
                      } border rounded-full text-sm w-fit whitespace-nowrap py-1 px-4`}>
                      {status.type
                        .replace(/_/g, " ")
                        .replace(/\b\w/g, (c) => c.toUpperCase())}
                    </div>
                  )}
                  <div
                    className={`${
                      status.active
                        ? "border-success-color text-success-color bg-success-color/10"
                        : "border-error-color text-error-color bg-error-color/10"
                    } border rounded-full text-sm w-fit py-1 px-4`}>
                    {status.active ? "Active" : "Disabled"}
                  </div>
                  <CTAButton
                    icon={HiOutlinePencil}
                    iconSize="h-12 w-12"
                    height="h-10"
                    width="w-10"
                    type="main"
                    text=""
                    callbackFn={() =>
                      setEditing((prev) =>
                        !prev.includes(status.id)
                          ? [...prev, status.id]
                          : prev.filter((id) => id !== status.id)
                      )
                    }
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default SettingsStatus;
