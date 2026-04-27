import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import { resolveAssetUrl } from "../lib/runtime";

interface Branding {
  primaryColor: string;
  accentColor: string;
  logoUrl: string | null;
  companyName?: string;
}

interface BrandingContextType extends Branding {
  reload: () => void;
}

const defaultBranding: Branding = {
  primaryColor: "#27295A",
  accentColor: "#FCC00E",
  logoUrl: null,
};

const BrandingContext = createContext<BrandingContextType>({
  ...defaultBranding,
  reload: () => {},
});

export function BrandingProvider({ children }: { children: ReactNode }) {
  const [branding, setBranding] = useState<Branding>(defaultBranding);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    // Detect role from stored auth to choose the right branding endpoint
    let endpoint = "/api/branding";
    try {
      const raw = localStorage.getItem("auth");
      if (raw) {
        const auth = JSON.parse(raw);
        if (auth?.user?.role === "CLIENT_ADMIN" && auth?.user?.clientId) {
          endpoint = `/api/branding/client/${auth.user.clientId}`;
        } else if (auth?.user?.role === "EMPLOYEE" && auth?.user?.clientId) {
          endpoint = `/api/branding/client/${auth.user.clientId}`;
        }
      }
    } catch {}

    fetch(endpoint)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => {
        const resolvedLogoUrl = resolveAssetUrl(data.logoUrl);
        const logoUrl = resolvedLogoUrl ? `${resolvedLogoUrl}?v=${Date.now()}` : null;
        setBranding({ ...data, logoUrl });
        document.documentElement.style.setProperty("--color-primary", data.primaryColor);
        document.documentElement.style.setProperty("--color-accent", data.accentColor);
        // ITER10: alias standard pour les composants qui utilisent --primary-color
        document.documentElement.style.setProperty("--primary-color", data.primaryColor);
        document.documentElement.style.setProperty("--accent-color", data.accentColor);
      })
      .catch(() => {});
  }, [version]);

  const reload = useCallback(() => setVersion(v => v + 1), []);

  return (
    <BrandingContext.Provider value={{ ...branding, reload }}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBranding() {
  return useContext(BrandingContext);
}
