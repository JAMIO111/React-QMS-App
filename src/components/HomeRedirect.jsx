import { Navigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthProvider";

export default function HomeRedirect() {
  const { user } = useAuth();

  if (user === undefined)
    return (
      <div role="status" className="flex h-screen items-center justify-center bg-primary-bg text-secondary-text">
        Loading…
      </div>
    );

  // Redirect based on user state
  if (user) {
    return <Navigate to="/Dashboard" replace />;
  } else {
    return <Navigate to="/login" replace />;
  }
}
