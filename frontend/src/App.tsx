import React from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import { BrandingProvider } from "./contexts/BrandingContext";
import { I18nProvider } from "./contexts/I18nContext";
import ProtectedRoute from "./components/ProtectedRoute";
import Login from "./pages/Login";
import ResetPassword from "./pages/ResetPassword";
import VerifyEmail from "./pages/VerifyEmail"; // ITER11
import SuperAdminDashboard from "./pages/super-admin/Dashboard";
import SuperAdminQuestions from "./pages/super-admin/Questions";
import SuperAdminTests from "./pages/super-admin/Tests";
import SuperAdminClients from "./pages/super-admin/Clients";
import SuperAdminSettings from "./pages/super-admin/Settings";
import SuperAdminMessages from "./pages/super-admin/Messages";
import SuperAdminResponses from "./pages/super-admin/Responses"; // ITER8: page réponses à analyser
import AdminDashboard from "./pages/admin/Dashboard";
import AdminTests from "./pages/admin/Tests";
import AdminEmployees from "./pages/admin/Employees";
import AdminSettings from "./pages/admin/Settings";
import AdminMessages from "./pages/admin/Messages";
import ParticipantDashboard from "./pages/participant/Dashboard";
import ParticipantTests from "./pages/participant/Tests";
import ParticipantProfile from "./pages/participant/Profile";
import ParticipantMessages from "./pages/participant/Messages"; // ITER7

export default function App() {
  return (
    <I18nProvider>
      <AuthProvider>
        <BrandingProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/verify-email" element={<VerifyEmail />} /> {/* ITER11 */}

            {/* Super Admin */}
            <Route path="/super-admin/dashboard" element={<ProtectedRoute role="SUPER_ADMIN"><SuperAdminDashboard /></ProtectedRoute>} />
            <Route path="/super-admin/questions"  element={<ProtectedRoute role="SUPER_ADMIN"><SuperAdminQuestions /></ProtectedRoute>} />
            <Route path="/super-admin/tests"      element={<ProtectedRoute role="SUPER_ADMIN"><SuperAdminTests /></ProtectedRoute>} />
            <Route path="/super-admin/clients"    element={<ProtectedRoute role="SUPER_ADMIN"><SuperAdminClients /></ProtectedRoute>} />
            <Route path="/super-admin/settings"   element={<ProtectedRoute role="SUPER_ADMIN"><SuperAdminSettings /></ProtectedRoute>} />
            <Route path="/super-admin/messages"   element={<ProtectedRoute role="SUPER_ADMIN"><SuperAdminMessages /></ProtectedRoute>} />
            <Route path="/super-admin/responses"  element={<ProtectedRoute role="SUPER_ADMIN"><SuperAdminResponses /></ProtectedRoute>} /> {/* ITER8 */}

            {/* Admin Client */}
            <Route path="/admin/dashboard"  element={<ProtectedRoute role="CLIENT_ADMIN"><AdminDashboard /></ProtectedRoute>} />
            <Route path="/admin/tests"      element={<ProtectedRoute role="CLIENT_ADMIN"><AdminTests /></ProtectedRoute>} />
            <Route path="/admin/employees"  element={<ProtectedRoute role="CLIENT_ADMIN"><AdminEmployees /></ProtectedRoute>} />
            <Route path="/admin/settings"   element={<ProtectedRoute role="CLIENT_ADMIN"><AdminSettings /></ProtectedRoute>} />
            <Route path="/admin/messages"   element={<ProtectedRoute role="CLIENT_ADMIN"><AdminMessages /></ProtectedRoute>} />

            {/* Participant */}
            <Route path="/participant/dashboard" element={<ProtectedRoute role="EMPLOYEE"><ParticipantDashboard /></ProtectedRoute>} />
            <Route path="/participant/tests"     element={<ProtectedRoute role="EMPLOYEE"><ParticipantTests /></ProtectedRoute>} />
            <Route path="/participant/profile"   element={<ProtectedRoute role="EMPLOYEE"><ParticipantProfile /></ProtectedRoute>} />
            <Route path="/participant/messages"  element={<ProtectedRoute role="EMPLOYEE"><ParticipantMessages /></ProtectedRoute>} /> {/* ITER7 */}

            <Route path="/"  element={<Navigate to="/login" replace />} />
            <Route path="*"  element={<Navigate to="/login" replace />} />
          </Routes>
        </BrandingProvider>
      </AuthProvider>
    </I18nProvider>
  );
}
