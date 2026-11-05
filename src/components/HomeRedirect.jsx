import { Navigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthProvider";
import LoadingScreen from "./ui/LoadingScreen";

export default function HomeRedirect() {
  const { user } = useAuth();

  if (user === undefined)
    return (
      <LoadingScreen fullscreen />
    );

  // Redirect based on user state
  if (user) {
    return <Navigate to="/Dashboard" replace />;
  } else {
    return <Navigate to="/login" replace />;
  }
}
