import CTAButton from "./CTAButton";
import TextInput from "./ui/TextInput";

const SettingsAccount = () => {
  return (
    <div className="flex flex-col xl:flex-row lg:flex-row gap-5 w-full pr-5 overflow-y-scroll">
      <div className="flex flex-col gap-5 w-1/2">
        {/* Photo Card */}
        <div className="flex flex-row justify-between items-center bg-secondary-bg border border-border-color rounded-3xl p-5">
          <div className="flex flex-col w-1/2 justify-between h-full">
            <p className="text-primary-text text-xl">Your Photo</p>
            <CTAButton width="w-full" type="main" text="Add Photo" />
          </div>
          <div className="w-32 h-32 rounded-3xl border border-primary-text overflow-hidden">
            <img
              className="w-full h-full object-cover"
              src="/Profile-img-cropped.jpg"
              alt="JD"
            />
          </div>
        </div>

        {/* Personal Info Card */}
        <div className="flex flex-col bg-secondary-bg rounded-3xl border border-border-color p-5">
          <p className="text-primary-text text-xl mb-5">Personal Information</p>
          <TextInput placeholder="First Name..." />
          <TextInput placeholder="Surname..." />
          <TextInput placeholder="Job Title..." />
          <TextInput placeholder="Email..." />
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
          <TextInput placeholder="Current Password..." />
          <TextInput placeholder="New Password..." />
          <TextInput placeholder="Confirm New Password..." />
          <div className="h-10 flex flex-row justify-between items-center">
            <CTAButton width="w-1/2" type="main" text="Change Password" />
          </div>
        </div>
        {/* Optional small card */}
        <div className="flex flex-col bg-secondary-bg rounded-3xl border border-border-color p-5">
          <p className="text-primary-text text-xl mb-2">Delete Account</p>
          <p className="text-secondary-text text-sm mb-5">
            Permanently delete your account. This cannot be undone.
          </p>
          <CTAButton width="w-1/2" type="cancel" text="Delete Account" />
        </div>
      </div>
    </div>
  );
};

export default SettingsAccount;
