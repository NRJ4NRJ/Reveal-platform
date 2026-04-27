import React from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";

interface Props {
  children: React.ReactNode;
  role: "SUPER_ADMIN" | "CLIENT_ADMIN" | "EMPLOYEE";
}

export default function ProtectedRoute({ children, role }: Props) {
  const { user, isLoading } = useAuth();
  if (isLoading) return <div className="flex items-center justify-center h-screen">Chargement...</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== role) {
    if (user.role === "SUPER_ADMIN")  return <Navigate to="/super-admin/dashboard" replace />;
    if (user.role === "CLIENT_ADMIN") return <Navigate to="/admin/dashboard" replace />;
    if (user.role === "EMPLOYEE")     return <Navigate to="/participant/dashboard" replace />;
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
