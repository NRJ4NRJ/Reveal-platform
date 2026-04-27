import React, { useEffect, useState } from "react";
import Sidebar from "../../components/Sidebar";
import { useAuth } from "../../contexts/AuthContext";
import { useBranding } from "../../contexts/BrandingContext";
import { useI18n } from "../../contexts/I18nContext"; // ITER9
import { useNavigate } from "react-router-dom"; // ITER9
import { Building2, Users, ClipboardList, Clock, CheckCircle, AlertCircle } from "lucide-react"; // ITER9

// ITER9: Extended stats interface
interface Stats {
  clientCount: number;
  employeeCount: number;
  assignedCount: number; // ITER9
  inProgressCount: number; // ITER9
  completedCount: number; // ITER9
  openResponsesCount: number; // ITER9
  scenarioResponsesCount: number; // ITER9
}

// ITER9: Client for filter dropdown
interface Client { id: number; name: string; }

export default function SuperAdminDashboard() {
  const { accessToken } = useAuth();
  const branding = useBranding();
  const { t } = useI18n(); // ITER9
  const navigate = useNavigate(); // ITER9

  // ITER9: Extended stats state
  const [stats, setStats] = useState<Stats>({
    clientCount: 0, employeeCount: 0,
    assignedCount: 0, inProgressCount: 0, completedCount: 0,
    openResponsesCount: 0, scenarioResponsesCount: 0,
  });

  // ITER9: Client filter state
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string>("");

  // ITER9: Fetch client list for filter
  useEffect(() => {
    if (!accessToken) return;
    fetch("/api/super-admin/clients", { headers: { Authorization: `Bearer ${accessToken}` } })
      .then(r => r.ok ? r.json() : [])
      .then((data: any[]) => setClients(data.map((c: any) => ({ id: c.id, name: c.name }))))
      .catch(() => {});
  }, [accessToken]);

  // ITER9: Fetch stats — re-fetch when clientId changes
  useEffect(() => {
    if (!accessToken) return;
    const params = new URLSearchParams();
    if (selectedClientId) params.set("clientId", selectedClientId); // ITER9
    fetch(`/api/super-admin/stats?${params.toString()}`, { headers: { Authorization: `Bearer ${accessToken}` } })
      .then(r => r.json())
      .then(data => setStats(data))
      .catch(() => {});
  }, [accessToken, selectedClientId]); // ITER9: dependency on selectedClientId

  // ITER9: Combined responses count
  const totalResponses = stats.openResponsesCount + stats.scenarioResponsesCount; // ITER9

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <Sidebar />
      <main className="flex-1 overflow-y-auto p-8">
        <h1 className="text-2xl font-bold mb-4" style={{ color: branding.primaryColor }}>
          {t("dashboard")}
        </h1>

        {/* ITER9: Client filter dropdown */}
        <div className="mb-6">
          <select
            value={selectedClientId}
            onChange={e => setSelectedClientId(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2"
            style={{ minWidth: 220 }}
          >
            <option value="">{t("allClients")}</option>
            {clients.map(c => (
              <option key={c.id} value={String(c.id)}>{c.name}</option>
            ))}
          </select>
        </div>

        {/* ITER9: 6-card grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">

          {/* Card 1 — Entreprises clientes */}
          <div className="bg-white rounded-xl shadow-sm p-6 flex items-center gap-4">
            <div className="w-14 h-14 rounded-xl flex items-center justify-center"
              style={{ backgroundColor: `${branding.primaryColor}15` }}>
              <Building2 size={28} style={{ color: branding.primaryColor }} />
            </div>
            <div>
              <p className="text-sm text-gray-500">{t("clientCompanies")}</p>
              <p className="text-3xl font-bold" style={{ color: branding.primaryColor }}>{stats.clientCount}</p>
            </div>
          </div>

          {/* Card 2 — Salariés inscrits */}
          <div className="bg-white rounded-xl shadow-sm p-6 flex items-center gap-4">
            <div className="w-14 h-14 rounded-xl flex items-center justify-center"
              style={{ backgroundColor: `${branding.accentColor}30` }}>
              <Users size={28} style={{ color: branding.accentColor }} />
            </div>
            <div>
              <p className="text-sm text-gray-500">{t("registeredEmployees")}</p>
              <p className="text-3xl font-bold" style={{ color: branding.primaryColor }}>{stats.employeeCount}</p>
            </div>
          </div>

          {/* ITER9: Card 3 — Tests assignés */}
          <div className="bg-white rounded-xl shadow-sm p-6 flex items-center gap-4">
            <div className="w-14 h-14 rounded-xl flex items-center justify-center bg-indigo-50">
              <ClipboardList size={28} className="text-indigo-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">{t("assignedTests")}</p>
              <p className="text-3xl font-bold text-indigo-700">{stats.assignedCount}</p>
            </div>
          </div>

          {/* ITER9: Card 4 — Tests en cours */}
          <div className="bg-white rounded-xl shadow-sm p-6 flex items-center gap-4">
            <div className="w-14 h-14 rounded-xl flex items-center justify-center bg-amber-50">
              <Clock size={28} className="text-amber-500" />
            </div>
            <div>
              <p className="text-sm text-gray-500">{t("testsInProgress")}</p>
              <p className="text-3xl font-bold text-amber-600">{stats.inProgressCount}</p>
            </div>
          </div>

          {/* ITER9: Card 5 — Tests terminés */}
          <div className="bg-white rounded-xl shadow-sm p-6 flex items-center gap-4">
            <div className="w-14 h-14 rounded-xl flex items-center justify-center bg-green-50">
              <CheckCircle size={28} className="text-green-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">{t("testsCompleted")}</p>
              <p className="text-3xl font-bold text-green-700">{stats.completedCount}</p>
            </div>
          </div>

          {/* ITER9: Card 6 — Réponses à analyser (clickable) */}
          <div
            className="bg-white rounded-xl shadow-sm p-6 flex flex-col gap-3 cursor-pointer hover:shadow-md transition-shadow border-2 border-transparent hover:border-orange-200"
            onClick={() => navigate("/super-admin/responses")} // ITER9: navigate on click
          >
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-xl flex items-center justify-center bg-orange-50">
                <AlertCircle size={28} className="text-orange-500" />
              </div>
              <div>
                <p className="text-sm text-gray-500">{t("openResponsesToReview")}</p>
                <p className="text-3xl font-bold text-orange-600">{totalResponses}</p>
              </div>
            </div>
            {/* ITER9: Sub-cards breakdown */}
            <div className="flex gap-2 pt-1 border-t border-gray-100">
              <button
                className="flex-1 text-xs text-center py-1.5 px-2 bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100 transition-colors"
                onClick={e => { e.stopPropagation(); navigate("/super-admin/responses", { state: { tab: "OPEN" } }); }} // ITER9
              >
                {t("openQuestionsCount")}: {stats.openResponsesCount}
              </button>
              <button
                className="flex-1 text-xs text-center py-1.5 px-2 bg-purple-50 text-purple-700 rounded-lg hover:bg-purple-100 transition-colors"
                onClick={e => { e.stopPropagation(); navigate("/super-admin/responses", { state: { tab: "SCENARIO" } }); }} // ITER9
              >
                {t("scenariosToReview")}: {stats.scenarioResponsesCount}
              </button>
            </div>
          </div>

        </div>
      </main>
    </div>
  );
}
