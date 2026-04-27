import React, { useState, useEffect } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { LayoutDashboard, ClipboardList, UserCircle, ChevronLeft, ChevronRight, LogOut, MessageSquare } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext";
import toast from "react-hot-toast";
import LanguageSwitcher from "../../components/LanguageSwitcher"; // ITER7: changement de langue

interface NavItem { to: string; icon: React.ReactNode; label: string; }

// ITER7: Ajout du lien "Mes messages"
const participantNav: NavItem[] = [
  { to: "/participant/dashboard", icon: <LayoutDashboard size={20} />, label: "Tableau de bord" },
  { to: "/participant/tests",     icon: <ClipboardList size={20} />,   label: "Mes tests" },
  { to: "/participant/messages",  icon: <MessageSquare size={20} />,   label: "Mes messages" },
  { to: "/participant/profile",   icon: <UserCircle size={20} />,      label: "Mes informations" },
];

// Tooltip pour mode réduit
function NavTooltip({ label, children }: { label: string; children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative" onMouseEnter={() => setVisible(true)} onMouseLeave={() => setVisible(false)}>
      {children}
      {visible && (
        <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 z-50 px-2 py-1 bg-gray-900 text-white text-xs rounded-md whitespace-nowrap shadow-lg pointer-events-none">
          {label}
          <div className="absolute right-full top-1/2 -translate-y-1/2 border-4 border-transparent border-r-gray-900" />
        </div>
      )}
    </div>
  );
}

interface ParticipantSidebarProps {
  primaryColor: string;
  accentColor: string;
  logoUrl?: string | null;
  companyName?: string;
}

export default function ParticipantSidebar({ primaryColor, accentColor, logoUrl, companyName }: ParticipantSidebarProps) {
  const { logout } = useAuth();
  const navigate = useNavigate();
  // Préférence mémorisée dans localStorage (clé distincte pour le participant)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("participant_sidebar_collapsed") === "true");

  useEffect(() => {
    localStorage.setItem("participant_sidebar_collapsed", String(collapsed));
  }, [collapsed]);

  async function handleLogout() {
    await logout();
    toast.success("Déconnecté");
    navigate("/login");
  }

  return (
    <aside
      className="flex flex-col h-screen transition-all duration-300 shrink-0"
      style={{ width: collapsed ? 64 : 240, backgroundColor: primaryColor }}
    >
      {/* Logo / Nom entreprise */}
      <div className="flex items-center gap-3 px-4 py-5 border-b border-white/10">
        {logoUrl ? (
          <img src={logoUrl} alt="Logo" className="w-8 h-8 object-contain rounded shrink-0" />
        ) : (
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
            style={{ backgroundColor: accentColor, color: primaryColor }}>
            {companyName?.[0]?.toUpperCase() || "P"}
          </div>
        )}
        {!collapsed && (
          <span className="text-white font-bold text-sm truncate">{companyName || "Mon espace"}</span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 overflow-y-auto overflow-x-hidden">
        {participantNav.map(item => (
          <div key={item.to}>
            {collapsed ? (
              <NavTooltip label={item.label}>
                <NavLink to={item.to} aria-label={item.label}
                  className={({ isActive }) =>
                    `flex items-center justify-center py-3 mx-2 rounded-lg mb-1 transition-colors ` +
                    (isActive ? "text-gray-900 font-semibold" : "text-white/80 hover:text-white hover:bg-white/10")
                  }
                  style={({ isActive }) => isActive ? { backgroundColor: accentColor, color: "#1a1a1a" } : {}}>
                  {item.icon}
                </NavLink>
              </NavTooltip>
            ) : (
              <NavLink to={item.to} aria-label={item.label}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-4 py-3 mx-2 rounded-lg mb-1 transition-colors text-sm font-medium ` +
                  (isActive ? "text-gray-900 font-semibold" : "text-white/80 hover:text-white hover:bg-white/10")
                }
                style={({ isActive }) => isActive ? { backgroundColor: accentColor, color: "#1a1a1a" } : {}}>
                {item.icon}
                <span>{item.label}</span>
              </NavLink>
            )}
          </div>
        ))}
      </nav>

      {/* Bas : déconnexion + toggle */}
      <div className="border-t border-white/10 p-2 space-y-1">
        {collapsed ? (
          <NavTooltip label="Déconnexion">
            <button onClick={handleLogout} aria-label="Déconnexion"
              className="flex items-center justify-center w-full py-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors">
              <LogOut size={20} />
            </button>
          </NavTooltip>
        ) : (
          <button onClick={handleLogout} aria-label="Déconnexion"
            className="flex items-center gap-3 w-full px-4 py-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors">
            <LogOut size={20} />
            <span className="text-sm">Déconnexion</span>
          </button>
        )}
        <button onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? "Étendre la sidebar" : "Réduire la sidebar"}
          className="flex items-center justify-center w-full py-2 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-colors">
          {collapsed ? <ChevronRight size={20} /> : <><ChevronLeft size={20} /><span className="ml-2 text-xs text-white/60">Réduire</span></>}
        </button>
        {/* ITER7: sélecteur de langue en bas de sidebar participant */}
        {!collapsed && (
          <div className="flex justify-center pt-1">
            <LanguageSwitcher className="text-white/70" />
          </div>
        )}
      </div>
    </aside>
  );
}
