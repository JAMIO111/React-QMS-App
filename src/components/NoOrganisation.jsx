import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../contexts/AuthProvider";
import { signOut } from "../authService";
import CreateOrganisationForm from "./CreateOrganisationForm";
import PendingInvitations from "./PendingInvitations";

/**
 * Shown to a signed-in user who is not an active member of any organisation: accept a pending
 * invitation, or create an organisation (they become its Owner).
 */
const NoOrganisation = ({ error }) => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-primary-bg p-4">
      <div className="max-w-lg w-full rounded-2xl border border-border-color bg-secondary-bg p-6 text-primary-text flex flex-col gap-5">
        {error ? (
          <div>
            <h1 className="text-xl font-semibold mb-2">Couldn't load your organisations</h1>
            <p className="text-secondary-text">{error.message}</p>
          </div>
        ) : (
          <>
            <div>
              <h1 className="text-xl font-semibold mb-1">Set up your organisation</h1>
              <p className="text-secondary-text text-sm">
                {user?.email ? `${user.email} is` : "Your account is"} not a member of any
                organisation yet. Create one to get started — you'll be its Owner — or ask an
                administrator of an existing organisation to invite you.
              </p>
            </div>
            <PendingInvitations />
            <CreateOrganisationForm />
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
    </main>
  );
};

export default NoOrganisation;
