import { useEffect, useState } from "react";
import CTAButton from "../CTAButton";
import ProfileImageSection from "../ProfileImageSection";
import TextInput from "../ui/TextInput";
import Callout from "../ui/Callout";
import { useUser } from "@/contexts/UserProvider";
import { useToast } from "@/contexts/ToastProvider";
import { useUpdateProfile } from "@/hooks/useQmsApi";
import { PASSWORD_MIN_LENGTH, passwordProblems, signIn, updatePassword } from "@/authService";
import { RectangleEllipsisIcon, AtSignIcon, LockIcon } from "@/components/icons";
import MenuCard from "../ui/MenuCard";
import TwoFactorCard from "./TwoFactorCard";

const PersonalInformation = ({ profile, refreshProfile }) => {
  const { showToast } = useToast();
  const updateProfile = useUpdateProfile();
  const [form, setForm] = useState({ firstName: "", surname: "", jobTitle: "" });
  useEffect(() => {
    setForm({ firstName: profile?.first_name ?? "", surname: profile?.surname ?? "", jobTitle: profile?.job_title ?? "" });
  }, [profile?.first_name, profile?.surname, profile?.job_title]);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const changed =
    form.firstName !== (profile?.first_name ?? "") || form.surname !== (profile?.surname ?? "") || form.jobTitle !== (profile?.job_title ?? "");
  const valid = form.firstName.trim() && form.surname.trim();
  const save = async (e) => {
    e.preventDefault();
    try {
      await updateProfile.mutateAsync({ firstName: form.firstName.trim(), surname: form.surname.trim(), jobTitle: form.jobTitle.trim() || null });
      await refreshProfile?.();
      showToast({ type: "success", title: "Your details were saved" });
    } catch (err) {
      showToast({ type: "error", title: "Could not save", message: err?.message });
    }
  };
  return (
    <MenuCard as="form" onSubmit={save} noValidate title="Personal Information" subtitle="Update your personal details">
      <div className="flex flex-col gap-4">
        <TextInput label="First Name" required icon={RectangleEllipsisIcon} value={form.firstName} onChange={set("firstName")} placeholder="First Name..." />
        <TextInput label="Surname" required icon={RectangleEllipsisIcon} value={form.surname} onChange={set("surname")} placeholder="Surname..." />
        <TextInput label="Job Title" icon={RectangleEllipsisIcon} value={form.jobTitle} onChange={set("jobTitle")} placeholder="Job Title..." />
        <TextInput label="Email" icon={AtSignIcon} value={profile?.email ?? ""} readOnly disabled hint="Your sign-in address. Ask your administrator if it needs to change." />
        <div>
          <CTAButton type="main" buttonType="submit" text="Save details" disabled={!changed || !valid} loading={updateProfile.isPending} />
        </div>
      </div>
    </MenuCard>
  );
};

const PasswordCard = ({ email }) => {
  const { showToast } = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const problems = next ? passwordProblems(next, email) : [];
  const mismatch = confirm && confirm !== next;
  const ready = current && next && confirm && !problems.length && !mismatch;
  const submit = async (e) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      // Re-check the current password first, so a borrowed open session cannot change it.
      try {
        await signIn(email, current);
      } catch {
        setError("Your current password is not right.");
        return;
      }
      await updatePassword(next);
      setCurrent("");
      setNext("");
      setConfirm("");
      showToast({ type: "success", title: "Your password was changed" });
    } catch (err) {
      setError(err?.message || "The password could not be changed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <MenuCard as="form" onSubmit={submit} noValidate title="Password" subtitle="Enter your current password, then your new password." bodyClassName="flex flex-col gap-3">
      <TextInput label="Current password" dataType="password" autoComplete="current-password" icon={LockIcon} value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Current password..." />
      <TextInput
        label="New password"
        dataType="password"
        autoComplete="new-password"
        icon={LockIcon}
        value={next}
        onChange={(e) => setNext(e.target.value)}
        placeholder="New password..."
        hint={`At least ${PASSWORD_MIN_LENGTH} characters, with letters and numbers.`}
        error={problems.length ? problems.join(". ") : undefined}
      />
      <TextInput
        label="Confirm new password"
        dataType="password"
        autoComplete="new-password"
        icon={LockIcon}
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        placeholder="Confirm new password..."
        error={mismatch ? "The passwords do not match" : undefined}
      />
      {error && (
        <Callout tone="error" role="alert">
          {error}
        </Callout>
      )}
      <div>
        <CTAButton type="main" buttonType="submit" text="Change Password" disabled={!ready} loading={busy} />
      </div>
    </MenuCard>
  );
};

const SettingsAccount = () => {
  const { profile, refreshProfile } = useUser();
  const initials =
    [profile?.first_name, profile?.surname]
      .filter(Boolean)
      .map((n) => n.charAt(0).toUpperCase())
      .join(" ") || "?";
  return (
    <div className="flex flex-col xl:flex-row lg:flex-row gap-5 w-full">
      <div className="flex flex-col gap-4 w-1/2">
        <MenuCard
          title="Profile Picture"
          subtitle="Add an image of yourself so your team can easily identify you.">
          <div className="w-full flex flex-row justify-start items-center">
            <ProfileImageSection
              noImageText={initials}
              profile={profile}
              width="w-32"
              height="h-32"
              aspectRatio="aspect-square"
              onChange={refreshProfile}
            />
          </div>
        </MenuCard>

        <PersonalInformation profile={profile} refreshProfile={refreshProfile} />
      </div>

      <div className="flex flex-col w-1/2 gap-5">
        <TwoFactorCard />
        <PasswordCard email={profile?.email} />
        <MenuCard title="Delete account" subtitle="Quality records are never deleted, so accounts are not either.">
          <p className="text-sm text-secondary-text">
            To stop someone using Fortress QMS, an administrator suspends or removes them under Settings → Users &amp; permissions. Their name stays on the
            records they made. To remove your personal details as well, contact your administrator.
          </p>
        </MenuCard>
      </div>
    </div>
  );
};

export default SettingsAccount;
