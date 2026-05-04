"use client";

import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "@/lib/theme";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <SessionProvider>{children}</SessionProvider>
    </ThemeProvider>
  );
}
