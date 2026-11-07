import { useQueryClient } from "@tanstack/react-query";
import { CheckIcon } from "@/components/icons";
import { useAuth } from "../contexts/AuthProvider";
import { useUser } from "../contexts/UserProvider";
import { signOut } from "../authService";
import CreateOrganisationForm from "./CreateOrganisationForm";
import PendingInvitations from "./PendingInvitations";

const STEPS = [
  { key: "account", title: "Create your account", done: true },
  { key: "organisation", title: "Name your organisation", current: true },
  { key: "plan", title: "Choose your plan and seats" },
  { key: "setup", title: "Set up sites, security and your team" },
];

/**
 * Shown to a signed-in user who is not an active member of any organisation. Either they accept an invitation to join one, or they start their own:
 * the account is made, and the organisation, the plan and the set-up follow.
 */
const NoOrganisation = ({ error }) => {
  const { user } = useAuth();
  const { profile } = useUser() ?? {};
  const queryClient = useQueryClient();
  const firstName = profile?.first_name;
  return (
    <main className="h-dvh w-full overflow-y-auto bg-primary-bg">
      <div className="flex min-h-full items-center justify-center p-4">
      <div className="flex w-full max-w-2xl flex-col gap-6 rounded-2xl border border-border-color bg-secondary-bg p-6 text-primary-text">
        {error ? (
          <div role="alert">
            <h1 className="mb-2 text-xl font-semibold">Couldn&apos;t load your organisations</h1>
            <p className="text-secondary-text">{error.message}</p>
          </div>
        ) : (
          <>
            <div>
              <h1 className="mb-1 text-2xl font-semibold">{firstName ? `Welcome, ${firstName}` : "Welcome to Fortress QMS"}</h1>
              <p className="text-sm text-secondary-text">
                {user?.email ? `${user.email} is` : "Your account is"} verified and ready. Start your organisation to get going, or accept an invitation if someone has invited you to theirs.
              </p>
            </div>
            <ol aria-label="Getting started" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {STEPS.map((step, i) => (
                <li key={step.key} aria-current={step.current ? "step" : undefined} className={`flex items-center gap-3 rounded-xl border px-3 py-2 text-sm ${step.current ? "border-brand-primary bg-brand-primary/10" : "border-border-color"}`}>
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${step.done ? "bg-success-color text-white" : step.current ? "border-2 border-brand-primary" : "border border-border-color text-secondary-text"}`}>
                    {step.done ? <CheckIcon className="h-4 w-4" aria-label="Done" /> : i + 1}
                  </span>
                  <span className={step.done || step.current ? "text-primary-text" : "text-secondary-text"}>{step.title}</span>
                </li>
              ))}
            </ol>
            <PendingInvitations />
            <section aria-labelledby="start-org-heading" className="flex flex-col gap-2">
              <h2 id="start-org-heading" className="text-lg font-semibold">
                Start your organisation
              </h2>
              <CreateOrganisationForm />
            </section>
          </>
        )}
        <button
          type="button"
          onClick={async () => {
            await signOut();
            queryClient.clear();
          }}
          className="self-start text-sm text-secondary-text underline hover:text-primary-text cursor-pointer">
          Sign out
        </button>
      </div>
    </div>
    </main>
  );
};

export default NoOrganisation;
