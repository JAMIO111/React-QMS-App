import CTAButton from "../CTAButton";
import ProfileImageSection from "../ProfileImageSection";
import TextInput from "../ui/TextInput";
import { useUser } from "@/contexts/UserProvider";
import { RectangleEllipsisIcon, AtSignIcon } from "@/components/icons";
import MenuCard from "../ui/MenuCard";

const SettingsAccount = () => {
  const { profile, refreshProfile } = useUser();
  const initials =
    [profile?.first_name, profile?.surname]
      .filter(Boolean)
      .map((n) => n.charAt(0).toUpperCase())
      .join(" ") || "?";
  return (
    <div className="flex flex-col xl:flex-row lg:flex-row p-5 gap-5 w-full">
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

        {/* Personal Info Card */}
        <MenuCard
          title="Personal Information"
          subtitle="Update your personal details">
          <div className="flex flex-col gap-4">
            <TextInput
              label="First Name"
              icon={RectangleEllipsisIcon}
              value={profile?.first_name}
              placeholder="First Name..."
            />
            <TextInput
              label="Surname"
              icon={RectangleEllipsisIcon}
              value={profile?.surname}
              placeholder="Surname..."
            />
            <TextInput
              label="Job Title"
              icon={RectangleEllipsisIcon}
              value={profile?.job_title}
              placeholder="Job Title..."
            />
            <TextInput
              label="Email"
              icon={AtSignIcon}
              value={profile?.email}
              placeholder="Email..."
            />
          </div>
        </MenuCard>
      </div>

      <div className="flex flex-col w-1/2 gap-5">
        {/* Password Card */}
        <div className="flex flex-col bg-secondary-bg rounded-3xl border border-border-color p-5">
          <p className="text-primary-text text-xl mb-1">Password</p>
          <p className="text-secondary-text text-sm mb-5">
            You can change your password here. Please enter your current
            password and then your new password.
          </p>
          <TextInput
            icon={RectangleEllipsisIcon}
            placeholder="Current Password..."
          />
          <TextInput
            icon={RectangleEllipsisIcon}
            placeholder="New Password..."
          />
          <TextInput
            icon={RectangleEllipsisIcon}
            placeholder="Confirm New Password..."
          />
          <div className="h-10 flex flex-row justify-between items-center">
            <CTAButton type="main" text="Change Password" />
          </div>
        </div>
        {/* Optional small card */}
        <div className="flex flex-col bg-secondary-bg rounded-3xl border border-border-color p-5">
          <p className="text-primary-text text-xl mb-2">Delete Account</p>
          <p className="text-secondary-text text-sm mb-5">
            Permanently delete your account. This cannot be undone.
          </p>
          <CTAButton type="cancel" text="Delete Account" />
        </div>
      </div>
    </div>
  );
};

export default SettingsAccount;
