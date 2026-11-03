import { Navigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthProvider";

export default function HomeRedirect() {
  const { user } = useAuth();

  if (user === undefined) return <div>Loading...</div>; // or a spinner

  // Redirect based on user state
  if (user) {
    return <Navigate to="/Dashboard" replace />;
  } else {
    return <Navigate to="/login" replace />;
  }
}
