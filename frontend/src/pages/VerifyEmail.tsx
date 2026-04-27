// ITER11: Page de confirmation de changement d'e-mail Super Admin
import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle, XCircle, Loader } from "lucide-react";

export default function VerifyEmail() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const token = searchParams.get("token");
    if (!token) {
      setStatus("error");
      setMessage("Lien invalide (token manquant).");
      return;
    }
    fetch(`/api/super-admin/platform-settings/verify-email?token=${encodeURIComponent(token)}`)
      .then(async res => {
        const data = await res.json();
        if (res.ok) {
          setStatus("success");
          setMessage(data.message || "Adresse e-mail mise à jour avec succès.");
        } else {
          setStatus("error");
          setMessage(data.error || "Lien invalide ou expiré.");
        }
      })
      .catch(() => {
        setStatus("error");
        setMessage("Erreur réseau. Veuillez réessayer.");
      });
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-sm p-8 max-w-md w-full text-center">
        <div className="flex justify-center mb-4">
          {status === "loading" && <Loader size={48} className="text-indigo-600 animate-spin" />}
          {status === "success" && <CheckCircle size={48} className="text-green-500" />}
          {status === "error"   && <XCircle    size={48} className="text-red-500" />}
        </div>
        <h1 className="text-xl font-semibold text-gray-900 mb-2">
          {status === "loading" && "Vérification en cours…"}
          {status === "success" && "E-mail confirmé"}
          {status === "error"   && "Erreur de vérification"}
        </h1>
        <p className="text-gray-600 text-sm mb-6">{message}</p>
        {status !== "loading" && (
          <button
            onClick={() => navigate("/login")}
            className="px-6 py-2 text-sm text-white rounded-lg font-medium"
            style={{ backgroundColor: "#27295A" }}>
            Aller à la connexion
          </button>
        )}
      </div>
    </div>
  );
}
