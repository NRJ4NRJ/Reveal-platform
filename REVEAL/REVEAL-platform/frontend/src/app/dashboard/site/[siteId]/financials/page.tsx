"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useParams } from "next/navigation";
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Cell,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useSite } from "@/hooks/useSites";
import { BackLink } from "@/components/layout/BackLink";
import { Button } from "@/components/ui/Button";
import {
  compute,
  formatEur,
  formatPct,
  solveAssetValueForTargetEquityIrr,
  type FinancialParams,
  type FinancialResult,
  type SiteFinancialInput,
} from "@/lib/financialModel";
import { exportFinancialWorkbook } from "@/lib/financialExcelExport";
import type { Site } from "@/types/site";

type RevenueMode = "guaranteed" | "merchant" | "hybrid";
type RevenueYieldBasis = "p50" | "p90";

interface FinancialFormValues {
  acquisitionDate: string;
  revenueMode: RevenueMode;
  electricityPrice: number;
  electricityEscalation: number;
  contractPriceEscalation: number;
  guaranteedPhaseYears: number;
  revenueYieldBasis: RevenueYieldBasis;
  negativePriceBonusFactorPct: number;
  bessSpreadPrice: number;
  pvProdP50: number;
  pvProdP90: number;
  curtailmentRate: number;
  pvDegradation: number;
  pvLifetime: number;
  bessCyclesPerDay: number;
  bessMinSoH: number;
  bessDegradation: number;
  bessEffDCAC: number;
  capexPvPerKwc: number;
  capexBessPerKwh: number;
  omPv: number;
  insPv: number;
  amPv: number;
  rmPv: number;
  decomPv: number;
  omBess: number;
  insBess: number;
  amBess: number;
  rmBess: number;
  rentEuros: number;
  leaseDepositEuros: number;
  debtPercent: number;
  seniorRate: number;
  debtDuration: number;
  dsraMonths: number;
  dscrTarget: number;
  inflation: number;
  opexInflation: number;
  insuranceInflation: number;
  rentInflation: number;
  equityDividendRate: number;
  costOfEquity: number;
  tax: number;
  targetEquityIrr: number;
}

function parseUiDateToIso(value?: string | null): string | null {
  if (!value) return null;
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}

function buildDefaults(site: Site): FinancialFormValues {
  const currentYear = new Date().getFullYear();
  const defaultAcquisitionDate = parseUiDateToIso(site.cod) ?? `${currentYear}-01-01`;
  return {
    acquisitionDate: defaultAcquisitionDate,
    revenueMode: site.tariff_eur_mwh != null ? "guaranteed" : "merchant",
    electricityPrice: 85,
    electricityEscalation: 1.5,
    contractPriceEscalation: 0,
    guaranteedPhaseYears: site.contract_duration_years ?? 20,
    revenueYieldBasis: "p90",
    negativePriceBonusFactorPct: 50,
    bessSpreadPrice: 30,
    pvProdP50: site.specific_yield_p50_target_kwh_kwp ?? 1350,
    pvProdP90: site.specific_yield_p90_target_kwh_kwp ?? 1250,
    curtailmentRate: 0,
    pvDegradation: 0.5,
    pvLifetime: 25,
    bessCyclesPerDay: 1,
    bessMinSoH: 70,
    bessDegradation: 2.0,
    bessEffDCAC: site.bess_roundtrip_efficiency_pct ?? 88,
    capexPvPerKwc: 600,
    capexBessPerKwh: 300,
    omPv: 6,
    insPv: 3,
    amPv: 3,
    rmPv: 2,
    decomPv: 1,
    omBess: 8,
    insBess: 2,
    amBess: 1,
    rmBess: 2,
    rentEuros: 0,
    leaseDepositEuros: 0,
    debtPercent: 80,
    seniorRate: 5,
    debtDuration: 12,
    dsraMonths: 6,
    dscrTarget: 1.15,
    inflation: 2.0,
    opexInflation: 2.0,
    insuranceInflation: 2.0,
    rentInflation: 2.0,
    equityDividendRate: 10,
    costOfEquity: 10,
    tax: 25.0,
    targetEquityIrr: 10,
  };
}

function formatSiteCapacitySummary(site: Site) {
  if (site.site_type === "wind") {
    return site.cap_ac_kw >= 1000 ? `${(site.cap_ac_kw / 1000).toFixed(2)} MW Wind` : `${site.cap_ac_kw} kW Wind`;
  }

  return site.cap_dc_kwp >= 1000 ? `${(site.cap_dc_kwp / 1000).toFixed(2)} MWp PV` : `${site.cap_dc_kwp} kWp PV`;
}

function buildSiteInput(site: Site, f: FinancialFormValues): SiteFinancialInput {
  const pvCap = site.cap_dc_kwp || 0;
  const bessCap = site.bess_energy_kwh || 0;
  const bessPow = site.bess_power_kw || 0;
  return {
    hasPV: true,
    pvCapacity: pvCap,
    acCapacity: site.cap_ac_kw || 0,
    revenueYieldBasis: f.revenueYieldBasis,
    pvProdP50: f.pvProdP50,
    pvProdP90: f.pvProdP90,
    pvDegradation: f.pvDegradation,
    pvLifetime: f.pvLifetime,
    capexPv: f.capexPvPerKwc * pvCap,
    omPv: f.omPv,
    insPv: f.insPv,
    amPv: f.amPv,
    rmPv: f.rmPv,
    decomPv: f.decomPv,
    hasBESS: !!site.has_bess,
    bessPower: bessPow,
    bessCapacity: bessCap,
    bessDegradation: f.bessDegradation,
    bessMinSoH: f.bessMinSoH,
    bessCyclesPerDay: f.bessCyclesPerDay,
    bessEffDCAC: f.bessEffDCAC,
    capexBess: f.capexBessPerKwh * bessCap,
    omBess: f.omBess,
    insBess: f.insBess,
    amBess: f.amBess,
    rmBess: f.rmBess,
    rentEuros: f.rentEuros,
    leaseDepositEuros: f.leaseDepositEuros,
  };
}

function buildProjectParams(site: Site, f: FinancialFormValues): Partial<FinancialParams> {
  const debtShare = f.debtPercent / 100;
  const equityShare = 1 - debtShare;
  const guaranteedPhaseYears = Math.max(0, Math.min(f.guaranteedPhaseYears, f.pvLifetime));
  const contractDurationYears =
    f.revenueMode === "merchant"
      ? 0
      : f.revenueMode === "guaranteed"
        ? f.pvLifetime
        : guaranteedPhaseYears;
  const autoWacc = (equityShare * f.costOfEquity) + (debtShare * f.seniorRate * (1 - f.tax / 100));
  return {
    electricityPrice: f.electricityPrice,
    electricityEscalation: f.electricityEscalation,
    contractPrice: site.tariff_eur_mwh ?? 85,
    contractPriceEscalation: f.contractPriceEscalation,
    contractDurationYears,
    curtailmentRate: f.curtailmentRate,
    bessSpreadPrice: f.bessSpreadPrice,
    inflation: f.inflation,
    opexInflation: f.opexInflation,
    insuranceInflation: f.insuranceInflation,
    rentInflation: f.rentInflation,
    equityDividendRate: f.equityDividendRate,
    tax: f.tax,
    wacc: autoWacc,
    debtPercent: f.debtPercent,
    seniorRate: f.seniorRate,
    debtDuration: f.debtDuration,
    dsraMonths: f.dsraMonths,
    dscrTarget: f.dscrTarget,
    negativePriceBonusFactorPct: /france/i.test(site.country) ? f.negativePriceBonusFactorPct : 0,
    acquisitionDate: f.acquisitionDate,
  };
}

