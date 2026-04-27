const rawApiBaseUrl = (import.meta.env.VITE_API_BASE_URL || "").trim();

export const API_BASE_URL = rawApiBaseUrl.replace(/\/+$/, "");

export function resolveAssetUrl(value?: string | null): string | null {
  if (!value) return null;
  if (/^https?:\/\//i.test(value) || value.startsWith("data:")) return value;
  if (!API_BASE_URL) return value;
  if (value.startsWith("/")) return `${API_BASE_URL}${value}`;
  return `${API_BASE_URL}/${value}`;
}

export function installApiFetchShim(): void {
  if (!API_BASE_URL || typeof window === "undefined") return;

  const originalFetch = window.fetch.bind(window);

  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string") {
      if (input.startsWith("/api") || input.startsWith("/uploads")) {
        return originalFetch(`${API_BASE_URL}${input}`, init);
      }
      return originalFetch(input, init);
    }

    if (input instanceof URL) {
      if (input.origin === window.location.origin && (input.pathname.startsWith("/api") || input.pathname.startsWith("/uploads"))) {
        return originalFetch(`${API_BASE_URL}${input.pathname}${input.search}`, init);
      }
      return originalFetch(input.href, init);
    }

    return originalFetch(input, init);
  }) as typeof window.fetch;
}
