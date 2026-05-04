"use client";

import { startTransition, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { LanguageToggle } from "./LanguageToggle";
import { ThemeToggle } from "./ThemeToggle";
import { Button } from "@/components/ui/Button";
import { useTranslation } from "@/lib/i18n";
import { BrandLockup } from "./BrandLockup";

export function Header() {
  const { data: session } = useSession();
  const { t } = useTranslation();
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const isActiveLink = (href: string) => (href === "/dashboard" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`));

  const navigateTo = (href: string) => {
    setMenuOpen(false);
    if (pathname !== href) {
      if (pathname.startsWith("/dashboard/charting")) {
        window.location.assign(href);
        return;
      }
      startTransition(() => {
        router.push(href);
      });
    }
  };

  const navLinks = session
    ? [
        { href: "/dashboard", label: t("nav.dashboard") },
        { href: "/dashboard/charting", label: t("nav.charting") },
        { href: "/dashboard/performance", label: t("nav.reporting") },
        { href: "/dashboard/long-term-modelling", label: t("nav.longTerm") },
        { href: "/dashboard/financials", label: t("nav.financials") },
        { href: "/dashboard/price-forecast", label: t("nav.priceForecast") },
        { href: "/dashboard/retrofit-bess", label: t("nav.retrofitBess") },
        { href: "/dashboard/knowledge-base", label: t("nav.knowledgeBase") },
        { href: "/dashboard/contact", label: t("nav.contact") },
      ]
    : [];

  useEffect(() => {
    if (!session) return;
    navLinks.forEach(({ href }) => {
      router.prefetch(href);
    });
  }, [navLinks, router, session]);

  return (
    <header className="fixed top-0 left-0 right-0 z-[1000] isolate border-b border-header bg-header transition-colors duration-200">
      {/* Main bar */}
      <div className="relative z-10 flex h-14 items-center justify-between px-4 lg:px-5 xl:px-6">
        <div className="flex min-w-0 items-center gap-2 lg:gap-3 xl:gap-5">
          <BrandLockup compact />

          {/* Desktop nav — hidden below lg */}
          {session && (
            <nav className="relative z-10 hidden lg:flex items-center gap-0 text-[11px] xl:gap-0.5 xl:text-xs">
              {navLinks.map(({ href, label }) => (
                <button
                  key={href}
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    navigateTo(href);
                  }}
                  className={`header-nav-link relative z-10 whitespace-nowrap px-1.5 py-1.5 xl:px-2.5 transition-colors ${
                    isActiveLink(href)
                      ? "header-nav-link-active text-nav-active font-semibold"
                      : "text-nav hover:text-nav-active"
                    }`}
                >
                  {label}
                </button>
              ))}
            </nav>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5 lg:gap-2 xl:gap-3">
          <ThemeToggle />
          <LanguageToggle />
          {session && (
            <>
              <span className="hidden xl:block text-xs text-slate-400 truncate max-w-[180px]">
                {session.user?.email}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="hidden lg:inline-flex lg:px-2 xl:px-3"
                onClick={() => signOut({ callbackUrl: "/login" })}
              >
                {t("nav.logout")}
              </Button>
            </>
          )}

          {/* Hamburger — visible below lg */}
          {session && (
            <button
              type="button"
              aria-label="Toggle menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((prev) => !prev)}
              className="lg:hidden flex flex-col justify-center gap-[5px] p-1.5 rounded"
            >
              <span
                className={`block w-5 h-0.5 bg-slate-400 origin-center transition-transform duration-200 ${
                  menuOpen ? "translate-y-[7px] rotate-45" : ""
                }`}
              />
              <span
                className={`block w-5 h-0.5 bg-slate-400 transition-opacity duration-200 ${
                  menuOpen ? "opacity-0" : ""
                }`}
              />
              <span
                className={`block w-5 h-0.5 bg-slate-400 origin-center transition-transform duration-200 ${
                  menuOpen ? "-translate-y-[7px] -rotate-45" : ""
                }`}
              />
            </button>
          )}
        </div>
      </div>

      {/* Mobile / tablet dropdown */}
      {session && menuOpen && (
        <div className="relative z-10 lg:hidden border-t border-header bg-header px-4 py-3 transition-colors duration-200">
          <nav className="flex flex-col gap-0.5">
            {navLinks.map(({ href, label }) => (
              <button
                key={href}
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  navigateTo(href);
                }}
                className={`rounded px-3 py-2.5 text-left text-sm transition-colors border-l-2 ${
                  pathname === href
                    ? "border-orange-DEFAULT text-nav-active font-semibold bg-row"
                    : "border-transparent text-nav hover:text-nav-active hover:bg-row"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="mt-3 pt-3 border-t border-subtle flex items-center justify-between">
            <span className="text-xs text-slate-400 truncate">{session.user?.email}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => signOut({ callbackUrl: "/login" })}
            >
              {t("nav.logout")}
            </Button>
          </div>
        </div>
      )}
    </header>
  );
}