const AXIS_TICK = { fill: "var(--nav-text)", fontSize: 10 };
const TOOLTIP_CONTENT = {
  backgroundColor: "rgba(8, 20, 32, 0.96)",
  border: "1px solid rgba(148, 163, 184, 0.28)",
  borderRadius: "8px",
  fontSize: "11px",
  color: "#f8fafc",
  boxShadow: "0 16px 40px rgba(2, 6, 23, 0.35)",
};
const TOOLTIP_LABEL_STYLE = { color: "#cbd5e1", fontWeight: 600 };
const TOOLTIP_ITEM_STYLE = { color: "#f8fafc" };

const PNL_COLUMNS = [
  { label: "Year", description: "Model year number within the selected project lifetime." },
  { label: "Gross", description: "Gross production before curtailment, after applying the selected specific yield, degradation, and first-year proration." },
  { label: "Curt.", description: "Curtailment loss applied to gross production using the configured curtailment rate." },
  { label: "Net", description: "Net production after curtailment. Calculated as Gross minus Curt." },
  { label: "Neg. bonus", description: "French negative-hours bonus revenue. Calculated from bonus factor multiplied by tariff and the curtailed-energy basis." },
  { label: "Revenue", description: "Total revenue including PV revenue, negative-hours bonus where applicable, and BESS revenue if enabled." },
  { label: "OPEX", description: "Cash operating costs including O&M, insurance, asset management, and rent." },
  { label: "EBITDA", description: "Earnings before interest, tax, depreciation and amortization. Calculated as Revenue minus OPEX." },
  { label: "MRA", description: "Maintenance reserve accruals and similar non-cash reserve charges." },
  { label: "Decom.", description: "Dismantling or decommissioning provision accrued for the year." },
  { label: "D&A", description: "Depreciation and amortization charge for the year." },
  { label: "Interest", description: "Finance cost on outstanding debt for the year." },
  { label: "Tax", description: "Corporate tax applied to positive earnings before tax." },
  { label: "Principal", description: "Debt principal repaid during the year." },
  { label: "Debt Svc", description: "Total debt service. Calculated as Interest plus Principal." },
  { label: "CFADS", description: "Cash flow available for debt service. Formula: CFADS = EBITDA - Tax (+ lease-deposit recovery in the final year, if any)." },
  { label: "FCF Equity", description: "Free cash flow to equity. Formula: FCF Equity = CFADS - Debt Svc." },
  { label: "Eq. Div.", description: "Equity dividends distributed from free cash available after debt service." },
  { label: "Retained", description: "FCF Equity - Eq. Div." },
  { label: "DSCR", description: "Debt service coverage ratio. Calculated as CFADS divided by Debt Svc." },
] as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-faint bg-row p-4">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.25em] text-nav/70">{title}</p>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

function NumInput({
  label,
  value,
  onChange,
  step = 1,
  min,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  suffix?: string;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex-1 leading-tight text-xs text-nav/85">{label}</span>
      <div className="flex w-[9.25rem] shrink-0 items-center justify-end gap-1">
        <input
          type="text"
          inputMode="decimal"
          value={draft}
          onChange={(e) => {
            const next = e.target.value;
            setDraft(next);
            const normalized = next.replace(",", ".").trim();
            if (!normalized) return;
            const v = parseFloat(normalized);
            if (!isFinite(v)) return;
            if (min != null && v < min) return;
            onChange(v);
          }}
          onBlur={() => {
            if (!draft.trim()) setDraft(String(value));
          }}
          className="w-24 rounded border border-faint bg-panel px-2 py-1 text-right text-sm text-nav-active focus:border-orange-400/70 focus:outline-none"
        />
        {suffix && <span className="w-12 text-right text-[10px] text-nav/65">{suffix}</span>}
      </div>
    </div>
  );
}

function StaticValue({ label, value, suffix }: { label: string; value: string; suffix?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex-1 leading-tight text-xs text-nav/85">{label}</span>
      <div className="flex w-[9.25rem] shrink-0 items-center justify-end gap-1">
        <span className="w-24 rounded border border-faint bg-panel px-2 py-1 text-right text-sm text-nav-active">{value}</span>
        {suffix && <span className="w-12 text-right text-[10px] text-nav/65">{suffix}</span>}
      </div>
    </div>
  );
}

function SelectInput({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex-1 leading-tight text-xs text-nav/85">{label}</span>
      <div className="flex w-[9.25rem] shrink-0 items-center justify-end gap-1">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded border border-faint bg-panel px-2 py-1 text-right text-sm text-nav-active focus:border-orange-400/70 focus:outline-none"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function DateInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex-1 leading-tight text-xs text-nav/85">{label}</span>
      <div className="flex w-[9.25rem] shrink-0 items-center justify-end gap-1">
        <input
          type="date"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded border border-faint bg-panel px-2 py-1 text-right text-sm text-nav-active focus:border-orange-400/70 focus:outline-none"
        />
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  colorClass = "text-nav-active",
  sub,
}: {
  label: string;
  value: string;
  colorClass?: string;
  sub?: string;
}) {
  return (
    <div className="rounded-2xl border border-faint bg-row p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-nav/70">{label}</p>
      <p className={`mt-2 font-dolfines text-2xl font-semibold tracking-[0.04em] ${colorClass}`}>{value}</p>
      {sub && <p className="mt-1 text-[10px] text-nav/65">{sub}</p>}
    </div>
  );
}

