import { useState } from "react";
import CTAButton from "@/components/CTAButton";
import { CopyIcon, CheckIcon } from "@/components/icons";

/** Copies a value to the clipboard and says "Copied" for two seconds. `label` is its accessible name ("Copy the token"). */
const CopyButton = ({ text, label }) => {
  const [done, setDone] = useState(false);
  return (
    <CTAButton
      type="neutral"
      size="md"
      icon={done ? CheckIcon : CopyIcon}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        } catch {
          setDone(false);
        }
      }}>
      {done ? "Copied" : "Copy"}
    </CTAButton>
  );
};

export default CopyButton;
