import type { Metadata } from "next";
import { Montserrat } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const montserrat = Montserrat({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-dolfines",
});

export const metadata: Metadata = {
  title: "REVEAL Renewable Energy Valuation, Evaluation and Analytics Lab",
  description: "Solar PV & wind performance analysis, long-term modelling, and retrofit decision platform",
  icons: {
    icon: "/brand/favicon.png",
    shortcut: "/brand/favicon.png",
    apple: "/brand/favicon.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Anti-flash: set data-theme before first paint */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('reveal_theme');document.documentElement.setAttribute('data-theme',t==='light'?'light':'dark');}catch(e){}`,
          }}
        />
      </head>
      <body className={montserrat.variable}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
