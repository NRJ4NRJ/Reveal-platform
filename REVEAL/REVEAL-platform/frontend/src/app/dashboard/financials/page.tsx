"use client";

import Image from "next/image";
import Link from "next/link";
import { useSites } from "@/hooks/useSites";
import { BackLink } from "@/components/layout/BackLink";
import { Button } from "@/components/ui/Button";
import type { Site } from "@/types/site";

function SiteTypeBadge({ siteType }: { siteType: "solar" | "wind" }) {
  return (
    <span
      className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${
        siteType === "solar"
          ? "border border-orange-300/20 bg-orange-400/15 text-orange-100"
          : "border border-sky-300/20 bg-sky-400/15 text-sky-100"
      }`}
    >
      {siteType === "solar" ? "Solar PV" : "Wind"}
    </span>
  );
}

function formatFinancialCapacity(site: Site) {
  if (site.site_type === "wind") {
    return {
      label: "AC",
      value: site.cap_ac_kw >= 1000
        ? `${(site.cap_ac_kw / 1000).toFixed(2)} MW`
        : `${site.cap_ac_kw} kW`,
    };
  }

  return {
    label: "DC",
    value: site.cap_dc_kwp >= 1000
      ? `${(site.cap_dc_kwp / 1000).toFixed(2)} MWp`
      : `${site.cap_dc_kwp} kWp`,
  };
}

function SiteList({ sites }: { sites: Site[] }) {
  return (
    <div className="mt-5 overflow-hidden rounded-[24px] border border-faint bg-[rgba(255,255,255,0.04)]">
      {sites.map((site) => {
        const capacity = formatFinancialCapacity(site);

        return (
          <Link
            key={site.id}
            href={`/dashboard/site/${site.id}/financials`}
            className="grid gap-3 border-t border-weak px-4 py-3 transition hover:bg-[rgba(255,255,255,0.06)] md:grid-cols-[1.5fr_0.8fr_1fr_0.9fr_auto] md:items-start first:border-t-0"
          >
            <div>
              <p className="font-dolfines text-lg font-semibold tracking-[0.04em] text-white">{site.display_name}</p>
              <p className="mt-1 text-xs text-slate-300/82">{site.region}, {site.country}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.2em] text-white/45">{capacity.label}</p>
              <p className="mt-1 text-sm font-semibold text-white">{capacity.value}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.2em] text-white/45">Tariff</p>
              <p className="mt-1 text-sm font-semibold text-white">
                {site.tariff_eur_mwh != null ? `${site.tariff_eur_mwh} €/MWh` : "—"}
              </p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.2em] text-white/45">BESS</p>
              <p className="mt-1 text-sm font-semibold text-white">
                {site.has_bess ? `${site.bess_energy_kwh ?? "—"} kWh` : "None"}
              </p>
            </div>
            <div className="flex items-center justify-between gap-3 md:self-center md:justify-end">
              <SiteTypeBadge siteType={site.site_type} />
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-orange-100">Open</span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

export default function FinancialsLandingPage() {
  const { sites, isLoading } = useSites();

  return (
    <div className="relative min-h-[calc(100vh-4rem)] overflow-hidden" style={{ backgroundColor: "var(--bg-page)" }}>
      <div className="absolute inset-0">
        <Image
          src="/brand/dashboard-hero.jpg"
          alt="Financial modelling background"
          fill
          priority
          className="object-cover"
        />
        <div className="absolute inset-0 bg-[linear-gradient(100deg,rgba(2,18,28,0.94),rgba(4,24,36,0.86),rgba(4,24,36,0.76))] hero-overlay" />
      </div>

      <div className="relative space-y-6 px-8 py-8 hero-content">
        <BackLink href="/dashboard" label="Back to dashboard" />

        {/* Overview panel */}
        <section className="rounded-[28px] border border-faint bg-panel p-6 backdrop-blur-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.34em] text-white/55">
            Dolfines REVEAL — Renewable Energy Valuation, Evaluation and Analytics Lab
          </p>
          <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-3">
              <h1 className="font-dolfines text-3xl font-semibold tracking-[0.08em] text-white">
                Financial Modelling
              </h1>
              <p className="max-w-3xl text-sm leading-7 text-slate-200/84">
                Build a 25-year technico-economic model for any site. The model is seeded automatically from
                the site&apos;s technical data — DC capacity, BESS specs, and tariff — then enriched with
                project CAPEX, OPEX, and financing assumptions you provide. Results include Project IRR,
                Equity IRR, NPV, and annual DSCR.
              </p>
            </div>
            <Link href="/dashboard/site/new/edit">
              <Button variant="secondary">Add new site</Button>
            </Link>
          </div>
        </section>

        {/* Workflow overview */}
        <section className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
          <div className="rounded-[28px] border border-faint bg-panel p-6 backdrop-blur-sm">
            <h2 className="font-dolfines text-2xl font-semibold tracking-[0.05em] text-white">Workflow</h2>
            <ol className="mt-5 space-y-2">
              {[
                "Select a site — technical data is pre-filled automatically",
                "Enter or review CAPEX, OPEX, and financing assumptions",
                "Inspect the 25-year P&L, DSCR, and KPI outputs in real time",
                "Save the parameters to persist them across sessions",
                "Export the annual table to CSV for investor reports",
              ].map((item, idx) => (
                <li key={idx} className="grid grid-cols-[auto_1fr] gap-3 rounded-2xl border border-faint bg-row px-4 py-3">
                  <span className="mt-0.5 text-xs font-semibold uppercase tracking-[0.2em] text-orange-100/75">{idx + 1}.</span>
                  <span className="text-sm font-medium text-white">{item}</span>
                </li>
              ))}
            </ol>
          </div>

          <div className="rounded-[28px] border border-faint bg-panel p-6 backdrop-blur-sm">
            <h2 className="font-dolfines text-2xl font-semibold tracking-[0.05em] text-white">Model scope</h2>
            <div className="mt-5 space-y-3">
              <div className="rounded-2xl border border-emerald-300/20 bg-emerald-500/8 p-4">
                <p className="text-sm font-semibold text-white">PV + BESS projects</p>
                <p className="mt-2 text-xs leading-6 text-slate-200/80">
                  Models standalone solar PV and hybrid PV + BESS projects over a configurable lifetime
                  (default 25 years). BESS revenue is modelled via a spread-price on discharged energy.
                </p>
              </div>
              <div className="rounded-2xl border border-sky-300/20 bg-sky-500/8 p-4">
                <p className="text-sm font-semibold text-white">Key outputs</p>
                <p className="mt-2 text-xs leading-6 text-slate-200/80">
                  Project IRR, Equity IRR, NPV at WACC, annual P&amp;L, CFADS, debt service coverage
                  (DSCR), and free cashflow to equity — all computed client-side in real time.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Site list */}
        <section className="rounded-[28px] border border-faint bg-panel p-6 backdrop-blur-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="font-dolfines text-2xl font-semibold tracking-[0.05em] text-white">
                Configured sites
              </h2>
              <p className="mt-2 text-sm text-slate-200/78">
                Select a site to open its financial model. Any previously saved parameters will be loaded automatically.
              </p>
            </div>
            <span className="rounded-full border border-faint bg-row px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-white/70">
              {sites.length} sites
            </span>
          </div>

          {isLoading ? (
            <p className="mt-6 text-sm text-slate-400">Loading sites…</p>
          ) : sites.length === 0 ? (
            <div className="mt-6 rounded-2xl border border-dashed border-faint bg-row p-5 text-sm leading-7 text-slate-300/78">
              No sites configured yet. Add a site to the REVEAL platform first, then return here to build its financial model.
            </div>
          ) : (
            <SiteList sites={sites} />
          )}
        </section>
      </div>
    </div>
  );
}
