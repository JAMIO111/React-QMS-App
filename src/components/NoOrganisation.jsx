import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../contexts/AuthProvider";
import { signOut } from "../authService";

/**
 * Shown to a signed-in user who is not an active member of any organisation.
 * (Creating an organisation and accepting invitations arrive in Phase 1.4/1.5.)
 */
const NoOrganisation = ({ error }) => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-primary-bg p-4">
      <div className="max-w-md w-full rounded-2xl border border-border-color bg-secondary-bg p-6 text-primary-text">
        {error ? (
          <>
            <h1 className="text-xl font-semibold mb-2">Couldn't load your organisations</h1>
            <p className="text-secondary-text mb-4">{error.message}</p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold mb-2">No organisation yet</h1>
            <p className="text-secondary-text mb-4">
              {user?.email ? `${user.email} is` : "Your account is"} not a member
              of any organisation. Ask an administrator of your organisation to
              invite you, then sign in again.
            </p>
          </>
        )}
        <button
          type="button"
          onClick={async () => {
            await signOut();
            queryClient.clear();
          }}
          className="rounded-lg border border-border-color px-4 py-2 hover:bg-tertiary-bg cursor-pointer">
          Sign out
        </button>
      </div>
    </div>
  );
};

export default NoOrganisation;
