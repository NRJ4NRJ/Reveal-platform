"use client";

import Image from "next/image";
import { Suspense, useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useDropzone } from "react-dropzone";
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useSite } from "@/hooks/useSites";
import { useAnalysisRun, useColumnDetect } from "@/hooks/useAnalysis";
import { ColumnMapper } from "@/components/reports/ColumnMapper";
import { ReportProgress } from "@/components/reports/ReportProgress";
import { WaterfallChart } from "@/components/charts/WaterfallChart";
import { SpecificYieldHeatmap } from "@/components/charts/SpecificYieldHeatmap";
import { Button } from "@/components/ui/Button";
import { BackLink } from "@/components/layout/BackLink";
import { api } from "@/lib/api";
import { savePerformancePreviewSnapshot } from "@/lib/performance-preview";
import { canCallDirectly, generateReportExport } from "@/lib/python-client";
import type { ReportType } from "@/types/report";
import type { AnalysisColumnMapping, AnalysisResult, ColumnDetectionResult } from "@/types/analysis";
import type { Site } from "@/types/site";
import { useTranslation } from "@/lib/i18n";

const REPORT_TYPE: ReportType = "comprehensive";

function formatDateRange(range?: [string, string] | null) {
  if (!range?.[0] || !range?.[1]) return "Date range will appear once REVEAL has analysed the upload.";
  return `${range[0]} to ${range[1]}`;
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function parseDateValue(value?: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getObservedDays(range?: [string, string] | null, fallbackMonths: string[] = []) {
  const start = parseDateValue(range?.[0]);
  const end = parseDateValue(range?.[1]);
  if (start && end) {
    const elapsedDays = (end.getTime() - start.getTime()) / 86_400_000;
    if (elapsedDays > 0) return elapsedDays;
  }

  if (fallbackMonths.length > 0) {
    return fallbackMonths.length * (365.25 / 12);
  }

  return 365.25;
}

function formatMonthLabel(month: string) {
  const [year, monthPart] = month.split("-");
  if (!year || !monthPart) return month;
  return `${monthPart}/${year.slice(-2)}`;
}

type ComprehensivePunchlistItem = AnalysisResult["punchlist"][number] & {
  id: string;
  title: string;
  evidence: string[];
  next_steps: string[];
  source: string;
};

type TechnologyRiskPriority = "HIGH" | "MEDIUM" | "INFO";
type TechnologyRiskFocus = "Inverter" | "Module";

type TechnologyRiskRow = {
  priority: TechnologyRiskPriority;
  focus: TechnologyRiskFocus;
  equipment: string;
  risk: string;
  action: string;
};

type ReviewedTechnologyProfile = {
  kind: TechnologyRiskFocus;
  label: string;
  matchers: string[];
  rows: TechnologyRiskRow[];
};

function normalizeTechnologyLabel(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

const reviewedTechnologyProfiles: ReviewedTechnologyProfile[] = [
  {
    kind: "Inverter",
    label: "Sungrow SG250HX",
    matchers: ["sungrow", "sg250hx"],
    rows: [
      {
        priority: "HIGH",
        focus: "Inverter",
        equipment: "Sungrow SG250HX",
        risk: "AC relay wear (Fault 038) can leave the inverter unable to reconnect after repeated trip cycles.",
        action: "Pull the yearly trip count from iSolarCloud. If a unit is running above roughly 500 trips/year, schedule relay replacement and inspect the LV-cabinet SPD/earth path before the next summer peak.",
      },
      {
        priority: "HIGH",
        focus: "Inverter",
        equipment: "Sungrow SG250HX",
        risk: "DC insulation fault (Fault 039) after rain usually points to a wet string, damaged cable run, or non-OEM connector compatibility issue.",
        action: "Run string-by-string insulation testing at 1000 V DC, isolate any string below 1 MOhm, then replace suspect MC4 terminations or tracker-rail pinch points before re-energisation.",
      },
      {
        priority: "HIGH",
        focus: "Inverter",
        equipment: "Sungrow SG250HX",
        risk: "MPPT wiring/configuration errors can hide as persistent low PR on a single inverter without throwing alarms.",
        action: "Audit each MPPT against the single-line diagram, compare DC power by MPPT to expected loading, and run the iSolarCloud remote IV-curve scan before dispatching field technicians.",
      },
      {
        priority: "MEDIUM",
        focus: "Inverter",
        equipment: "Sungrow SG250HX",
        risk: "Thermal overtemperature faults (036/037) appear when fan performance drops or cabinet airflow is restricted.",
        action: "Inspect fans, filters, and cabinet clearance on the weakest units first. If summer ambient temperatures are routinely high, add a shade canopy or improve cabinet ventilation.",
      },
      {
        priority: "INFO",
        focus: "Inverter",
        equipment: "Sungrow SG250HX",
        risk: "Ten-minute SCADA often understates clipping severity on high DC/AC-ratio sites.",
        action: "Where clipping is material, move operational trending to 5-minute SCADA and apply a clipping correction before comparing plant PR against the yield model.",
      },
    ],
  },
  {
    kind: "Module",
    label: "First Solar Series 6 / CdTe",
    matchers: ["first solar", "series 6", "cdte"],
    rows: [
      {
        priority: "HIGH",
        focus: "Module",
        equipment: "First Solar Series 6",
        risk: "PID/TCO corrosion risk is highest on negative-string-end modules and can drive persistent low-string power without obvious thermal signatures.",
        action: "Prioritise EL imaging and IV-curve testing on negative-polarity string ends, then inspect edge seals and any repeat underperforming strings before replacing modules.",
      },
      {
        priority: "HIGH",
        focus: "Module",
        equipment: "First Solar Series 6",
        risk: "Fleet PR decline above the warranted degradation rate points to a real technology or site-condition problem rather than normal ageing.",
        action: "Compare year-on-year PR trend against warranty expectations, then validate with a module sample IV/EL campaign and a sensor-drift check before attributing the loss to degradation.",
      },
      {
        priority: "MEDIUM",
        focus: "Module",
        equipment: "First Solar Series 6",
        risk: "Standard IR surveys can miss hot spots because CdTe temperature gradients are weaker than crystalline silicon.",
        action: "Use a high-sensitivity IR camera at irradiance above 600 W/m2 and confirm any suspicious strings with IV-curve fill-factor checks rather than relying on thermal images alone.",
      },
      {
        priority: "INFO",
        focus: "Module",
        equipment: "First Solar Series 6",
        risk: "CdTe modules usually outperform c-Si PR benchmarks in hot weather because of the better temperature coefficient.",
        action: "Benchmark summer PR against CdTe expectations, not c-Si reference plants. If that thermal advantage is disappearing, inspect for soiling, sensor drift, or real module decline.",
      },
    ],
  },
];

function priorityWeight(priority: ComprehensivePunchlistItem["priority"]) {
  if (priority === "HIGH") return 0;
  if (priority === "MEDIUM") return 1;
  return 2;
}

function priorityCardClass(priority: ComprehensivePunchlistItem["priority"]) {
  if (priority === "HIGH") {
    return "border-rose-400/55 bg-rose-100/92 shadow-[0_0_0_1px_rgba(244,63,94,0.18)] dark:border-rose-500/40 dark:bg-rose-500/10";
  }
  if (priority === "MEDIUM") {
    return "border-orange-400/50 bg-orange-100/92 shadow-[0_0_0_1px_rgba(251,146,60,0.16)] dark:border-orange-400/30 dark:bg-orange-400/8";
  }
  return "border-yellow-300/60 bg-yellow-50/96 shadow-[0_0_0_1px_rgba(250,204,21,0.14)] dark:border-yellow-400/30 dark:bg-yellow-300/8";
}

function priorityBadgeClass(priority: ComprehensivePunchlistItem["priority"]) {
  if (priority === "HIGH") return "border border-rose-500/30 bg-rose-500 text-white";
  if (priority === "MEDIUM") return "border border-orange-500/30 bg-orange-500 text-white";
  return "border border-yellow-400/40 bg-yellow-300 text-slate-950";
}

function technologyPriorityBadgeClass(priority: TechnologyRiskPriority) {
  if (priority === "HIGH") return "border border-rose-500/30 bg-rose-500 text-white";
  if (priority === "MEDIUM") return "border border-orange-500/30 bg-orange-500 text-white";
  return "border border-sky-400/30 bg-sky-300 text-slate-950";
}

function resolveTechnologyRiskRegister(site?: Site | null) {
  const primaryModule = site?.solar_module_types?.[0];
  const inverterDescriptor = [site?.inv_model, site?.solar_inverter_units?.length ? `${site.solar_inverter_units.length} configured inverter unit(s)` : ""]
    .filter(Boolean)
    .join(" ");
  const moduleDescriptor = [
    primaryModule?.manufacturer || site?.module_brand || "",
    primaryModule?.model || "",
    primaryModule?.technology || "",
  ]
    .filter(Boolean)
    .join(" ");

  const descriptors: Record<TechnologyRiskFocus, string> = {
    Inverter: inverterDescriptor.trim(),
    Module: moduleDescriptor.trim(),
  };

  const coverage = (["Inverter", "Module"] as TechnologyRiskFocus[]).map((kind) => {
    const descriptor = descriptors[kind];
    const normalizedDescriptor = normalizeTechnologyLabel(descriptor);
    const profiles = reviewedTechnologyProfiles.filter(
      (profile) => profile.kind === kind && profile.matchers.every((matcher) => normalizedDescriptor.includes(normalizeTechnologyLabel(matcher)))
    );

    return {
      kind,
      descriptor: descriptor || "Technology not specified",
      reviewed: profiles.length > 0,
      note:
        profiles.length > 0
          ? `${kind} technology reviewed in the REVEAL database.`
          : descriptor
            ? `This ${kind.toLowerCase()} technology has not yet been reviewed in our database.`
            : `No ${kind.toLowerCase()} technology has been configured for this site yet.`,
      profiles,
    };
  });

  const rows = coverage
    .flatMap((item) => item.profiles.flatMap((profile) => profile.rows))
    .sort((a, b) => {
      const priorityOrder = { HIGH: 0, MEDIUM: 1, INFO: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });

  return { coverage, rows };
}

function maxOf(values: number[]) {
  return values.length ? Math.max(...values) : 0;
}

function selectAllOnFocus(event: React.FocusEvent<HTMLInputElement>) {
  event.currentTarget.select();
}

function parseMonthValue(value: string) {
  if (!value) return null;
  const date = new Date(`${value}-01T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatMonthValue(date: Date) {
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}`;
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, delta: number) {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function isMonthDisabled(date: Date, min?: string, max?: string) {
  const value = formatMonthValue(date);
  if (min && value < min) return true;
  if (max && value > max) return true;
  return false;
}

function MonthFieldPicker({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
}) {
  const selectedMonth = useMemo(() => parseMonthValue(value), [value]);
  const [open, setOpen] = useState(false);
  const [visibleYear, setVisibleYear] = useState<number>(() => (selectedMonth ?? parseMonthValue(min ?? "") ?? new Date()).getFullYear());
  const months = Array.from({ length: 12 }, (_, index) => new Date(visibleYear, index, 1));

  useEffect(() => {
    if (selectedMonth) {
      setVisibleYear(selectedMonth.getFullYear());
    }
  }, [selectedMonth]);

  return (
    <div className="relative min-w-[180px] flex-1">
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-nav">{label}</p>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="mt-2 flex h-10 w-full items-center rounded-xl border border-subtle bg-white px-3 text-left text-sm font-medium text-slate-900 transition hover:border-orange-DEFAULT/50"
      >
        {value ? formatMonthLabel(value) : `Select ${label.toLowerCase()}`}
      </button>
      {open ? (
        <div className="calendar-surface absolute left-0 top-[calc(100%+0.5rem)] z-30 w-[18rem] rounded-2xl border border-subtle bg-panel p-3 shadow-2xl backdrop-blur-sm">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setVisibleYear((current) => current - 1)}
              className="calendar-nav rounded-lg border border-subtle bg-row px-2.5 py-1.5 text-sm transition"
            >
              Prev
            </button>
            <p className="calendar-nav text-sm font-semibold">{visibleYear}</p>
            <button
              type="button"
              onClick={() => setVisibleYear((current) => current + 1)}
              className="calendar-nav rounded-lg border border-subtle bg-row px-2.5 py-1.5 text-sm transition"
            >
              Next
            </button>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {months.map((monthDate) => {
              const monthValue = formatMonthValue(monthDate);
              const disabled = isMonthDisabled(monthDate, min, max);
              const selected = value === monthValue;
              return (
                <button
                  key={monthValue}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onChange(monthValue);
                    setOpen(false);
                  }}
                  className={`rounded-lg px-3 py-2 text-sm transition ${
                    selected
                      ? "calendar-day-selected"
                      : disabled
                        ? "calendar-day-disabled cursor-not-allowed"
                        : "calendar-day-current"
                  }`}
                >
                  {monthDate.toLocaleDateString("en-GB", { month: "short" })}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function normalizeDecimalInput(value: string) {
  return value.replace(/,/g, ".");
}

function buildExecutiveSummary(result: AnalysisResult | null) {
  if (!result) return [];

  const topIssues = result.punchlist.slice(0, 3).map((item) => item.finding);
  const annualPr = result.pr.annual.at(-1)?.PR_pct ?? average(result.pr.monthly.map((item) => item.PR_pct));
  const totalEnergyMwh = result.pr.monthly.reduce((sum, item) => sum + item.E_act_mwh, 0);
  const observedDays = getObservedDays(result.summary.data_date_range, result.pr.monthly.map((item) => item.month));
  const annualisedSiteYield =
    result.summary.cap_dc_kwp > 0 && observedDays > 0
      ? (totalEnergyMwh * 1000 * (365.25 / observedDays)) / result.summary.cap_dc_kwp
      : 0;
  const highPriorityCount = result.punchlist.filter((item) => item.priority === "HIGH").length;

  return [
    `REVEAL analysed ${result.summary.n_inverters} inverter(s) across ${formatDateRange(result.summary.data_date_range)} with ${result.data_quality.overall_power_pct.toFixed(1)}% power-data completeness and ${result.data_quality.irradiance_pct.toFixed(1)}% irradiance-data completeness.`,
    `Fleet mean availability is ${result.availability.mean_pct.toFixed(1)}% and the latest annual PR is ${annualPr.toFixed(1)}%. Annualised whole-site specific yield sits at ${annualisedSiteYield.toFixed(1)} kWh/kWp/yr.`,
    highPriorityCount > 0
      ? `REVEAL has flagged ${highPriorityCount} high-priority improvement point${highPriorityCount === 1 ? "" : "s"} for follow-up.`
      : "REVEAL did not identify any high-priority improvement points in the current dataset.",
    topIssues.length > 0 ? `Main issues detected: ${topIssues.join(" • ")}.` : "No punchlist findings are available yet for this dataset.",
  ];
}

function getHeatTileClass(quality: { completenessPct: number; missingPct: number; frozenPct: number }) {
  if (quality.frozenPct > 0 && quality.missingPct > 0) {
    return "border-red-300/70 bg-[linear-gradient(135deg,rgba(220,38,38,0.5)_0%,rgba(220,38,38,0.5)_49%,rgba(244,114,182,0.28)_51%,rgba(244,114,182,0.28)_100%)] text-slate-900 shadow-[inset_0_0_0_1px_rgba(248,113,113,0.22)]";
  }
  if (quality.frozenPct > 0) return "border-red-300/70 bg-red-600/40 text-slate-900 shadow-[inset_0_0_0_1px_rgba(248,113,113,0.22)]";
  if (quality.completenessPct >= 95) return "border-emerald-300/25 bg-emerald-400/15 text-slate-900";
  if (quality.missingPct > 0) return "border-rose-300/35 bg-rose-400/20 text-slate-900";
  if (quality.completenessPct >= 85) return "border-sky-300/25 bg-sky-400/18 text-slate-900";
  return "border-weak bg-row text-nav-active";
}

function getRainHeatTileStyle(totalRainMm: number) {
  if (!Number.isFinite(totalRainMm) || totalRainMm <= 0) {
    return {
      borderColor: "rgba(226, 232, 240, 0.9)",
      background: "rgba(255,255,255,0.96)",
      color: "#64748b",
    };
  }
  if (totalRainMm >= 120) {
    return {
      borderColor: "rgba(153, 27, 27, 0.48)",
      background: "rgba(185, 28, 28, 0.92)",
      color: "#fff7f7",
    };
  }
  if (totalRainMm >= 60) {
    return {
      borderColor: "rgba(220, 38, 38, 0.42)",
      background: "rgba(239, 68, 68, 0.72)",
      color: "#fff7f7",
    };
  }
  if (totalRainMm >= 25) {
    return {
      borderColor: "rgba(251, 113, 133, 0.42)",
      background: "rgba(254, 226, 226, 0.95)",
      color: "#9f1239",
    };
  }
  if (totalRainMm >= 5) {
    return {
      borderColor: "rgba(252, 165, 165, 0.34)",
      background: "rgba(255, 241, 242, 0.96)",
      color: "#b91c1c",
    };
  }
  return {
    borderColor: "rgba(226, 232, 240, 0.9)",
    background: "rgba(255,255,255,0.98)",
    color: "#64748b",
  };
}

function WorkflowPanel({
  step,
  title,
  description,
  accent,
  summary,
  active,
  completed,
  collapsed,
  activeTone = "default",
  onToggle,
  children,
}: {
  step: string;
  title: string;
  description: string;
  accent: string;
  summary: string;
  active: boolean;
  completed: boolean;
  collapsed: boolean;
  activeTone?: "default" | "dark";
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`workflow-panel rounded-[28px] border p-5 backdrop-blur-sm transition-all duration-300 ${
        active
          ? activeTone === "dark"
            ? "workflow-panel-active border-strong bg-panel shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_0_28px_rgba(96,165,250,0.08)] animate-[workflowPulse_2.6s_ease-in-out_infinite]"
            : "workflow-panel-active border-strong bg-panel shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_0_32px_rgba(120,197,255,0.14)] animate-[workflowPulse_2.6s_ease-in-out_infinite]"
          : "border-subtle bg-panel"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-nav">{step}</p>
            <div className={`h-1 w-16 rounded-full bg-gradient-to-r ${accent}`} />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            <h2 className="font-dolfines text-[1.5rem] font-semibold tracking-[0.04em] text-white">{title}</h2>
            {completed ? (
              <span className="rounded-full border border-emerald-300/20 bg-emerald-400/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-100">
                Ready
              </span>
            ) : null}
          </div>
          {collapsed && summary ? (
            <p className="mt-1 text-xs leading-5 text-nav">{summary}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="rounded-full border border-subtle bg-row px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-nav-active transition hover:border-orange-DEFAULT/35 hover:bg-row-hover"
        >
          {collapsed ? "Expand details" : "Collapse details"}
        </button>
      </div>
      {!collapsed ? (
        <div className="mt-4">
          {description ? <p className="mb-4 text-sm leading-6 text-nav">{description}</p> : null}
          {children}
        </div>
      ) : null}
    </section>
  );
}

function MetricBars({
  title,
  description,
  rows,
  valueSuffix = "",
}: {
  title: string;
  description: string;
  rows: Array<{ label: string; value: number; secondary?: string; tone?: "positive" | "negative" | "neutral" }>;
  valueSuffix?: string;
}) {
  const maxValue = maxOf(rows.map((row) => row.value));
  return (
    <div className="flex h-full flex-col rounded-[24px] border border-faint bg-panel p-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/55">{title}</p>
      <p className="mt-2 text-sm leading-7 text-slate-200/82">{description}</p>
      <div className="mt-5 flex-1 space-y-3">
        {rows.map((row) => {
          const width = maxValue > 0 ? `${Math.max((row.value / maxValue) * 100, 6)}%` : "6%";
          const barClass =
            row.tone === "positive"
              ? "bg-[linear-gradient(90deg,rgba(16,185,129,0.96),rgba(34,197,94,0.96))]"
              : row.tone === "negative"
                ? "bg-[linear-gradient(90deg,rgba(239,68,68,0.96),rgba(220,38,38,0.96))]"
                : "bg-[linear-gradient(90deg,rgba(168,85,247,0.96),rgba(139,92,246,0.96))]";
          return (
            <div key={row.label} className="rounded-2xl border border-weak bg-[rgba(255,255,255,0.035)] px-4 py-3">
              <div className="flex items-center justify-between gap-3 text-sm text-white">
                <span className="font-semibold">{row.label}</span>
                <span className="text-right font-semibold">
                  {row.value.toFixed(1)}
                  {valueSuffix}
                </span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/8">
                <div className={`h-full rounded-full ${barClass}`} style={{ width }} />
              </div>
              {row.secondary ? <p className="mt-2 text-xs leading-6 text-white/55">{row.secondary}</p> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChartShell({
  title,
  description,
  children,
  heightClass = "h-[320px]",
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  heightClass?: string;
}) {
  return (
    <div className="flex h-full flex-col rounded-[24px] border border-faint bg-panel p-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/55">{title}</p>
      <p className="mt-2 text-sm leading-7 text-slate-200/82">{description}</p>
      <div className={`mt-5 min-h-[320px] ${heightClass}`}>{children}</div>
    </div>
  );
}

function AnalysisSection({
  id,
  title,
  description,
  collapsed,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  description: string;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[26px] border border-faint bg-panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/55">{id}</p>
          <h3 className="mt-2 font-dolfines text-[1.45rem] font-semibold tracking-[0.04em] text-white">{title}</h3>
          <p className="mt-2 text-sm leading-7 text-slate-200/82">{description}</p>
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="section-toggle-button rounded-full px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] transition"
        >
          {collapsed ? "Expand section" : "Collapse section"}
        </button>
      </div>
      {!collapsed ? <div className="mt-5">{children}</div> : null}
    </section>
  );
}

function RevealTooltip({
  active,
  payload,
  label,
  labelFormatter,
  valueSuffix = "",
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number | string; color?: string }>;
  label?: string;
  labelFormatter?: (label: string) => string;
  valueSuffix?: string;
}) {
  if (!active || !payload?.length) return null;
  const resolvedLabel = labelFormatter ? labelFormatter(label ?? "") : label;
  return (
    <div className="rounded-2xl border border-subtle bg-panel px-4 py-3 shadow-[0_14px_28px_rgba(0,0,0,0.35)]">
      {resolvedLabel ? <p className="text-xs font-semibold uppercase tracking-[0.16em] text-white/70">{resolvedLabel}</p> : null}
      <div className="mt-2 space-y-2">
        {payload.map((entry, index) => (
          <div key={`${entry.name}-${index}`} className="flex items-center justify-between gap-4 text-sm">
            <span className="text-white/72">{entry.name}</span>
            <span className="font-semibold text-white">
              {typeof entry.value === "number" ? entry.value.toFixed(1) : entry.value}
              {typeof entry.value === "number" ? valueSuffix : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

type DirectExportState = {
  status: "running" | "complete" | "error";
  progress: number;
  message: string;
  htmlUrl?: string;
  htmlFilename?: string;
  error?: string;
};

function GenerateReportPageContent({ params }: { params: { siteId: string } }) {
  const { t } = useTranslation();
  const router = useRouter();
  const searchParams = useSearchParams();
  const reportType = REPORT_TYPE;
  const { site } = useSite(params.siteId);
  const { trigger: detectColumns, isMutating: isDetecting } = useColumnDetect();
  const { trigger: runAnalysis, isMutating: isRunningAnalysis } = useAnalysisRun();

  const [files, setFiles] = useState<File[]>([]);
  const [lang, setLang] = useState<"en" | "fr" | "de">("en");
  const [reportDate, setReportDate] = useState("");
  const [columnMappings, setColumnMappings] = useState<Record<string, AnalysisColumnMapping>>({});
  const [detectedMappings, setDetectedMappings] = useState<Record<string, ColumnDetectionResult>>({});
  const [detectionError, setDetectionError] = useState<string | null>(null);
  const [worksheetLoadingFile, setWorksheetLoadingFile] = useState<string | null>(null);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisSignature, setAnalysisSignature] = useState<string | null>(null);
  const [analysisRequested, setAnalysisRequested] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [detectionProgress, setDetectionProgress] = useState(0);
  const [detectionProgressLabel, setDetectionProgressLabel] = useState("");
  const [previewProgress, setPreviewProgress] = useState(0);
  const [previewProgressLabel, setPreviewProgressLabel] = useState("");
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analysisProgressLabel, setAnalysisProgressLabel] = useState("");
  const [assumptionsConfirmed, setAssumptionsConfirmed] = useState(false);
  const [analysisLaunched, setAnalysisLaunched] = useState(false);
  const [dataConfirmed, setDataConfirmed] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [directExport, setDirectExport] = useState<DirectExportState | null>(null);
  const directExportRef = useRef<DirectExportState | null>(null);
  const [languageChosen, setLanguageChosen] = useState(false);
  const [inverterType, setInverterType] = useState("");
  const [inverterQuantity, setInverterQuantity] = useState("");
  const [moduleQuantity, setModuleQuantity] = useState("");
  const [moduleCapacityWp, setModuleCapacityWp] = useState("");
  const [moduleTiltDeg, setModuleTiltDeg] = useState("");
  const [siteTariffEurMwh, setSiteTariffEurMwh] = useState("");
  const [irradianceBasis, setIrradianceBasis] = useState<"poa" | "ghi">("poa");
  const [waterfallStartMonthDraft, setWaterfallStartMonthDraft] = useState("");
  const [waterfallEndMonthDraft, setWaterfallEndMonthDraft] = useState("");
  const [waterfallStartMonth, setWaterfallStartMonth] = useState("");
  const [waterfallEndMonth, setWaterfallEndMonth] = useState("");
  const [collapsedSteps, setCollapsedSteps] = useState<Record<number, boolean>>({
    1: false,
    2: false,
    3: false,
    4: false,
  });
  const [collapsedAnalysisSections, setCollapsedAnalysisSections] = useState<Record<string, boolean>>({
    overview: true,
    weather: true,
    availability: true,
    site: true,
    inverter: true,
    losses: true,
    actions: true,
    punchlist: false,
    technology: true,
    appendix: true,
    export: true,
  });

  const revokeDirectExportUrls = useCallback((state: DirectExportState | null) => {
    if (state?.htmlUrl) URL.revokeObjectURL(state.htmlUrl);
  }, []);

  useEffect(() => {
    directExportRef.current = directExport;
  }, [directExport]);

  useEffect(() => {
    return () => revokeDirectExportUrls(directExportRef.current);
  }, [revokeDirectExportUrls]);

  const filesReadyForReview =
    files.length > 0 && !isDetecting && !worksheetLoadingFile && files.every((file) => Boolean(detectedMappings[file.name]));

  const detectionList = useMemo(
    () => files.map((file) => ({ file, detection: detectedMappings[file.name] })).filter((item) => Boolean(item.detection)),
    [files, detectedMappings]
  );

  const totalRows = detectionList.reduce((sum, item) => sum + (item.detection?.row_count ?? 0), 0);
  const powerColumnsSelected = detectionList.reduce((sum, item) => sum + (item.detection?.mapping.power?.length ?? 0), 0);
  const firstRange = detectionList[0]?.detection?.data_date_range;
  const previewSignature = useMemo(
    () =>
      JSON.stringify({
        reportType,
        files: files.map((file) => ({ name: file.name, size: file.size, lastModified: file.lastModified })),
        mappings: columnMappings,
      }),
    [columnMappings, files, reportType]
  );
  const executiveSummary = useMemo(() => buildExecutiveSummary(analysisResult), [analysisResult]);
  const totalEnergyMwh = useMemo(
    () => (analysisResult ? analysisResult.pr.monthly.reduce((sum, item) => sum + item.E_act_mwh, 0) : 0),
    [analysisResult]
  );
  const annualisedSiteSpecificYield = useMemo(() => {
    if (!analysisResult) return 0;
    const observedDays = getObservedDays(analysisResult.summary.data_date_range, analysisResult.pr.monthly.map((item) => item.month));
    if (analysisResult.summary.cap_dc_kwp <= 0 || observedDays <= 0) return 0;
    return (totalEnergyMwh * 1000 * (365.25 / observedDays)) / analysisResult.summary.cap_dc_kwp;
  }, [analysisResult, totalEnergyMwh]);
  const tariffEurMwh = useMemo(() => {
    const numeric = Number(siteTariffEurMwh);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
  }, [siteTariffEurMwh]);
  const inferredAcCapacityKw = useMemo(() => {
    if (!site) return 0;
    const siteWithAc = site as typeof site & { cap_ac_kw?: number };
    const baseAcKw = siteWithAc.cap_ac_kw ?? 0;
    const perInverterKw = site.n_inverters && site.n_inverters > 0 ? baseAcKw / site.n_inverters : 0;
    const selectedInverters = Number(inverterQuantity);
    if (Number.isFinite(selectedInverters) && selectedInverters > 0 && perInverterKw > 0) {
      return selectedInverters * perInverterKw;
    }
    return baseAcKw;
  }, [inverterQuantity, site]);
  const dcAcRatio = useMemo(() => {
    if (!site || inferredAcCapacityKw <= 0) return null;
    return site.cap_dc_kwp / inferredAcCapacityKw;
  }, [inferredAcCapacityKw, site]);
  const latestAnnualPr = useMemo(
    () =>
      analysisResult
        ? (analysisResult.pr.annual.at(-1)?.PR_pct ?? average(analysisResult.pr.monthly.map((item) => item.PR_pct)))
        : 0,
    [analysisResult]
  );
  const heatMapMonths = useMemo(() => {
    if (!analysisResult) return [];
    return Array.from(new Set(analysisResult.data_quality.monthly.map((item) => item.month))).sort();
  }, [analysisResult]);
  const heatMapInverters = useMemo(() => {
    if (!analysisResult) return [];
    return Array.from(new Set(analysisResult.data_quality.monthly.map((item) => item.inv_id))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [analysisResult]);
  const heatMapLookup = useMemo(() => {
    const lookup = new Map<string, { completenessPct: number; missingPct: number; frozenPct: number }>();
    if (!analysisResult) return lookup;
    for (const item of analysisResult.data_quality.monthly) {
      lookup.set(`${item.month}::${item.inv_id}`, {
        completenessPct: item.completeness_pct,
        missingPct: item.missing_pct,
        frozenPct: item.frozen_pct,
      });
    }
    return lookup;
  }, [analysisResult]);
  const irrHeatMapLookup = useMemo(() => {
    const lookup = new Map<string, { completenessPct: number; missingPct: number }>();
    if (!analysisResult?.data_quality.monthly_irradiance) return lookup;
    for (const item of analysisResult.data_quality.monthly_irradiance) {
      lookup.set(item.month, { completenessPct: item.completeness_pct, missingPct: item.missing_pct });
    }
    return lookup;
  }, [analysisResult]);
  const topPunchlist = useMemo(() => analysisResult?.punchlist.slice(0, 6) ?? [], [analysisResult]);
  const latestMonths = useMemo(() => (analysisResult ? analysisResult.pr.monthly : []), [analysisResult]);
  const latestAvailabilityMonths = useMemo(() => (analysisResult ? analysisResult.availability.site_monthly : []), [analysisResult]);
  const analysisMonths = useMemo(() => latestMonths.map((item) => item.month), [latestMonths]);
  const effectiveWaterfallStartMonth = waterfallStartMonth || analysisMonths[0] || "";
  const effectiveWaterfallEndMonth = waterfallEndMonth || analysisMonths[analysisMonths.length - 1] || "";
  const filteredWaterfallMonths = useMemo(() => {
    if (!latestMonths.length) return [];
    return latestMonths.filter(
      (item) =>
        (!effectiveWaterfallStartMonth || item.month >= effectiveWaterfallStartMonth) &&
        (!effectiveWaterfallEndMonth || item.month <= effectiveWaterfallEndMonth)
    );
  }, [effectiveWaterfallEndMonth, effectiveWaterfallStartMonth, latestMonths]);
  const filteredWaterfallContext = useMemo(() => {
    if (!analysisResult || !latestMonths.length || !filteredWaterfallMonths.length) {
      return {
        chartData: analysisResult?.waterfall ?? [],
        designYieldMwh: analysisResult?.diagnosis.summary.design_yield_mwh ?? 0,
        weatherCorrectedYieldMwh: analysisResult?.diagnosis.summary.weather_corrected_yield_mwh ?? 0,
        recoverableMwh: analysisResult?.diagnosis.summary.recoverable_mwh ?? 0,
        overUnderPerformanceMwh: analysisResult?.diagnosis.summary.over_under_performance_mwh ?? 0,
        actualYieldMwh: analysisResult?.diagnosis.summary.actual_yield_mwh ?? 0,
      };
    }

    const totalActual = latestMonths.reduce((sum, item) => sum + item.E_act_mwh, 0);
    const totalReference = latestMonths.reduce((sum, item) => sum + item.E_ref_mwh, 0);
    const selectedActual = filteredWaterfallMonths.reduce((sum, item) => sum + item.E_act_mwh, 0);
    const selectedReference = filteredWaterfallMonths.reduce((sum, item) => sum + item.E_ref_mwh, 0);
    const actualShare = totalActual > 0 ? selectedActual / totalActual : 1;
    const referenceShare = totalReference > 0 ? selectedReference / totalReference : actualShare;
    const summary = analysisResult.diagnosis.summary;
    const scaledDesignYield = summary.design_yield_mwh * referenceShare;
    const scaledWeatherCorrectedYield = summary.weather_corrected_yield_mwh * referenceShare;
    const scaledRecoverable = summary.recoverable_mwh * actualShare;
    const scaledOverUnder = summary.over_under_performance_mwh * actualShare;
    const scaledActual = summary.actual_yield_mwh * actualShare;

    const chartData = analysisResult.waterfall.map((item) => {
      if (item.label === "Design yield") return { ...item, value_mwh: scaledDesignYield };
      if (item.label === "Weather-corrected yield") return { ...item, value_mwh: scaledWeatherCorrectedYield };
      if (item.label === "Actual yield") return { ...item, value_mwh: scaledActual };
      if (item.label === "Over / under performance") return { ...item, value_mwh: scaledOverUnder };
      if (item.type === "loss") {
        const lower = item.label.toLowerCase();
        const usesReferenceShare = lower.includes("irradiance") || lower.includes("temperature");
        return { ...item, value_mwh: Math.abs(item.value_mwh) * (usesReferenceShare ? referenceShare : actualShare) };
      }
      return item;
    });

    return {
      chartData,
      designYieldMwh: scaledDesignYield,
      weatherCorrectedYieldMwh: scaledWeatherCorrectedYield,
      recoverableMwh: scaledRecoverable,
      overUnderPerformanceMwh: scaledOverUnder,
      actualYieldMwh: scaledActual,
    };
  }, [analysisResult, filteredWaterfallMonths, latestMonths]);
  const yieldRanking = useMemo(() => {
    if (!analysisResult) return [];
    const sorted = [...analysisResult.specific_yield];
    if (sorted.length <= 4) return sorted;
    const combined = [...sorted.slice(0, 2), ...sorted.slice(-2)];
    const unique = new Map(combined.map((item) => [item.inv_id, item]));
    return Array.from(unique.values());
  }, [analysisResult]);
  const specificYieldHeatmapRows = useMemo(
    () => (analysisResult ? analysisResult.specific_yield_monthly : []),
    [analysisResult]
  );
  const specificYieldHeatmapInsights = useMemo(() => {
    if (!analysisResult || specificYieldHeatmapRows.length === 0) return [];

    const meanByInverter = new Map<string, { total: number; count: number }>();
    const monthValues = new Map<string, number[]>();
    for (const row of specificYieldHeatmapRows) {
      const inv = meanByInverter.get(row.inv_id) ?? { total: 0, count: 0 };
      inv.total += row.yield_kwh_kwp;
      inv.count += 1;
      meanByInverter.set(row.inv_id, inv);

      const monthBucket = monthValues.get(row.month) ?? [];
      monthBucket.push(row.yield_kwh_kwp);
      monthValues.set(row.month, monthBucket);
    }

    const inverterAverages = Array.from(meanByInverter.entries())
      .map(([inv_id, stats]) => ({
        inv_id,
        mean: stats.count > 0 ? stats.total / stats.count : 0,
      }))
      .sort((a, b) => a.mean - b.mean);

    const insights: string[] = [];

    if (inverterAverages.length > 0) {
      const weakest = inverterAverages.slice(0, Math.min(2, inverterAverages.length));
      insights.push(
        `Persistent lowest normalized output is coming from ${weakest.map((item) => item.inv_id).join(" and ")}, which sit at the bottom of the fleet-average specific-yield ranking.`
      );
    }

    const winterMonths = ["12", "01", "02"];
    const summerMonths = ["06", "07", "08"];
    const winterValues = specificYieldHeatmapRows.filter((row) => winterMonths.includes(row.month.slice(5, 7))).map((row) => row.yield_kwh_kwp);
    const summerValues = specificYieldHeatmapRows.filter((row) => summerMonths.includes(row.month.slice(5, 7))).map((row) => row.yield_kwh_kwp);
    const winterAverage = average(winterValues);
    const summerAverage = average(summerValues);
    if (winterValues.length > 0 && summerValues.length > 0 && winterAverage < summerAverage * 0.8) {
      insights.push(
        `Fleet-wide specific yield is visibly lower through the winter months than in summer, which is a normal seasonal pattern rather than an inverter-specific fault by itself.`
      );
    }

    const lowestCells = [...specificYieldHeatmapRows]
      .sort((a, b) => a.yield_kwh_kwp - b.yield_kwh_kwp)
      .filter((row, index, rows) => index < 3 && row.yield_kwh_kwp < average(rows.map((item) => item.yield_kwh_kwp)) * 0.7);
    if (lowestCells.length > 0) {
      const examples = lowestCells
        .slice(0, 2)
        .map((item) => `${item.inv_id} in ${formatMonthLabel(item.month)}`)
        .join(" and ");
      insights.push(
        `There are isolated low-yield pockets beyond the seasonal trend, especially around ${examples}, which are good candidates for targeted inverter-level fault or clipping checks.`
      );
    }

    const weakestMonth = Array.from(monthValues.entries())
      .map(([month, values]) => ({ month, mean: average(values) }))
      .sort((a, b) => a.mean - b.mean)[0];
    if (weakestMonth) {
      insights.push(
        `At the fleet level, ${formatMonthLabel(weakestMonth.month)} is the weakest month in the heat map, so it is the first period to cross-check against outages, poor weather, and any site-wide operational anomalies.`
      );
    }

    return insights.slice(0, 4);
  }, [analysisResult, specificYieldHeatmapRows]);
  const mttfRanking = useMemo(
    () => (analysisResult ? [...analysisResult.mttf.by_inverter].sort((a, b) => a.mttf_hours - b.mttf_hours).slice(0, 8) : []),
    [analysisResult]
  );
  const startStopOutliers = useMemo(
    () =>
      analysisResult
        ? [...analysisResult.start_stop]
            .sort((a, b) => Math.abs(b.start_dev) - Math.abs(a.start_dev))
            .slice(0, 8)
        : [],
    [analysisResult]
  );
  const peerGroupRows = useMemo(() => analysisResult?.peer_groups ?? [], [analysisResult]);
  const clippingBins = useMemo(() => analysisResult?.clipping.by_irradiance_bin ?? [], [analysisResult]);
  const clippingInverters = useMemo(() => analysisResult?.clipping.top_inverters ?? [], [analysisResult]);
  const lossBreakdown = useMemo(() => analysisResult?.diagnosis.loss_breakdown ?? [], [analysisResult]);
  const curtailmentCandidates = useMemo(() => analysisResult?.diagnosis.curtailment_candidates ?? [], [analysisResult]);
  const diagnosisCommentary = useMemo(() => analysisResult?.diagnosis.commentary ?? [], [analysisResult]);
  const rootCauses = useMemo(() => analysisResult?.diagnosis.root_causes ?? [], [analysisResult]);
  const sectionCommentary = useMemo(() => analysisResult?.diagnosis.section_commentary ?? {}, [analysisResult]);
  const irradianceCheck = useMemo(() => analysisResult?.diagnosis.irradiance_check ?? null, [analysisResult]);
  const irradianceBenchmarkRows = useMemo(() => irradianceCheck?.monthly ?? [], [irradianceCheck]);
  const degradationTrendRows = useMemo(
    () => (analysisResult ? analysisResult.pr.annual.map((item) => ({ year: String(item.year), pr_pct: item.PR_pct, energy_mwh: item.E_act_mwh })) : []),
    [analysisResult]
  );
  const weatherMonthlyRows = useMemo(() => analysisResult?.weather.monthly ?? [], [analysisResult]);
  const weatherSummary = useMemo(() => analysisResult?.weather.summary ?? null, [analysisResult]);
  const weatherEvents = useMemo(() => analysisResult?.weather.events ?? [], [analysisResult]);
  const monthlyTimelineRows = useMemo(() => {
    if (!analysisResult) return [];
    const qualityByMonth = new Map(
      analysisResult.data_quality.monthly.reduce<Array<[string, { missingPct: number; frozenPct: number }]>>((acc, item) => {
        const current = acc.find(([month]) => month === item.month)?.[1];
        if (current) {
          current.missingPct = Math.max(current.missingPct, item.missing_pct);
          current.frozenPct = Math.max(current.frozenPct, item.frozen_pct);
        } else {
          acc.push([item.month, { missingPct: item.missing_pct, frozenPct: item.frozen_pct }]);
        }
        return acc;
      }, [])
    );
    const availabilityByMonth = new Map(analysisResult.availability.site_monthly.map((item) => [item.month, item.avail_pct]));
    const curtailmentByMonth = new Map(analysisResult.diagnosis.curtailment_candidates.map((item) => [item.month, item.loss_mwh]));
    return analysisResult.pr.monthly.map((item) => {
      const quality = qualityByMonth.get(item.month) ?? { missingPct: 0, frozenPct: 0 };
      return {
        month: item.month,
        pr_pct: item.PR_pct,
        irradiation_kwh_m2: item.irrad_kwh_m2,
        energy_mwh: item.E_act_mwh,
        availability_pct: availabilityByMonth.get(item.month) ?? 0,
        missing_pct: quality.missingPct,
        frozen_pct: quality.frozenPct,
        curtailment_mwh: curtailmentByMonth.get(item.month) ?? 0,
      };
    });
  }, [analysisResult]);
  const dataLimitations = useMemo(() => {
    if (!analysisResult) return [];
    const notes = [
      `Power-data availability is ${analysisResult.data_quality.overall_power_pct.toFixed(1)}% and irradiance availability is ${analysisResult.data_quality.irradiance_pct.toFixed(1)}% over the analysed daytime window.`,
      `REVEAL screened frozen readings from ${analysisResult.data_quality.stuck_inverters_count ?? 0} inverter stream(s) before calculating the diagnosis.`,
      analysisResult.weather.error
        ? `ERA precipitation could not be loaded for this run, so rain-linked soiling checks remain unavailable in the current diagnosis.`
        : `REVEAL has loaded ERA precipitation context for the analysed period. Rain events can now be reviewed in Step 4 to support later excess-soiling interpretation, while full irradiance-reference correlation still lives in the Long-Term workflow.`,
    ];
    if (analysisResult.pr.annual.length < 3) {
      notes.push("Fewer than three annual periods are available, so degradation and long-term performance drift should be interpreted cautiously.");
    }
    return notes;
  }, [analysisResult]);
  const lossActionRows = useMemo(() => {
    if (!analysisResult) return [];
    return analysisResult.diagnosis.loss_breakdown
      .filter((item) => item.value_mwh > 0.01)
      .map((item, index) => {
        const rootCause = rootCauses[index] ?? rootCauses.find((candidate) =>
          candidate.title.toLowerCase().includes(item.label.toLowerCase().split(" ")[0])
        );
        return {
          ...item,
          value_keur: tariffEurMwh > 0 ? (item.value_mwh * tariffEurMwh) / 1000 : 0,
          action:
            rootCause?.action ??
            (item.classification === "recoverable"
              ? "Investigate this recoverable bucket in detail and test it in the digital twin."
              : "Treat this as a baseline or residual bucket unless later evidence shows it is recoverable."),
        };
      });
  }, [analysisResult, rootCauses, tariffEurMwh]);
  const comprehensivePunchlist = useMemo<ComprehensivePunchlistItem[]>(() => {
    if (!analysisResult) return [];
    return analysisResult.punchlist
      .map((item, index) => ({
        ...item,
        id: `core-${index}`,
        title: item.title ?? item.category,
        evidence: item.evidence?.length ? item.evidence : [item.finding],
        next_steps: item.next_steps?.length ? item.next_steps : [item.recommendation],
        source: "Core diagnosis",
      }))
      .sort((a, b) => {
        const priorityDelta = priorityWeight(a.priority) - priorityWeight(b.priority);
        if (priorityDelta !== 0) return priorityDelta;
        return (b.impact_mwh ?? 0) - (a.impact_mwh ?? 0);
      });
  }, [analysisResult]);
  const comprehensivePunchlistCounts = useMemo(
    () => ({
      high: comprehensivePunchlist.filter((item) => item.priority === "HIGH").length,
      medium: comprehensivePunchlist.filter((item) => item.priority === "MEDIUM").length,
      low: comprehensivePunchlist.filter((item) => item.priority === "LOW").length,
    }),
    [comprehensivePunchlist]
  );
  const technologyRiskRegister = useMemo(() => resolveTechnologyRiskRegister(site), [site]);
  const appendixScopeRows = useMemo(
    () => [
      {
        activity: "Data availability assessment",
        status: "Completed",
        notes: "Per-inverter and site-level telemetry completeness reviewed.",
      },
      {
        activity: "Performance ratio assessment",
        status: "Completed",
        notes: "Monthly and annual PR calculated on the IEC 61724 DC-kWp basis.",
      },
      {
        activity: "Irradiance coherence (SARAH-3)",
        status: "Completed",
        notes: "On-site irradiance cross-checked against SARAH reference, including bias and suspect-reading screening.",
      },
      {
        activity: "Availability and reliability review",
        status: "Completed",
        notes: "Fleet uptime, inverter-level availability, and fault recurrence screened.",
      },
      {
        activity: "Loss attribution",
        status: "Completed",
        notes: "Budget, weather correction, availability loss, technical loss, and residual reviewed.",
      },
      {
        activity: "Per-inverter specific yield",
        status: "Completed",
        notes: "Monthly inverter heatmaps reviewed for recurring underperformance patterns.",
      },
      {
        activity: "Start/stop signature screening",
        status: "Completed",
        notes: "Fleet-relative wake-up and shut-down timing deviations screened for threshold anomalies.",
      },
      {
        activity: "Weather-correlation review",
        status: "Completed",
        notes: "Rainfall and temperature context considered in the diagnostic workflow.",
      },
    ],
    []
  );
  const appendixConstraintRows = useMemo(
    () => [
      {
        analysis: "Inverter AC/DC efficiency",
        status: "Not possible",
        notes: "No DC current or DC power channels are available in the export.",
      },
      {
        analysis: "String-level fault detection",
        status: "Not possible",
        notes: "The SCADA extract is limited to inverter-level AC production.",
      },
      {
        analysis: "Short transients",
        status: "Limited",
        notes: "The 10-minute sampling interval is too coarse for sub-interval fault isolation.",
      },
      {
        analysis: "Downtime root cause",
        status: "Limited",
        notes: "Alarm and fault-code channels are absent, so trips are classified indirectly.",
      },
      {
        analysis: "Curtailment certainty",
        status: "Limited",
        notes: "Without explicit export-limit flags, curtailment remains heuristic.",
      },
      {
        analysis: "Degradation certainty",
        status: "Limited",
        notes: "The available time horizon remains too short for a statistically robust long-term degradation estimate.",
      },
      {
        analysis: "Soiling quantification",
        status: "Not possible",
        notes: "No dedicated soiling sensor or IV-curve dataset is available to isolate accumulation rates.",
      },
    ],
    []
  );
  const appendixPriorityRows = useMemo(
    () =>
      comprehensivePunchlist.slice(0, 5).map((item) => ({
        id: item.id,
        priority: item.priority,
        category: item.category,
        estimatedLoss: (item.impact_mwh ?? 0) > 0 ? `${(item.impact_mwh ?? 0).toLocaleString()} MWh` : "—",
        recommendedAction: item.recommendation,
      })),
    [comprehensivePunchlist]
  );
  const mttfBenchmarkedRows = useMemo(() => {
    if (!analysisResult) return [];
    return analysisResult.mttf.by_inverter
      .map((item) => {
        const status =
          item.mttf_hours >= 1500
            ? "Above industry benchmark"
            : item.mttf_hours >= 750
              ? "Watch list"
              : "Below benchmark";
        return { ...item, status };
      })
      .sort((a, b) => a.mttf_hours - b.mttf_hours);
  }, [analysisResult]);

  const inverterDiagnostics = useMemo(() => {
    if (!analysisResult) return [];
    const startMap = new Map(analysisResult.start_stop.map((item) => [item.inv_id, item]));
    return [...analysisResult.mttf.by_inverter]
      .sort((a, b) => a.mttf_hours - b.mttf_hours)
      .map((item) => ({
        inv_id: item.inv_id,
        mttf_hours: Math.round(item.mttf_hours),
        n_failures: item.n_failures,
        start_dev_abs: Math.abs(startMap.get(item.inv_id)?.start_dev ?? 0),
      }));
  }, [analysisResult]);
  const step1Configured = languageChosen;
  const previewReady = analysisSignature === previewSignature && Boolean(analysisResult) && !isRunningAnalysis;
  const previewSettled = previewReady || Boolean(analysisError);
  const siteDetailsReady =
    inverterType.trim().length > 0 &&
    inverterQuantity.trim().length > 0 &&
    siteTariffEurMwh.trim().length > 0 &&
    (site?.site_type === "wind" ||
      (moduleQuantity.trim().length > 0 && moduleCapacityWp.trim().length > 0 && moduleTiltDeg.trim().length > 0));
  const siteConfigOverrides = useMemo(
    () => ({
      inv_model: inverterType.trim(),
      n_inverters: inverterQuantity ? Number(inverterQuantity) : undefined,
      n_modules: moduleQuantity ? Number(moduleQuantity) : undefined,
      module_wp: moduleCapacityWp ? Number(moduleCapacityWp) : undefined,
      module_tilt_deg: moduleTiltDeg ? Number(moduleTiltDeg) : undefined,
      tariff_eur_mwh: siteTariffEurMwh ? Number(siteTariffEurMwh) : undefined,
      irradiance_basis: irradianceBasis,
    }),
    [inverterQuantity, inverterType, irradianceBasis, moduleCapacityWp, moduleQuantity, moduleTiltDeg, siteTariffEurMwh]
  );

  const activeStep = !step1Configured ? 1 : files.length === 0 || !filesReadyForReview || !dataConfirmed ? 2 : !assumptionsConfirmed || !analysisLaunched ? 3 : 4;

  useEffect(() => {
    setAssumptionsConfirmed(false);
    setAnalysisLaunched(false);
  }, [reportType, files.length, totalRows, dataConfirmed]);

  useEffect(() => {
    if (!site) return;
    setInverterType(site.inv_model ?? "");
    setInverterQuantity(site.n_inverters ? String(site.n_inverters) : "");
    setModuleQuantity(site.n_modules ? String(site.n_modules) : "");
    setModuleCapacityWp(site.module_wp ? String(site.module_wp) : "");
    setSiteTariffEurMwh(((site as { tariff_eur_mwh?: number } | undefined)?.tariff_eur_mwh) ? String((site as { tariff_eur_mwh?: number }).tariff_eur_mwh) : "");
  }, [site]);

  useEffect(() => {
    if (!analysisMonths.length) {
      setWaterfallStartMonth("");
      setWaterfallEndMonth("");
      setWaterfallStartMonthDraft("");
      setWaterfallEndMonthDraft("");
      return;
    }
    setWaterfallStartMonth((current) => current || analysisMonths[0]);
    setWaterfallEndMonth((current) => current || analysisMonths[analysisMonths.length - 1]);
    setWaterfallStartMonthDraft((current) => current || analysisMonths[0]);
    setWaterfallEndMonthDraft((current) => current || analysisMonths[analysisMonths.length - 1]);
  }, [analysisMonths]);

  useEffect(() => {
    setAnalysisResult(null);
    setAnalysisError(null);
    setAnalysisSignature(null);
    setAnalysisRequested(false);
    setAnalysisLaunched(false);
    setDataConfirmed(false);
    setJobId(null);
    setDirectExport((previous) => {
      revokeDirectExportUrls(previous);
      return null;
    });
  }, [previewSignature, revokeDirectExportUrls]);

  useEffect(() => {
    if (!isDetecting) {
      if (detectionProgress > 0) {
        setDetectionProgress(100);
        const resetTimer = window.setTimeout(() => {
          setDetectionProgress(0);
          setDetectionProgressLabel("");
        }, 900);
        return () => window.clearTimeout(resetTimer);
      }
      return;
    }

    if (!detectionProgressLabel) {
      setDetectionProgressLabel("Analysing uploaded file structure");
    }

    const timer = window.setInterval(() => {
      setDetectionProgress((current) => Math.min(current + (current < 60 ? 9 : current < 85 ? 4 : 1), 92));
    }, 220);

    return () => window.clearInterval(timer);
  }, [detectionProgress, detectionProgressLabel, isDetecting]);

  useEffect(() => {
    if (!isRunningAnalysis) {
      if (previewProgress > 0) {
        setPreviewProgress(100);
        const resetTimer = window.setTimeout(() => {
          setPreviewProgress(0);
          setPreviewProgressLabel("");
        }, 900);
        return () => window.clearTimeout(resetTimer);
      }
      return;
    }

    if (!previewProgressLabel) {
      setPreviewProgressLabel("Building the data-quality preview");
    }

    const timer = window.setInterval(() => {
      setPreviewProgress((current) => Math.min(current + (current < 45 ? 8 : current < 78 ? 4 : 1), 94));
    }, 260);

    return () => window.clearInterval(timer);
  }, [isRunningAnalysis, previewProgress, previewProgressLabel]);

  useEffect(() => {
    if (!assumptionsConfirmed) {
      setAnalysisProgress(0);
      setAnalysisProgressLabel("");
      return;
    }
    if (!isRunningAnalysis) {
      if (analysisProgress > 0) {
        setAnalysisProgress(100);
        const resetTimer = window.setTimeout(() => {
          setAnalysisProgress(0);
          setAnalysisProgressLabel("");
        }, 900);
        return () => window.clearTimeout(resetTimer);
      }
      return;
    }

    if (!analysisProgressLabel) {
      setAnalysisProgressLabel("Generating the in-app performance analysis");
    }

    const timer = window.setInterval(() => {
      setAnalysisProgress((current) => Math.min(current + (current < 35 ? 9 : current < 75 ? 4 : 1), 94));
    }, 260);

    return () => window.clearInterval(timer);
  }, [analysisProgress, analysisProgressLabel, assumptionsConfirmed, isRunningAnalysis]);

  useEffect(() => {
    setCollapsedSteps({
      1: activeStep !== 1,
      2: activeStep !== 2,
      3: activeStep !== 3,
      4: activeStep !== 4,
    });
  }, [activeStep]);

  const requestPreview = useCallback(async () => {
    if (!site || !filesReadyForReview || isRunningAnalysis) return;
    try {
      setAnalysisRequested(true);
      setAnalysisError(null);
      if (assumptionsConfirmed) {
        setAnalysisProgress(10);
        setAnalysisProgressLabel("Generating the in-app performance analysis");
      } else {
        setPreviewProgress(10);
        setPreviewProgressLabel("Preparing the heat-map preview");
      }
      const result = await runAnalysis({
        files,
        site,
        columnMappings: columnMappings as Record<string, unknown>,
        siteConfigOverrides: siteConfigOverrides as Record<string, unknown>,
        lang,
      });
      setAnalysisResult(result);
      if (assumptionsConfirmed) {
        savePerformancePreviewSnapshot(params.siteId, result);
      }
      setAnalysisSignature(previewSignature);
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : "REVEAL could not analyse the uploaded dataset.");
    }
  }, [site, filesReadyForReview, isRunningAnalysis, params.siteId, columnMappings, files, runAnalysis, previewSignature, assumptionsConfirmed, siteConfigOverrides]);

  const onDrop = useCallback(
    (accepted: File[]) => {
      setJobId(null);
      setDetectionProgress(8);
      setDetectionProgressLabel(
        accepted.length === 1 ? `Analysing ${accepted[0]?.name ?? "uploaded file"}` : `Analysing ${accepted.length} uploaded files`
      );
      setFiles((prev) => {
        const nextFiles = [...prev, ...accepted];
        void autoDetectColumns(nextFiles);
        return nextFiles;
      });
    },
    [site]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "text/csv": [".csv"], "application/vnd.ms-excel": [".xls", ".xlsx"] },
    multiple: true,
  });

  async function handleGenerate() {
    if (files.length === 0 || !assumptionsConfirmed) return;
    setSubmitting(true);
    setExportError(null);
    try {
      revokeDirectExportUrls(directExport);
      setDirectExport(null);
      setJobId(null);

      if (site && canCallDirectly()) {
        setDirectExport({
          status: "running",
          progress: 15,
          message: "Generating the HTML site report…",
        });

        const htmlExport = await generateReportExport({
          files,
          site,
          columnMappings,
          siteConfigOverrides,
          reportType,
          lang,
          reportDate: reportDate || undefined,
          outputFormat: "html",
        });
        const htmlUrl = URL.createObjectURL(htmlExport.blob);

        setDirectExport({
          status: "running",
          progress: 60,
          message: "Finalising the HTML site report…",
          htmlUrl,
          htmlFilename: htmlExport.filename,
        });

        setDirectExport({
          status: "complete",
          progress: 100,
          message: "Export ready.",
          htmlUrl,
          htmlFilename: htmlExport.filename,
        });
        setCollapsedSteps((prev) => ({ ...prev, 4: false }));
        return;
      }

      const form = new FormData();
      form.append("siteId", params.siteId);
      form.append("reportType", reportType);
      form.append("lang", lang);
      if (reportDate) form.append("reportDate", reportDate);
      form.append("columnMappings", JSON.stringify(columnMappings));
      form.append("siteConfigOverrides", JSON.stringify(siteConfigOverrides));
      files.forEach((f) => form.append("files", f));

      const { jobId: id } = await api.reports.createJob(form);
      setJobId(id);
      setCollapsedSteps((prev) => ({ ...prev, 4: false }));
    } catch (error) {
      revokeDirectExportUrls(directExport);
      setDirectExport(null);
      setExportError(error instanceof Error ? error.message : "REVEAL could not start the export job.");
    } finally {
      setSubmitting(false);
    }
  }

  async function detectFileColumns(file: File, worksheet?: string) {
    if (!site) {
      throw new Error("Site configuration is not available yet.");
    }
    return detectColumns({ file, siteType: site.site_type, worksheet });
  }

  async function autoDetectColumns(nextFiles: File[]) {
    setDetectionError(null);
    if (!site || nextFiles.length === 0) {
      setDetectedMappings({});
      setColumnMappings({});
      return;
    }

    try {
      const detections = await Promise.all(
        nextFiles.map(async (file) => [file.name, await detectFileColumns(file)] as const)
      );

      const detectionMap = Object.fromEntries(detections);
      setDetectedMappings(detectionMap);
      setColumnMappings(
        Object.fromEntries(
          detections.map(([filename, detection]) => [
            filename,
            {
              ...detection.mapping,
              worksheet: detection.selected_worksheet ?? undefined,
            },
          ])
        )
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Column detection failed.";
      setDetectionError(`Column detection error: ${msg}`);
    }
  }

  async function handleWorksheetChange(filename: string, worksheet: string) {
    const file = files.find((candidate) => candidate.name === filename);
    if (!file) return;

    setWorksheetLoadingFile(filename);
    try {
      const detection = await detectFileColumns(file, worksheet);
      setDetectedMappings((previous) => ({
        ...previous,
        [filename]: detection,
      }));
      setColumnMappings((previous) => ({
        ...previous,
        [filename]: {
          ...detection.mapping,
          worksheet: detection.selected_worksheet ?? worksheet,
        },
      }));
    } finally {
      setWorksheetLoadingFile((current) => (current === filename ? null : current));
    }
  }

  return (
    <div className="relative min-h-[calc(100vh-4rem)] overflow-hidden" style={{ backgroundColor: "var(--bg-page)" }}>
      <div className="absolute inset-0">
        <Image src="/brand/report-generate-hero.jpg" alt="Performance generation hero" fill priority className="object-cover" />
        <div className="absolute inset-0 bg-[linear-gradient(100deg,rgba(2,18,28,0.9),rgba(5,30,45,0.76),rgba(5,30,45,0.64))] hero-overlay" />
      </div>

      <div className="relative px-8 py-8 hero-content">
        <div className="space-y-6">
          <BackLink href={`/dashboard/site/${params.siteId}`} label="Back to site page" />

          <section className="rounded-[24px] border border-faint bg-panel px-6 py-4 backdrop-blur-sm">
            <p className="text-[10px] font-semibold uppercase tracking-[0.34em] text-white/45">8p2 Advisory · REVEAL</p>
            <h1 className="mt-0.5 font-dolfines text-2xl font-semibold tracking-[0.06em] text-white">
              {t("reports.title")}{site ? ` · ${site.display_name}` : ""}
            </h1>
            <p className="mt-2 w-full text-sm leading-7 text-slate-200/82">
              Move from uploaded operating data to a client-ready performance diagnosis through a clear step flow: choose the
              summary language, upload and map the measured data, confirm the site context and data availability, then generate the
              final technical summary and PDF.
            </p>
          </section>

          <div className="space-y-4">
            <WorkflowPanel
              step="Step 1"
              title="Choose summary language"
              description="REVEAL generates a comprehensive performance diagnosis that adapts to the data available. Choose the language for the narrative summary."
              accent="from-violet-400/95 to-violet-600/70"
              active={activeStep === 1}
              completed={step1Configured}
              collapsed={collapsedSteps[1]}
              onToggle={() => setCollapsedSteps((prev) => ({ ...prev, 1: !prev[1] }))}
              summary={
                step1Configured
                  ? `Comprehensive diagnosis in ${lang === "en" ? "English" : lang === "fr" ? "French" : "German"}.`
                  : "Choose the summary language to unlock Step 2."
              }
            >
              <div className="rounded-[22px] border border-orange-DEFAULT/25 bg-row p-4 shadow-[0_14px_28px_rgba(243,146,0,0.12)] inline-block">
                <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.18em] text-orange-DEFAULT">
                  Summary language
                </label>
                <div className="segmented-control flex flex-wrap gap-2 rounded-2xl border border-faint bg-row p-1">
                  {(["en", "fr", "de"] as const).map((l) => (
                    <button
                      key={l}
                      type="button"
                      onClick={() => {
                        setLang(l);
                        setLanguageChosen(true);
                      }}
                      className={`segmented-control-button rounded-xl border px-4 py-2 text-sm font-semibold transition-colors ${
                        lang === l
                          ? "segmented-control-button-active border-orange-DEFAULT bg-orange-DEFAULT text-white shadow-[0_8px_24px_rgba(234,120,36,0.35)]"
                          : "border-subtle bg-row text-nav-active hover:border-orange-DEFAULT/40 hover:text-orange-DEFAULT"
                      }`}
                    >
                      {l === "en" ? "English" : l === "fr" ? "Français" : "Deutsch"}
                    </button>
                  ))}
                </div>
              </div>
            </WorkflowPanel>

            <WorkflowPanel
              step="Step 2"
              title="Upload actual data"
              description="Drop the measured SCADA workbook here, let REVEAL analyse the structure, and confirm the detected columns before the performance diagnosis begins."
              accent="from-sky-400/95 to-sky-600/70"
              active={activeStep === 2}
              completed={filesReadyForReview}
              collapsed={collapsedSteps[2]}
              onToggle={() => setCollapsedSteps((prev) => ({ ...prev, 2: !prev[2] }))}
              summary={
                previewReady
                  ? `${files.length} file(s) analysed. ${totalRows.toLocaleString()} rows detected across ${formatDateRange(firstRange)} and the availability heat map is ready.`
                  : analysisError
                    ? `${files.length} file(s) analysed. ${totalRows.toLocaleString()} rows detected across ${formatDateRange(firstRange)}. The optional heat-map preview failed, but you can continue to Step 3.`
                    : dataConfirmed
                      ? `${files.length} file(s) analysed. ${totalRows.toLocaleString()} rows detected across ${formatDateRange(firstRange)}. Uploaded data and mappings confirmed.`
                  : files.length > 0
                    ? "REVEAL is analysing the uploaded files and waiting for you to confirm the mapped data before Step 3."
                    : "No measured file uploaded yet."
              }
            >
              <div className="rounded-[24px] border border-faint bg-panel p-4 backdrop-blur-sm">
                <div
                  {...getRootProps()}
                  className={`rounded-2xl border-2 border-dashed p-6 text-center transition-colors ${
                    isDragActive
                      ? "border-orange-DEFAULT bg-orange-DEFAULT/10"
                      : "cursor-pointer border-white/20 bg-[rgba(255,255,255,0.04)] hover:border-orange-DEFAULT/60"
                  }`}
                >
                  <input {...getInputProps()} />
                  <p className="text-sm font-medium text-slate-100">{isDragActive ? t("common.dropFiles") : t("common.dragDrop")}</p>
                  <p className="mt-2 text-xs leading-6 text-white/55">
                    Accepted formats: CSV, XLS, XLSX. REVEAL will detect timestamps, power, irradiance, ambient temperature, and module temperature automatically when available.
                  </p>
                </div>

                {files.length > 0 ? (
                  <ul className="mt-4 space-y-2">
                    {files.map((f, i) => (
                      <li
                        key={`${f.name}-${i}`}
                        className="flex items-center justify-between rounded-xl border border-weak bg-[rgba(255,255,255,0.05)] px-3 py-2 text-xs text-slate-100"
                      >
                        <span>{f.name}</span>
                        <button
                          type="button"
                          onClick={() => {
                            const nextFiles = files.filter((_, j) => j !== i);
                            setFiles(nextFiles);
                            setJobId(null);
                            revokeDirectExportUrls(directExport);
                            setDirectExport(null);
                            void autoDetectColumns(nextFiles);
                          }}
                          className="ml-2 text-slate-500 hover:text-danger"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {files.length > 0 ? (
                  <div className="mt-4 rounded-[24px] border border-subtle bg-panel p-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="progress-label text-xs font-semibold uppercase tracking-[0.2em]">Measured data analysis</p>
                        <p className="progress-title mt-2 font-dolfines text-xl font-semibold tracking-[0.04em]">
                          {isDetecting ? detectionProgressLabel || "Analysing uploaded file" : filesReadyForReview ? "Column analysis complete" : "Awaiting analysis"}
                        </p>
                      </div>
                      <div className="progress-pill rounded-full px-4 py-2 text-sm font-semibold">
                        {isDetecting ? `${detectionProgress}%` : filesReadyForReview ? "100%" : "0%"}
                      </div>
                    </div>
                    <div className="progress-track mt-4 h-3 overflow-hidden rounded-full">
                      <div
                        className="progress-fill h-full rounded-full transition-all duration-500"
                        style={{ width: `${isDetecting ? detectionProgress : filesReadyForReview ? 100 : 0}%` }}
                      />
                    </div>
                    <p className="progress-copy mt-3 text-sm">
                      {isDetecting
                        ? "REVEAL is scanning the CSV/XLSX structure, proposing column roles, and detecting the measured date range."
                        : "Columns detected. Please review and confirm the mappings below before moving to the site details step."}
                    </p>
                  </div>
                ) : null}
              </div>

              {detectionError ? (
                <div className="mt-5 rounded-[22px] border border-red-300/25 bg-red-500/10 px-5 py-4">
                  <p className="text-sm font-semibold text-red-100">Column detection failed</p>
                  <p className="mt-1 text-xs leading-6 text-red-100/80">{detectionError}</p>
                </div>
              ) : null}

              {files.length > 0 && site ? (
                <div className="mt-5">
                        <ColumnMapper
                          files={files}
                          siteType={site.site_type}
                          onMappingChange={setColumnMappings}
                          onWorksheetChange={handleWorksheetChange}
                          detectedMappings={detectedMappings}
                          worksheetLoadingFile={worksheetLoadingFile}
                        />
                </div>
              ) : null}

              {filesReadyForReview ? (
                <div className="mt-5 rounded-[24px] border border-faint bg-panel p-5 backdrop-blur-sm">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-nav">Data-availability heat map</p>
                      <p className="mt-2 text-sm leading-7 text-nav">
                        REVEAL previews monthly data quality across the inverter fleet here, separating missing data from frozen data. For solar, the preview is calculated over local daylight hours only, so overnight zeroes do not count against the coverage metrics.
                      </p>
                    </div>
                    {isRunningAnalysis ? (
                      <span className="rounded-full border border-sky-300/25 bg-sky-400/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-sky-100">
                        Analysing…
                      </span>
                    ) : analysisResult ? (
                      <span className="rounded-full border border-emerald-300/25 bg-emerald-400/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-100">
                        Preview ready
                      </span>
                    ) : analysisError ? (
                      <span className="rounded-full border border-amber-300/25 bg-amber-400/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-amber-100">
                        Preview skipped
                      </span>
                    ) : null}
                  </div>

                  {analysisError ? (
                    <div className="mt-4 rounded-2xl border border-amber-300/25 bg-amber-400/10 px-4 py-4">
                      <p className="text-sm leading-7 text-slate-900">
                        REVEAL could not load the optional heat-map preview for this dataset. You can continue to Step 3, or retry the preview here.
                      </p>
                      <p className="mt-2 text-xs leading-6 text-slate-700">{analysisError}</p>
                      <div className="mt-4">
                        <Button variant="secondary" size="sm" onClick={requestPreview} disabled={isRunningAnalysis}>
                          Retry heat-map preview
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {isRunningAnalysis ? (
                    <div className="mt-4 rounded-[22px] border border-subtle bg-panel p-5">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="progress-label text-xs font-semibold uppercase tracking-[0.2em]">Heat-map preview</p>
                          <p className="progress-title mt-2 font-dolfines text-xl font-semibold tracking-[0.04em]">
                            {previewProgressLabel || "Building the data-quality preview"}
                          </p>
                        </div>
                        <div className="progress-pill rounded-full px-4 py-2 text-sm font-semibold">
                          {previewProgress}%
                        </div>
                      </div>
                      <div className="progress-track mt-4 h-3 overflow-hidden rounded-full">
                        <div
                          className="progress-fill h-full rounded-full transition-all duration-500"
                          style={{ width: `${previewProgress}%` }}
                        />
                      </div>
                      <p className="progress-copy mt-3 text-sm">
                        REVEAL is calculating monthly data quality, identifying missing versus frozen periods, and preparing the inverter heat map.
                      </p>
                    </div>
                  ) : null}

                  {analysisResult ? (
                    <>
                      <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                        <div className="rounded-2xl border border-weak bg-row px-4 py-3">
                          <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Power completeness</p>
                          <p className="mt-2 text-xl font-semibold text-white">{analysisResult.data_quality.overall_power_pct.toFixed(1)}%</p>
                        </div>
                        <div className="rounded-2xl border border-weak bg-row px-4 py-3">
                          <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Irradiance completeness</p>
                          <p className="mt-2 text-xl font-semibold text-white">{analysisResult.data_quality.irradiance_pct.toFixed(1)}%</p>
                        </div>
                        <div className="rounded-2xl border border-weak bg-row px-4 py-3">
                          <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Site mean availability</p>
                          <p className="mt-2 text-xl font-semibold text-white">{analysisResult.availability.mean_pct.toFixed(1)}%</p>
                        </div>
                      <div className="rounded-2xl border border-weak bg-row px-4 py-3">
                        <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Whole-site outages</p>
                        <p className="mt-2 text-xl font-semibold text-white">{analysisResult.availability.whole_site_events}</p>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 xl:grid-cols-2">
                      <div className="rounded-2xl border border-weak bg-row px-4 py-3">
                        <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Availability assumptions</p>
                        <p className="mt-2 text-sm leading-7 text-nav">
                          For solar, REVEAL calculates preview completeness over the local daylight window only, using the same daytime screen as the long-term workflow. Overnight zeroes do not count as missing data.
                        </p>
                      </div>
                      <div className="rounded-2xl border border-weak bg-row px-4 py-3">
                        <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Whole-site outages definition</p>
                        <p className="mt-2 text-sm leading-7 text-nav">
                          This counts daytime periods where all mapped power channels are effectively offline at the same time, indicating a plant-wide outage rather than an isolated inverter event.
                        </p>
                      </div>
                    </div>

                    <div className="mt-5 overflow-x-auto rounded-2xl border border-faint bg-row">
                        <div className="min-w-[760px]">
                          <div
                            className="grid gap-2 border-b border-faint px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-nav"
                            style={{ gridTemplateColumns: `120px repeat(${heatMapMonths.length}, minmax(72px, 1fr))` }}
                          >
                            <div>Inverter</div>
                            {heatMapMonths.map((month) => (
                              <div key={month} className="text-center">
                                {formatMonthLabel(month)}
                              </div>
                            ))}
                          </div>
                          <div className="space-y-2 px-4 py-4">
                            {heatMapInverters.map((inverter) => (
                              <div
                                key={inverter}
                                className="grid gap-2"
                                style={{ gridTemplateColumns: `120px repeat(${heatMapMonths.length}, minmax(72px, 1fr))` }}
                              >
                                <div className="flex items-center rounded-xl border border-faint bg-panel px-3 py-2 text-xs font-semibold text-nav-active">
                                  {inverter}
                                </div>
                                  {heatMapMonths.map((month) => {
                                    const quality = heatMapLookup.get(`${month}::${inverter}`) ?? {
                                      completenessPct: 0,
                                      missingPct: 0,
                                      frozenPct: 0,
                                    };
                                    return (
                                      <div
                                        key={`${inverter}-${month}`}
                                        className={`rounded-xl border px-2 py-2 text-center text-xs font-semibold ${getHeatTileClass(quality)}`}
                                        title={`${inverter} · ${formatMonthLabel(month)} · ${quality.completenessPct.toFixed(1)}% valid · ${quality.missingPct.toFixed(1)}% missing · ${quality.frozenPct.toFixed(1)}% frozen`}
                                      >
                                        {quality.frozenPct > 0
                                          ? `F ${quality.frozenPct.toFixed(0)}%`
                                          : quality.missingPct > 0
                                            ? `M ${quality.missingPct.toFixed(0)}%`
                                            : `${quality.completenessPct.toFixed(0)}%`}
                                      </div>
                                    );
                                  })}
                              </div>
                            ))}
                            {irrHeatMapLookup.size > 0 && (
                              <>
                                <div
                                  className="col-span-full my-1 border-t border-faint"
                                  style={{ gridColumn: `1 / -1` }}
                                />
                                <div
                                  className="grid gap-2"
                                  style={{ gridTemplateColumns: `120px repeat(${heatMapMonths.length}, minmax(72px, 1fr))` }}
                                >
                                  <div className="flex items-center rounded-xl border border-sky-300/30 bg-sky-400/10 px-3 py-2 text-xs font-semibold text-sky-300">
                                    Irradiance
                                  </div>
                                  {heatMapMonths.map((month) => {
                                    const irr = irrHeatMapLookup.get(month) ?? { completenessPct: 0, missingPct: 100 };
                                    const quality = { ...irr, frozenPct: 0 };
                                    return (
                                      <div
                                        key={`irr-${month}`}
                                        className={`rounded-xl border px-2 py-2 text-center text-xs font-semibold ${getHeatTileClass(quality)}`}
                                        title={`Irradiance · ${formatMonthLabel(month)} · ${irr.completenessPct.toFixed(1)}% valid · ${irr.missingPct.toFixed(1)}% missing`}
                                      >
                                        {irr.missingPct > 0
                                          ? `M ${irr.missingPct.toFixed(0)}%`
                                          : `${irr.completenessPct.toFixed(0)}%`}
                                      </div>
                                    );
                                  })}
                                </div>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="mt-4 flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-[0.18em]">
                        <span className="rounded-full border border-emerald-300/30 bg-emerald-400/15 px-3 py-1 text-emerald-900 dark:text-emerald-50">95%+ valid data</span>
                        <span className="rounded-full border border-sky-300/30 bg-sky-400/18 px-3 py-1 text-sky-900 dark:text-sky-50">Reduced but usable coverage</span>
                        <span className="rounded-full border border-rose-300/35 bg-rose-400/18 px-3 py-1 text-rose-900 dark:text-rose-50">Missing data</span>
                        <span className="rounded-full border border-red-300/35 bg-red-500/18 px-3 py-1 text-red-900 dark:text-red-50">Frozen data</span>
                        <span className="rounded-full border border-rose-300/35 bg-[linear-gradient(135deg,rgba(239,68,68,0.28)_0%,rgba(239,68,68,0.28)_49%,rgba(251,113,133,0.22)_51%,rgba(251,113,133,0.22)_100%)] px-3 py-1 text-rose-950 dark:text-white">Frozen + missing</span>
                      </div>
                    </>
                  ) : !analysisError ? (
                    <div className="mt-4 rounded-2xl border border-faint bg-row px-4 py-3 text-sm text-nav">
                      Click “Load heat-map preview” if you want REVEAL to render the monthly completeness view before moving on.
                    </div>
                  ) : null}

                  <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-faint bg-row px-4 py-4">
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-white">Confirm the uploaded data and mapped columns</p>
                      <p className="text-xs leading-6 text-nav">
                        Step 3 should only open after you confirm that the measured files, mapped power channels, irradiance signal, and optional temperatures look correct.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="secondary" onClick={requestPreview} disabled={!filesReadyForReview || isRunningAnalysis}>
                        {analysisResult ? "Refresh heat-map preview" : "Load heat-map preview"}
                      </Button>
                      <Button
                        variant={dataConfirmed ? "secondary" : "primary"}
                        onClick={() => setDataConfirmed(true)}
                        disabled={!filesReadyForReview}
                      >
                        {dataConfirmed ? "Data confirmed" : "Confirm uploaded data"}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : null}
            </WorkflowPanel>

            <WorkflowPanel
              step="Step 3"
              title="Confirm site details and data availability"
              description="Review the site context, detected time range, and mapped performance signals before you launch the performance analysis."
              accent="from-amber-300/95 to-amber-500/70"
              active={activeStep === 3}
              completed={assumptionsConfirmed}
              collapsed={collapsedSteps[3]}
              onToggle={() => setCollapsedSteps((prev) => ({ ...prev, 3: !prev[3] }))}
              summary={
                assumptionsConfirmed
                  ? "Site context and data-availability checks confirmed for this run."
                  : "Confirm the plant assumptions, equipment details, site tariff, module tilt, and irradiance basis before REVEAL generates the performance diagnosis."
              }
            >
              <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
                <div className="rounded-[24px] border border-faint bg-panel p-5">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-nav">Site context</p>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-2xl border border-weak bg-row px-4 py-3">
                      <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Site</p>
                      <p className="mt-2 text-sm font-semibold text-white">{site?.display_name ?? "Loading site..."}</p>
                    </div>
                    <div className="rounded-2xl border border-weak bg-row px-4 py-3">
                      <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Technology</p>
                      <p className="mt-2 text-sm font-semibold text-white">{site?.technology ?? "—"}</p>
                    </div>
                    <div className="rounded-2xl border border-weak bg-row px-4 py-3">
                      <p className="text-[11px] uppercase tracking-[0.22em] text-nav">DC capacity</p>
                      <p className="mt-2 text-sm font-semibold text-white">
                        {site ? `${site.cap_dc_kwp.toLocaleString()} kWp` : "—"}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-weak bg-row px-4 py-3">
                      <p className="text-[11px] uppercase tracking-[0.22em] text-nav">AC capacity</p>
                      <p className="mt-2 text-sm font-semibold text-white">
                        {inferredAcCapacityKw > 0 ? `${inferredAcCapacityKw.toLocaleString(undefined, { maximumFractionDigits: 1 })} kW` : "—"}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-weak bg-row px-4 py-3">
                      <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Inverter type</p>
                      <input
                        type="text"
                        value={inverterType}
                        onChange={(event) => setInverterType(event.target.value)}
                        onFocus={selectAllOnFocus}
                        className="mt-2 w-full rounded-xl border border-subtle bg-white px-3 py-2 text-sm font-medium text-slate-900 focus:border-orange-DEFAULT focus:outline-none"
                        placeholder="Confirm inverter model"
                      />
                    </div>
                    <div className="rounded-2xl border border-weak bg-row px-4 py-3">
                      <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Inverter quantity</p>
                      <input
                        type="number"
                        min="0"
                        value={inverterQuantity}
                        onChange={(event) => setInverterQuantity(event.target.value)}
                        onFocus={selectAllOnFocus}
                        className="mt-2 w-full rounded-xl border border-subtle bg-white px-3 py-2 text-sm font-medium text-slate-900 focus:border-orange-DEFAULT focus:outline-none"
                        placeholder="e.g. 31"
                      />
                    </div>
                    <div className="rounded-2xl border border-weak bg-row px-4 py-3">
                      <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Module quantity</p>
                      <input
                        type="number"
                        min="0"
                        value={moduleQuantity}
                        onChange={(event) => setModuleQuantity(event.target.value)}
                        onFocus={selectAllOnFocus}
                        className="mt-2 w-full rounded-xl border border-subtle bg-white px-3 py-2 text-sm font-medium text-slate-900 focus:border-orange-DEFAULT focus:outline-none"
                        placeholder="e.g. 16800"
                      />
                    </div>
                    <div className="rounded-2xl border border-weak bg-row px-4 py-3">
                      <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Module capacity</p>
                      <div className="mt-2 flex items-center gap-2">
                        <input
                          type="text"
                          inputMode="decimal"
                          value={moduleCapacityWp}
                          onChange={(event) => setModuleCapacityWp(normalizeDecimalInput(event.target.value))}
                          onFocus={selectAllOnFocus}
                          className="w-full rounded-xl border border-subtle bg-white px-3 py-2 text-sm font-medium text-slate-900 focus:border-orange-DEFAULT focus:outline-none"
                          placeholder="e.g. 660"
                        />
                        <span className="text-sm font-semibold text-nav">Wp</span>
                      </div>
                    </div>
                    <div className="rounded-2xl border border-weak bg-row px-4 py-3">
                      <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Site tariff</p>
                      <div className="mt-2 flex items-center gap-2">
                        <input
                          type="text"
                          inputMode="decimal"
                          value={siteTariffEurMwh}
                          onChange={(event) => setSiteTariffEurMwh(normalizeDecimalInput(event.target.value))}
                          onFocus={selectAllOnFocus}
                          className="w-full rounded-xl border border-subtle bg-white px-3 py-2 text-sm font-medium text-slate-900 focus:border-orange-DEFAULT focus:outline-none"
                          placeholder="e.g. 85"
                        />
                        <span className="text-sm font-semibold text-nav">EUR/MWh</span>
                      </div>
                      <p className="mt-2 text-xs leading-6 text-nav">Required so REVEAL can later translate recoverable losses into owner value.</p>
                    </div>
                    {site?.site_type === "solar" ? (
                      <div className="rounded-2xl border border-weak bg-row px-4 py-3">
                        <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Module tilt</p>
                        <div className="mt-2 flex items-center gap-2">
                          <input
                            type="text"
                            inputMode="decimal"
                            value={moduleTiltDeg}
                            onChange={(event) => setModuleTiltDeg(normalizeDecimalInput(event.target.value))}
                            onFocus={selectAllOnFocus}
                            className="w-full rounded-xl border border-subtle bg-white px-3 py-2 text-sm font-medium text-slate-900 focus:border-orange-DEFAULT focus:outline-none"
                            placeholder="e.g. 20"
                          />
                          <span className="text-sm font-semibold text-nav">deg</span>
                        </div>
                      </div>
                    ) : null}
                    {site?.site_type === "solar" ? (
                      <div className="rounded-2xl border border-weak bg-row px-4 py-3">
                        <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Irradiance basis</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {[
                            { value: "poa", label: "POA" },
                            { value: "ghi", label: "GHI" },
                          ].map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              onClick={() => setIrradianceBasis(option.value as "poa" | "ghi")}
                              className={`rounded-xl border px-3 py-2 text-sm font-semibold transition-colors ${
                                irradianceBasis === option.value
                                  ? "power-channel-chip-selected"
                                  : "power-channel-chip"
                              }`}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="rounded-[24px] border border-faint bg-panel p-5">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-nav">Data availability</p>
                  <div className="mt-4 space-y-3 text-sm text-nav-active">
                    <div className="rounded-2xl border border-weak bg-row px-4 py-3">
                      <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Files analysed</p>
                      <p className="mt-2 font-semibold text-white">{files.length}</p>
                    </div>
                    <div className="rounded-2xl border border-weak bg-row px-4 py-3">
                      <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Detected rows</p>
                      <p className="mt-2 font-semibold text-white">{totalRows.toLocaleString()}</p>
                    </div>
                    <div className="rounded-2xl border border-weak bg-row px-4 py-3">
                      <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Date range</p>
                      <p className="mt-2 font-semibold text-white">{formatDateRange(firstRange)}</p>
                    </div>
                    <div className="rounded-2xl border border-weak bg-row px-4 py-3">
                      <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Mapped power signals</p>
                      <p className="mt-2 font-semibold text-white">{powerColumnsSelected.toLocaleString()}</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-[22px] border border-faint bg-row px-5 py-4">
                <div className="space-y-2">
                  <p className="text-sm leading-7 text-nav">
                    Confirm that the uploaded period, plant context, equipment details, site tariff, module tilt, and irradiance basis are correct before REVEAL generates the performance diagnosis and PDF summary.
                  </p>
                  <p className="text-xs leading-6 text-nav">
                    If this is a brand-new asset, create the site in REVEAL first so Step 3 can pull the correct plant details, capacities, and technology.
                  </p>
                </div>
                <Button
                  variant="primary"
                  className={`font-semibold text-white shadow-[0_14px_36px_rgba(240,120,32,0.42)] ${assumptionsConfirmed ? "opacity-100" : "bg-orange-DEFAULT text-white hover:bg-orange-DEFAULT/90"}`}
                  onClick={() => {
                    setAssumptionsConfirmed(true);
                    setAnalysisLaunched(false);
                    setAnalysisResult(null);
                    setAnalysisError(null);
                    setAnalysisRequested(false);
                  }}
                  disabled={!filesReadyForReview || !dataConfirmed || !siteDetailsReady}
                >
                  {assumptionsConfirmed ? "Confirmed" : "Confirm assumptions"}
                </Button>
              </div>
              {assumptionsConfirmed ? (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-[22px] border border-violet-300/18 bg-[linear-gradient(135deg,rgba(124,58,237,0.10),rgba(59,130,246,0.06))] px-5 py-4">
                  <div className="space-y-2">
                    <p className="text-sm font-semibold text-white">Launch the live analysis</p>
                    <p className="text-xs leading-6 text-white/65">
                      Trigger the full Step 4 diagnosis now to build the charts, commentary, waterfall, and punchlist in the app.
                    </p>
                    {dcAcRatio !== null && (dcAcRatio < 0.9 || dcAcRatio > 1.5) ? (
                      <p className="rounded-xl border border-amber-300/30 bg-amber-400/12 px-3 py-2 text-xs leading-6 text-amber-50">
                        Warning: the current DC/AC ratio is <span className="font-semibold text-white">{dcAcRatio.toFixed(2)}</span>. REVEAL expects most solar sites to sit roughly between <span className="font-semibold text-white">0.9</span> and <span className="font-semibold text-white">1.5</span>, so please double-check the inverter quantity or plant capacities before launching the analysis.
                      </p>
                    ) : null}
                  </div>
                  <Button
                    variant="primary"
                    className="font-semibold text-white shadow-[0_14px_34px_rgba(139,92,246,0.36)]"
                    onClick={async () => {
                      setAnalysisLaunched(true);
                      setCollapsedSteps((prev) => ({ ...prev, 4: false }));
                      await requestPreview();
                    }}
                    disabled={isRunningAnalysis}
                  >
                    {analysisResult && analysisSignature === previewSignature ? "Refresh analysis" : "Launch analysis"}
                  </Button>
                </div>
              ) : null}
            </WorkflowPanel>

            <WorkflowPanel
              step="Step 4"
              title="Review the analysis and export"
              description="Review the charts, commentary, KPIs, and punchlist directly in REVEAL first. Then generate the client-ready export as an extra deliverable."
              accent="from-violet-300/95 to-violet-500/70"
              active={activeStep === 4}
              completed={Boolean(jobId)}
              collapsed={collapsedSteps[4]}
              onToggle={() => setCollapsedSteps((prev) => ({ ...prev, 4: !prev[4] }))}
                summary={
                  jobId
                    ? "The performance analysis job is running or complete. Use the progress panel below to monitor the PDF generation."
                    : analysisResult
                      ? "The live diagnosis is ready in-app. Review the KPIs and punchlist, then generate the client-ready summary export if you need it."
                      : analysisLaunched
                        ? "REVEAL is preparing the in-app diagnosis now. The legacy summary export stays optional and secondary."
                        : assumptionsConfirmed
                          ? "Assumptions are confirmed. Launch the analysis when you are ready to open the full Step 4 diagnosis."
                        : "Once the assumptions are confirmed, REVEAL will run the live diagnosis in-app and keep the legacy summary export as an optional extra."
                }
              >
              {analysisLaunched && isRunningAnalysis ? (
                <div className="mb-5 rounded-[24px] border border-subtle bg-panel p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="progress-label text-xs font-semibold uppercase tracking-[0.2em]">Analysis generation</p>
                      <p className="progress-title mt-2 font-dolfines text-xl font-semibold tracking-[0.04em]">
                        {analysisProgressLabel || "Generating the in-app performance analysis"}
                      </p>
                    </div>
                    <div className="progress-pill rounded-full px-4 py-2 text-sm font-semibold">
                      {analysisProgress}%
                    </div>
                  </div>
                  <div className="progress-track mt-4 h-3 overflow-hidden rounded-full">
                    <div
                      className="progress-fill h-full rounded-full transition-all duration-500"
                      style={{ width: `${analysisProgress}%` }}
                    />
                  </div>
                  <p className="progress-copy mt-3 text-sm">
                    REVEAL is building the loss breakdown, the performance commentary, and the chart set that drives the comprehensive in-app diagnosis.
                  </p>
                </div>
              ) : null}
              <div className="space-y-4">
                <div className="rounded-[24px] border border-faint bg-row p-5">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-nav">Executive summary</p>
                  {analysisResult ? (
                    <>
                      <div className="mt-4 rounded-[22px] border border-faint bg-panel p-4">
                        <div className="space-y-3 text-sm leading-7 text-nav">
                          {executiveSummary.map((line, index) => (
                            <p key={index}>{line}</p>
                          ))}
                        </div>
                      </div>

                        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                          <div className="h-full rounded-2xl border border-weak bg-panel px-4 py-3">
                            <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Total measured energy</p>
                            <p className="mt-2 text-2xl font-semibold text-white">{totalEnergyMwh.toFixed(1)} MWh</p>
                          </div>
                          <div className="h-full rounded-2xl border border-weak bg-panel px-4 py-3">
                            <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Mean availability</p>
                            <p className="mt-2 text-2xl font-semibold text-white">{analysisResult.availability.mean_pct.toFixed(1)}%</p>
                          </div>
                          <div className="h-full rounded-2xl border border-weak bg-panel px-4 py-3">
                            <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Latest annual PR</p>
                            <p className="mt-2 text-2xl font-semibold text-white">
                              {latestAnnualPr.toFixed(1)}%
                            </p>
                          </div>
                          <div className="h-full rounded-2xl border border-weak bg-panel px-4 py-3">
                            <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Annualised site specific yield</p>
                            <p className="mt-2 text-2xl font-semibold text-white">
                            {annualisedSiteSpecificYield.toFixed(1)} kWh/kWp/yr
                          </p>
                        </div>
                        <div className="h-full rounded-2xl border border-weak bg-panel px-4 py-3">
                          <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Whole-site outages</p>
                          <p className="mt-2 text-2xl font-semibold text-white">{analysisResult.availability.whole_site_events}</p>
                        </div>
                      </div>

                      <div className="mt-5">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-nav">Main improvement points</p>
                        <div className="mt-3 space-y-3">
                          {topPunchlist.length > 0 ? (
                            topPunchlist.map((item, index) => (
                              <div
                                key={`${item.category}-${index}`}
                                className={`rounded-2xl border p-4 ${
                                  item.priority === "HIGH"
                                    ? "border-rose-400/55 bg-rose-100/92 shadow-[0_0_0_1px_rgba(244,63,94,0.18)] dark:border-rose-500/40 dark:bg-rose-500/10"
                                    : item.priority === "MEDIUM"
                                      ? "border-amber-400/45 bg-amber-100/92 dark:border-amber-400/30 dark:bg-amber-400/6"
                                      : "border-weak bg-panel"
                                }`}
                              >
                                <div className="flex flex-wrap items-center gap-3">
                                  {item.priority === "HIGH" && (
                                    <svg className="h-4 w-4 shrink-0 text-rose-400" viewBox="0 0 20 20" fill="currentColor">
                                      <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                                    </svg>
                                  )}
                                  <span
                                    className={`rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] ${
                                      item.priority === "HIGH"
                                        ? "border border-rose-500/30 bg-rose-500 text-white"
                                        : item.priority === "MEDIUM"
                                          ? "border border-amber-400/30 bg-amber-400 text-slate-950"
                                          : "border border-sky-300/25 bg-sky-400/10 text-sky-100"
                                    }`}
                                  >
                                    {item.priority}
                                  </span>
                                  <span className={`text-[11px] font-semibold uppercase tracking-[0.18em] ${item.priority === "HIGH" ? "text-rose-700 dark:text-rose-200/70" : item.priority === "MEDIUM" ? "text-amber-800 dark:text-amber-200" : "text-nav"}`}>{item.category}</span>
                                </div>
                                <p className={`mt-3 text-sm font-semibold ${item.priority === "HIGH" ? "text-rose-900 dark:text-rose-50" : item.priority === "MEDIUM" ? "text-amber-950 dark:text-amber-50" : "text-white"}`}>{item.finding}</p>
                                <p className="mt-2 text-sm leading-7 text-nav">{item.recommendation}</p>
                                {((item.impact_mwh !== null && item.impact_mwh !== undefined && item.impact_mwh > 0) ||
                                  (item.impact_eur !== null && item.impact_eur !== undefined && item.impact_eur > 0)) && (
                                  <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
                                    {item.impact_mwh !== null && item.impact_mwh !== undefined && item.impact_mwh > 0 ? (
                                      <span className="rounded-full border border-orange-400/30 bg-orange-100/90 px-3 py-1 text-orange-800 dark:border-orange-300/25 dark:bg-orange-400/10 dark:text-orange-200/80">
                                        Est. loss: {item.impact_mwh.toLocaleString()} MWh
                                      </span>
                                    ) : null}
                                    {item.impact_eur !== null && item.impact_eur !== undefined && item.impact_eur > 0 ? (
                                      <span className="rounded-full border border-orange-500/30 bg-orange-500 px-3 py-1 text-white">
                                        Est. value: €{item.impact_eur.toLocaleString()}
                                      </span>
                                    ) : null}
                                  </div>
                                )}
                              </div>
                            ))
                          ) : (
                            <div className="rounded-2xl border border-weak bg-panel p-4 text-sm text-nav">
                              REVEAL has not identified any punchlist items in the current preview.
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="mt-5">
                        <AnalysisSection
                          id="Lead section"
                          title="Yield waterfall and core bridge"
                          description="This is the lead view of the performance diagnosis. It bridges design expectation to actual yield, separates baseline non-recoverable effects from recoverable losses, and keeps any unexplained remainder in an explicit over / under-performance bucket."
                          collapsed={collapsedAnalysisSections.overview}
                          onToggle={() => setCollapsedAnalysisSections((prev) => ({ ...prev, overview: !prev.overview }))}
                        >
                          <div className="mb-4 rounded-[24px] border border-faint bg-row p-5">
                            <div className="flex flex-wrap items-end gap-4">
                              <MonthFieldPicker
                                label="Waterfall start"
                                value={waterfallStartMonthDraft}
                                min={analysisMonths[0]}
                                max={waterfallEndMonthDraft || analysisMonths[analysisMonths.length - 1]}
                                onChange={setWaterfallStartMonthDraft}
                              />
                              <MonthFieldPicker
                                label="Waterfall end"
                                value={waterfallEndMonthDraft}
                                min={waterfallStartMonthDraft || analysisMonths[0]}
                                max={analysisMonths[analysisMonths.length - 1]}
                                onChange={setWaterfallEndMonthDraft}
                              />
                              <div className="min-w-[180px]">
                                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-nav">Apply period</p>
                                <Button
                                  variant="primary"
                                  className="mt-2 w-full font-semibold text-white"
                                  onClick={() => {
                                    setWaterfallStartMonth(waterfallStartMonthDraft);
                                    setWaterfallEndMonth(waterfallEndMonthDraft);
                                  }}
                                  disabled={
                                    !waterfallStartMonthDraft ||
                                    !waterfallEndMonthDraft ||
                                    waterfallStartMonthDraft > waterfallEndMonthDraft ||
                                    (waterfallStartMonthDraft === waterfallStartMonth && waterfallEndMonthDraft === waterfallEndMonth)
                                  }
                                >
                                  Update chart
                                </Button>
                              </div>
                              <div className="min-w-[240px] flex-1 rounded-2xl border border-weak bg-panel px-4 py-3">
                                <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Selected period</p>
                                <p className="mt-2 text-sm font-semibold text-white">
                                  {effectiveWaterfallStartMonth && effectiveWaterfallEndMonth
                                    ? `${formatMonthLabel(effectiveWaterfallStartMonth)} to ${formatMonthLabel(effectiveWaterfallEndMonth)}`
                                    : "Full analysed period"}
                                </p>
                                <p className="mt-2 text-xs leading-6 text-nav">
                                  The waterfall is filtered to the selected months and prorated to that period so you can compare summer, winter, or any custom slice consistently.
                                </p>
                              </div>
                            </div>
                          </div>
                          <ChartShell
                            title="Yield waterfall"
                            description="Start here. This bridge shows how REVEAL moves from design yield through weather-corrected yield to actual yield, with the main loss buckets laid out in the order the owner should question them."
                            heightClass="h-auto"
                          >
                            <div className="h-[396px] min-h-[396px] w-full">
                              <WaterfallChart data={filteredWaterfallContext.chartData} />
                            </div>
                          </ChartShell>

                          <div className="mt-4 rounded-[24px] border border-faint bg-row p-5">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-nav">Waterfall commentary</p>
                            <div className="mt-4 space-y-3 text-sm leading-7 text-nav">
                              <p>
                                REVEAL starts from the design-level yield expectation, then adjusts it for the actual irradiation, temperature, and other climatic conditions observed over the analysed period. That creates the weather-corrected yield.
                              </p>
                              <p>
                                From there, REVEAL isolates the recoverable losses that matter most for owners: downtime, curtailment / negative-hour behaviour, and site-side mismatch or soiling effects.
                              </p>
                              <p>
                                Any remaining unexplained difference is kept in the <span className="font-semibold text-white">over / under performance</span> bucket so it remains explicit rather than being hidden inside other assumptions.
                              </p>
                              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                                <div className="rounded-2xl border border-weak bg-panel px-4 py-3">
                                  <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Design yield</p>
                                  <p className="mt-2 text-xl font-semibold text-white">{filteredWaterfallContext.designYieldMwh.toFixed(1)} MWh</p>
                                </div>
                                <div className="rounded-2xl border border-weak bg-panel px-4 py-3">
                                  <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Weather-corrected yield</p>
                                  <p className="mt-2 text-xl font-semibold text-white">{filteredWaterfallContext.weatherCorrectedYieldMwh.toFixed(1)} MWh</p>
                                </div>
                                <div className="rounded-2xl border border-weak bg-panel px-4 py-3">
                                  <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Recoverable losses</p>
                                  <p className="mt-2 text-xl font-semibold text-white">{filteredWaterfallContext.recoverableMwh.toFixed(1)} MWh</p>
                                </div>
                                <div className="rounded-2xl border border-weak bg-panel px-4 py-3">
                                  <p className="text-[11px] uppercase tracking-[0.22em] text-nav">Over / under performance</p>
                                  <p className="mt-2 text-xl font-semibold text-white">{filteredWaterfallContext.overUnderPerformanceMwh.toFixed(1)} MWh</p>
                                </div>
                              </div>
                            </div>
                          </div>
                        </AnalysisSection>
                      </div>

                      <AnalysisSection
                        id="Section A"
                        title="Weather context and rainfall heat map"
                        description="ERA rainfall is shown here to support later excess-soiling interpretation. REVEAL highlights heavy and very heavy rainfall months and the strongest cleaning-event candidates."
                        collapsed={collapsedAnalysisSections.weather}
                        onToggle={() => setCollapsedAnalysisSections((prev) => ({ ...prev, weather: !prev.weather }))}
                      >
                        {weatherMonthlyRows.length > 0 ? (
                          <>
                            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
                              <div className="rounded-[24px] border border-faint bg-[rgba(255,255,255,0.04)] p-5">
                                <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/55">Weather source</p>
                                <p className="mt-3 text-lg font-semibold text-white">{analysisResult?.weather.source ?? "ERA rainfall"}</p>
                              </div>
                              <div className="rounded-[24px] border border-faint bg-[rgba(255,255,255,0.04)] p-5">
                                <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/55">Total rain</p>
                                <p className="mt-3 text-lg font-semibold text-white">{weatherSummary?.total_rain_mm.toFixed(1) ?? "0.0"} mm</p>
                              </div>
                              <div className="rounded-[24px] border border-faint bg-[rgba(255,255,255,0.04)] p-5">
                                <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/55">Heavy rain days</p>
                                <p className="mt-3 text-lg font-semibold text-white">{weatherSummary?.heavy_rain_days ?? 0}</p>
                              </div>
                              <div className="rounded-[24px] border border-faint bg-[rgba(255,255,255,0.04)] p-5">
                                <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/55">Very heavy rain days</p>
                                <p className="mt-3 text-lg font-semibold text-white">{weatherSummary?.very_heavy_rain_days ?? 0}</p>
                              </div>
                              <div className="rounded-[24px] border border-faint bg-[rgba(255,255,255,0.04)] p-5">
                                <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/55">Irradiance vs ERA</p>
                                <p className="mt-3 text-lg font-semibold text-white">
                                  {irradianceCheck?.median_ratio_pct !== null && irradianceCheck?.median_ratio_pct !== undefined
                                    ? `${irradianceCheck.median_ratio_pct.toFixed(1)}%`
                                    : "n/a"}
                                </p>
                                <p className="mt-2 text-xs leading-6 text-slate-200/70">
                                  {irradianceCheck?.status === "warning"
                                    ? "sensor check recommended"
                                    : irradianceCheck?.status === "ok"
                                      ? "benchmark tracks well"
                                      : "benchmark unavailable"}
                                </p>
                              </div>
                            </div>

                            {sectionCommentary.weather?.length ? (
                              <div className="mt-4 rounded-[24px] border border-faint bg-[rgba(255,255,255,0.04)] p-5">
                                <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/55">Commentary</p>
                                <div className="mt-4 space-y-3">
                                  {sectionCommentary.weather.map((line, index) => (
                                    <div key={`weather-commentary-${index}`} className="rounded-2xl border border-weak bg-row px-4 py-3 text-sm leading-7 text-nav">
                                      <div className="flex items-start gap-3">
                                        <span className="mt-2 inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-orange-DEFAULT" />
                                        <p>{line}</p>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : null}

                            {irradianceBenchmarkRows.length > 0 ? (
                              <div className="mt-4">
                                <ChartShell
                                  title="Measured irradiance versus ERA benchmark"
                                  description="This comparison checks whether the site irradiance signal tracks the ERA reference consistently month by month. Persistent bias can point to pyranometer calibration, cleaning, shading, or scaling issues."
                                >
                                  <ResponsiveContainer width="100%" height="100%">
                                    <ComposedChart data={irradianceBenchmarkRows} margin={{ top: 20, right: 12, left: 8, bottom: 30 }}>
                                      <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-axis-grid)" />
                                      <XAxis
                                        dataKey="month"
                                        tick={{ fill: "var(--chart-axis-text)", fontSize: 11 }}
                                        tickFormatter={formatMonthLabel}
                                        axisLine={{ stroke: "var(--chart-axis-line)" }}
                                        tickLine={false}
                                        label={{ value: "Month", position: "insideBottom", offset: -6, fill: "var(--chart-axis-text-strong)", fontSize: 11 }}
                                      />
                                      <YAxis
                                        yAxisId="left"
                                        tick={{ fill: "var(--chart-axis-text)", fontSize: 11 }}
                                        axisLine={{ stroke: "var(--chart-axis-line)" }}
                                        tickLine={false}
                                        label={{ value: "Irradiation (kWh/m²)", angle: -90, position: "insideLeft", dy: 64, fill: "var(--chart-axis-text-strong)", fontSize: 11 }}
                                      />
                                      <Tooltip content={<RevealTooltip labelFormatter={formatMonthLabel} />} cursor={false} />
                                      <Legend wrapperStyle={{ color: "var(--chart-legend-text)", fontSize: 12, paddingTop: 18 }} />
                                      <Bar yAxisId="left" dataKey="measured_kwh_m2" name="Measured irradiance" fill="rgba(245,158,11,0.72)" radius={[5, 5, 0, 0]} />
                                      <Line yAxisId="left" type="monotone" dataKey="reference_kwh_m2" name="ERA reference irradiance" stroke="#60a5fa" strokeWidth={2.4} dot={false} />
                                    </ComposedChart>
                                  </ResponsiveContainer>
                                </ChartShell>
                              </div>
                            ) : null}

                            <div className="mt-4 rounded-[24px] border border-faint bg-[rgba(255,255,255,0.04)] p-4">
                              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/55">Rainfall heat map</p>
                              <p className="mt-2 text-sm leading-7 text-slate-200/82">
                                Higher monthly rainfall is shown in stronger darker red tones, while lighter rainfall stays pale. This is the weather context REVEAL will use when checking whether heavy rainfall coincides with a PR reset that could confirm excess soiling.
                              </p>
                              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                                {weatherMonthlyRows.map((item) => {
                                  const style = getRainHeatTileStyle(item.total_rain_mm);
                                  return (
                                    <div
                                      key={item.month}
                                      className="rounded-xl border px-3 py-2.5"
                                      style={style}
                                    >
                                      <div className="flex items-center justify-between gap-3">
                                        <p className="text-xs font-semibold">{formatMonthLabel(item.month)}</p>
                                        <span className="rounded-full border border-current/20 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.18em]">
                                          {item.intensity.replace("_", " ")}
                                        </span>
                                      </div>
                                      <div className="mt-2 flex items-end justify-between gap-3">
                                        <p className="text-lg font-semibold">{item.total_rain_mm.toFixed(1)} mm</p>
                                        <p className="text-[10px] leading-5 opacity-80">{item.rainy_hours}h rain</p>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                              <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-nav">
                                <span className="rounded-full border border-subtle bg-white px-3 py-1">Dry / negligible</span>
                                <span className="rounded-full border border-red-300/25 bg-red-100 px-3 py-1 text-red-700">Moderate rain</span>
                                <span className="rounded-full border border-red-400/30 bg-red-200 px-3 py-1 text-red-800">Heavy rain</span>
                                <span className="rounded-full border border-red-500/35 bg-red-300 px-3 py-1 text-red-950">Very heavy rain</span>
                                <span className="rounded-full border border-red-700/45 bg-red-700 px-3 py-1 text-white">Extreme wet month</span>
                              </div>
                            </div>

                            <div className="mt-4 rounded-[24px] border border-faint bg-[rgba(255,255,255,0.04)] p-5">
                              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/55">Heavy-rain event candidates</p>
                              <p className="mt-2 text-sm leading-7 text-slate-200/82">
                                These are the strongest heavy and very heavy rain days from ERA. They do not prove cleaning by themselves, but they give REVEAL the right event candidates to compare like-for-like PR before and after rain.
                              </p>
                              <div className="mt-4">
                                {weatherEvents.length > 0 ? (
                                  <div className="grid gap-2 xl:grid-cols-2 2xl:grid-cols-3">
                                    {weatherEvents.map((item) => (
                                      <div key={item.date} className="rounded-2xl border border-weak bg-row px-3 py-3 text-nav-active">
                                        <div className="flex items-start justify-between gap-3">
                                          <div className="min-w-0">
                                            <p className="text-sm font-semibold text-nav-active">{item.date}</p>
                                            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                                              <p className="font-semibold">{item.total_rain_mm.toFixed(1)} mm</p>
                                              <p className="text-nav">Peak {item.peak_hourly_rain_mm.toFixed(2)} mm/h</p>
                                            </div>
                                          </div>
                                          <span
                                            className={`shrink-0 rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${
                                              item.classification === "very heavy"
                                                ? "border border-red-500/30 bg-red-500 text-white"
                                                : "border border-amber-400/35 bg-amber-300 text-amber-950"
                                            }`}
                                          >
                                            {item.classification}
                                          </span>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div className="rounded-2xl border border-weak bg-row px-3 py-4 text-nav">
                                    REVEAL did not find any heavy-rain candidates in the ERA record for this analysed period.
                                  </div>
                                )}
                              </div>
                            </div>
                          </>
                        ) : (
                          <div className="rounded-[22px] border border-faint bg-[rgba(255,255,255,0.04)] p-4 text-sm leading-7 text-slate-200/84">
                            {analysisResult?.weather.error
                              ? `REVEAL could not load ERA rainfall for this run: ${analysisResult.weather.error}`
                              : "REVEAL did not receive any rainfall context for this analysed period."}
                          </div>
                        )}
                      </AnalysisSection>

                      <AnalysisSection
                        id="Section B"
                        title="Monthly performance story and inverter spread"
                        description="This section keeps the main month-by-month comparison, the first-pass loss framing, and the best-versus-worst inverter spread together so it can be opened or collapsed as one block."
                        collapsed={collapsedAnalysisSections.site}
                        onToggle={() => setCollapsedAnalysisSections((prev) => ({ ...prev, site: !prev.site }))}
                      >
                      <div className="grid gap-4 xl:grid-cols-2">
                        <ChartShell
                          title="Monthly energy versus reference"
                          description="Actual site energy is compared against the weather-implied reference each month. This is the first view to check whether the underperformance is concentrated in specific periods or structural across the year."
                        >
                          <ResponsiveContainer width="100%" height="100%">
                            <ComposedChart data={latestMonths} margin={{ top: 20, right: 10, left: 10, bottom: 30 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-axis-grid)" />
                              <XAxis
                                dataKey="month"
                                tick={{ fill: "var(--chart-axis-text)", fontSize: 11 }}
                                tickFormatter={formatMonthLabel}
                                axisLine={{ stroke: "var(--chart-axis-line)" }}
                                tickLine={false}
                                label={{ value: "Month", position: "insideBottom", offset: -6, fill: "var(--chart-axis-text-strong)", fontSize: 11 }}
                              />
                              <YAxis
                                tick={{ fill: "var(--chart-axis-text)", fontSize: 11 }}
                                axisLine={{ stroke: "var(--chart-axis-line)" }}
                                tickLine={false}
                                label={{ value: "Energy (MWh)", angle: -90, position: "insideLeft", dy: 60, fill: "var(--chart-axis-text-strong)", fontSize: 11 }}
                              />
                              <Tooltip content={<RevealTooltip labelFormatter={formatMonthLabel} valueSuffix=" MWh" />} cursor={false} />
                              <Legend wrapperStyle={{ color: "var(--chart-legend-text)", fontSize: 12, paddingTop: 18 }} />
                              <Bar dataKey="E_act_mwh" name="Measured energy" fill="rgba(88,176,255,0.88)" radius={[5, 5, 0, 0]} />
                              <Line type="monotone" dataKey="E_ref_mwh" name="Reference energy" stroke="#f59e0b" strokeWidth={2.4} dot={false} />
                            </ComposedChart>
                          </ResponsiveContainer>
                        </ChartShell>

                        <ChartShell
                          title="Monthly PR and irradiation"
                          description="This chart helps separate weather from performance. Strong irradiation paired with weak PR points to recoverable operational issues rather than a poor solar resource month."
                        >
                          <ResponsiveContainer width="100%" height="100%">
                            <ComposedChart data={latestMonths} margin={{ top: 20, right: 12, left: 8, bottom: 30 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-axis-grid)" />
                              <XAxis
                                dataKey="month"
                                tick={{ fill: "var(--chart-axis-text)", fontSize: 11 }}
                                tickFormatter={formatMonthLabel}
                                axisLine={{ stroke: "var(--chart-axis-line)" }}
                                tickLine={false}
                                label={{ value: "Month", position: "insideBottom", offset: -6, fill: "var(--chart-axis-text-strong)", fontSize: 11 }}
                              />
                              <YAxis
                                yAxisId="left"
                                tick={{ fill: "var(--chart-axis-text)", fontSize: 11 }}
                                axisLine={{ stroke: "var(--chart-axis-line)" }}
                                tickLine={false}
                                label={{ value: "PR (%)", angle: -90, position: "insideLeft", dy: 56, fill: "#cbd5e1", fontSize: 11 }}
                              />
                              <YAxis
                                yAxisId="right"
                                orientation="right"
                                tick={{ fill: "#cbd5e1", fontSize: 11 }}
                                axisLine={{ stroke: "rgba(255,255,255,0.16)" }}
                                tickLine={false}
                                label={{ value: "Irradiation (kWh/m²)", angle: 90, position: "insideRight", dy: 56, fill: "#cbd5e1", fontSize: 11 }}
                              />
                              <Tooltip content={<RevealTooltip labelFormatter={formatMonthLabel} />} cursor={false} />
                              <Legend wrapperStyle={{ color: "#e2e8f0", fontSize: 12, paddingTop: 18 }} />
                              <Line yAxisId="left" type="monotone" dataKey="PR_pct" name="PR" stroke="#60a5fa" strokeWidth={2.4} dot={false} />
                              <Bar yAxisId="right" dataKey="irrad_kwh_m2" name="Irradiation" fill="rgba(245,158,11,0.75)" radius={[5, 5, 0, 0]} />
                            </ComposedChart>
                          </ResponsiveContainer>
                        </ChartShell>
                      </div>

                      <div className="mt-5 grid items-stretch gap-4 xl:grid-cols-2">
                        <ChartShell
                          title="Recoverable versus non-recoverable losses"
                          description="REVEAL converts the production gap into structured loss buckets. The recoverable side is where corrective actions should be prioritized first."
                        >
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={lossBreakdown} layout="vertical" margin={{ top: 10, right: 10, left: 54, bottom: 10 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-axis-grid)" horizontal={false} />
                              <XAxis
                                type="number"
                                tick={{ fill: "var(--chart-axis-text)", fontSize: 11 }}
                                axisLine={{ stroke: "var(--chart-axis-line)" }}
                                tickLine={false}
                                label={{ value: "Loss estimate (MWh)", position: "insideBottom", offset: -4, fill: "var(--chart-axis-text-strong)", fontSize: 11 }}
                              />
                              <YAxis
                                type="category"
                                dataKey="label"
                                width={170}
                                tick={{ fill: "var(--chart-axis-text)", fontSize: 11 }}
                                axisLine={false}
                                tickLine={false}
                              />
                              <Tooltip content={<RevealTooltip valueSuffix=" MWh" />} cursor={false} />
                              <Bar dataKey="value_mwh" radius={[0, 6, 6, 0]}>
                                {lossBreakdown.map((item, index) => (
                                  <Cell
                                    key={`${item.label}-${index}`}
                                    fill={
                                      item.classification === "recoverable"
                                        ? "rgba(88,176,255,0.88)"
                                        : item.classification === "screened"
                                          ? "rgba(239,68,68,0.85)"
                                          : "rgba(148,163,184,0.7)"
                                    }
                                  />
                                ))}
                              </Bar>
                            </BarChart>
                          </ResponsiveContainer>
                        </ChartShell>

                        <div className="rounded-[24px] border border-faint bg-[rgba(255,255,255,0.04)] p-5">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/55">Diagnosis commentary</p>
                          <div className="mt-4 space-y-3 text-sm leading-7 text-slate-200/84">
                            {(sectionCommentary.site?.length ? sectionCommentary.site : diagnosisCommentary).map((line, index) => (
                              <p key={`diagnosis-line-${index}`}>{line}</p>
                            ))}
                            <p>
                              Curtailment and negative-hour losses should still be confirmed against site records, dispatch instructions, and market context before they are treated as final recoverable values.
                            </p>
                          </div>
                        </div>
                      </div>

                      <div className="mt-5 grid items-stretch gap-4 xl:grid-cols-2">
                        <ChartShell
                          title="Site availability trend"
                          description="Availability is shown alongside the monthly production story so equipment downtime can be separated from pure resource-driven variation."
                        >
                          <ResponsiveContainer width="100%" height="100%">
                            <ComposedChart data={latestAvailabilityMonths} margin={{ top: 20, right: 10, left: 8, bottom: 16 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.12)" />
                              <XAxis
                                dataKey="month"
                                tick={{ fill: "#cbd5e1", fontSize: 11 }}
                                tickFormatter={formatMonthLabel}
                                axisLine={{ stroke: "rgba(255,255,255,0.16)" }}
                                tickLine={false}
                                label={{ value: "Month", position: "insideBottom", offset: -6, fill: "#cbd5e1", fontSize: 11 }}
                              />
                              <YAxis
                                domain={[0, 100]}
                                tick={{ fill: "#cbd5e1", fontSize: 11 }}
                                axisLine={{ stroke: "rgba(255,255,255,0.16)" }}
                                tickLine={false}
                                label={{ value: "Availability (%)", angle: -90, position: "insideLeft", dy: 60, fill: "var(--chart-axis-text-strong)", fontSize: 11 }}
                              />
                              <Tooltip content={<RevealTooltip labelFormatter={formatMonthLabel} valueSuffix="%" />} cursor={false} />
                              <Line type="monotone" dataKey="avail_pct" name="Availability" stroke="#34d399" strokeWidth={2.6} dot={false} />
                            </ComposedChart>
                          </ResponsiveContainer>
                        </ChartShell>

                        <MetricBars
                          title="Inverter specific yield ranking"
                          description="The chart highlights the top 2 and bottom 2 inverters so the spread is easy to read while keeping the section compact."
                          rows={yieldRanking.map((item) => ({
                            label: item.inv_id,
                            value: item.yield_kwh_kwp,
                            secondary: `${item.rank <= 2 ? "Top performer" : "Lowest performer"} · PR ${item.pr_pct.toFixed(1)}% · Rank ${item.rank}`,
                            tone: item.rank <= 2 ? "positive" : "negative",
                          }))}
                          valueSuffix=" kWh/kWp"
                        />
                      </div>

                      <div className="mt-5 grid items-stretch gap-4 xl:grid-cols-2">
                        <div className="rounded-[24px] border border-faint bg-[rgba(255,255,255,0.04)] p-5">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/55">Root causes and actions</p>
                          <div className="mt-4 space-y-3">
                            {sectionCommentary.losses?.map((line, index) => (
                              <div key={`loss-commentary-${index}`} className="rounded-2xl border border-weak bg-row px-4 py-3 text-sm leading-7 text-nav">
                                <div className="flex items-start gap-3">
                                  <span className="mt-2 inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-orange-DEFAULT" />
                                  <p>{line}</p>
                                </div>
                              </div>
                            ))}
                            {rootCauses.length > 0 ? (
                              rootCauses.map((item, index) => (
                                <div key={`${item.title}-${index}`} className="rounded-2xl border border-weak bg-row p-4">
                                  <div className="flex items-center gap-3">
                                    <span
                                      className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${
                                        item.recoverability === "recoverable"
                                          ? "border border-emerald-500/30 bg-emerald-500 text-white"
                                          : item.recoverability === "screened"
                                            ? "border border-red-500/30 bg-red-500 text-white"
                                            : "border border-slate-300/25 bg-slate-200 text-slate-700"
                                      }`}
                                    >
                                      {item.recoverability.replace("_", " ")}
                                    </span>
                                    <p className="font-semibold text-white">{item.title}</p>
                                  </div>
                                  {(item.impact_mwh || item.impact_eur || item.confidence) && (
                                    <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
                                      {item.impact_mwh ? (
                                        <span className="rounded-full border border-orange-400/30 bg-orange-100/90 px-3 py-1 text-orange-800 dark:border-orange-300/25 dark:bg-orange-400/10 dark:text-orange-200/80">
                                          {item.impact_mwh.toLocaleString()} MWh
                                        </span>
                                      ) : null}
                                      {item.impact_eur ? (
                                        <span className="rounded-full border border-orange-500/30 bg-orange-500 px-3 py-1 text-white">
                                          €{item.impact_eur.toLocaleString()}
                                        </span>
                                      ) : null}
                                      {item.confidence ? (
                                        <span className="rounded-full border border-sky-300/25 bg-sky-400/10 px-3 py-1 text-sky-100">
                                          {item.confidence} confidence
                                        </span>
                                      ) : null}
                                    </div>
                                  )}
                                  <p className="mt-3 text-sm leading-7 text-slate-200/84">{item.cause}</p>
                                  <p className="mt-2 text-sm leading-7 text-white/68">{item.action}</p>
                                </div>
                              ))
                            ) : (
                              <div className="rounded-2xl border border-weak bg-row p-4 text-sm text-slate-200/82">
                                  REVEAL has not yet isolated a clear root-cause chain from the current dataset.
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="rounded-[24px] border border-faint bg-[rgba(255,255,255,0.04)] p-5">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/55">Probable curtailment months</p>
                          <p className="mt-2 text-sm leading-7 text-slate-200/82">
                            These are months where irradiation stayed healthy and site availability remained high, but production still underperformed. They are the first periods to validate for curtailment, export limitation, or market-driven shutdown behaviour.
                          </p>
                          <div className="mt-4 space-y-3">
                            {curtailmentCandidates.length > 0 ? (
                              curtailmentCandidates.map((item) => (
                                <div key={item.month} className="rounded-2xl border border-weak bg-row p-4">
                                  <div className="flex items-center justify-between gap-3">
                                    <p className="font-semibold text-white">{formatMonthLabel(item.month)}</p>
                                    <span className="rounded-full border border-amber-300/25 bg-amber-400/12 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-50">
                                      {item.confidence} confidence
                                    </span>
                                  </div>
                                  <p className="mt-3 text-sm leading-7 text-slate-200/84">
                                    {item.loss_mwh.toFixed(1)} MWh suppressed with PR at {item.pr_pct.toFixed(1)}%, availability at {item.availability_pct.toFixed(1)}%, and irradiation at {item.irradiation_kwh_m2.toFixed(1)} kWh/m².
                                  </p>
                                  <p className="mt-2 text-sm leading-7 text-white/68">{item.reason}</p>
                                </div>
                              ))
                            ) : (
                              <div className="rounded-2xl border border-weak bg-row p-4 text-sm text-slate-200/82">
                                REVEAL did not isolate any strong curtailment months from the current dataset. That suggests losses may be driven more by downtime or broader underperformance than by export suppression.
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                      </AnalysisSection>

                      <AnalysisSection
                        id="Section C"
                        title="Inverter diagnostics"
                        description="MTTF, morning start behaviour, and clipping exposure for all inverters — ranked worst-first so underperformers are immediately visible."
                        collapsed={collapsedAnalysisSections.inverter}
                        onToggle={() => setCollapsedAnalysisSections((prev) => ({ ...prev, inverter: !prev.inverter }))}
                      >
                        <ChartShell
                          title="MTTF and start deviation — all inverters"
                          description="Bars show mean time between failures (h) on the left axis. The line shows absolute start-time deviation vs fleet mean (min) on the right. Inverters are sorted by MTTF, worst first."
                          heightClass="h-[360px]"
                        >
                          <ResponsiveContainer width="100%" height="100%">
                            <ComposedChart data={inverterDiagnostics} margin={{ top: 16, right: 48, left: 8, bottom: 64 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.12)" />
                              <XAxis
                                dataKey="inv_id"
                                tick={{ fill: "#cbd5e1", fontSize: 10 }}
                                axisLine={{ stroke: "rgba(255,255,255,0.16)" }}
                                tickLine={false}
                                angle={-35}
                                textAnchor="end"
                                interval={0}
                              />
                              <YAxis
                                yAxisId="left"
                                tick={{ fill: "#cbd5e1", fontSize: 11 }}
                                axisLine={{ stroke: "rgba(255,255,255,0.16)" }}
                                tickLine={false}
                                label={{ value: "MTTF (h)", angle: -90, position: "insideLeft", dy: 36, fill: "#cbd5e1", fontSize: 11 }}
                              />
                              <YAxis
                                yAxisId="right"
                                orientation="right"
                                tick={{ fill: "#cbd5e1", fontSize: 11 }}
                                axisLine={{ stroke: "rgba(255,255,255,0.16)" }}
                                tickLine={false}
                                label={{ value: "Start dev (min)", angle: 90, position: "insideRight", dy: -36, fill: "#cbd5e1", fontSize: 11 }}
                              />
                              <Tooltip content={<RevealTooltip />} cursor={false} />
                              <Legend wrapperStyle={{ color: "#e2e8f0", fontSize: 12, paddingTop: 8 }} />
                              <Bar yAxisId="left" dataKey="mttf_hours" name="MTTF (h)" fill="rgba(251,146,60,0.78)" radius={[4, 4, 0, 0]} />
                              <Line yAxisId="right" type="monotone" dataKey="start_dev_abs" name="Start dev (min)" stroke="#60a5fa" strokeWidth={2.2} dot={{ r: 3, fill: "#60a5fa" }} />
                            </ComposedChart>
                          </ResponsiveContainer>
                        </ChartShell>

                        <div className="mt-4 grid items-stretch gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(280px,0.9fr)]">
                          <ChartShell
                            title="Per-inverter specific yield heat map"
                            description="Monthly normalized output in kWh/kWp per inverter. Lower-yield months stand out immediately so persistent underperformers are easy to isolate before drilling into faults or clipping."
                            heightClass="h-auto"
                          >
                            <SpecificYieldHeatmap data={specificYieldHeatmapRows} />
                          </ChartShell>

                          <div className="flex h-full flex-col rounded-[24px] border border-faint bg-panel p-5">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/55">Commentary</p>
                            <p className="mt-2 text-sm leading-7 text-slate-200/82">
                              REVEAL reads the heat map for persistent laggards, seasonal fleet patterns, and isolated low-yield months that deserve follow-up.
                            </p>
                            <div className="mt-5 flex-1 space-y-3">
                              {(sectionCommentary.inverter?.length || specificYieldHeatmapInsights.length) > 0 ? (
                                [...(sectionCommentary.inverter ?? []), ...specificYieldHeatmapInsights].map((line, index) => (
                                  <div key={`specific-yield-insight-${index}`} className="rounded-2xl border border-weak bg-row px-4 py-3 text-sm leading-7 text-nav">
                                    <div className="flex items-start gap-3">
                                      <span className="mt-2 inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-orange-DEFAULT" />
                                      <p>{line}</p>
                                    </div>
                                  </div>
                                ))
                              ) : (
                                <div className="rounded-2xl border border-weak bg-row px-4 py-3 text-sm leading-7 text-nav">
                                  Inverter-specific observations will appear here once monthly normalized yield values are available across the fleet.
                                </div>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="mt-4 grid gap-4 xl:grid-cols-2">
                          <ChartShell
                            title="Near-clipping frequency by irradiance bin"
                            description="Shows how often the site approaches its AC ceiling across irradiance bands. High values in the upper bins indicate the DC array regularly saturates the inverters."
                          >
                            <ResponsiveContainer width="100%" height="100%">
                              <BarChart data={clippingBins} margin={{ top: 20, right: 10, left: 8, bottom: 28 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.12)" />
                                <XAxis
                                  dataKey="label"
                                  tick={{ fill: "#cbd5e1", fontSize: 11 }}
                                  axisLine={{ stroke: "rgba(255,255,255,0.16)" }}
                                  tickLine={false}
                                  label={{ value: "Irradiance bin (W/m²)", position: "insideBottom", offset: -10, fill: "#cbd5e1", fontSize: 11 }}
                                />
                                <YAxis
                                  tick={{ fill: "#cbd5e1", fontSize: 11 }}
                                  axisLine={{ stroke: "rgba(255,255,255,0.16)" }}
                                  tickLine={false}
                                  label={{ value: "Near-clip (%)", angle: -90, position: "insideLeft", dy: 44, fill: "#cbd5e1", fontSize: 11 }}
                                />
                                <Tooltip content={<RevealTooltip valueSuffix="%" />} cursor={false} />
                                <Bar dataKey="near_clip_pct" name="Near-clipping" fill="rgba(245,158,11,0.82)" radius={[5, 5, 0, 0]} />
                              </BarChart>
                            </ResponsiveContainer>
                          </ChartShell>

                          <ChartShell
                            title="Near-clipping occurrence — per inverter"
                            description="Inverters most frequently operating near their AC ceiling. Units at the top are candidates for DC/AC ratio review or export-limit investigation."
                          >
                            <ResponsiveContainer width="100%" height="100%">
                              <BarChart
                                data={[...clippingInverters].sort((a, b) => b.near_clip_pct - a.near_clip_pct)}
                                layout="vertical"
                                margin={{ top: 8, right: 24, left: 8, bottom: 8 }}
                              >
                                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.12)" />
                                <XAxis
                                  type="number"
                                  tick={{ fill: "#cbd5e1", fontSize: 11 }}
                                  axisLine={{ stroke: "rgba(255,255,255,0.16)" }}
                                  tickLine={false}
                                  label={{ value: "Near-clip (%)", position: "insideBottom", offset: -4, fill: "#cbd5e1", fontSize: 11 }}
                                />
                                <YAxis
                                  type="category"
                                  dataKey="inv_id"
                                  width={64}
                                  tick={{ fill: "#cbd5e1", fontSize: 10 }}
                                  axisLine={{ stroke: "rgba(255,255,255,0.16)" }}
                                  tickLine={false}
                                />
                                <Tooltip content={<RevealTooltip valueSuffix="%" />} cursor={false} />
                                <Bar dataKey="near_clip_pct" name="Near-clipping %" fill="rgba(245,158,11,0.82)" radius={[0, 4, 4, 0]} />
                              </BarChart>
                            </ResponsiveContainer>
                          </ChartShell>
                        </div>
                      </AnalysisSection>

                      <AnalysisSection
                        id="Section D"
                        title="Loss deep-dive and recovery actions"
                        description="Each loss category is expressed in energy and approximate value at the confirmed site tariff, with a specific action so recoverable losses can be prioritized clearly."
                        collapsed={collapsedAnalysisSections.actions}
                        onToggle={() => setCollapsedAnalysisSections((prev) => ({ ...prev, actions: !prev.actions }))}
                      >
                        <div className="rounded-[24px] border border-faint bg-[rgba(255,255,255,0.04)] p-5">
                          <div className="mt-2 overflow-x-auto">
                            <table className="min-w-full border-separate border-spacing-y-3 text-sm">
                              <thead>
                                <tr className="text-left text-[11px] uppercase tracking-[0.18em] text-nav">
                                  <th className="px-3 py-2">Loss category</th>
                                  <th className="px-3 py-2">Class</th>
                                  <th className="px-3 py-2">MWh</th>
                                  <th className="px-3 py-2">kEUR</th>
                                  <th className="px-3 py-2">Specific action</th>
                                </tr>
                              </thead>
                              <tbody>
                                {lossActionRows.map((item) => (
                                  <tr key={item.label} className="align-top text-nav-active">
                                    <td className="rounded-l-2xl border-y border-l border-weak bg-row px-3 py-3 font-semibold text-nav-active">
                                      <div className="flex items-center gap-2">
                                        {item.color && (
                                          <span className="inline-block h-3 w-3 shrink-0 rounded-full" style={{ background: item.color }} />
                                        )}
                                        {item.label}
                                      </div>
                                    </td>
                                    <td className="border-y border-weak bg-row px-3 py-3">
                                      <span
                                        className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${
                                          item.classification === "recoverable"
                                            ? "border border-emerald-400/30 bg-emerald-300 text-emerald-950"
                                          : item.classification === "screened"
                                              ? "border border-red-400/30 bg-red-500 text-white"
                                              : "border border-slate-300/25 bg-slate-200 text-slate-700"
                                        }`}
                                      >
                                        {item.classification.replace("_", " ")}
                                      </span>
                                    </td>
                                    <td className="border-y border-weak bg-row px-3 py-3 font-semibold tabular-nums">{item.value_mwh.toFixed(1)}</td>
                                    <td className="border-y border-weak bg-row px-3 py-3 font-semibold tabular-nums">{item.value_keur.toFixed(1)}</td>
                                    <td className="rounded-r-2xl border-y border-r border-weak bg-row px-3 py-3 leading-7 text-nav">{item.action}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <p className="mt-3 text-xs leading-6 text-nav">
                            MWh losses are derived from the weather-corrected production gap and then split into diagnosis buckets such as inverter downtime, curtailment, clipping, soiling, and string mismatch. Euro values are a direct conversion of each bucket using the confirmed site tariff.
                          </p>
                          <p className="mt-2 text-xs leading-6 text-nav">
                            Value conversion uses the confirmed site tariff of {tariffEurMwh.toFixed(1)} EUR/MWh. This is a first-order owner view — not yet a price-shape or market-dispatch valuation. Recoverable losses are the primary target for the digital-twin pass.
                          </p>
                        </div>
                      </AnalysisSection>

                      <AnalysisSection
                        id="Section E"
                        title="Performance trend and event overlay annex"
                        description="This annex carries the longer-form analytical views for drift, instability, and event clustering so they can be reviewed directly in REVEAL."
                        collapsed={collapsedAnalysisSections.losses}
                        onToggle={() => setCollapsedAnalysisSections((prev) => ({ ...prev, losses: !prev.losses }))}
                      >
                        <div className="grid gap-4 xl:grid-cols-2">
                          <ChartShell
                            title="Annual PR trend"
                            description="This view tracks annual PR across the analysed period so drift can be identified before it is mistaken for true degradation."
                          >
                            <ResponsiveContainer width="100%" height="100%">
                              <ComposedChart data={degradationTrendRows} margin={{ top: 20, right: 10, left: 8, bottom: 30 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.12)" />
                                <XAxis dataKey="year" tick={{ fill: "#cbd5e1", fontSize: 11 }} axisLine={{ stroke: "rgba(255,255,255,0.16)" }} tickLine={false} label={{ value: "Year", position: "insideBottom", offset: -6, fill: "#cbd5e1", fontSize: 11 }} />
                                <YAxis yAxisId="left" tick={{ fill: "#cbd5e1", fontSize: 11 }} axisLine={{ stroke: "rgba(255,255,255,0.16)" }} tickLine={false} label={{ value: "PR (%)", angle: -90, position: "insideLeft", dy: 60, fill: "#cbd5e1", fontSize: 11 }} />
                                <YAxis yAxisId="right" orientation="right" tick={{ fill: "#cbd5e1", fontSize: 11 }} axisLine={{ stroke: "rgba(255,255,255,0.16)" }} tickLine={false} label={{ value: "Energy (MWh)", angle: 90, position: "insideRight", dy: 56, fill: "#cbd5e1", fontSize: 11 }} />
                                <Tooltip content={<RevealTooltip />} cursor={false} />
                                <Legend wrapperStyle={{ color: "#e2e8f0", fontSize: 12, paddingTop: 18 }} />
                                <Line yAxisId="left" type="monotone" dataKey="pr_pct" name="Annual PR" stroke="#60a5fa" strokeWidth={2.6} dot />
                                <Bar yAxisId="right" dataKey="energy_mwh" name="Annual energy" fill="rgba(34,197,94,0.7)" radius={[5, 5, 0, 0]} />
                              </ComposedChart>
                            </ResponsiveContainer>
                          </ChartShell>

                          <ChartShell
                            title="Monthly event overlay"
                            description="This overlay combines PR, availability, missing data, frozen data, and probable curtailment. It is designed to show when multiple warning signals stack up in the same month."
                          >
                            <ResponsiveContainer width="100%" height="100%">
                              <ComposedChart data={monthlyTimelineRows} margin={{ top: 20, right: 10, left: 8, bottom: 30 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.12)" />
                                <XAxis dataKey="month" tick={{ fill: "#cbd5e1", fontSize: 11 }} tickFormatter={formatMonthLabel} axisLine={{ stroke: "rgba(255,255,255,0.16)" }} tickLine={false} label={{ value: "Month", position: "insideBottom", offset: -6, fill: "#cbd5e1", fontSize: 11 }} />
                                <YAxis yAxisId="left" domain={[0, 100]} tick={{ fill: "#cbd5e1", fontSize: 11 }} axisLine={{ stroke: "rgba(255,255,255,0.16)" }} tickLine={false} label={{ value: "Percent (%)", angle: -90, position: "insideLeft", dy: 60, fill: "#cbd5e1", fontSize: 11 }} />
                                <YAxis yAxisId="right" orientation="right" tick={{ fill: "#cbd5e1", fontSize: 11 }} axisLine={{ stroke: "rgba(255,255,255,0.16)" }} tickLine={false} label={{ value: "Curtailment (MWh)", angle: 90, position: "insideRight", dy: 56, fill: "#cbd5e1", fontSize: 11 }} />
                                <Tooltip content={<RevealTooltip labelFormatter={formatMonthLabel} />} cursor={false} />
                                <Legend wrapperStyle={{ color: "#e2e8f0", fontSize: 12, paddingTop: 18 }} />
                                <Line yAxisId="left" type="monotone" dataKey="pr_pct" name="PR" stroke="#60a5fa" strokeWidth={2.2} dot={false} />
                                <Line yAxisId="left" type="monotone" dataKey="availability_pct" name="Availability" stroke="#34d399" strokeWidth={2.2} dot={false} />
                                <Bar yAxisId="left" dataKey="missing_pct" name="Missing data" fill="rgba(244,114,182,0.58)" radius={[4, 4, 0, 0]} />
                                <Bar yAxisId="left" dataKey="frozen_pct" name="Frozen data" fill="rgba(220,38,38,0.72)" radius={[4, 4, 0, 0]} />
                                <Bar yAxisId="right" dataKey="curtailment_mwh" name="Curtailment candidate" fill="rgba(245,158,11,0.72)" radius={[4, 4, 0, 0]} />
                              </ComposedChart>
                            </ResponsiveContainer>
                          </ChartShell>
                        </div>
                      </AnalysisSection>

                      <AnalysisSection
                        id="Section F"
                        title="Data quality and analytical assumptions"
                        description="Input data completeness, screened anomalies, and the key assumptions behind the current diagnosis. Use this to judge how much weight to place on each loss bucket."
                        collapsed={collapsedAnalysisSections.availability}
                        onToggle={() => setCollapsedAnalysisSections((prev) => ({ ...prev, availability: !prev.availability }))}
                      >
                        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
                          <div className="rounded-[20px] border border-faint bg-[rgba(255,255,255,0.04)] p-4">
                            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-white/45">Power completeness</p>
                            <p className={`mt-3 text-2xl font-bold tabular-nums ${(analysisResult?.data_quality.overall_power_pct ?? 0) >= 90 ? "text-emerald-300" : (analysisResult?.data_quality.overall_power_pct ?? 0) >= 75 ? "text-amber-300" : "text-rose-300"}`}>
                              {analysisResult?.data_quality.overall_power_pct.toFixed(1) ?? "—"}%
                            </p>
                            <p className="mt-1 text-xs text-white/45">of daytime window covered</p>
                          </div>
                          <div className="rounded-[20px] border border-faint bg-[rgba(255,255,255,0.04)] p-4">
                            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-white/45">Irradiance completeness</p>
                            <p className={`mt-3 text-2xl font-bold tabular-nums ${(analysisResult?.data_quality.irradiance_pct ?? 0) >= 90 ? "text-emerald-300" : (analysisResult?.data_quality.irradiance_pct ?? 0) >= 75 ? "text-amber-300" : "text-rose-300"}`}>
                              {analysisResult?.data_quality.irradiance_pct.toFixed(1) ?? "—"}%
                            </p>
                            <p className="mt-1 text-xs text-white/45">GHI signal available</p>
                          </div>
                          <div className="rounded-[20px] border border-faint bg-[rgba(255,255,255,0.04)] p-4">
                            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-white/45">Frozen inverter streams</p>
                            <p className={`mt-3 text-2xl font-bold tabular-nums ${(analysisResult?.data_quality.stuck_inverters_count ?? 0) === 0 ? "text-emerald-300" : "text-amber-300"}`}>
                              {analysisResult?.data_quality.stuck_inverters_count ?? 0}
                            </p>
                            <p className="mt-1 text-xs text-white/45">screened before diagnosis</p>
                          </div>
                          <div className="rounded-[20px] border border-faint bg-[rgba(255,255,255,0.04)] p-4">
                            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-white/45">ERA precipitation</p>
                            <p className={`mt-3 text-2xl font-bold ${analysisResult?.weather.error ? "text-rose-300" : "text-emerald-300"}`}>
                              {analysisResult?.weather.error ? "Error" : "Loaded"}
                            </p>
                            <p className="mt-1 text-xs text-white/45">
                              {analysisResult?.weather.error ? "rain context unavailable" : `${weatherEvents.length} event${weatherEvents.length === 1 ? "" : "s"} detected`}
                            </p>
                          </div>
                        </div>
                        <div className="mt-4 space-y-3">
                          {dataLimitations.map((line, index) => (
                            <div key={`limitation-${index}`} className="rounded-2xl border border-weak bg-row p-4 text-sm leading-7 text-slate-200/84">
                              {line}
                            </div>
                          ))}
                          <div className="rounded-2xl border border-weak bg-row p-4 text-sm leading-7 text-slate-200/84">
                            REVEAL uses the measured on-site irradiance directly for PR and loss calculation. Irradiance-reference correlation against satellite data (ERA5, SARAH-3) lives in the Long-Term Modelling workflow and is not yet embedded in the performance diagnosis.
                          </div>
                        </div>
                      </AnalysisSection>

                      <AnalysisSection
                        id="Section G"
                        title="Comprehensive punchlist and priority actions"
                        description="This is the end-of-report action register. It consolidates the main issues REVEAL sees across weather, monthly performance, inverter diagnostics, losses, and data quality so the owner can move directly from diagnosis to action."
                        collapsed={collapsedAnalysisSections.punchlist}
                        onToggle={() => setCollapsedAnalysisSections((prev) => ({ ...prev, punchlist: !prev.punchlist }))}
                      >
                        <div className="rounded-[24px] border border-faint bg-row p-5">
                          <div className="flex flex-wrap items-center justify-between gap-4">
                            <div>
                              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-nav">Priority summary</p>
                              <p className="mt-2 text-sm leading-7 text-nav">
                                REVEAL has converted the chart evidence into a ranked action list. Start with the red items, then move to orange items once the highest-impact recovery actions are in motion.
                              </p>
                            </div>
                            <div className="flex flex-wrap gap-2 text-xs font-semibold">
                              <span className="rounded-full border border-rose-500/30 bg-rose-500 px-3 py-1 text-white">
                                {comprehensivePunchlistCounts.high} high priority
                              </span>
                              <span className="rounded-full border border-orange-500/30 bg-orange-500 px-3 py-1 text-white">
                                {comprehensivePunchlistCounts.medium} medium priority
                              </span>
                              <span className="rounded-full border border-yellow-400/40 bg-yellow-300 px-3 py-1 text-slate-950">
                                {comprehensivePunchlistCounts.low} minor issues
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="mt-5 overflow-x-auto rounded-[24px] border border-faint bg-row">
                          {comprehensivePunchlist.length > 0 ? (
                            <table className="min-w-full text-left text-sm text-nav">
                              <thead className="bg-panel text-[11px] uppercase tracking-[0.18em] text-nav/70">
                                <tr className="border-b border-weak">
                                  <th className="px-3 py-3 font-semibold">Priority</th>
                                  <th className="px-3 py-3 font-semibold">Category</th>
                                  <th className="px-3 py-3 font-semibold text-right">Est. loss</th>
                                  <th className="px-3 py-3 font-semibold text-right">Est. value</th>
                                  <th className="px-3 py-3 font-semibold">Issue</th>
                                  <th className="px-3 py-3 font-semibold">Recommended action</th>
                                </tr>
                              </thead>
                              <tbody>
                                {comprehensivePunchlist.map((item) => (
                                  <tr key={item.id} className={`border-b border-weak/70 align-top last:border-b-0 ${priorityCardClass(item.priority)}`}>
                                    <td className="px-3 py-3">
                                      <span className={`rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] ${priorityBadgeClass(item.priority)}`}>
                                        {item.priority}
                                      </span>
                                    </td>
                                    <td className="px-3 py-3 font-medium text-nav-active">{item.category}</td>
                                    <td className="px-3 py-3 text-right tabular-nums">{(item.impact_mwh ?? 0) > 0 ? item.impact_mwh?.toLocaleString() : "—"}</td>
                                    <td className="px-3 py-3 text-right tabular-nums">{(item.impact_eur ?? 0) > 0 ? `€${item.impact_eur?.toLocaleString()}` : "—"}</td>
                                    <td className="px-3 py-3">
                                      <div className="font-semibold text-nav-active">{item.title}</div>
                                      <div className="mt-1 text-nav/90">{item.finding}</div>
                                    </td>
                                    <td className="px-3 py-3 text-nav/90">{item.recommendation}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          ) : (
                            <div className="p-4 text-sm leading-7 text-nav">
                              REVEAL has not yet isolated any section-level actions from the current dataset.
                            </div>
                          )}
                        </div>
                      </AnalysisSection>

                      <AnalysisSection
                        id="Technology Risk"
                        title="Technology risk register"
                        description="Focused module and inverter watch-list based on the technology configured for this site. If REVEAL has not reviewed the configured technology yet, that gap is stated explicitly below."
                        collapsed={collapsedAnalysisSections.technology}
                        onToggle={() => setCollapsedAnalysisSections((prev) => ({ ...prev, technology: !prev.technology }))}
                      >
                        <div className="grid gap-5">
                          <div className="grid gap-4 xl:grid-cols-2">
                            {technologyRiskRegister.coverage.map((item) => (
                              <div key={item.kind} className="rounded-[24px] border border-faint bg-row p-5">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                  <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-nav">{item.kind} coverage</p>
                                  <span
                                    className={`rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] ${
                                      item.reviewed
                                        ? "border border-emerald-400/30 bg-emerald-300 text-emerald-950"
                                        : "border border-amber-400/30 bg-amber-300 text-slate-950"
                                    }`}
                                  >
                                    {item.reviewed ? "Reviewed" : "Not reviewed"}
                                  </span>
                                </div>
                                <p className="mt-3 text-base font-semibold text-nav-active">{item.descriptor}</p>
                                <p className="mt-2 text-sm leading-7 text-nav/90">{item.note}</p>
                              </div>
                            ))}
                          </div>

                          {technologyRiskRegister.rows.length > 0 ? (
                            <div className="overflow-x-auto rounded-[24px] border border-faint bg-row">
                              <table className="min-w-full text-left text-sm text-nav">
                                <thead className="bg-panel text-[11px] uppercase tracking-[0.18em] text-nav/70">
                                  <tr className="border-b border-weak">
                                    <th className="px-3 py-3 font-semibold">Priority</th>
                                    <th className="px-3 py-3 font-semibold">Focus</th>
                                    <th className="px-3 py-3 font-semibold">Equipment</th>
                                    <th className="px-3 py-3 font-semibold">Risk / what to watch</th>
                                    <th className="px-3 py-3 font-semibold">Diagnostic / action</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {technologyRiskRegister.rows.map((row, index) => (
                                    <tr key={`${row.equipment}-${index}`} className="border-b border-weak/70 align-top last:border-b-0">
                                      <td className="px-3 py-3">
                                        <span className={`rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] ${technologyPriorityBadgeClass(row.priority)}`}>
                                          {row.priority}
                                        </span>
                                      </td>
                                      <td className="px-3 py-3 font-medium text-nav-active">{row.focus}</td>
                                      <td className="px-3 py-3 font-medium text-nav-active">{row.equipment}</td>
                                      <td className="px-3 py-3 text-nav/90">{row.risk}</td>
                                      <td className="px-3 py-3 text-nav/90">{row.action}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ) : (
                            <div className="rounded-[24px] border border-faint bg-row p-5 text-sm leading-7 text-nav/90">
                              REVEAL does not yet have a reviewed module or inverter technology profile for this site, so no technology-specific risk rows can be shown in-app yet.
                            </div>
                          )}
                        </div>
                      </AnalysisSection>

                      <AnalysisSection
                        id="Appendix"
                        title="Appendix - analytical scope and data limitations"
                        description="Summary of the analytical scope completed for this assessment and the principal data constraints affecting interpretation."
                        collapsed={collapsedAnalysisSections.appendix}
                        onToggle={() => setCollapsedAnalysisSections((prev) => ({ ...prev, appendix: !prev.appendix }))}
                      >
                        <div className="grid gap-5">
                          <div className="rounded-[24px] border border-faint bg-row p-5">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-nav">Analytical scope completed</p>
                            <div className="mt-4 overflow-x-auto">
                              <table className="min-w-full text-left text-sm text-nav">
                                <thead className="text-[11px] uppercase tracking-[0.18em] text-nav/70">
                                  <tr className="border-b border-weak">
                                    <th className="px-3 py-3 font-semibold">Activity</th>
                                    <th className="px-3 py-3 font-semibold">Status</th>
                                    <th className="px-3 py-3 font-semibold">Notes</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {appendixScopeRows.map((row) => (
                                    <tr key={row.activity} className="border-b border-weak/70 align-top last:border-b-0">
                                      <td className="px-3 py-3 font-medium text-nav-active">{row.activity}</td>
                                      <td className="px-3 py-3">{row.status}</td>
                                      <td className="px-3 py-3 text-nav/90">{row.notes}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>

                          <div className="rounded-[24px] border border-faint bg-row p-5">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-nav">Analytical constraints</p>
                            <div className="mt-4 overflow-x-auto">
                              <table className="min-w-full text-left text-sm text-nav">
                                <thead className="text-[11px] uppercase tracking-[0.18em] text-nav/70">
                                  <tr className="border-b border-weak">
                                    <th className="px-3 py-3 font-semibold">Analysis</th>
                                    <th className="px-3 py-3 font-semibold">Status</th>
                                    <th className="px-3 py-3 font-semibold">Notes</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {appendixConstraintRows.map((row) => (
                                    <tr key={row.analysis} className="border-b border-weak/70 align-top last:border-b-0">
                                      <td className="px-3 py-3 font-medium text-nav-active">{row.analysis}</td>
                                      <td className="px-3 py-3">{row.status}</td>
                                      <td className="px-3 py-3 text-nav/90">{row.notes}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>

                          <div className="rounded-[24px] border border-faint bg-row p-5">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-nav">Priority action snapshot</p>
                            <div className="mt-4 overflow-x-auto">
                              <table className="min-w-full text-left text-sm text-nav">
                                <thead className="text-[11px] uppercase tracking-[0.18em] text-nav/70">
                                  <tr className="border-b border-weak">
                                    <th className="px-3 py-3 font-semibold">Priority</th>
                                    <th className="px-3 py-3 font-semibold">Category</th>
                                    <th className="px-3 py-3 font-semibold">Estimated loss</th>
                                    <th className="px-3 py-3 font-semibold">Recommended action</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {appendixPriorityRows.length > 0 ? (
                                    appendixPriorityRows.map((row) => (
                                      <tr key={row.id} className="border-b border-weak/70 align-top last:border-b-0">
                                        <td className="px-3 py-3 font-medium text-nav-active">{row.priority}</td>
                                        <td className="px-3 py-3">{row.category}</td>
                                        <td className="px-3 py-3">{row.estimatedLoss}</td>
                                        <td className="px-3 py-3 text-nav/90">{row.recommendedAction}</td>
                                      </tr>
                                    ))
                                  ) : (
                                    <tr>
                                      <td className="px-3 py-3 text-nav/90" colSpan={4}>
                                        REVEAL has not yet generated enough ranked actions to populate the appendix snapshot for this run.
                                      </td>
                                    </tr>
                                  )}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </div>
                      </AnalysisSection>
                    </>
                  ) : analysisLaunched && isRunningAnalysis ? (
                    <div className="mt-4 rounded-[22px] border border-sky-300/20 bg-sky-400/10 p-4 text-sm leading-7 text-sky-900 dark:text-sky-50">
                      REVEAL is preparing the diagnosis now. The KPI cards, executive summary, and punchlist will appear here once the analysis finishes.
                    </div>
                  ) : assumptionsConfirmed ? (
                    <div className="mt-4 rounded-[22px] border border-violet-300/20 bg-violet-400/10 p-4 text-sm leading-7 text-violet-900 dark:text-violet-50">
                      Step 3 is confirmed. Hit <span className="font-semibold text-violet-950 dark:text-white">Launch analysis</span> above to reveal the full Step 4 diagnosis.
                    </div>
                  ) : analysisError ? (
                    <div className="mt-4 rounded-[22px] border border-amber-300/20 bg-amber-400/10 p-4 text-sm leading-7 text-amber-50">
                      REVEAL could not prepare the diagnosis for this run. You can retry the live analysis or continue with the export.
                      <div className="mt-4">
                        <Button variant="secondary" onClick={requestPreview} disabled={isRunningAnalysis}>
                          Retry live diagnosis
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-4 rounded-[22px] border border-faint bg-[rgba(255,255,255,0.04)] p-4 text-sm leading-7 text-slate-200/84">
                      REVEAL will surface the executive summary, KPIs, and improvement punchlist here once Step 3 is confirmed and the live diagnosis completes.
                    </div>
                  )}
                </div>

                <div className="space-y-4">
                  <div className="rounded-[24px] border border-faint bg-panel p-5 backdrop-blur-sm">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/55">Summary export</p>
                    <div className="mt-4 space-y-3 text-sm leading-7 text-slate-200/84">
                      <p>Generate the client-ready site performance report once you are happy with the live diagnosis shown in-app.</p>
                      <p>The export uses the same mapped inputs, site context, and analysis depth as the live diagnosis, and follows the SCADA analysis report structure already used in the existing reference deliverable.</p>
                      <p>For now, REVEAL exports the report as HTML so the full structured analysis can still be reviewed and shared without relying on server-side PDF rendering.</p>
                    </div>

                    {exportError ? (
                      <div className="mt-4 rounded-2xl border border-red-300/35 bg-red-500/10 px-4 py-4 text-sm leading-7 text-red-800">
                        {exportError}
                      </div>
                    ) : null}

                    {!jobId ? (
                      <div className="mt-5">
                        <Button
                          variant="primary"
                          size="lg"
                          className="rounded-2xl"
                          loading={submitting}
                          disabled={files.length === 0 || !assumptionsConfirmed}
                          onClick={handleGenerate}
                        >
                          Generate export
                        </Button>
                      </div>
                    ) : null}
                  </div>

                  <div className="rounded-[24px] border border-faint bg-panel p-5 backdrop-blur-sm">
                    {jobId ? (
                      <>
                        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.24em] text-white/48">Job progress</p>
                        <p className="mb-4 text-xs leading-6 text-white/55">Job ID {jobId}</p>
                        <ReportProgress jobId={jobId} />
                      </>
                    ) : directExport ? (
                      <div className="space-y-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/48">
                          {directExport.status === "complete" ? "Export ready" : directExport.status === "error" ? "Export failed" : "Generating export"}
                        </p>
                        <div className="space-y-2">
                          <div className="flex items-center justify-between text-sm">
                            <span className="progress-copy">{directExport.message}</span>
                            <span className="progress-pill rounded-full px-3 py-1 text-sm font-semibold">{directExport.progress}%</span>
                          </div>
                          <div className="progress-track h-2 w-full overflow-hidden rounded-full">
                            <div
                              className="progress-fill h-full rounded-full transition-all duration-500"
                              style={{ width: `${directExport.progress}%` }}
                            />
                          </div>
                        </div>
                        {directExport.status === "complete" ? (
                          <div className="flex flex-wrap gap-2">
                            {directExport.htmlUrl ? (
                              <a href={directExport.htmlUrl} download={directExport.htmlFilename} className="inline-block">
                                <Button variant="primary" size="sm">
                                  Download HTML
                                </Button>
                              </a>
                            ) : null}
                          </div>
                        ) : null}
                        {directExport.error ? (
                          <p className="text-xs leading-6 text-amber-700">{directExport.error}</p>
                        ) : null}
                      </div>
                    ) : analysisResult ? (
                      <div className="space-y-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/48">Export ready</p>
                        <p className="text-sm leading-7 text-slate-200/84">
                          The live diagnosis is complete. Click <span className="font-semibold text-white">Generate export</span> to create the downloadable HTML report for this run.
                        </p>
                      </div>
                    ) : analysisLaunched && isRunningAnalysis ? (
                      <div className="space-y-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/48">Waiting for analysis</p>
                        <p className="text-sm leading-7 text-slate-200/84">
                          Export will unlock once the live Step 4 diagnosis finishes building.
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/48">Ready to run</p>
                        <p className="text-sm leading-7 text-slate-200/84">
                          Confirm Step 3, launch the live analysis, then generate the export. REVEAL will stream the export progress here and unlock the download buttons once complete.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </WorkflowPanel>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function GenerateReportPage({ params }: { params: { siteId: string } }) {
  return (
    <Suspense fallback={<p className="px-8 py-8 text-sm text-slate-400">Loading performance workflow…</p>}>
      <GenerateReportPageContent params={params} />
    </Suspense>
  );
}
