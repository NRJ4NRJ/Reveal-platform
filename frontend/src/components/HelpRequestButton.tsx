// ITER12: Floating "Besoin d'aide" button for all Admin Client pages
import React, { useState } from "react";
import { HelpCircle, X } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { useBranding } from "../contexts/BrandingContext";
import { useI18n } from "../contexts/I18nContext";
import toast from "react-hot-toast";

export default function HelpRequestButton() {
  const { accessToken, user } = useAuth();
  const branding = useBranding();
  const { t } = useI18n();
  const [showModal, setShowModal] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [contactEmail, setContactEmail] = useState((user as any)?.email || "");
  const [sending, setSending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    try {
      const res = await fetch("/api/admin/messages/help-request", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ subject, body, contactEmail }),
      });
      if (!res.ok) throw new Error();
      toast.success(t("messageSent"));
      setShowModal(false);
      setSubject(""); setBody("");
    } catch {
      toast.error(t("messageError"));
    } finally {
      setSending(false);
    }
  }

  if (user?.role !== "CLIENT_ADMIN") return null;

  return (
    <>
      {/* Floating help button — visible on all Admin Client pages */}
      <button
        onClick={() => setShowModal(true)}
        className="fixed bottom-6 right-6 z-40 flex items-center gap-2 px-4 py-3 rounded-full shadow-lg text-white text-sm font-medium hover:opacity-90 transition-opacity"
        style={{ backgroundColor: branding.primaryColor }}
        title={t("helpButton")}
      >
        <HelpCircle size={18} />
        <span>{t("helpButton")}</span>
      </button>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <h2 className="text-lg font-semibold text-gray-900">{t("helpModalTitle")}</h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600">
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("messageSubject")}</label>
                <input
                  type="text" value={subject} onChange={e => setSubject(e.target.value)}
                  required
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder={t("messageSubject")}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("messageBody")}</label>
                <textarea
                  value={body} onChange={e => setBody(e.target.value)}
                  required rows={5}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none resize-none"
                  placeholder={t("helpBodyPlaceholder")}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("emailAddress")}</label>
                <input
                  type="email" value={contactEmail} onChange={e => setContactEmail(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none"
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50">
                  {t("cancel")}
                </button>
                <button type="submit" disabled={sending}
                  className="px-4 py-2 text-sm text-white rounded-lg font-medium disabled:opacity-50 hover:opacity-90"
                  style={{ backgroundColor: branding.primaryColor }}>
                  {sending ? t("sending") : t("send")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
