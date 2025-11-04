import CTAButton from "../CTAButton";
import ProfileImageSection from "../ProfileImageSection";
import TextInput from "../ui/TextInput";
import { useUser } from "@/contexts/UserProvider";
import { PiPassword } from "react-icons/pi";

const SettingsAccount = () => {
  const { profile } = useUser();
  console.log("profile:", profile);
  return (
    <div className="flex flex-col xl:flex-row lg:flex-row gap-5 w-full pr-5 overflow-y-auto">
      <div className="flex flex-col gap-4 w-1/2">
        {/* Photo Card */}
        <div className="flex flex-row justify-between items-center bg-secondary-bg border border-border-color rounded-3xl p-5">
          <div className="flex flex-col w-1/2 gap-2 justify-start h-full">
            <p className="text-primary-text text-xl">Profile Picture</p>
            <p className="text-secondary-text text-sm mb-5">
              Add an image of yourself so your team can easily identify you.
            </p>
          </div>
          <ProfileImageSection
            noImageText={`${profile?.first_name.charAt(
              0
            )} ${profile?.surname.charAt(0)}`}
            item={profile}
            bucket="avatars"
            path="employees"
            table="Employees"
            width="w-32"
            height="h-32"
            aspectRatio="aspect-square"
            onImageChange={(url) => {
              console.log("New avatar URL:", url);
            }}
          />
        </div>

        {/* Personal Info Card */}
        <div className="flex flex-col bg-secondary-bg rounded-3xl border border-border-color p-4">
          <p className="text-primary-text text-xl mb-5">Personal Information</p>
          <TextInput
            icon={PiPassword}
            value={profile?.first_name}
            placeholder="First Name..."
          />
          <TextInput
            icon={PiPassword}
            value={profile?.surname}
            placeholder="Surname..."
          />
          <TextInput
            icon={PiPassword}
            value={profile?.job_title}
            placeholder="Job Title..."
          />
          <TextInput
            icon={PiPassword}
            value={profile?.email}
            placeholder="Email..."
          />
        </div>
      </div>

      <div className="flex flex-col w-1/2 gap-5">
        {/* Password Card */}
        <div className="flex flex-col bg-secondary-bg rounded-3xl border border-border-color p-5">
          <p className="text-primary-text text-xl mb-1">Password</p>
          <p className="text-secondary-text text-sm mb-5">
            You can change your password here. Please enter your current
            password and then your new password.
          </p>
          <TextInput icon={PiPassword} placeholder="Current Password..." />
          <TextInput icon={PiPassword} placeholder="New Password..." />
          <TextInput icon={PiPassword} placeholder="Confirm New Password..." />
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
