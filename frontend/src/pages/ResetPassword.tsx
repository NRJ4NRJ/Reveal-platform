import React, { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import { Eye, EyeOff, ArrowLeft } from "lucide-react";
import { useI18n } from "../contexts/I18nContext";
import LanguageSwitcher from "../components/LanguageSwitcher";

export default function ResetPassword() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || "";

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirmPassword) {
      toast.error(t("passwordsNoMatch"));
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erreur");
      setDone(true);
      toast.success(t("passwordUpdated"));
      setTimeout(() => navigate("/login"), 2000);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <div className="flex flex-1 items-center justify-center bg-gray-50 p-8">
        <div className="w-full max-w-sm bg-white rounded-xl shadow-md p-8">
          <button onClick={() => navigate("/login")}
            className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-6">
            <ArrowLeft size={16} /> {t("backToLogin")}
          </button>

          <h1 className="text-2xl font-bold mb-2" style={{ color: "#27295A" }}>{t("resetPassword")}</h1>

          {!token ? (
            <p className="text-red-500 text-sm">Lien invalide ou expiré.</p>
          ) : done ? (
            <div className="p-4 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
              {t("passwordUpdated")} Redirection...
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4 mt-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("newPassword")}</label>
                <div className="relative">
                  <input type={showPassword ? "text" : "password"} value={password}
                    onChange={e => setPassword(e.target.value)} required minLength={8}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 pr-10 text-sm focus:outline-none focus:ring-2"
                    placeholder="••••••••" />
                  <button type="button" onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("confirmPassword")}</label>
                <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
                  required className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2"
                  placeholder="••••••••" />
              </div>
              <button type="submit" disabled={loading}
                className="w-full py-2.5 rounded-lg font-semibold text-white text-sm hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: "#27295A" }}>
                {loading ? t("saving") : t("resetPassword")}
              </button>
            </form>
          )}
        </div>
      </div>
      <footer className="flex items-center justify-center py-3 bg-white border-t border-gray-100">
        <LanguageSwitcher />
      </footer>
    </div>
  );
}
