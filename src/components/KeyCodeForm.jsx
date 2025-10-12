import { useState, useEffect } from "react";
import CTAButton from "./CTAButton";
import TextInput from "./ui/TextInput";
import { PiPassword } from "react-icons/pi";
import { LuTag } from "react-icons/lu";

const KeyCodeForm = ({ defaultValues, onSave, onCancel }) => {
  const [form, setForm] = useState({
    id: null,
    code: "",
    name: "",
    is_private: false,
    ...defaultValues,
  });

  const [submitted, setSubmitted] = useState(false);

  // Sync defaults if editing
  useEffect(() => {
    if (defaultValues) {
      setForm((prev) => ({ ...prev, ...defaultValues }));
    }
  }, [defaultValues]);

  const handleSubmit = (e) => {
    e.preventDefault();
    setSubmitted(true);

    const code = form.code?.trim() || "";
    const name = form.name?.trim() || "";

    // Validate safely
    if (!code || !name) return;

    // If valid
    onSave({ ...form, code, name });
  };

  return (
    <form onSubmit={handleSubmit} className="p-4 flex flex-col gap-4">
      <TextInput
        label="Key Code"
        placeholder="Enter key code..."
        icon={PiPassword}
        value={form.code}
        onChange={(e) => setForm({ ...form, code: e.target.value })}
        error={
          submitted && !form.code?.trim()
            ? { message: "Key Code is required" }
            : null
        }
      />

      <TextInput
        label="Description"
        placeholder="Enter description..."
        icon={LuTag}
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
        error={
          submitted && !form.name?.trim()
            ? { message: "Description is required" }
            : null
        }
      />

      <label className="flex text-primary-text items-center gap-2">
        <input
          type="checkbox"
          checked={form.is_private}
          onChange={(e) => setForm({ ...form, is_private: e.target.checked })}
        />
        Private
      </label>

      <div className="flex gap-2 pt-2">
        <CTAButton
          width="w-full"
          type="cancel"
          text="Cancel"
          callbackFn={onCancel}
        />
        <CTAButton
          width="w-full"
          type="success"
          text={defaultValues ? "Update" : "Add"}
          callbackFn={handleSubmit}
        />
      </div>
    </form>
  );
};

export default KeyCodeForm;