function InfoBadge({
  description,
  placement = "bottom",
  width = 224,
}: {
  description: string;
  placement?: "top" | "bottom";
  width?: number;
}) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const updatePosition = useCallback(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const offset = 10;
    setPosition({
      left: rect.left + (rect.width / 2),
      top: placement === "top" ? rect.top - offset : rect.bottom + offset,
    });
  }, [placement]);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const handleReposition = () => updatePosition();
    window.addEventListener("scroll", handleReposition, true);
    window.addEventListener("resize", handleReposition);
    return () => {
      window.removeEventListener("scroll", handleReposition, true);
      window.removeEventListener("resize", handleReposition);
    };
  }, [open, updatePosition]);

  return (
    <>
      <span
        ref={anchorRef}
        onMouseEnter={() => {
          updatePosition();
          setOpen(true);
        }}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => {
          updatePosition();
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-faint text-[9px] font-semibold normal-case tracking-normal text-nav/70"
        tabIndex={0}
        aria-label={description}
      >
        i
      </span>
      {open && position
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[120] rounded-lg border border-faint bg-panel px-3 py-2 text-[10px] font-normal normal-case tracking-normal text-nav-active shadow-lg"
              style={{
                left: position.left,
                top: position.top,
                width,
                transform: placement === "top" ? "translate(-50%, -100%)" : "translateX(-50%)",
              }}
            >
              {description}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function HeaderInfo({ label, description }: { label: string; description: string }) {
  return (
    <div className="inline-flex items-center gap-1.5">
      <span className={label === "Revenue" ? "font-bold text-nav-active" : ""}>{label}</span>
      <InfoBadge description={description} placement="bottom" />
    </div>
  );
}

function irrColor(pct: number): string {
  if (!isFinite(pct)) return "text-slate-400";
  return pct < 5 ? "text-rose-400" : "text-nav-active";
}

function dscrColor(val: number | null, target: number): string {
  if (val === null || !isFinite(val)) return "text-slate-400";
  return val < target ? "text-rose-400" : "text-nav-active";
}

function formatCompactNumber(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

function pnlValueClass(value: number): string {
  return value < 0 ? "text-rose-400" : "text-nav-active";
}

export default function SiteFinancialsPage() {
  const params = useParams();
  const siteId = params.siteId as string;
  const { site, isLoading } = useSite(siteId);

  const [formValues, setFormValues] = useState<FinancialFormValues | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [hasCalculated, setHasCalculated] = useState(false);
  const [dirtySinceCalc, setDirtySinceCalc] = useState(false);
  const [calcVersion, setCalcVersion] = useState(0);
  const [nboWarning, setNboWarning] = useState<string | null>(null);

  useEffect(() => {
    if (!site || formValues !== null) return;
    fetch(`/api/sites/${site.id}/financials`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: FinancialFormValues | null) => {
        setFormValues({ ...buildDefaults(site), ...(data ?? {}) });
        setHasCalculated(false);
        setDirtySinceCalc(false);
      })
      .catch(() => {
        setFormValues(buildDefaults(site));
        setHasCalculated(false);
        setDirtySinceCalc(false);
      });
  }, [site, formValues]);

  const update = useCallback(
    <K extends keyof FinancialFormValues>(key: K, value: FinancialFormValues[K]) =>
      setFormValues((prev) => {
        if (!prev) return prev;
        if (hasCalculated) {
          setDirtySinceCalc(true);
          setNboWarning(null);
        }
        return { ...prev, [key]: value };
      }),
    [hasCalculated],
  );

  const siteInput = useMemo<SiteFinancialInput | null>(() => {
    if (!site || !formValues) return null;
    return buildSiteInput(site, formValues);
  }, [site, formValues]);

  const projectParams = useMemo<Partial<FinancialParams> | null>(() => {
    if (!site || !formValues) return null;
    return buildProjectParams(site, formValues);
  }, [site, formValues]);

  const result = useMemo<FinancialResult | null>(() => {
    if (!siteInput || !projectParams) return null;
    void calcVersion;
    try {
      return compute(siteInput, projectParams);
    } catch {
      return null;
    }
  }, [siteInput, projectParams, calcVersion]);

  const valuation = useMemo(() => {
    if (!siteInput || !projectParams || !formValues) return null;
    void calcVersion;
    try {
      return solveAssetValueForTargetEquityIrr(siteInput, projectParams, formValues.targetEquityIrr);
    } catch {
      return null;
    }
  }, [siteInput, projectParams, formValues, calcVersion]);

  const handleSave = async () => {
    if (!site || !formValues) return;
    setSaving(true);
    try {
      await fetch(`/api/sites/${site.id}/financials`, {
        method: "PUT",
        body: JSON.stringify(formValues),
        headers: { "Content-Type": "application/json" },
      });
      setSavedAt(new Date().toLocaleTimeString());
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (!site) return;
    setFormValues(buildDefaults(site));
    setHasCalculated(false);
    setDirtySinceCalc(false);
    setNboWarning(null);
  };

  const handleRunCalculation = () => {
    setCalcVersion((current) => current + 1);
    setHasCalculated(true);
    setDirtySinceCalc(false);
    setNboWarning(null);
  };

  const handleGenerateNbo = () => {
    if (!site) return;
    if (!hasCalculated || !result) {
      setNboWarning("Run calculation first before generating the NBO.");
      return;
    }
    if (dirtySinceCalc) {
      setNboWarning("Recalculate first so the NBO uses the latest assumptions.");
      return;
    }
    setNboWarning(null);
    window.location.href = `/api/sites/${site.id}/offers/nbo`;
  };

  const handleExportExcel = async () => {
    if (!site) return;
    if (!hasCalculated || !result) {
      setNboWarning("Run calculation first before exporting Excel.");
      return;
    }
    if (dirtySinceCalc) {
      setNboWarning("Recalculate first so the Excel export uses the latest assumptions.");
      return;
    }
    if (!siteInput || !projectParams || !formValues) return;
    setNboWarning(null);
    await exportFinancialWorkbook({
      siteName: site.display_name,
      location: `${site.region}, ${site.country}`,
      capacitySummary: formatSiteCapacitySummary(site),
      cod: site.cod,
      siteInput,
      projectParams: projectParams as FinancialParams,
      kpis: result.kpis,
      annual: result.annual,
      valuation,
      targetEquityIrr: formValues.targetEquityIrr,
      costOfEquity: formValues.costOfEquity,
      logoUrl: `${window.location.origin}/brand/dolfines_colour.png`,
    });
  };

  if (isLoading || !site || !formValues) {
    return (
      <div className="min-h-[calc(100vh-4rem)] px-8 py-8" style={{ backgroundColor: "var(--bg-page)" }}>
        <p className="text-sm text-nav/70">Loading…</p>
      </div>
    );
  }

  const showResults = hasCalculated && !dirtySinceCalc && !!result;
  const canUseCalculatedOutputs = hasCalculated && !dirtySinceCalc && !!result;
  const kpis = result?.kpis;
  const hasBESS = !!site.has_bess;
  const isFrenchSite = /france/i.test(site.country);
  const chartData =
    result?.annual.map((a) => ({
      year: a.year,
      pvRevenue: Math.round(a.pvRevenue / 1e3),
      negativePriceBonusRevenue: Math.round(a.negativePriceBonusRevenue / 1e3),
      bessRevenue: Math.round(a.bessRevenue / 1e3),
      totalOpex: Math.round(a.totalOpex / 1e3),
      ebitda: Math.round(a.ebitda / 1e3),
      cfads: Math.round(a.cfads / 1e3),
      debtService: Math.round(a.debtService / 1e3),
      fcfEquity: Math.round(a.fcfEquity / 1e3),
    })) ?? [];
  const opexBreakdownData =
    result?.annual.map((a) => ({
      year: a.year,
      pvOmCost: Math.round(a.pvOmCost / 1e3),
      pvAmCost: Math.round(a.pvAmCost / 1e3),
      pvInsurance: Math.round(a.pvInsurance / 1e3),
      bessOmCost: Math.round(a.bessOmCost / 1e3),
      bessAmCost: Math.round(a.bessAmCost / 1e3),
      bessInsurance: Math.round(a.bessInsurance / 1e3),
      rent: Math.round(a.rent / 1e3),
    })) ?? [];
  const fmtK = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}M` : `${v}k`);
  const fmtInvestorAxis = (v: number) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M€` : `${Math.round(v / 1000)}k€`);
  const totalBaseCapex = formValues.capexPvPerKwc * (site.cap_dc_kwp || 0) + formValues.capexBessPerKwh * (site.bess_energy_kwh || 0);
  const guaranteedYears = Math.max(0, Math.min(formValues.guaranteedPhaseYears, formValues.pvLifetime));
  const merchantYears =
    formValues.revenueMode === "merchant"
      ? formValues.pvLifetime
      : formValues.revenueMode === "hybrid"
        ? Math.max(0, formValues.pvLifetime - guaranteedYears)
        : 0;
  const equityPct = Math.max(0, 100 - formValues.debtPercent);
  const autoWacc =
    (equityPct / 100) * formValues.costOfEquity +
    (formValues.debtPercent / 100) * formValues.seniorRate * (1 - formValues.tax / 100);
  const investorReturnData =
    result?.annual.reduce<Array<{ year: number; cumulativeCash: number; netCashPosition: number }>>((acc, row) => {
      const initialEquity = result.kpis.equity + formValues.leaseDepositEuros;
      const cumulativeCash = (acc[acc.length - 1]?.cumulativeCash ?? 0) + row.equityDividends;
      acc.push({
        year: row.year,
        cumulativeCash,
        netCashPosition: cumulativeCash - initialEquity,
      });
      return acc;
    }, []) ?? [];
  const investorMilestones = [5, 10, 15, 20]
    .map((year) => investorReturnData.find((point) => point.year === year))
    .filter((point): point is { year: number; cumulativeCash: number; netCashPosition: number } => Boolean(point));
  const initialEquityInvestment = (result?.kpis.equity ?? 0) + formValues.leaseDepositEuros;
  const lifetimeTotals = result
    ? result.annual.reduce(
        (acc, row) => {
          acc.revenue += row.totalRevenue;
          acc.negativeBonus += row.negativePriceBonusRevenue;
          acc.opex += row.totalOpex;
          acc.interest += row.financialCharge;
          acc.tax += row.taxAmount;
          acc.principal += row.principalRepayment;
          acc.equityDividends += row.equityDividends;
          acc.retainedCash += row.retainedCash;
          return acc;
        },
        { revenue: 0, negativeBonus: 0, opex: 0, interest: 0, tax: 0, principal: 0, equityDividends: 0, retainedCash: 0 },
      )
    : null;
  const waterfallData = lifetimeTotals
    ? [
        { name: "Base revenue", base: 0, value: lifetimeTotals.revenue - lifetimeTotals.negativeBonus, color: "#22c55e" },
        { name: "Neg.-hours bonus", base: lifetimeTotals.revenue - lifetimeTotals.negativeBonus, value: lifetimeTotals.negativeBonus, color: "#22c55e" },
        { name: "OPEX", base: lifetimeTotals.revenue, value: -lifetimeTotals.opex, color: "#ef4444" },
        {
          name: "Interest",
          base: lifetimeTotals.revenue - lifetimeTotals.opex,
          value: -lifetimeTotals.interest,
          color: "#ef4444",
        },
        {
          name: "Tax",
          base: lifetimeTotals.revenue - lifetimeTotals.opex - lifetimeTotals.interest,
          value: -lifetimeTotals.tax,
          color: "#ef4444",
        },
        {
          name: "Principal",
          base: lifetimeTotals.revenue - lifetimeTotals.opex - lifetimeTotals.interest - lifetimeTotals.tax,
          value: -lifetimeTotals.principal,
          color: "#ef4444",
        },
        {
          name: "Eq. return",
          base: lifetimeTotals.revenue - lifetimeTotals.opex - lifetimeTotals.interest - lifetimeTotals.tax - lifetimeTotals.principal,
          value: -lifetimeTotals.equityDividends,
          color: "#ef4444",
        },
        {
          name: "Retained cash",
          base: 0,
          value: lifetimeTotals.retainedCash,
          color: "#22c55e",
        },
      ]
    : [];

  return (
    <div className="min-h-[calc(100vh-4rem)]" style={{ backgroundColor: "var(--bg-page)" }}>
      <div className="space-y-6 px-8 py-8">
        <BackLink href="/dashboard/financials" label="Back to Financial Modelling" />

        <section className="rounded-[28px] border border-faint bg-panel p-6 backdrop-blur-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.34em] text-nav/70">Dolfines REVEAL — Financial Modelling</p>
          <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="font-dolfines text-3xl font-semibold tracking-[0.08em] text-nav-active">{site.display_name}</h1>
              <p className="mt-1 text-sm text-nav/80">
                {site.region}, {site.country}
                {" · "}
                {formatSiteCapacitySummary(site)}
                {hasBESS && ` · ${site.bess_energy_kwh ?? "—"} kWh BESS`}
                {" · COD "}
                {site.cod}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {savedAt && <span className="text-xs text-emerald-500">Saved {savedAt}</span>}
              {hasCalculated && dirtySinceCalc && <span className="text-xs text-amber-500">Results out of date</span>}
              <Button variant="primary" size="sm" onClick={handleRunCalculation}>
                {hasCalculated ? "1. Recalculate" : "1. Run calculation"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleExportExcel}
                disabled={!canUseCalculatedOutputs}
                className="border-sky-600 !bg-sky-600 !text-white hover:!border-sky-700 hover:!bg-sky-700 hover:!text-white focus:ring-sky-500 disabled:!border-slate-400 disabled:!bg-slate-400 disabled:!text-white"
              >
                2. Export Excel
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleGenerateNbo}
                disabled={!canUseCalculatedOutputs}
                className="border-emerald-600 !bg-emerald-600 !text-white hover:!border-emerald-700 hover:!bg-emerald-700 hover:!text-white focus:ring-emerald-500"
              >
                3. Generate NBO
              </Button>
              <Button variant="ghost" size="sm" onClick={handleReset}>
                Reset
              </Button>
              <Button variant="ghost" size="sm" onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : "Save parameters"}
              </Button>
            </div>
          </div>
          {nboWarning && <p className="mt-3 text-sm text-rose-500">{nboWarning}</p>}
        </section>

        <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
          <div className="space-y-3">
            <Section title="Revenue assumptions">
              <DateInput label="Acquisition date" value={formValues.acquisitionDate} onChange={(v) => update("acquisitionDate", v)} />
              <NumInput label="Project lifetime" value={formValues.pvLifetime} onChange={(v) => update("pvLifetime", v)} step={1} suffix="years" />
              <SelectInput
                label="Revenue structure"
                value={formValues.revenueMode}
                onChange={(v) => update("revenueMode", v as RevenueMode)}
                options={[
                  { value: "guaranteed", label: "Guaranteed" },
                  { value: "merchant", label: "Merchant" },
                  { value: "hybrid", label: "Guaranteed + Merchant" },
                ]}
              />
              <SelectInput
                label="Use specific yield basis"
                value={formValues.revenueYieldBasis}
                onChange={(v) => update("revenueYieldBasis", v as RevenueYieldBasis)}
                options={[
                  { value: "p50", label: "P50" },
                  { value: "p90", label: "P90" },
                ]}
              />
              <StaticValue label="Contracted / offtake price" value={(site.tariff_eur_mwh ?? 85).toFixed(2)} suffix="€/MWh" />
              {formValues.revenueMode !== "merchant" && (
                <NumInput label="Guaranteed price escalation" value={formValues.contractPriceEscalation} onChange={(v) => update("contractPriceEscalation", v)} step={0.1} suffix="%/yr" />
              )}
              {formValues.revenueMode === "hybrid" && (
                <>
                  <NumInput label="Guaranteed / offtake period" value={formValues.guaranteedPhaseYears} onChange={(v) => update("guaranteedPhaseYears", v)} step={1} suffix="years" />
                  <StaticValue label="Merchant period" value={merchantYears.toFixed(0)} suffix="years" />
                </>
              )}
              {formValues.revenueMode === "guaranteed" && <StaticValue label="Guaranteed / offtake period" value={formValues.pvLifetime.toFixed(0)} suffix="years" />}
              {formValues.revenueMode === "merchant" && <StaticValue label="Merchant period" value={formValues.pvLifetime.toFixed(0)} suffix="years" />}
              {formValues.revenueMode !== "guaranteed" && (
                <>
                  <NumInput label="Merchant price" value={formValues.electricityPrice} onChange={(v) => update("electricityPrice", v)} step={1} suffix="€/MWh" />
                  <NumInput label="Merchant escalation" value={formValues.electricityEscalation} onChange={(v) => update("electricityEscalation", v)} step={0.1} suffix="%/yr" />
                </>
              )}
              {isFrenchSite && (
                <>
                  <NumInput label="Negative-hours bonus factor" value={formValues.negativePriceBonusFactorPct} onChange={(v) => update("negativePriceBonusFactorPct", v)} step={1} min={0} suffix="%" />
                </>
              )}
              {hasBESS && <NumInput label="BESS spread price" value={formValues.bessSpreadPrice} onChange={(v) => update("bessSpreadPrice", v)} step={1} suffix="€/MWh" />}
              <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-nav/70">
                <div className="inline-flex items-center gap-1.5">
                  <span>Revenue structure</span>
                  <InfoBadge description="Choose whether revenue is fully guaranteed, fully merchant, or split between a guaranteed phase and a merchant tail. The guaranteed tariff is inherited from site setup." placement="top" />
                </div>
                <div className="inline-flex items-center gap-1.5">
                  <span>Year 1 proration</span>
                  <InfoBadge description="Year 1 revenue and annual costs are prorated linearly from the acquisition date through year-end." placement="top" />
                </div>
                <div className="inline-flex items-center gap-1.5">
                  <span>Yield basis</span>
                  <InfoBadge description="The selected P50 or P90 specific yield is used for the live revenue case and, for French sites, also for the negative-hours bonus basis." placement="top" />
                </div>
                {isFrenchSite && (
                  <div className="inline-flex items-center gap-1.5">
                    <span>Negative-hours bonus</span>
                    <InfoBadge description="France-only bonus: bonus factor × tarif de reference × qualifying negative-price basis. The qualifying basis is derived automatically from curtailment % × annual specific yield × kWp. Set the factor to 0% to disable the bonus." placement="top" width={260} />
                  </div>
                )}
              </div>
            </Section>

            <Section title="Operating assumptions">
              <NumInput label="P50 specific yield" value={formValues.pvProdP50} onChange={(v) => update("pvProdP50", v)} step={10} suffix="kWh/kWp" />
              <NumInput label="P90 specific yield" value={formValues.pvProdP90} onChange={(v) => update("pvProdP90", v)} step={10} suffix="kWh/kWp" />
              <NumInput label="Curtailment rate" value={formValues.curtailmentRate} onChange={(v) => update("curtailmentRate", v)} step={0.1} suffix="%" />
              <NumInput label="Annual module degradation" value={formValues.pvDegradation} onChange={(v) => update("pvDegradation", v)} step={0.1} suffix="%/yr" />
              <p className="text-xs text-nav/70">The live revenue case and the negative-hours bonus basis both use the selected P50 or P90 specific yield, with curtailment applied explicitly.</p>
            </Section>

            {hasBESS && (
              <Section title="BESS assumptions">
                <NumInput label="Cycles per day" value={formValues.bessCyclesPerDay} onChange={(v) => update("bessCyclesPerDay", v)} step={0.5} suffix="cyc/day" />
                <NumInput label="Min state of health" value={formValues.bessMinSoH} onChange={(v) => update("bessMinSoH", v)} step={1} suffix="%" />
                <NumInput label="Degradation" value={formValues.bessDegradation} onChange={(v) => update("bessDegradation", v)} step={0.1} suffix="%/yr" />
                <NumInput label="Round-trip efficiency" value={formValues.bessEffDCAC} onChange={(v) => update("bessEffDCAC", v)} step={1} suffix="%" />
              </Section>
            )}

            <Section title="Investment amount">
              <NumInput label="PV" value={formValues.capexPvPerKwc} onChange={(v) => update("capexPvPerKwc", v)} step={10} suffix="€/kWp" />
              {hasBESS && <NumInput label="BESS" value={formValues.capexBessPerKwh} onChange={(v) => update("capexBessPerKwh", v)} step={10} suffix="€/kWh" />}
              <div className="flex items-center justify-between border-t border-faint/50 pt-1">
                <span className="text-xs text-nav/70">Base investment amount</span>
                <span className="text-sm font-semibold text-nav-active">{formatEur(totalBaseCapex)}</span>
              </div>
            </Section>

            <Section title="OPEX — PV">
              <NumInput label="O&M" value={formValues.omPv} onChange={(v) => update("omPv", v)} step={0.5} suffix="€/kWp/yr" />
              <NumInput label="Insurance" value={formValues.insPv} onChange={(v) => update("insPv", v)} step={0.5} suffix="€/kWp/yr" />
              <NumInput label="Asset management" value={formValues.amPv} onChange={(v) => update("amPv", v)} step={0.5} suffix="€/kWp/yr" />
              <NumInput label="Maintenance reserve" value={formValues.rmPv} onChange={(v) => update("rmPv", v)} step={0.5} suffix="€/kWp/yr" />
              <NumInput label="Dismantling provision" value={formValues.decomPv} onChange={(v) => update("decomPv", v)} step={0.5} suffix="€/kWp/yr" />
            </Section>

            {hasBESS && (
              <Section title="OPEX — BESS">
                <NumInput label="O&M" value={formValues.omBess} onChange={(v) => update("omBess", v)} step={0.5} suffix="€/kW/yr" />
                <NumInput label="Insurance" value={formValues.insBess} onChange={(v) => update("insBess", v)} step={0.5} suffix="€/kW/yr" />
                <NumInput label="Asset management" value={formValues.amBess} onChange={(v) => update("amBess", v)} step={0.5} suffix="€/kW/yr" />
                <NumInput label="Maintenance reserve" value={formValues.rmBess} onChange={(v) => update("rmBess", v)} step={0.5} suffix="€/kW/yr" />
              </Section>
            )}

            <Section title="Other operating costs">
              <NumInput label="Land / roof rent" value={formValues.rentEuros} onChange={(v) => update("rentEuros", v)} step={1000} suffix="€/yr" />
              <NumInput label="Lease deposit" value={formValues.leaseDepositEuros} onChange={(v) => update("leaseDepositEuros", v)} step={1000} suffix="€" />
              <NumInput label="OPEX inflator" value={formValues.opexInflation} onChange={(v) => update("opexInflation", v)} step={0.1} suffix="%/yr" />
              <NumInput label="Insurance inflator" value={formValues.insuranceInflation} onChange={(v) => update("insuranceInflation", v)} step={0.1} suffix="%/yr" />
              <NumInput label="Rent inflator" value={formValues.rentInflation} onChange={(v) => update("rentInflation", v)} step={0.1} suffix="%/yr" />
            </Section>

            <Section title="Financing">
              <NumInput label="Debt % of asset value" value={formValues.debtPercent} onChange={(v) => update("debtPercent", v)} step={1} suffix="%" />
              <StaticValue label="Equity % of asset value" value={formatCompactNumber(equityPct)} suffix="%" />
              <NumInput label="Senior loan rate" value={formValues.seniorRate} onChange={(v) => update("seniorRate", v)} step={0.1} suffix="%/yr" />
              <NumInput label="Loan duration" value={formValues.debtDuration} onChange={(v) => update("debtDuration", v)} step={1} suffix="years" />
              <NumInput label="DSRA months" value={formValues.dsraMonths} onChange={(v) => update("dsraMonths", v)} step={1} suffix="months" />
              <NumInput label="DSCR covenant" value={formValues.dscrTarget} onChange={(v) => update("dscrTarget", v)} step={0.05} suffix="x" />
              <NumInput label="Cost of equity" value={formValues.costOfEquity} onChange={(v) => update("costOfEquity", v)} step={0.1} suffix="%/yr" />
              <NumInput label="Equity dividend rate" value={formValues.equityDividendRate} onChange={(v) => update("equityDividendRate", v)} step={5} suffix="%" />
              <p className="text-xs text-nav/70">
                The DSCR covenant is currently a monitoring threshold: it colours the DSCR outputs and flags whether annual coverage stays above the minimum, but it does not yet resize debt automatically.
              </p>
            </Section>

            <Section title="Economics">
              <NumInput label="Corporate tax" value={formValues.tax} onChange={(v) => update("tax", v)} step={1} suffix="%" />
              <StaticValue label="Auto-calculated WACC" value={autoWacc.toFixed(2)} suffix="%/yr" />
            </Section>

            <Section title="Valuation">
              <NumInput label="Target equity IRR" value={formValues.targetEquityIrr} onChange={(v) => update("targetEquityIrr", v)} step={0.1} suffix="%" />
              <div className="rounded-xl border border-faint/70 bg-panel px-3 py-2 text-xs text-nav/75">REVEAL solves for the maximum asset value that still delivers the target equity IRR under the current operating and financing assumptions.</div>
              {!showResults ? (
                <div className="rounded-xl border border-dashed border-faint bg-panel px-3 py-4 text-xs text-nav/70">Run the calculation to generate valuation outputs.</div>
              ) : (
                <>
                  <div className="flex items-center justify-between border-t border-faint/50 pt-1">
                    <span className="text-xs text-nav/70">Implied asset value</span>
                    <span className="text-sm font-semibold text-nav-active">{formatEur(valuation?.assetValue)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-nav/70">Implied price per kWp</span>
                    <span className="text-sm font-semibold text-nav-active">{valuation?.pricePerWp != null ? `${valuation.pricePerWp.toFixed(1)} €/kWp` : "—"}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-nav/70">Debt at solved value</span>
                    <span className="text-sm font-semibold text-sky-300">{formatEur(valuation?.debt)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-nav/70">Equity at solved value</span>
                    <span className="text-sm font-semibold text-violet-300">{formatEur(valuation?.equity)}</span>
                  </div>
                </>
              )}
            </Section>
          </div>

          <div className="flex h-full flex-col gap-4">
            {!showResults ? (
              <div className="flex-1 rounded-[24px] border border-dashed border-faint bg-panel p-8 text-center backdrop-blur-sm">
                <p className="text-sm font-semibold text-nav-active">Model outputs are hidden until calculation is run.</p>
                <p className="mt-2 text-xs text-nav/70">Review the assumptions on the left, then click {hasCalculated ? "Recalculate" : "Run calculation"} to generate KPIs, charts, valuation, and the annual P&amp;L.</p>
              </div>
            ) : (
              <div className="flex h-full flex-col gap-4">
                <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <KpiCard label="Project IRR" value={formatPct(kpis?.projectIRR)} colorClass={irrColor(kpis?.projectIRR ?? NaN)} />
                  <KpiCard label="Equity IRR" value={formatPct(kpis?.equityIRR)} colorClass={irrColor(kpis?.equityIRR ?? NaN)} />
                  <KpiCard label="NPV (WACC)" value={formatEur(kpis?.van)} colorClass={(kpis?.van ?? 0) < 0 ? "text-rose-400" : "text-nav-active"} />
                  <KpiCard
                    label="DSCR min"
                    value={kpis?.dscrMin != null ? kpis.dscrMin.toFixed(2) : "—"}
                    colorClass={dscrColor(kpis?.dscrMin ?? null, formValues.dscrTarget)}
                    sub={`avg ${kpis?.dscrAvg != null ? kpis.dscrAvg.toFixed(2) : "—"}`}
                  />
                  <KpiCard label="Total investment amount" value={formatEur(kpis?.totalCapex)} />
                  <KpiCard label="Senior debt" value={formatEur(kpis?.debt)} sub={`${kpis?.debtPercent ?? 0}% gearing`} />
                  <KpiCard label="Equity" value={formatEur(kpis?.equity)} />
                  <KpiCard label="CFADS Y1" value={formatEur(result?.annual[0]?.cfads)} />
                </section>

                <div className="rounded-[24px] border border-faint bg-panel p-5 backdrop-blur-sm">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-[0.22em] text-nav/70">Lifetime Cash Waterfall</p>
                  <p className="mb-4 text-xs text-nav/70">Whole-project cash bridge from revenue through OPEX, financing, equity investor return, and final cash retained by the project over the selected lifetime.</p>
                  <div className="h-[32rem]">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={waterfallData} margin={{ top: 12, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-faint)" />
                        <XAxis dataKey="name" tick={AXIS_TICK} tickLine={false} axisLine={false} />
                        <YAxis tickFormatter={fmtInvestorAxis} tick={AXIS_TICK} tickLine={false} axisLine={false} width={64} />
                        <Tooltip
                          contentStyle={TOOLTIP_CONTENT}
                          labelStyle={TOOLTIP_LABEL_STYLE}
                          itemStyle={TOOLTIP_ITEM_STYLE}
                          formatter={(v: number, name: string, item: { payload?: { value?: number; base?: number } }) => {
                            if (name === "base") return null;
                            const delta = item?.payload?.value ?? v;
                            const end = (item?.payload?.base ?? 0) + delta;
                            return [formatEur(delta), `${name} | end ${formatEur(end)}`];
                          }}
                        />
                        <ReferenceLine y={0} stroke="var(--border-faint)" />
                        <Bar dataKey="base" stackId="waterfall" fill="transparent" />
                        <Bar dataKey="value" stackId="waterfall" radius={[6, 6, 6, 6]}>
                          {waterfallData.map((entry) => (
                            <Cell key={entry.name} fill={entry.color} />
                          ))}
                        </Bar>
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="rounded-[24px] border border-faint bg-panel p-5 backdrop-blur-sm">
                  <p className="mb-4 text-xs font-semibold uppercase tracking-[0.22em] text-nav/70">Annual Revenue &amp; OPEX (k€)</p>
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={chartData} margin={{ top: 2, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-faint)" />
                        <XAxis dataKey="year" tick={AXIS_TICK} tickLine={false} axisLine={false} interval={4} />
                        <YAxis tickFormatter={fmtK} tick={AXIS_TICK} tickLine={false} axisLine={false} width={48} />
                        <Tooltip contentStyle={TOOLTIP_CONTENT} labelStyle={TOOLTIP_LABEL_STYLE} itemStyle={TOOLTIP_ITEM_STYLE} formatter={(v: number, name: string) => [`${v.toLocaleString()} k€`, name]} labelFormatter={(yr) => `Year ${yr}`} />
                        <Legend wrapperStyle={{ fontSize: 10, color: "var(--nav-text)" }} />
                        <Bar dataKey="pvRevenue" name="PV Revenue" stackId="rev" fill="#34d399" />
                        {isFrenchSite && <Bar dataKey="negativePriceBonusRevenue" name="Negative-hours bonus" stackId="rev" fill="#f59e0b" />}
                        {hasBESS && <Bar dataKey="bessRevenue" name="BESS Revenue" stackId="rev" fill="#38bdf8" />}
                        <Bar dataKey="totalOpex" name="OPEX" fill="#fb7185" opacity={0.85} />
                        <Line dataKey="ebitda" name="EBITDA" stroke="#fbbf24" dot={false} strokeWidth={2} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="rounded-[24px] border border-faint bg-panel p-5 backdrop-blur-sm">
                  <p className="mb-4 text-xs font-semibold uppercase tracking-[0.22em] text-nav/70">OPEX Breakdown By Year (k€)</p>
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={opexBreakdownData} margin={{ top: 2, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-faint)" />
                        <XAxis dataKey="year" tick={AXIS_TICK} tickLine={false} axisLine={false} interval={4} />
                        <YAxis tickFormatter={fmtK} tick={AXIS_TICK} tickLine={false} axisLine={false} width={48} />
                        <Tooltip
                          contentStyle={TOOLTIP_CONTENT}
                          labelStyle={TOOLTIP_LABEL_STYLE}
                          itemStyle={TOOLTIP_ITEM_STYLE}
                          formatter={(v: number, name: string) => [`${v.toLocaleString()} k€`, name]}
                          labelFormatter={(yr) => `Year ${yr}`}
                        />
                        <Legend wrapperStyle={{ fontSize: 10, color: "var(--nav-text)" }} />
                        <Bar dataKey="pvOmCost" name="PV O&M" stackId="opex" fill="#dc2626" />
                        <Bar dataKey="pvAmCost" name="PV asset management" stackId="opex" fill="#f59e0b" />
                        <Bar dataKey="pvInsurance" name="PV insurance" stackId="opex" fill="#db2777" />
                        {hasBESS && <Bar dataKey="bessOmCost" name="BESS O&M" stackId="opex" fill="#2563eb" />}
                        {hasBESS && <Bar dataKey="bessAmCost" name="BESS asset management" stackId="opex" fill="#14b8a6" />}
                        {hasBESS && <Bar dataKey="bessInsurance" name="BESS insurance" stackId="opex" fill="#7c3aed" />}
                        <Bar dataKey="rent" name="Rent" stackId="opex" fill="#65a30d" />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="rounded-[24px] border border-faint bg-panel p-5 backdrop-blur-sm">
                  <p className="mb-4 text-xs font-semibold uppercase tracking-[0.22em] text-nav/70">CFADS vs Debt Service &amp; FCF Equity (k€)</p>
                  <div className="h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={chartData} margin={{ top: 2, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-faint)" />
                        <XAxis dataKey="year" tick={AXIS_TICK} tickLine={false} axisLine={false} interval={4} />
                        <YAxis tickFormatter={fmtK} tick={AXIS_TICK} tickLine={false} axisLine={false} width={48} />
                        <Tooltip contentStyle={TOOLTIP_CONTENT} labelStyle={TOOLTIP_LABEL_STYLE} itemStyle={TOOLTIP_ITEM_STYLE} formatter={(v: number, name: string) => [`${v.toLocaleString()} k€`, name]} labelFormatter={(yr) => `Year ${yr}`} />
                        <Legend wrapperStyle={{ fontSize: 10, color: "var(--nav-text)" }} />
                        <Bar dataKey="cfads" name="CFADS" fill="#a78bfa" opacity={0.85} />
                        <Bar dataKey="debtService" name="Debt Service" fill="#f97316" opacity={0.75} />
                        <Line dataKey="fcfEquity" name="FCF Equity" stroke="#fbbf24" dot={false} strokeWidth={2} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="flex h-[25rem] flex-none flex-col rounded-[24px] border border-faint bg-panel p-5 backdrop-blur-sm">
                  <p className="mb-4 text-xs font-semibold uppercase tracking-[0.22em] text-nav/70">Equity Investor Cash Return</p>
                  <p className="mb-4 text-xs text-nav/70">Initial equity invested: {formatEur(initialEquityInvestment)}</p>
                  <div className="min-h-[10rem] flex-1">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={investorReturnData} margin={{ top: 2, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-faint)" />
                        <XAxis dataKey="year" tick={AXIS_TICK} tickLine={false} axisLine={false} interval={4} />
                        <YAxis tickFormatter={fmtInvestorAxis} tick={AXIS_TICK} tickLine={false} axisLine={false} width={56} />
                        <Tooltip
                          contentStyle={TOOLTIP_CONTENT}
                          labelStyle={TOOLTIP_LABEL_STYLE}
                          itemStyle={TOOLTIP_ITEM_STYLE}
                          formatter={(v: number, name: string) => [formatEur(v), name]}
                          labelFormatter={(yr) => `Year ${yr}`}
                        />
                        <Legend wrapperStyle={{ fontSize: 10, color: "var(--nav-text)" }} />
                        <Line dataKey="cumulativeCash" name="Cumulative dividends received" stroke="#38bdf8" dot={false} strokeWidth={2} />
                        <Line dataKey="netCashPosition" name="Net cash position vs initial equity" stroke="#34d399" dot={false} strokeWidth={2} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-auto grid gap-3 pt-3 sm:grid-cols-4">
                    {investorMilestones.map((point) => (
                      <div key={point.year} className="rounded-2xl border border-faint bg-row p-2.5">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-nav/70">Year {point.year}</p>
                        <p className="mt-2 text-sm font-semibold text-nav-active">{formatEur(point.cumulativeCash)}</p>
                        <p className="mt-1 text-[10px] text-nav/65">net cash position {formatEur(point.netCashPosition)}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {showResults && (
          <section className="rounded-[28px] border border-faint bg-panel p-6 backdrop-blur-sm">
            <h2 className="mb-4 font-dolfines text-xl font-semibold tracking-[0.05em] text-nav-active">Annual P&amp;L Summary</h2>
            <div className="relative overflow-x-auto overflow-y-visible">
              <table className="w-full text-xs">
                <thead>
                    <tr className="border-b border-faint text-left">
                      {PNL_COLUMNS.map((column) => (
                        <th key={column.label} className="pb-2 pr-4 text-[10px] font-semibold uppercase tracking-[0.2em] text-nav/70 last:pr-0">
                          <HeaderInfo label={column.label} description={column.description} />
                        </th>
                      ))}
                    </tr>
                </thead>
                <tbody>
                  {result?.annual.map((a) => {
                    const rowClass = a.year % 2 === 0 ? "bg-[rgba(255,255,255,0.02)]" : "";
                    return (
                      <tr key={a.year} className={`border-b border-faint/30 ${rowClass}`}>
                        <td className="py-1.5 pr-4 font-semibold text-nav-active">{a.year}</td>
                        <td className="py-1.5 pr-4 text-nav/85">{(a.grossProduction / 1e6).toFixed(2)} GWh</td>
                        <td className="py-1.5 pr-4 text-rose-300">{(a.curtailmentLoss / 1e6).toFixed(2)} GWh</td>
                        <td className="py-1.5 pr-4 text-emerald-300">{(a.production / 1e6).toFixed(2)} GWh</td>
                        <td className={`py-1.5 pr-4 ${pnlValueClass(a.negativePriceBonusRevenue)}`}>{a.negativePriceBonusRevenue > 0 ? formatEur(a.negativePriceBonusRevenue) : "—"}</td>
                        <td className={`py-1.5 pr-4 ${pnlValueClass(a.totalRevenue)}`}>{formatEur(a.totalRevenue)}</td>
                        <td className={`py-1.5 pr-4 ${pnlValueClass(-a.totalOpex)}`}>{formatEur(a.totalOpex)}</td>
                        <td className={`py-1.5 pr-4 font-semibold ${pnlValueClass(a.ebitda)}`}>{formatEur(a.ebitda)}</td>
                        <td className={`py-1.5 pr-4 ${pnlValueClass(-a.mraExpense)}`}>{a.mraExpense > 0 ? formatEur(a.mraExpense) : "—"}</td>
                        <td className={`py-1.5 pr-4 ${pnlValueClass(-a.decomExpense)}`}>{a.decomExpense > 0 ? formatEur(a.decomExpense) : "—"}</td>
                        <td className={`py-1.5 pr-4 ${pnlValueClass(-a.depreciation)}`}>{formatEur(a.depreciation)}</td>
                        <td className={`py-1.5 pr-4 ${pnlValueClass(-a.financialCharge)}`}>{formatEur(a.financialCharge)}</td>
                        <td className={`py-1.5 pr-4 ${pnlValueClass(-a.taxAmount)}`}>{formatEur(a.taxAmount)}</td>
                        <td className={`py-1.5 pr-4 ${pnlValueClass(-a.principalRepayment)}`}>{a.principalRepayment > 0 ? formatEur(a.principalRepayment) : "—"}</td>
                        <td className={`py-1.5 pr-4 ${pnlValueClass(-a.debtService)}`}>{a.debtService > 0 ? formatEur(a.debtService) : "—"}</td>
                        <td className={`py-1.5 pr-4 ${pnlValueClass(a.cfads)}`}>{formatEur(a.cfads)}</td>
                        <td className={`py-1.5 pr-4 font-semibold ${pnlValueClass(a.fcfEquity)}`}>{formatEur(a.fcfEquity)}</td>
                        <td className={`py-1.5 pr-4 ${pnlValueClass(-a.equityDividends)}`}>{a.equityDividends > 0 ? formatEur(a.equityDividends) : "—"}</td>
                        <td className={`py-1.5 pr-4 font-semibold ${pnlValueClass(a.retainedCash)}`}>{formatEur(a.retainedCash)}</td>
                        <td className={`py-1.5 font-semibold ${dscrColor(a.dscr, formValues.dscrTarget)}`}>{a.dscr !== null ? a.dscr.toFixed(2) : "—"}</td>
                      </tr>
                    );
                  })}
                  {result?.annual.length ? (
                    <tr className="border-t-4 border-double border-faint bg-row/70">
                      <td className="py-2 pr-4 font-semibold text-nav-active">Total</td>
                      <td className="py-2 pr-4 text-nav/85">{(result.annual.reduce((s, a) => s + a.grossProduction, 0) / 1e6).toFixed(2)} GWh</td>
                      <td className="py-2 pr-4 text-rose-300">{(result.annual.reduce((s, a) => s + a.curtailmentLoss, 0) / 1e6).toFixed(2)} GWh</td>
                      <td className="py-2 pr-4 text-emerald-300">{(result.annual.reduce((s, a) => s + a.production, 0) / 1e6).toFixed(2)} GWh</td>
                      <td className={`py-2 pr-4 ${pnlValueClass(result.annual.reduce((s, a) => s + a.negativePriceBonusRevenue, 0))}`}>{result.annual.reduce((s, a) => s + a.negativePriceBonusRevenue, 0) > 0 ? formatEur(result.annual.reduce((s, a) => s + a.negativePriceBonusRevenue, 0)) : "—"}</td>
                      <td className={`py-2 pr-4 ${pnlValueClass(result.annual.reduce((s, a) => s + a.totalRevenue, 0))}`}>{formatEur(result.annual.reduce((s, a) => s + a.totalRevenue, 0))}</td>
                      <td className={`py-2 pr-4 ${pnlValueClass(-result.annual.reduce((s, a) => s + a.totalOpex, 0))}`}>{formatEur(result.annual.reduce((s, a) => s + a.totalOpex, 0))}</td>
                      <td className={`py-2 pr-4 font-semibold ${pnlValueClass(result.annual.reduce((s, a) => s + a.ebitda, 0))}`}>{formatEur(result.annual.reduce((s, a) => s + a.ebitda, 0))}</td>
                      <td className={`py-2 pr-4 ${pnlValueClass(-result.annual.reduce((s, a) => s + a.mraExpense, 0))}`}>{formatEur(result.annual.reduce((s, a) => s + a.mraExpense, 0))}</td>
                      <td className={`py-2 pr-4 ${pnlValueClass(-result.annual.reduce((s, a) => s + a.decomExpense, 0))}`}>{formatEur(result.annual.reduce((s, a) => s + a.decomExpense, 0))}</td>
                      <td className={`py-2 pr-4 ${pnlValueClass(-result.annual.reduce((s, a) => s + a.depreciation, 0))}`}>{formatEur(result.annual.reduce((s, a) => s + a.depreciation, 0))}</td>
                      <td className={`py-2 pr-4 ${pnlValueClass(-result.annual.reduce((s, a) => s + a.financialCharge, 0))}`}>{formatEur(result.annual.reduce((s, a) => s + a.financialCharge, 0))}</td>
                      <td className={`py-2 pr-4 ${pnlValueClass(-result.annual.reduce((s, a) => s + a.taxAmount, 0))}`}>{formatEur(result.annual.reduce((s, a) => s + a.taxAmount, 0))}</td>
                      <td className={`py-2 pr-4 ${pnlValueClass(-result.annual.reduce((s, a) => s + a.principalRepayment, 0))}`}>{formatEur(result.annual.reduce((s, a) => s + a.principalRepayment, 0))}</td>
                      <td className={`py-2 pr-4 ${pnlValueClass(-result.annual.reduce((s, a) => s + a.debtService, 0))}`}>{formatEur(result.annual.reduce((s, a) => s + a.debtService, 0))}</td>
                      <td className={`py-2 pr-4 ${pnlValueClass(result.annual.reduce((s, a) => s + a.cfads, 0))}`}>{formatEur(result.annual.reduce((s, a) => s + a.cfads, 0))}</td>
                      <td className={`py-2 pr-4 font-semibold ${pnlValueClass(result.annual.reduce((s, a) => s + a.fcfEquity, 0))}`}>{formatEur(result.annual.reduce((s, a) => s + a.fcfEquity, 0))}</td>
                      <td className={`py-2 pr-4 ${pnlValueClass(-result.annual.reduce((s, a) => s + a.equityDividends, 0))}`}>{formatEur(result.annual.reduce((s, a) => s + a.equityDividends, 0))}</td>
                      <td className={`py-2 pr-4 font-semibold ${pnlValueClass(result.annual.reduce((s, a) => s + a.retainedCash, 0))}`}>{formatEur(result.annual.reduce((s, a) => s + a.retainedCash, 0))}</td>
                      <td className="py-2 font-semibold text-nav-active">{kpis?.dscrAvg != null ? kpis.dscrAvg.toFixed(2) : "—"}</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <div className="flex justify-center pt-2">
          <Button variant="primary" size="md" onClick={handleRunCalculation}>
            {hasCalculated ? "Recalculate" : "Run calculation"}
          </Button>
        </div>
      </div>
    </div>
  );
}
