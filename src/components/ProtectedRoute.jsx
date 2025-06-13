import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../contexts/AuthProvider";

const ProtectedRoute = () => {
  const { user } = useAuth();

  if (user === undefined) return <div>Loading Protected Route...</div>; // Optional: handle loading state

  return user ? <Outlet /> : <Navigate to="/login" replace />;
};

export default ProtectedRoute;
