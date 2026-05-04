"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDropzone } from "react-dropzone";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BackLink } from "@/components/layout/BackLink";
import { Button } from "@/components/ui/Button";
import { useColumnDetect } from "@/hooks/useAnalysis";
import { fetchChartingReferenceIrradiance, getChartingDateRange, runCharting } from "@/lib/python-client";
import { useSite, useSites } from "@/hooks/useSites";
import type { ColumnDetectionResult } from "@/types/analysis";
import type { ChartingReferenceIrradianceResult, ChartingResult, ChartingResultRow, ChartingSeriesConfig } from "@/types/charting";

type SeriesDraft = ChartingSeriesConfig & { id: string };
type ConfirmedInverterMapping = Record<string, string>;
type PlotOption = {
  key: string;
  column: string;
  label: string;
  unit?: string;
  sourceColumn?: string;
  derivedMetric?: "specific_yield";
  capacityKwp?: number;
};

const DEFAULT_COLORS = ["#60a5fa", "#F39200", "#34d399", "#f472b6", "#a78bfa", "#f5b942"];
const REFERENCE_IRRADIANCE_COLUMN = "reference_irradiance_era5_land";
const REFERENCE_IRRADIANCE_SOURCE = "__reference_irradiance__";

function getChartingMappingStorageKey(siteId: string) {
  return `reveal-charting-inverter-mapping-v1-${siteId}`;
}

function getAutoColor(index: number) {
  if (index < DEFAULT_COLORS.length) return DEFAULT_COLORS[index];
  const hue = Math.round((index * 137.508) % 360);
  return `hsl(${hue} 72% 58%)`;
}

function formatDateRange(range?: [string, string] | null) {
  if (!range?.[0] || !range?.[1]) return "Date range will appear once REVEAL has analysed the upload.";
  const normalize = (value: string) => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return `${parsed.getFullYear()}-${`${parsed.getMonth() + 1}`.padStart(2, "0")}-${`${parsed.getDate()}`.padStart(2, "0")}`;
  };
  return `${normalize(range[0])} to ${normalize(range[1])}`;
}

function diffDays(start: string, end: string) {
  if (!start || !end) return 0;
  const startDate = parseDateValue(start);
  const endDate = parseDateValue(end);
  const startTs = startDate?.getTime() ?? Number.NaN;
  const endTs = endDate?.getTime() ?? Number.NaN;
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) return 0;
  return Math.max((endTs - startTs) / (1000 * 60 * 60 * 24), 0);
}

function getZonedDateParts(date: Date, timeZone?: string) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const lookup = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    dayMonth: `${lookup.day ?? ""} ${lookup.month ?? ""}`.trim(),
    time: `${lookup.hour ?? "00"}:${lookup.minute ?? "00"}`,
    hour: Number(lookup.hour ?? "0"),
    minute: Number(lookup.minute ?? "0"),
  };
}

function formatAdaptiveTimeLabel(value: string, rangeDays: number, timeZone?: string) {
  const ts = new Date(String(value));
  if (Number.isNaN(ts.getTime())) return String(value);
  const zoned = getZonedDateParts(ts, timeZone);
  if (rangeDays <= 1.5) {
    const isMidnight = zoned.hour === 0 && zoned.minute === 0;
    if (isMidnight) {
      return `${zoned.dayMonth}\n00:00`;
    }
    return zoned.time;
  }
  if (rangeDays <= 7) {
    const isMidnight = zoned.hour === 0 && zoned.minute === 0;
    if (isMidnight) {
      return `${zoned.dayMonth}\n00:00`;
    }
    if (zoned.hour % 3 === 0 && zoned.minute === 0) {
      return zoned.time;
    }
    return "";
  }
  if (rangeDays <= 45) {
    return zoned.dayMonth;
  }
  if (rangeDays <= 400) {
    return new Intl.DateTimeFormat("en-GB", { timeZone, month: "short", year: "2-digit" }).format(ts);
  }
  return new Intl.DateTimeFormat("en-GB", { timeZone, month: "short", year: "numeric" }).format(ts);
}

function inferUnit(column: string, label?: string) {
  const text = `${column} ${label ?? ""}`.toLowerCase();
  if (/specific[_\s-]?yield|kwh\/kwp/.test(text)) return "kWh/kWp";
  if (/state.?of.?charge|soc|percent|percentage|(^|[^a-z])pct([^a-z]|$)|%/.test(text)) return "%";
  if (/w\/m2|w\/m²|irradi|ghi|poa/.test(text)) return "W/m2";
  if (/mwh/.test(text)) return "MWh";
  if (/kwh/.test(text)) return "kWh";
  if (/(^|[^a-z])wh([^a-z]|$)|energywh/.test(text)) return "Wh";
  if (/mw([^a-z]|$)/.test(text)) return "MW";
  if (/kw([^a-z]|$)/.test(text)) return "kW";
  if (/(^|[^a-z])w([^a-z]|$)|powerw|activepower|photovoltaicspower/.test(text)) return "W";
  if (/kv/.test(text)) return "kV";
  if (/voltage|(^|[^a-z])v([^a-z]|$)/.test(text)) return "V";
  if (/current|(^|[^a-z])a([^a-z]|$)/.test(text)) return "A";
  if (/temp|temperature/.test(text)) return "degC";
  if (/frequency|(^|[^a-z])hz([^a-z]|$)/.test(text)) return "Hz";
  return "";
}

function getSeriesDisplayLabel(series: Pick<ChartingSeriesConfig, "label" | "unit">) {
  const unit = (series.unit ?? "").trim();
  if (!unit) return series.label;
  if (series.label.toLowerCase().includes(`(${unit.toLowerCase()})`)) return series.label;
  return `${series.label} (${unit})`;
}

function buildSeriesIdentityKey(series: Pick<ChartingSeriesConfig, "column" | "sourceColumn" | "derivedMetric">) {
  return [series.column, series.sourceColumn ?? "", series.derivedMetric ?? ""].join("::");
}

function buildShortRangeTicks(rows: ChartingResultRow[], rangeDays: number) {
  if (rangeDays <= 0 || rangeDays > 7 || rows.length === 0) return undefined;

  const hourStep = rangeDays <= 1.5 ? 1 : 3;
  const ticks: string[] = [];
  const seenBuckets = new Set<string>();

  for (const row of rows) {
    const timestamp = String(row.timestamp);
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) continue;
    const isBoundary = parsed.getHours() === 0 && parsed.getMinutes() === 0;
    const isStepHour = parsed.getMinutes() === 0 && parsed.getHours() % hourStep === 0;
    if (!isBoundary && !isStepHour) continue;
    const bucket = `${parsed.getFullYear()}-${parsed.getMonth()}-${parsed.getDate()}-${parsed.getHours()}`;
    if (seenBuckets.has(bucket)) continue;
    seenBuckets.add(bucket);
    ticks.push(timestamp);
  }

  const first = String(rows[0]?.timestamp ?? "");
  const last = String(rows[rows.length - 1]?.timestamp ?? "");
  if (first && !ticks.includes(first)) ticks.unshift(first);
  if (last && !ticks.includes(last)) ticks.push(last);
  return ticks;
}

function ChartTimeTick(props: {
  x?: number;
  y?: number;
  payload?: { value?: string };
  rangeDays: number;
  timeZone?: string;
}) {
  const rawValue = String(props.payload?.value ?? "");
  const label = formatAdaptiveTimeLabel(rawValue, props.rangeDays, props.timeZone);
  if (!label || props.x == null || props.y == null) return null;

  const lines = label.split("\n");
  const isBoundary = lines.length > 1;

  return (
    <g transform={`translate(${props.x},${props.y})`}>
      {lines.map((line, index) => (
        <text
          key={`${rawValue}-${index}`}
          x={0}
          y={index === 0 ? 0 : 13}
          dy={16}
          textAnchor="middle"
          fill={isBoundary ? "var(--chart-axis-text-strong)" : "var(--chart-axis-text)"}
          fontSize={isBoundary && index === 0 ? 11.5 : 11}
          fontWeight={isBoundary ? 700 : 500}
        >
          {line}
        </text>
      ))}
    </g>
  );
}

function chooseAutoAggregation(start: string, end: string): "raw" | "hourly" | "daily" | "monthly" {
  const rangeDays = diffDays(start, end);
  if (rangeDays <= 2) return "raw";
  if (rangeDays <= 45) return "hourly";
  if (rangeDays <= 550) return "daily";
  return "monthly";
}

function inferNativeAggregation(
  rowCount: number | undefined,
  start: string,
  end: string
): "raw" | "hourly" | "daily" | "monthly" {
  const safeRows = Number.isFinite(rowCount) ? Number(rowCount) : 0;
  const rangeDays = diffDays(start, end);
  if (safeRows <= 0 || rangeDays <= 0) return "hourly";

  const coveredDays = Math.max(rangeDays + 1, 1);
  const rowsPerDay = safeRows / coveredDays;

  if (rowsPerDay <= 1.5) return "daily";
  if (rowsPerDay <= 26) return "hourly";
  return "raw";
}

function buildAxisLabel(series: ChartingSeriesConfig[], axis: "left" | "right") {
  const axisSeries = series.filter((item) => item.yAxis === axis);
  if (axisSeries.length === 0) return axis === "left" ? "Value" : "";
  const labels = axisSeries.map((item) => item.label.toLowerCase());
  const units = Array.from(new Set(axisSeries.map((item) => (item.unit ?? "").trim()).filter(Boolean)));
  const allIrradiance = labels.every((label) => /irradi|ghi|poa/.test(label));
  const allSpecificYield = labels.every((label) => /specific yield/.test(label));
  const anyTemperature = labels.some((label) => /temp/.test(label));
  const anyIrradiance = labels.some((label) => /irradi|ghi|poa/.test(label));
  const appendUnit = (base: string) => (units.length === 1 ? `${base} (${units[0]})` : base);
  if (allIrradiance) return appendUnit("Irradiance");
  if (allSpecificYield) return appendUnit("Specific yield");
  if (axis === "right" && anyIrradiance && anyTemperature) return appendUnit("Irradiance / temperature");
  if (axis === "right" && anyIrradiance) return appendUnit("Irradiance / derived");
  if (axisSeries.length > 1) return appendUnit(axis === "left" ? "Power / output" : "Comparison axis");
  return appendUnit(axisSeries[0].label);
}

function buildChartTitle(series: ChartingSeriesConfig[]) {
  if (!series.length) return "Custom chart";
  if (series.length === 1) return getSeriesDisplayLabel(series[0]);
  return `${getSeriesDisplayLabel(series[0])} and ${series.length - 1} more series`;
}

function mergeChartRowsWithReference(
  baseRows: ChartingResultRow[],
  referenceRows: ChartingReferenceIrradianceResult["rows"]
): ChartingResultRow[] {
  const getTimestampKey = (value: string) => {
    const raw = String(value).trim();
    const wallClockMatch = raw.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
    if (wallClockMatch) return `${wallClockMatch[1]}T${wallClockMatch[2]}`;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return raw;
    return `${parsed.getFullYear()}-${`${parsed.getMonth() + 1}`.padStart(2, "0")}-${`${parsed.getDate()}`.padStart(2, "0")}T${`${parsed.getHours()}`.padStart(2, "0")}:${`${parsed.getMinutes()}`.padStart(2, "0")}`;
  };
  const referenceByTimestamp = new Map<string, number | null>();
  for (const row of referenceRows) {
    referenceByTimestamp.set(getTimestampKey(String(row.timestamp)), row.reference_irradiance_era5_land);
  }
  return baseRows.map((row) => ({
    ...row,
    [REFERENCE_IRRADIANCE_COLUMN]: referenceByTimestamp.get(getTimestampKey(String(row.timestamp))) ?? null,
  }));
}

function formatAxisTick(value: number) {
  if (!Number.isFinite(value)) return "";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) {
    return new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  }
  if (absolute >= 1000) {
    return Math.round(value).toString();
  }
  if (absolute >= 100) {
    return value.toFixed(0);
  }
  if (absolute >= 10) {
    return value.toFixed(0);
  }
  return value.toFixed(1);
}

function selectAllOnFocus(event: React.FocusEvent<HTMLInputElement>) {
  event.currentTarget.select();
}

function parseDateValue(value: string) {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateOnly(value?: string | null) {
  if (!value) return "";
  return String(value).slice(0, 10);
}

function formatDateValue(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, delta: number) {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isDateDisabled(date: Date, min?: string, max?: string) {
  const dateOnly = formatDateValue(date);
  if (min && dateOnly < min) return true;
  if (max && dateOnly > max) return true;
  return false;
}

function DateFieldPicker({
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
  const selectedDate = useMemo(() => parseDateValue(value), [value]);
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState<Date>(() => startOfMonth(selectedDate ?? parseDateValue(min ?? "") ?? new Date()));

  useEffect(() => {
    if (selectedDate) {
      setVisibleMonth(startOfMonth(selectedDate));
    }
  }, [selectedDate]);

  const monthStart = startOfMonth(visibleMonth);
  const monthLabel = monthStart.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const gridStart = new Date(monthStart);
  gridStart.setDate(gridStart.getDate() - ((gridStart.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, index) => {
    const day = new Date(gridStart);
    day.setDate(gridStart.getDate() + index);
    return day;
  });

  return (
    <div className="relative">
      <label className="text-[11px] font-semibold uppercase tracking-[0.18em] text-nav">{label}</label>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="mt-1.5 flex h-10 w-full items-center rounded-xl border border-subtle bg-white px-3 text-left text-sm font-medium text-slate-900 transition hover:border-orange-DEFAULT/50"
      >
        {value || `Select ${label.toLowerCase()}`}
      </button>
      {open ? (
        <div className="calendar-surface absolute left-0 top-[calc(100%+0.5rem)] z-30 w-[18rem] rounded-2xl border border-subtle bg-panel p-3 shadow-2xl backdrop-blur-sm">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setVisibleMonth((current) => addMonths(current, -1))}
              className="calendar-nav rounded-lg border border-subtle bg-row px-2.5 py-1.5 text-sm transition"
            >
              Prev
            </button>
            <p className="calendar-nav text-sm font-semibold">{monthLabel}</p>
            <button
              type="button"
              onClick={() => setVisibleMonth((current) => addMonths(current, 1))}
              className="calendar-nav rounded-lg border border-subtle bg-row px-2.5 py-1.5 text-sm transition"
            >
              Next
            </button>
          </div>
          <div className="calendar-label mt-3 grid grid-cols-7 gap-1 text-center text-[11px] font-semibold uppercase tracking-[0.18em]">
            {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-7 gap-1">
            {days.map((day) => {
              const outsideMonth = day.getMonth() !== monthStart.getMonth();
              const disabled = isDateDisabled(day, min, max);
              const selected = selectedDate ? isSameDay(day, selectedDate) : false;
              return (
                <button
                  key={day.toISOString()}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onChange(formatDateValue(day));
                    setOpen(false);
                  }}
                  className={`h-9 rounded-lg text-sm transition ${
                    selected
                      ? "calendar-day-selected"
                      : disabled
                        ? "calendar-day-disabled cursor-not-allowed"
                        : outsideMonth
                          ? "calendar-day-outside"
                          : "calendar-day-current"
                  }`}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function WorkflowPanel({
  step,
  title,
  description,
  accent,
  summary,
  active,
  collapsed,
  onToggle,
  toggleable = true,
  children,
}: {
  step: string;
  title: string;
  description: string;
  accent: string;
  summary: string;
  active: boolean;
  collapsed: boolean;
  onToggle: () => void;
  toggleable?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`rounded-[28px] border p-5 backdrop-blur-sm transition-all duration-300 ${
        active
          ? "border-white/65 bg-panel bg-[linear-gradient(135deg,rgba(255,255,255,0.12),rgba(255,255,255,0.04))] shadow-[0_0_0_1px_rgba(255,255,255,0.2),0_0_32px_rgba(120,197,255,0.14)] animate-[workflowPulse_2.6s_ease-in-out_infinite]"
          : "border-subtle bg-panel"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className={`h-1.5 w-28 rounded-full bg-gradient-to-r ${accent}`} />
          <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.3em] text-white/52">{step}</p>
          <h2 className="mt-2 font-dolfines text-[1.8rem] font-semibold tracking-[0.04em] text-white">{title}</h2>
          <p className="mt-2 text-sm leading-7 text-slate-200/84">{description}</p>
          <p className="mt-4 text-xs leading-6 text-white/55">{summary}</p>
        </div>
        {toggleable ? (
          <button
            type="button"
            onClick={onToggle}
            className="rounded-full border border-white/20 bg-white/6 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/82 transition hover:border-white/35 hover:text-white"
          >
            {collapsed ? "Expand details" : "Collapse details"}
          </button>
        ) : null}
      </div>
      {!collapsed ? <div className="mt-6">{children}</div> : null}
    </section>
  );
}

function RevealLegend({
  payload,
  focusedSeriesKey,
  onSelect,
}: {
  payload?: Array<{ value?: string; color?: string; dataKey?: string }>;
  focusedSeriesKey: string | null;
  onSelect: (seriesKey: string) => void;
}) {
  if (!payload?.length) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 px-2 pt-3 text-xs">
      {payload.map((entry, index) => {
        const seriesKey = typeof entry.dataKey === "string" ? entry.dataKey : typeof entry.value === "string" ? entry.value : `series-${index}`;
        const isFocused = focusedSeriesKey === seriesKey;
        const isMuted = Boolean(focusedSeriesKey && !isFocused);
        return (
          <button
            key={`${seriesKey}-${index}`}
            type="button"
            onClick={() => onSelect(seriesKey)}
            className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 transition ${
              isFocused
                ? "border-sky-300/60 lv-focused-chip text-white"
                : isMuted
                  ? "border-weak bg-white/0 text-white/45 hover:text-white/70"
                  : "border-faint bg-white/0 text-slate-200/90 hover:border-white/20 hover:text-white"
            }`}
          >
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: entry.color ?? "#fff" }} />
            <span className="font-medium">{entry.value}</span>
          </button>
        );
      })}
    </div>
  );
}

function getResolvedInverterCapacityKwp(
  unit: { dc_capacity_kwp?: number; module_count?: number; tag?: string },
  moduleWp?: number
) {
  if (unit.dc_capacity_kwp && unit.dc_capacity_kwp > 0) {
    return unit.dc_capacity_kwp;
  }
  if (unit.module_count && unit.module_count > 0 && moduleWp && moduleWp > 0) {
    return (unit.module_count * moduleWp) / 1000;
  }
  return 0;
}

function normalizeSeriesKey(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function getSeriesLetters(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z]+/g, "");
}

function getSeriesNumberSignature(value: string) {
  const parts = value.match(/\d+/g) ?? [];
  if (!parts.length) return "";
  return parts.map((part) => String(Number(part))).join("-");
}

function compareSeriesKeys(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function resolveInverterSourceColumn(
  tag: string | undefined,
  availableColumns: string[],
  mappedPowerColumns: string[]
) {
  const cleanTag = tag?.trim();
  if (!cleanTag) return null;

  const candidates = mappedPowerColumns.length > 0 ? mappedPowerColumns : availableColumns;
  const normalizedTag = normalizeSeriesKey(cleanTag);
  const tagLetters = getSeriesLetters(cleanTag);
  const tagNumberSignature = getSeriesNumberSignature(cleanTag);

  const exactMatch =
    candidates.find((column) => column === cleanTag) ??
    availableColumns.find((column) => column === cleanTag);
  if (exactMatch) return exactMatch;

  const normalizedExactMatch =
    candidates.find((column) => normalizeSeriesKey(column) === normalizedTag) ??
    availableColumns.find((column) => normalizeSeriesKey(column) === normalizedTag);
  if (normalizedExactMatch) return normalizedExactMatch;

  const containsMatch =
    candidates.find((column) => normalizeSeriesKey(column).includes(normalizedTag)) ??
    candidates.find((column) => normalizedTag.includes(normalizeSeriesKey(column))) ??
    availableColumns.find((column) => normalizeSeriesKey(column).includes(normalizedTag));
  if (containsMatch) return containsMatch;

  if (tagNumberSignature) {
    const scoredCandidates = [...candidates, ...availableColumns]
      .filter((column, index, array) => array.indexOf(column) === index)
      .map((column) => {
        const columnLetters = getSeriesLetters(column);
        const columnNumberSignature = getSeriesNumberSignature(column);
        let score = 0;

        if (columnNumberSignature && columnNumberSignature === tagNumberSignature) {
          score += 70;
        }
        if (tagLetters && columnLetters && columnLetters === tagLetters) {
          score += 25;
        } else if (
          tagLetters &&
          columnLetters &&
          (columnLetters.includes(tagLetters) || tagLetters.includes(columnLetters))
        ) {
          score += 18;
        }
        if (normalizeSeriesKey(column).includes(normalizedTag) || normalizedTag.includes(normalizeSeriesKey(column))) {
          score += 12;
        }

        return { column, score };
      })
      .filter((item) => item.score >= 70)
      .sort((a, b) => b.score - a.score);

    if (scoredCandidates.length > 0) {
      return scoredCandidates[0].column;
    }
  }

  return null;
}

function buildOrderedFallbackMapping(
  configuredTags: string[],
  candidateColumns: string[],
  existingMatches: ConfirmedInverterMapping
) {
  if (!configuredTags.length || configuredTags.length !== candidateColumns.length) {
    return existingMatches;
  }

  const nextMatches: ConfirmedInverterMapping = { ...existingMatches };
  const usedColumns = new Set(Object.values(existingMatches).filter(Boolean));
  const unmatchedTags = configuredTags.filter((tag) => !nextMatches[tag]).sort(compareSeriesKeys);
  const unmatchedColumns = candidateColumns.filter((column) => !usedColumns.has(column)).sort(compareSeriesKeys);

  if (unmatchedTags.length !== unmatchedColumns.length) {
    return nextMatches;
  }

  unmatchedTags.forEach((tag, index) => {
    nextMatches[tag] = unmatchedColumns[index];
  });

  return nextMatches;
}

function getChartColumnLabel(column: string, hasBess: boolean) {
  const key = column.trim().toLowerCase();
  if (hasBess) {
    if (/(soc|state.?of.?charge|battery.*level|charge.*level)/i.test(key)) return `${column} · Battery state of charge (%)`;
    if (/(battery|bess).*(charge)/i.test(key) || /(charge).*(battery|bess)/i.test(key)) return `${column} · Battery charge power`;
    if (/(battery|bess).*(discharge)/i.test(key) || /(discharge).*(battery|bess)/i.test(key)) return `${column} · Battery discharge power`;
    if (/(battery|bess).*(power)/i.test(key)) return `${column} · Battery power`;
    if (/(grid).*(import|consum)/i.test(key) || /(import|consum).*(grid)/i.test(key)) return `${column} · Grid import / consumption`;
    if (/(grid).*(export)/i.test(key) || /(export).*(grid)/i.test(key)) return `${column} · Grid export`;
    if (/(house|home|load).*(power|consum)?/i.test(key) || /(load).*(house|home)/i.test(key)) return `${column} · House load`;
  }
  if (/(poa|ghi|irradi)/i.test(key)) return `${column} · Irradiance`;
  return column;
}

function getDefaultUnitForOption(option: PlotOption | undefined, fallbackColumn: string, fallbackLabel?: string) {
  if (option?.unit) return option.unit;
  return inferUnit(fallbackColumn, fallbackLabel ?? option?.label);
}

export default function ChartingPage() {
  const { sites } = useSites();
  const { trigger: detectColumns, isMutating: isDetecting } = useColumnDetect();
  const [file, setFile] = useState<File | null>(null);
  const [uploadFeedback, setUploadFeedback] = useState<{ tone: "info" | "success" | "error"; message: string } | null>(null);
  const [detection, setDetection] = useState<ColumnDetectionResult | null>(null);
  const [detectionError, setDetectionError] = useState<string | null>(null);
  const [detectionProgress, setDetectionProgress] = useState(0);
  const [detectionLabel, setDetectionLabel] = useState("");
  const [collapsedSteps, setCollapsedSteps] = useState({ 1: false, 2: true, 3: true });
  const [chartControlsCollapsed, setChartControlsCollapsed] = useState(false);
  const [seriesBuilderCollapsed, setSeriesBuilderCollapsed] = useState(false);
  const [selectedWorksheet, setSelectedWorksheet] = useState("");
  const [worksheetSelectionConfirmed, setWorksheetSelectionConfirmed] = useState(true);
  const [timestampColumn, setTimestampColumn] = useState("");
  const [aggregation, setAggregation] = useState<"auto" | "raw" | "hourly" | "daily" | "monthly">("auto");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [selectedTimeRange, setSelectedTimeRange] = useState<[string, string] | null>(null);
  const [isLoadingTimeRange, setIsLoadingTimeRange] = useState(false);
  const [referenceIrradiance, setReferenceIrradiance] = useState<ChartingReferenceIrradianceResult | null>(null);
  const [isFetchingReferenceIrradiance, setIsFetchingReferenceIrradiance] = useState(false);
  const [referenceIrradianceError, setReferenceIrradianceError] = useState<string | null>(null);
  const [referencePromptDismissed, setReferencePromptDismissed] = useState(false);
  const [seriesDrafts, setSeriesDrafts] = useState<SeriesDraft[]>([]);
  const [chartResult, setChartResult] = useState<ChartingResult | null>(null);
  const [chartError, setChartError] = useState<string | null>(null);
  const [isGeneratingChart, setIsGeneratingChart] = useState(false);
  const [chartProgress, setChartProgress] = useState(0);
  const [chartLabel, setChartLabel] = useState("");
  const [zoomDomain, setZoomDomain] = useState<{ startIndex: number; endIndex: number } | null>(null);
  const [bulkChartType, setBulkChartType] = useState<"line" | "bar">("line");
  const [selectedSiteId, setSelectedSiteId] = useState("");
  const [confirmedInverterMapping, setConfirmedInverterMapping] = useState<ConfirmedInverterMapping>({});
  const [focusedSeriesKey, setFocusedSeriesKey] = useState<string | null>(null);
  const [expandedChart, setExpandedChart] = useState(false);
  const [plotSearch, setPlotSearch] = useState("");
  const [plotItemsExpanded, setPlotItemsExpanded] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [hoverSnapshot, setHoverSnapshot] = useState<{
    label: string;
    values: Array<{ key: string; name: string; value: number | string; color?: string }>;
  } | null>(null);
  const chartWheelContainerRef = useRef<HTMLDivElement | null>(null);
  const lastConfiguredDetectionRef = useRef<string>("");

  const worksheetOptions = detection?.worksheets ?? [];
  const needsWorksheetSelection = worksheetOptions.length > 1;
  const canOpenChartBuilder = Boolean(detection && (!needsWorksheetSelection || worksheetSelectionConfirmed));
  const activeStep = !detection ? 1 : !canOpenChartBuilder ? 2 : 3;
  const availableColumns = detection?.columns ?? [];
  const selectedSiteFromList = useMemo(() => sites.find((site) => site.id === selectedSiteId), [selectedSiteId, sites]);
  const { site: selectedSiteDetails, isLoading: selectedSiteIsLoading } = useSite(selectedSiteId);
  const selectedSite = selectedSiteDetails ?? selectedSiteFromList;
  const selectedSiteTimezone = selectedSite?.site_timezone || undefined;
  const selectedSiteHasBess = Boolean(selectedSite?.has_bess);
  const selectedSiteHasGps = Boolean(selectedSite && Number.isFinite(selectedSite.lat) && Number.isFinite(selectedSite.lon));
  const detectedPowerColumns = detection?.mapping?.power ?? [];
  const candidatePowerColumns = detectedPowerColumns.length > 0 ? detectedPowerColumns : availableColumns;
  const siteCapacities = useMemo(
    () =>
      (selectedSite?.solar_inverter_units ?? []).map((unit) => ({
        ...unit,
        resolvedCapacityKwp: getResolvedInverterCapacityKwp(unit, selectedSite?.module_wp),
      })),
    [selectedSite]
  );
  const autoMatchedInverterColumns = useMemo(
    () => {
      const configuredTags = siteCapacities
        .filter((item) => item.tag && item.resolvedCapacityKwp > 0)
        .map((item) => item.tag);

      const exactishMatches = Object.fromEntries(
        configuredTags
          .map((tag) => [tag, resolveInverterSourceColumn(tag, availableColumns, detectedPowerColumns) ?? ""])
          .filter((entry) => entry[1])
      ) as ConfirmedInverterMapping;

      return buildOrderedFallbackMapping(configuredTags, candidatePowerColumns, exactishMatches);
    },
    [availableColumns, candidatePowerColumns, detectedPowerColumns, siteCapacities]
  );
  const siteSetupIssues = useMemo(() => {
    if (!selectedSite || selectedSiteIsLoading) return [];

    const issues: string[] = [];
    if (!Number.isFinite(selectedSite.lat) || !Number.isFinite(selectedSite.lon)) issues.push("GPS coordinates");
    if (!selectedSite.site_timezone) issues.push("timezone");
    if (selectedSite.tariff_eur_mwh == null || !Number.isFinite(selectedSite.tariff_eur_mwh)) issues.push("site tariff");
    if (selectedSite.has_bess) {
      if (selectedSite.bess_power_kw == null || selectedSite.bess_power_kw <= 0) issues.push("BESS power");
      if (selectedSite.bess_energy_kwh == null || selectedSite.bess_energy_kwh <= 0) issues.push("BESS energy");
    }

    if (selectedSite.site_type === "solar") {
      if (!selectedSite.module_wp || selectedSite.module_wp <= 0) issues.push("module capacity");
      if (!selectedSite.n_modules || selectedSite.n_modules <= 0) issues.push("module quantity");
      if (!selectedSite.module_tilt_deg || selectedSite.module_tilt_deg <= 0) issues.push("module tilt");
      if (!selectedSite.irradiance_basis) issues.push("irradiance basis");
      if (!selectedSite.inv_model) issues.push("inverter model");
      if (!selectedSite.module_brand && !(selectedSite.solar_module_types?.length)) issues.push("module details");
      if (!selectedSite.n_inverters || selectedSite.n_inverters <= 0) {
        issues.push("inverter count");
      } else {
        const configuredUnits = siteCapacities;
        if (configuredUnits.length === 0) {
          issues.push("per-inverter breakdown");
        } else if (!configuredUnits.some((unit) => unit.tag && unit.resolvedCapacityKwp > 0)) {
          issues.push("per-inverter capacities");
        }
      }
    }

    return issues;
  }, [selectedSite, selectedSiteIsLoading, siteCapacities]);
  const matchedSiteCapacities = useMemo(
    () =>
      siteCapacities
        .filter((item) => item.resolvedCapacityKwp > 0 && item.tag)
        .map((item) => ({
          ...item,
          matchedColumn:
            (confirmedInverterMapping[item.tag] && candidatePowerColumns.includes(confirmedInverterMapping[item.tag]))
              ? confirmedInverterMapping[item.tag]
              : resolveInverterSourceColumn(item.tag, availableColumns, detectedPowerColumns),
        })),
    [availableColumns, candidatePowerColumns, confirmedInverterMapping, detectedPowerColumns, siteCapacities]
  );
  const matchedSpecificYieldCount = matchedSiteCapacities.filter((item) => item.matchedColumn).length;
  const unmatchedSpecificYieldTags = matchedSiteCapacities
    .filter((item) => !item.matchedColumn)
    .map((item) => item.tag)
    .slice(0, 6);
  const needsInverterMatchConfirmation = Boolean(
    selectedSiteId &&
    siteCapacities.some((item) => item.resolvedCapacityKwp > 0) &&
    candidatePowerColumns.length > 0
  );
  const plotOptions = useMemo<PlotOption[]>(() => {
    const inverterPowerLabelByColumn = new Map<string, string>();
    for (const item of matchedSiteCapacities) {
      const sourceColumn = item.matchedColumn;
      if (!item.tag || !sourceColumn) continue;
      inverterPowerLabelByColumn.set(sourceColumn, `${item.tag} power`);
    }

    const rawOptions = availableColumns
      .filter((column) => column !== timestampColumn)
      .map((column) => {
        const explicitLabel = inverterPowerLabelByColumn.get(column);
        const label = explicitLabel ?? getChartColumnLabel(column, selectedSiteHasBess);
        return {
          key: column,
          column,
          label,
          unit: inferUnit(column, label),
        };
      });
    const specificYieldOptions = matchedSiteCapacities.reduce<PlotOption[]>((acc, item) => {
        const sourceColumn = item.matchedColumn;
        if (!item.tag || item.resolvedCapacityKwp <= 0 || !sourceColumn) return acc;
        acc.push({
          key: `specific_yield::${item.tag}`,
          column: `specific_yield__${item.tag}`,
          label: `${item.tag} specific yield (kWh/kWp)`,
          unit: "kWh/kWp",
          sourceColumn,
          derivedMetric: "specific_yield" as const,
          capacityKwp: item.resolvedCapacityKwp,
        } satisfies PlotOption);
        return acc;
      }, []);
    const referenceOption =
      referenceIrradiance
        ? [{
            key: REFERENCE_IRRADIANCE_COLUMN,
            column: REFERENCE_IRRADIANCE_COLUMN,
            label: `${referenceIrradiance.label} · ${referenceIrradiance.mode}`,
            unit: "W/m2",
            sourceColumn: REFERENCE_IRRADIANCE_SOURCE,
          } satisfies PlotOption]
        : [];
    return [...rawOptions, ...specificYieldOptions, ...referenceOption];
  }, [availableColumns, matchedSiteCapacities, referenceIrradiance, selectedSiteHasBess, timestampColumn]);
  const filteredPlotOptions = useMemo(() => {
    const search = plotSearch.trim().toLowerCase();
    if (!search) return plotOptions;
    return plotOptions.filter((option) => option.label.toLowerCase().includes(search) || option.column.toLowerCase().includes(search));
  }, [plotOptions, plotSearch]);
  const specificYieldBySourceColumn = useMemo(
    () =>
      new Map(
        plotOptions
          .filter((option) => option.derivedMetric === "specific_yield" && option.sourceColumn)
          .map((option) => [option.sourceColumn as string, option])
      ),
    [plotOptions]
  );
  const rawPowerBySourceColumn = useMemo(
    () =>
      new Map(
        plotOptions
          .filter((option) => !option.derivedMetric && specificYieldBySourceColumn.has(option.column))
          .map((option) => [option.column, option])
      ),
    [plotOptions, specificYieldBySourceColumn]
  );
  const hasSpecificYieldOptions = specificYieldBySourceColumn.size > 0;
  const dataUploadedSummary = detection
    ? `1 file analysed${detection.selected_worksheet ? ` from worksheet ${detection.selected_worksheet}` : ""}. ${detection.row_count.toLocaleString()} rows detected across ${formatDateRange(selectedTimeRange ?? detection.data_date_range)}.`
    : "Drop one SCADA file here and REVEAL will scan the structure before opening the chart builder.";
  const hasMeasuredIrradiance = Boolean(detection?.mapping?.irradiance);

  useEffect(() => {
    if (!isDetecting) {
      if (detectionProgress < 100 && detection) {
        setDetectionProgress(100);
        setDetectionLabel(needsWorksheetSelection && !worksheetSelectionConfirmed ? "Worksheet selection needed" : "Data uploaded");
      }
      return;
    }
    setDetectionLabel("REVEAL is scanning the CSV/XLSX structure and detecting the available columns.");
    const timer = window.setInterval(() => {
      setDetectionProgress((current) => (current >= 92 ? current : current + 6));
    }, 180);
    return () => window.clearInterval(timer);
  }, [detection, detectionProgress, isDetecting, needsWorksheetSelection, worksheetSelectionConfirmed]);

  const runDetection = async (selected: File, worksheet?: string) => {
    setDetectionError(null);
    setChartError(null);
    setDetectionProgress(12);
    setDetectionLabel(worksheet ? `Analysing worksheet ${worksheet}…` : "Starting file analysis…");
    const result = await detectColumns({ file: selected, siteType: selectedSite?.site_type ?? "solar", worksheet });
    setDetection(result);
    setSelectedWorksheet(result.selected_worksheet ?? worksheet ?? "");
    return result;
  };

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (!expandedChart) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [expandedChart]);

  useEffect(() => {
    if (!selectedSiteId) {
      setConfirmedInverterMapping({});
      return;
    }

    const storageKey = getChartingMappingStorageKey(selectedSiteId);
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved) as ConfirmedInverterMapping;
        const validSavedEntries = Object.fromEntries(
          Object.entries(parsed ?? {}).filter(([tag, column]) => {
            if (!tag || !column) return false;
            return candidatePowerColumns.includes(column);
          })
        ) as ConfirmedInverterMapping;
        setConfirmedInverterMapping({
          ...autoMatchedInverterColumns,
          ...validSavedEntries,
        });
        return;
      }
    } catch {
      // Ignore corrupted saved mappings and fall back to best guess.
    }

    setConfirmedInverterMapping(autoMatchedInverterColumns);
  }, [autoMatchedInverterColumns, candidatePowerColumns, selectedSiteId]);

  useEffect(() => {
    if (!detection) return;
    const fallbackRange = detection.data_date_range ?? null;
    const detectionKey = JSON.stringify({
      filename: detection.filename,
      worksheet: detection.selected_worksheet ?? "",
      columns: detection.columns,
      time: detection.mapping.time ?? "",
      dateRange: fallbackRange,
    });
    if (lastConfiguredDetectionRef.current === detectionKey) return;
    lastConfiguredDetectionRef.current = detectionKey;
    const defaultTime = detection.mapping.time || detection.columns.find((column) => /time|date/i.test(column)) || detection.columns[0] || "";
    setTimestampColumn(defaultTime);
    setSelectedTimeRange(fallbackRange);
    setStartDate(fallbackRange?.[0] ?? "");
    setEndDate(fallbackRange?.[1] ?? "");

    const suggested = [detection.mapping.irradiance, ...(detection.mapping.power?.slice(0, 2) ?? [])].filter(
      (value): value is string => Boolean(value)
    );
    const uniqueSuggested = Array.from(new Set(suggested));
    setSeriesDrafts(
      uniqueSuggested.length > 0
        ? uniqueSuggested.map((column, index) => {
            const option =
              plotOptions.find((item) => item.sourceColumn === column && item.derivedMetric === "specific_yield") ??
              plotOptions.find((item) => item.column === column || item.key === column || item.sourceColumn === column);
            return {
              id: `${column}-${index}`,
              column: option?.column ?? column,
              sourceColumn: option?.sourceColumn,
              derivedMetric: option?.derivedMetric,
              capacityKwp: option?.capacityKwp,
              label: option?.label ?? column,
              unit: getDefaultUnitForOption(option, column),
              chartType: /irradi|ghi|poa|specific_yield/i.test(option?.column ?? column) ? "line" : "bar",
              color: getAutoColor(index),
              yAxis: /irradi|ghi|poa|temp|specific_yield/i.test(option?.column ?? column) ? "right" : "left",
            };
          })
        : [
            {
              id: "series-0",
              column: "",
              label: "",
              unit: "",
              chartType: "line",
              color: getAutoColor(0),
              yAxis: "left",
            },
          ]
    );
    const requiresWorksheetStep = (detection.worksheets?.length ?? 0) > 1 && !worksheetSelectionConfirmed;
    setCollapsedSteps({ 1: !needsInverterMatchConfirmation, 2: !requiresWorksheetStep, 3: requiresWorksheetStep });
  }, [detection, needsInverterMatchConfirmation, plotOptions, timestampColumn, worksheetSelectionConfirmed]);

  useEffect(() => {
    setReferenceIrradiance(null);
    setReferenceIrradianceError(null);
    setReferencePromptDismissed(false);
  }, [file, selectedSiteId]);

  useEffect(() => {
    let cancelled = false;

    const loadTimeRange = async () => {
      const fallbackRange = detection?.data_date_range ?? null;
      if (!file || !timestampColumn || !availableColumns.includes(timestampColumn)) {
        if (!cancelled) {
          setSelectedTimeRange(fallbackRange);
          setStartDate(fallbackRange?.[0] ?? "");
          setEndDate(fallbackRange?.[1] ?? "");
          setIsLoadingTimeRange(false);
        }
        return;
      }

      setIsLoadingTimeRange(true);
      try {
        const result = await getChartingDateRange(file, timestampColumn, selectedWorksheet || undefined);
        if (cancelled) return;
        setSelectedTimeRange(result.dateRange);
        setStartDate(result.dateRange[0] ?? "");
        setEndDate(result.dateRange[1] ?? "");
      } catch {
        if (cancelled) return;
        setSelectedTimeRange(fallbackRange);
        setStartDate(fallbackRange?.[0] ?? "");
        setEndDate(fallbackRange?.[1] ?? "");
      } finally {
        if (!cancelled) {
          setIsLoadingTimeRange(false);
        }
      }
    };

    void loadTimeRange();

    return () => {
      cancelled = true;
    };
  }, [availableColumns, detection?.data_date_range, file, selectedWorksheet, timestampColumn]);

  useEffect(() => {
    if (!isGeneratingChart) {
      if (chartProgress < 100 && chartResult) {
        setChartProgress(100);
        setChartLabel("Chart ready");
      }
      return;
    }
    setChartLabel("REVEAL is filtering the selected period and preparing the chart with the chosen time axis.");
    const timer = window.setInterval(() => {
      setChartProgress((current) => (current >= 90 ? current : current + 5));
    }, 180);
    return () => window.clearInterval(timer);
  }, [chartProgress, chartResult, isGeneratingChart]);

  const onDrop = async (acceptedFiles: File[]) => {
    const selected = acceptedFiles[0];
    if (!selected) return;
    setUploadFeedback({ tone: "info", message: `File accepted: ${selected.name}. Starting analysis…` });
    setFile(selected);
    setDetection(null);
    setDetectionError(null);
    setChartResult(null);
    setChartError(null);
    setTimestampColumn("");
    setStartDate("");
    setEndDate("");
    setSelectedTimeRange(null);
    setIsLoadingTimeRange(false);
    setReferenceIrradiance(null);
    setReferenceIrradianceError(null);
    setReferencePromptDismissed(false);
    setSelectedWorksheet("");
    setWorksheetSelectionConfirmed(true);
    setSeriesDrafts([
      {
        id: `series-upload-${Date.now()}`,
        column: "",
        label: "",
        unit: "",
        chartType: "line",
        color: getAutoColor(0),
        yAxis: "left",
      },
    ]);
    setZoomDomain(null);
    setDetectionProgress(12);
    setDetectionLabel("Starting file analysis…");
    try {
      const result = await runDetection(selected);
      setUploadFeedback({
        tone: "success",
        message: `File accepted: ${selected.name}. REVEAL analysed ${result.row_count.toLocaleString()} rows across ${result.columns.length} columns.`,
      });
      const worksheetCount = result.worksheets?.length ?? 0;
      const resolvedWorksheet = result.selected_worksheet ?? "";
      setSelectedWorksheet(resolvedWorksheet);
      setWorksheetSelectionConfirmed(worksheetCount <= 1);
      setCollapsedSteps({
        1: worksheetCount <= 1 ? !needsInverterMatchConfirmation : false,
        2: worksheetCount > 1 ? false : true,
        3: worksheetCount <= 1 ? false : true,
      });
    } catch (error) {
      setUploadFeedback({
        tone: "error",
        message: `File accepted: ${selected.name}. Analysis failed before the chart builder opened.`,
      });
      setDetectionError(error instanceof Error ? error.message : "Failed to analyse uploaded data.");
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    onDropRejected: (rejections) => {
      const firstRejection = rejections[0];
      const firstFile = firstRejection?.file?.name ? ` "${firstRejection.file.name}"` : "";
      const firstReason = firstRejection?.errors?.[0]?.message ?? "Unsupported file type.";
      setUploadFeedback({
        tone: "error",
        message: `File rejected${firstFile}. ${firstReason}`,
      });
      setDetectionError(`REVEAL could not accept${firstFile}. ${firstReason} Use a CSV, XLS, or XLSX file.`);
    },
    multiple: false,
    accept: {
      "text/csv": [".csv"],
      "text/plain": [".csv"],
      "application/vnd.ms-excel": [".xls"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
    },
  });

  const applyWorksheetSelection = async () => {
    if (!file || !selectedWorksheet) return;
    setTimestampColumn("");
    setStartDate("");
    setEndDate("");
    setSelectedTimeRange(null);
    setChartResult(null);
    setReferenceIrradiance(null);
    setReferenceIrradianceError(null);
    setReferencePromptDismissed(false);
    setWorksheetSelectionConfirmed(false);
    try {
      await runDetection(file, selectedWorksheet);
      setWorksheetSelectionConfirmed(true);
      setCollapsedSteps({ 1: !needsInverterMatchConfirmation, 2: true, 3: false });
    } catch (error) {
      setDetectionError(error instanceof Error ? error.message : "Failed to analyse the selected worksheet.");
    }
  };

  const cleanedSeries = useMemo(() => seriesDrafts.filter((item) => item.column.trim().length > 0 && item.label.trim().length > 0), [seriesDrafts]);
  const resolvedDetectedRange = selectedTimeRange ?? detection?.data_date_range ?? null;
  const detectedStartDate = resolvedDetectedRange?.[0] ?? "";
  const detectedEndDate = resolvedDetectedRange?.[1] ?? "";
  const effectiveStartDate = startDate || detectedStartDate;
  const effectiveEndDate = endDate || detectedEndDate;
  const shouldOfferReferenceIrradiance = Boolean(
    detection &&
      selectedSite?.site_type === "solar" &&
      selectedSiteHasGps &&
      !hasMeasuredIrradiance &&
      effectiveStartDate &&
      effectiveEndDate &&
      !referenceIrradiance &&
      !referencePromptDismissed
  );

  const canGenerateChart = Boolean(
    file &&
      timestampColumn &&
      cleanedSeries.length > 0 &&
      effectiveStartDate &&
      effectiveEndDate &&
      effectiveStartDate <= effectiveEndDate &&
      !isGeneratingChart
  );
  const selectedRangeDays = useMemo(() => diffDays(effectiveStartDate, effectiveEndDate), [effectiveEndDate, effectiveStartDate]);
  const nativeAggregation = useMemo(
    () => inferNativeAggregation(selectedTimeRange ? detection?.row_count : detection?.row_count, effectiveStartDate, effectiveEndDate),
    [detection?.row_count, effectiveEndDate, effectiveStartDate, selectedTimeRange]
  );
  const effectiveAggregation = useMemo(
    () => {
      if (aggregation !== "auto") return aggregation;
      const rangeSuggested = chooseAutoAggregation(effectiveStartDate, effectiveEndDate);
      const rank = { raw: 0, hourly: 1, daily: 2, monthly: 3 } as const;
      return rank[nativeAggregation] > rank[rangeSuggested] ? nativeAggregation : rangeSuggested;
    },
    [aggregation, effectiveEndDate, effectiveStartDate, nativeAggregation]
  );

  useEffect(() => {
    if (!referenceIrradiance) return;
    const referenceRange = referenceIrradiance.summary.dateRange ?? [];
    const aggregationChanged = referenceIrradiance.summary.aggregation !== effectiveAggregation;
    const startChanged = Boolean(effectiveStartDate) && toDateOnly(referenceRange[0]) !== toDateOnly(effectiveStartDate);
    const endChanged = Boolean(effectiveEndDate) && toDateOnly(referenceRange[1]) !== toDateOnly(effectiveEndDate);
    if (!aggregationChanged && !startChanged && !endChanged) return;
    setReferenceIrradiance(null);
    setReferenceIrradianceError(null);
    setSeriesDrafts((current) => current.filter((item) => item.sourceColumn !== REFERENCE_IRRADIANCE_SOURCE));
  }, [effectiveAggregation, effectiveEndDate, effectiveStartDate, referenceIrradiance]);

  const renderedSeries = useMemo(() => {
    if (!chartResult?.series) return [];
    const draftSeries = seriesDrafts.filter((item) => item.column.trim().length > 0);
    const draftByIdentity = new Map(draftSeries.map((item) => [buildSeriesIdentityKey(item), item]));
    const draftByColumn = new Map(draftSeries.map((item) => [item.column, item]));

    return chartResult.series.map((series) => {
      const draft = draftByIdentity.get(buildSeriesIdentityKey(series)) ?? draftByColumn.get(series.column);
      if (!draft) return series;
      return {
        ...series,
        color: draft.color,
      };
    });
  }, [chartResult, seriesDrafts]);
  const hasRightAxisSeries = useMemo(
    () => renderedSeries.some((series) => series.yAxis === "right"),
    [renderedSeries]
  );

  useEffect(() => {
    if (!focusedSeriesKey) return;
    if (renderedSeries.some((series) => series.column === focusedSeriesKey)) return;
    setFocusedSeriesKey(null);
  }, [focusedSeriesKey, renderedSeries]);

  const generateChart = async () => {
    if (!file || !timestampColumn || cleanedSeries.length === 0) return;
    setIsGeneratingChart(true);
    setChartError(null);
    setChartResult(null);
    setChartProgress(10);
    setChartLabel("Launching chart generation…");
    try {
      const resolvedTimeColumn =
        availableColumns.includes(timestampColumn)
          ? timestampColumn
          : detection?.mapping.time || availableColumns.find((column) => /time|date/i.test(column)) || availableColumns[0] || "";
      const invalidSeries = cleanedSeries.filter((item) => {
        if (item.sourceColumn === REFERENCE_IRRADIANCE_SOURCE) {
          return false;
        }
        const requestedColumn = item.sourceColumn ?? item.column;
        return !requestedColumn || !availableColumns.includes(requestedColumn);
      });
      const referenceSeries = cleanedSeries.filter((item) => item.sourceColumn === REFERENCE_IRRADIANCE_SOURCE);
      const backendSeries = cleanedSeries.filter((item) => item.sourceColumn !== REFERENCE_IRRADIANCE_SOURCE);

      if (!resolvedTimeColumn || !availableColumns.includes(resolvedTimeColumn)) {
        throw new Error("The selected timestamp column is not available in the uploaded file. Please re-check the detected columns.");
      }

      if (invalidSeries.length > 0) {
        throw new Error(
          `Some selected plot items do not exist in the uploaded file anymore: ${invalidSeries
            .map((item) => item.sourceColumn ?? item.column)
            .join(", ")}. Please clear and reselect the series for this file.`
        );
      }

      if (referenceSeries.length > 0 && !referenceIrradiance) {
        throw new Error("Reference irradiance has not been fetched yet. Please pull the ERA reference irradiance first.");
      }

      let result: ChartingResult;
      if (backendSeries.length > 0) {
        result = await runCharting(file, {
          timeColumn: resolvedTimeColumn,
          worksheet: selectedWorksheet || undefined,
          series: backendSeries,
          startDate: effectiveStartDate,
          endDate: effectiveEndDate,
          aggregation: effectiveAggregation,
          siteTimezone: selectedSite?.site_timezone || "UTC",
        });
      } else {
        result = {
          series: [],
          rows: [],
          summary: {
            filename: file.name,
            rowCount: 0,
            aggregation: effectiveAggregation,
            dateRange: [effectiveStartDate, effectiveEndDate],
          },
        };
      }

      if (referenceSeries.length > 0 && referenceIrradiance) {
        const mergedRows = mergeChartRowsWithReference(result.rows, referenceIrradiance.rows);
        result = {
          series: [...result.series, ...referenceSeries],
          rows: mergedRows,
          summary: {
            ...result.summary,
            rowCount: mergedRows.length,
            dateRange: referenceIrradiance.summary.dateRange,
          },
        };
      }

      if (backendSeries.length === 0 && referenceSeries.length > 0 && referenceIrradiance) {
        result.series = referenceSeries;
        result.rows = referenceIrradiance.rows as typeof result.rows;
        result.summary = {
          filename: file.name,
          rowCount: referenceIrradiance.summary.rowCount,
          aggregation: referenceIrradiance.summary.aggregation,
          dateRange: referenceIrradiance.summary.dateRange,
        };
      }

      setChartResult(result);
      setFocusedSeriesKey(null);
      setHoverSnapshot(null);
      setZoomDomain(null);
    } catch (error) {
      setChartError(error instanceof Error ? error.message : "Failed to generate chart.");
    } finally {
      setIsGeneratingChart(false);
    }
  };

  const fetchReferenceIrradiance = async () => {
    if (!selectedSite || !effectiveStartDate || !effectiveEndDate) return;
    setIsFetchingReferenceIrradiance(true);
    setReferenceIrradianceError(null);
    try {
      const form = new FormData();
      form.append("source", "era5-land");
      form.append("latitude", String(selectedSite.lat));
      form.append("longitude", String(selectedSite.lon));
      form.append("start_date", effectiveStartDate);
      form.append("end_date", effectiveEndDate);
      form.append("aggregation", effectiveAggregation);
      form.append("site_timezone", selectedSite.site_timezone || "UTC");
      form.append("irradiance_basis", selectedSite.irradiance_basis || "poa");
      form.append("tracker_mode", /tracker/i.test(selectedSite.technology || "") ? "single-axis-tracker" : "fixed-tilt");
      form.append("irradiance_tilt_deg", String(selectedSite.module_tilt_deg ?? 0));
      const result = await fetchChartingReferenceIrradiance(form);
      setReferenceIrradiance(result);
      setReferencePromptDismissed(false);
      setSeriesDrafts((current) => {
        if (current.some((item) => item.column === REFERENCE_IRRADIANCE_COLUMN)) return current;
        return [
          ...current,
            {
              id: `series-reference-${Date.now()}`,
              column: REFERENCE_IRRADIANCE_COLUMN,
              sourceColumn: REFERENCE_IRRADIANCE_SOURCE,
              label: `${result.label} · ${result.mode}`,
              unit: result.unit,
              chartType: "line",
              color: getAutoColor(current.length),
              yAxis: "right",
          },
        ];
      });
    } catch (error) {
      setReferenceIrradianceError(error instanceof Error ? error.message : "Failed to fetch reference irradiance.");
    } finally {
      setIsFetchingReferenceIrradiance(false);
    }
  };

  const addSeries = () => {
    setSeriesDrafts((current) => [
      ...current,
      {
        id: `series-${current.length}-${Date.now()}`,
        column: "",
        label: "",
        unit: "",
        chartType: "line",
        color: getAutoColor(current.length),
        yAxis: current.length % 2 === 0 ? "left" : "right",
      },
    ]);
  };

  const updateSeriesFromOption = (id: string, optionKeyOrColumn: string) => {
    const option = plotOptions.find((item) => item.key === optionKeyOrColumn || item.column === optionKeyOrColumn);
    if (!option) {
      updateSeries(id, { column: "", sourceColumn: undefined, derivedMetric: undefined, capacityKwp: undefined, label: "", unit: "" });
      return;
    }
    updateSeries(id, {
      column: option.column,
      sourceColumn: option.sourceColumn,
      derivedMetric: option.derivedMetric,
      capacityKwp: option.capacityKwp,
      label: option.label,
      unit: getDefaultUnitForOption(option, option.column),
      chartType: /irradi|ghi|poa|specific_yield/i.test(option.column) ? "line" : "bar",
      yAxis: /irradi|ghi|poa|temp|specific_yield/i.test(option.column) ? "right" : "left",
    });
  };

  const updateSeries = (id: string, patch: Partial<SeriesDraft>) => {
    setSeriesDrafts((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const removeSeries = (id: string) => {
    setSeriesDrafts((current) => current.filter((item) => item.id !== id));
  };

  const lastClickedKeyRef = useRef<string | null>(null);

  const makeDraftFromOption = (option: PlotOption, index: number): SeriesDraft => ({
    id: `series-${index}-${Date.now()}`,
    column: option.column,
    sourceColumn: option.sourceColumn,
    derivedMetric: option.derivedMetric,
    capacityKwp: option.capacityKwp,
    label: option.label,
    unit: getDefaultUnitForOption(option, option.column),
    chartType: /irradi|ghi|poa|specific_yield/i.test(option.column) ? "line" : "bar",
    color: getAutoColor(index),
    yAxis: /irradi|ghi|poa|temp|specific_yield/i.test(option.column) ? "right" : "left",
  });

  const toggleColumnSelection = (column: string, event?: React.MouseEvent) => {
    // Shift-click: select all items between the last clicked tag and this one
    if (event?.shiftKey && lastClickedKeyRef.current !== null) {
      const anchorIdx = filteredPlotOptions.findIndex(
        (item) => item.key === lastClickedKeyRef.current || item.column === lastClickedKeyRef.current
      );
      const targetIdx = filteredPlotOptions.findIndex(
        (item) => item.key === column || item.column === column
      );
      if (anchorIdx !== -1 && targetIdx !== -1 && anchorIdx !== targetIdx) {
        const start = Math.min(anchorIdx, targetIdx);
        const end = Math.max(anchorIdx, targetIdx);
        const rangeOptions = filteredPlotOptions.slice(start, end + 1);
        setSeriesDrafts((current) => {
          let updated = [...current];
          for (const opt of rangeOptions) {
            if (!updated.find((item) => item.column === opt.column)) {
              updated = [...updated, makeDraftFromOption(opt, updated.length)];
            }
          }
          return updated;
        });
        return;
      }
    }

    // Normal click: toggle the single tag
    lastClickedKeyRef.current = column;
    setSeriesDrafts((current) => {
      const option = plotOptions.find((item) => item.key === column || item.column === column);
      if (!option) return current;
      const existing = current.find((item) => item.column === option.column);
      if (existing) {
        if (current.length === 1) return current;
        return current.filter((item) => item.id !== existing.id);
      }
      return [...current, makeDraftFromOption(option, current.length)];
    });
  };

  const selectAllColumns = () => {
    setSeriesDrafts(
      plotOptions.map((option, index) => ({
        id: `series-all-${index}-${option.key}`,
        column: option.column,
        sourceColumn: option.sourceColumn,
        derivedMetric: option.derivedMetric,
        capacityKwp: option.capacityKwp,
        label: option.label,
        unit: getDefaultUnitForOption(option, option.column),
        chartType: /irradi|ghi|poa|specific_yield/i.test(option.column) ? "line" : "bar",
        color: getAutoColor(index),
        yAxis: /irradi|ghi|poa|temp|specific_yield/i.test(option.column) ? "right" : "left",
      }))
    );
  };

  const clearSeries = () => {
    setSeriesDrafts([
      {
        id: `series-clear-${Date.now()}`,
        column: "",
        label: "",
        unit: "",
        chartType: "line",
        color: getAutoColor(0),
        yAxis: "left",
      },
    ]);
  };

  const applyChartTypeToAll = () => {
    setSeriesDrafts((current) =>
      current.map((item) => ({
        ...item,
        chartType: bulkChartType,
      }))
    );
  };

  const convertSeriesToSpecificYield = () => {
    setSeriesDrafts((current) =>
      current.map((item) => {
        const specificYieldOption =
          (item.sourceColumn ? specificYieldBySourceColumn.get(item.sourceColumn) : undefined) ??
          specificYieldBySourceColumn.get(item.column);
        if (!specificYieldOption) return item;
        return {
          ...item,
          column: specificYieldOption.column,
          sourceColumn: specificYieldOption.sourceColumn,
          derivedMetric: specificYieldOption.derivedMetric,
          capacityKwp: specificYieldOption.capacityKwp,
          label: specificYieldOption.label,
          unit: specificYieldOption.unit ?? item.unit,
          chartType: "line",
          yAxis: "right",
        };
      })
    );
  };

  const convertSeriesToRawPower = () => {
    setSeriesDrafts((current) =>
      current.map((item) => {
        const sourceKey = item.sourceColumn ?? item.column;
        const rawPowerOption = rawPowerBySourceColumn.get(sourceKey);
        if (!rawPowerOption) return item;
        return {
          ...item,
          column: rawPowerOption.column,
          sourceColumn: rawPowerOption.sourceColumn,
          derivedMetric: rawPowerOption.derivedMetric,
          capacityKwp: rawPowerOption.capacityKwp,
          label: rawPowerOption.label,
          unit: rawPowerOption.unit ?? item.unit,
          yAxis: /irradi|ghi|poa|temp/i.test(rawPowerOption.column) ? "right" : "left",
        };
      })
    );
  };

  const updateConfirmedInverterMapping = (tag: string, sourceColumn: string) => {
    setConfirmedInverterMapping((current) => ({
      ...current,
      [tag]: sourceColumn,
    }));
  };

  const saveConfirmedInverterMapping = () => {
    if (!selectedSiteId) return;
    window.localStorage.setItem(
      getChartingMappingStorageKey(selectedSiteId),
      JSON.stringify(confirmedInverterMapping)
    );
  };

  const resetConfirmedInverterMapping = () => {
    if (selectedSiteId) {
      window.localStorage.removeItem(getChartingMappingStorageKey(selectedSiteId));
    }
    setConfirmedInverterMapping(autoMatchedInverterColumns);
  };

  const displayedRows = useMemo(() => {
    if (!chartResult?.rows) return [];
    if (!zoomDomain) return chartResult.rows;
    return chartResult.rows.slice(zoomDomain.startIndex, zoomDomain.endIndex + 1);
  }, [chartResult, zoomDomain]);

  const leftAxisLabel = useMemo(() => buildAxisLabel(renderedSeries, "left"), [renderedSeries]);
  const rightAxisLabel = useMemo(() => buildAxisLabel(renderedSeries, "right"), [renderedSeries]);
  const chartTitle = useMemo(() => buildChartTitle(renderedSeries), [renderedSeries]);
  const xAxisTicks = useMemo(() => buildShortRangeTicks(displayedRows, selectedRangeDays), [displayedRows, selectedRangeDays]);
  const displayedSeries = useMemo(() => renderedSeries.filter((series) => series.chartType === "line" || series.chartType === "bar"), [renderedSeries]);
  const focusedSeries = useMemo(() => renderedSeries.find((series) => series.column === focusedSeriesKey) ?? null, [focusedSeriesKey, renderedSeries]);
  const chartTimestamps = useMemo(() => chartResult?.rows.map((row) => String(row.timestamp)) ?? [], [chartResult]);
  const formatDisplayTimestamp = (value: string) => {
    const parsed = new Date(String(value));
    if (Number.isNaN(parsed.getTime())) return String(value);
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: selectedSiteTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(parsed);
  };
  const leftAxisDomain = useMemo(() => {
    let maxValue = 0;
    for (const row of displayedRows) {
      for (const series of displayedSeries) {
        if (series.yAxis !== "left") continue;
        const v = row[series.column];
        if (typeof v === "number" && Number.isFinite(v) && v > maxValue) maxValue = v;
      }
    }
    return [0, maxValue > 0 ? maxValue * 1.05 : 1] as [number, number];
  }, [displayedRows, displayedSeries]);
  const rightAxisDomain = useMemo(() => {
    let maxValue = 0;
    for (const row of displayedRows) {
      for (const series of displayedSeries) {
        if (series.yAxis !== "right") continue;
        const v = row[series.column];
        if (typeof v === "number" && Number.isFinite(v) && v > maxValue) maxValue = v;
      }
    }
    return [0, maxValue > 0 ? maxValue * 1.05 : 1] as [number, number];
  }, [displayedRows, displayedSeries]);
  const applyWheelZoom = (deltaY: number, clientX: number, rect: DOMRect) => {
    if (!chartTimestamps.length) return;
    const currentStartIndex = zoomDomain?.startIndex ?? 0;
    const currentEndIndex = zoomDomain?.endIndex ?? chartTimestamps.length - 1;
    const windowSize = currentEndIndex - currentStartIndex + 1;
    if (windowSize <= 1 && deltaY < 0) return;

    const ratio = rect.width > 0 ? Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1) : 0.5;
    const centerIndex = Math.round(currentStartIndex + ratio * Math.max(windowSize - 1, 0));
    const nextWindowSize = deltaY < 0
      ? Math.max(6, Math.floor(windowSize * 0.8))
      : Math.min(chartTimestamps.length, Math.ceil(windowSize * 1.25));
    if (nextWindowSize >= chartTimestamps.length) {
      setZoomDomain(null);
      return;
    }

    let nextStartIndex = Math.max(0, centerIndex - Math.floor(nextWindowSize / 2));
    let nextEndIndex = Math.min(chartTimestamps.length - 1, nextStartIndex + nextWindowSize - 1);
    nextStartIndex = Math.max(0, nextEndIndex - nextWindowSize + 1);
    setZoomDomain({ startIndex: nextStartIndex, endIndex: nextEndIndex });
  };

  return (
    <div className="relative z-0 min-h-[calc(100vh-4rem)] overflow-hidden" style={{ backgroundColor: "var(--bg-page)" }}>
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <Image src="/brand/reporting-hero.jpg" alt="" fill priority className="object-cover" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(7,18,32,0.45),rgba(3,10,20,0.88)_55%,rgba(2,8,16,0.96))] hero-overlay" />
      </div>

      <div className="relative z-0 px-8 py-8 hero-content">
        <BackLink href="/dashboard" label="Back to dashboard" />

        <div className="mt-4 rounded-[30px] border border-faint bg-panel p-8 backdrop-blur-sm">
          <h1 className="font-dolfines text-3xl font-semibold tracking-[0.08em] text-white">Charting</h1>
          <p className="mt-4 max-w-4xl text-sm leading-7 text-slate-200/82">
            Build your own plots without cluttering the guided diagnostics. Time stays on the X-axis by default, REVEAL adapts the time resolution to the selected period, and you can assign series to the left or right Y-axis before generating the chart.
          </p>
        </div>

        <div className="mt-6 space-y-5">
          <WorkflowPanel
            step="Step 1"
            title="Upload data"
            description="Drop one measured file here. REVEAL will analyse the structure, detect the likely timestamp column, and open the chart builder once the upload is ready."
            accent="from-sky-400/95 to-sky-600/70"
            summary={dataUploadedSummary}
            active={activeStep === 1}
            collapsed={collapsedSteps[1]}
            onToggle={() => setCollapsedSteps((current) => ({ ...current, 1: !current[1] }))}
          >
            <div className="mb-5 rounded-[24px] border border-faint bg-panel p-4">
              <label className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/45">Site for inverter capacities</label>
              <select
                value={selectedSiteId}
                onChange={(event) => setSelectedSiteId(event.target.value)}
                className="mt-1.5 h-10 w-full rounded-xl border border-subtle bg-white px-3 text-sm font-medium text-slate-900 focus:border-orange-DEFAULT focus:outline-none"
              >
                <option value="">No site selected</option>
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.display_name}
                  </option>
                ))}
              </select>
              <p className="mt-2 text-sm text-slate-300/78">
                Select the site if you want REVEAL to use the saved site configuration to improve the charting context and any derived metrics it can offer.
              </p>
              {selectedSiteId && selectedSiteHasBess ? (
                <div className="mt-3 rounded-2xl border border-sky-300/16 bg-sky-400/8 px-4 py-3 text-sm leading-6 text-sky-50/92">
                  Hybrid PV + BESS mode is active for this site. REVEAL will help you chart battery state of charge, battery charge/discharge power, grid import/export, and house load alongside PV production when those signals are present in the uploaded file.
                </div>
              ) : null}
              {selectedSiteId && siteSetupIssues.length > 0 ? (
                <div className="mt-3 rounded-2xl border border-amber-300/18 bg-amber-400/10 px-4 py-3 text-sm leading-6 text-amber-50">
                  Set up the site fully to obtain the best results here. REVEAL is still missing:{" "}
                  <span className="font-semibold text-white">{siteSetupIssues.slice(0, 4).join(", ")}</span>
                  {siteSetupIssues.length > 4 ? ` and ${siteSetupIssues.length - 4} more item${siteSetupIssues.length - 4 === 1 ? "" : "s"}` : ""}.
                </div>
              ) : null}
              {selectedSiteId && siteCapacities.some((item) => item.resolvedCapacityKwp > 0) ? (
                <p className="mt-2 text-sm text-slate-300/82">
                  REVEAL found {siteCapacities.filter((item) => item.resolvedCapacityKwp > 0).length} configured inverter DC capacities for this site and matched {matchedSpecificYieldCount}
                  {" "}uploaded inverter signal{matchedSpecificYieldCount === 1 ? "" : "s"} for
                  specific-yield series in kWh/kWp alongside raw inverter power. Look for paired items such as <span className="font-semibold text-nav-active">{siteCapacities.find((item) => item.resolvedCapacityKwp > 0)?.tag ?? "INV1"} power</span> and <span className="font-semibold text-nav-active">{siteCapacities.find((item) => item.resolvedCapacityKwp > 0)?.tag ?? "INV1"} specific yield (kWh/kWp)</span> in the detected and derived plot items list.
                </p>
              ) : null}
              {selectedSiteId && siteCapacities.some((item) => item.resolvedCapacityKwp > 0) && matchedSpecificYieldCount === 0 ? (
                <div className="mt-3 rounded-2xl border border-amber-300/18 bg-amber-400/10 px-4 py-3 text-sm leading-6 text-amber-50">
                  REVEAL could not match the configured inverter tags to the uploaded power columns yet. I’ve broadened the matching logic, but this upload still shows <span className="font-semibold text-white">0 matched inverter signals</span>.
                  {unmatchedSpecificYieldTags.length > 0 ? (
                    <> Unmatched examples: <span className="font-semibold text-white">{unmatchedSpecificYieldTags.join(", ")}</span>.</>
                  ) : null}
                </div>
              ) : null}
              {selectedSiteId && siteCapacities.some((item) => item.resolvedCapacityKwp > 0) && candidatePowerColumns.length > 0 ? (
                <div className="mt-4 rounded-[20px] border border-faint bg-row p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/55">Inverter match confirmation</p>
                      <p className="mt-1 text-sm text-slate-300/82">
                        REVEAL has made a best guess. Confirm which uploaded power column matches each configured inverter before using specific yield.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <span className="rounded-full border border-faint bg-panel px-3 py-1 text-xs font-semibold text-slate-100">
                        {matchedSpecificYieldCount} / {matchedSiteCapacities.length} matched
                      </span>
                      <Button variant="secondary" size="sm" onClick={saveConfirmedInverterMapping}>
                        Save mapping
                      </Button>
                      <Button variant="ghost" size="sm" onClick={resetConfirmedInverterMapping}>
                        Reset guesses
                      </Button>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-1.5 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                    {matchedSiteCapacities.map((item) => (
                      <div key={item.tag} className="rounded-xl border border-weak bg-panel px-2.5 py-2">
                        <label className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/45">{item.tag}</label>
                        <select
                          value={confirmedInverterMapping[item.tag] ?? item.matchedColumn ?? ""}
                          onChange={(event) => updateConfirmedInverterMapping(item.tag, event.target.value)}
                          className="mt-1 h-8 w-full rounded-lg border border-subtle bg-white px-2.5 text-sm font-medium text-slate-900 focus:border-orange-DEFAULT focus:outline-none"
                        >
                          <option value="">No match selected</option>
                          {candidatePowerColumns.map((column) => (
                            <option key={`${item.tag}-${column}`} value={column}>
                              {column}
                            </option>
                          ))}
                        </select>
                        <p className="mt-1 text-[11px] text-slate-300/78">
                          {item.resolvedCapacityKwp.toFixed(2)} kWp configured
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
            <div
              {...getRootProps()}
              className={`rounded-[24px] border border-dashed px-6 py-10 text-center transition ${
                isDragActive ? "border-sky-300/80 bg-sky-400/10" : "border-subtle bg-row"
              }`}
            >
              <input {...getInputProps()} />
              <p className="text-sm font-semibold">{isDragActive ? "Drop the charting data here…" : "Drag & drop one SCADA file, or click to select"}</p>
              <p className="mt-2 text-sm text-slate-300/78">Accepted formats: CSV, XLS, XLSX. REVEAL will detect the timestamp and available numeric columns automatically.</p>
              {uploadFeedback ? (
                <div
                  className={`mt-3 rounded-2xl border px-4 py-3 text-sm leading-6 ${
                    uploadFeedback.tone === "error"
                      ? "border-red-300/30 bg-red-500/10 text-danger"
                      : uploadFeedback.tone === "success"
                        ? "border-emerald-300/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
                        : "border-orange-300/30 bg-orange-500/10 text-orange-700 dark:text-orange-200"
                  }`}
                >
                  {uploadFeedback.message}
                </div>
              ) : null}
              {file ? (
                <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-faint bg-row px-4 py-2 text-sm font-semibold text-slate-100">
                  {file.name}
                </div>
              ) : null}
            </div>

            {isDetecting || detection ? (
              <div className="mt-5 rounded-[22px] border border-sky-300/20 bg-sky-400/10 p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="progress-label text-[11px] font-semibold uppercase tracking-[0.28em]">Measured data analysis</p>
                  <span className="progress-pill rounded-full px-3 py-1 text-xs font-semibold">{Math.round(detectionProgress)}%</span>
                </div>
                <div className="progress-track mt-3 h-2 overflow-hidden rounded-full">
                  <div className="progress-fill h-full rounded-full" style={{ width: `${Math.max(detectionProgress, 4)}%` }} />
                </div>
                <p className="progress-copy mt-3 text-sm">{detectionLabel || "REVEAL is preparing the charting upload."}</p>
              </div>
            ) : null}

            {detectionError ? (
                <div className="mt-5 rounded-[22px] border border-red-300/25 bg-red-500/10 p-4 text-sm leading-7 text-danger">
                  {detectionError}
                </div>
            ) : null}
          </WorkflowPanel>

          <WorkflowPanel
            step="Step 2"
            title="Choose worksheet"
            description="If the uploaded workbook contains more than one tab, tell REVEAL which worksheet should be analysed before opening the chart builder."
            accent="from-cyan-400/95 to-cyan-600/70"
            summary={
              needsWorksheetSelection
                ? worksheetSelectionConfirmed
                  ? `Worksheet ${selectedWorksheet || detection?.selected_worksheet || "selected"} is ready for charting.`
                  : "Select the worksheet that contains the measured data you want to chart."
                : "Worksheet selection is skipped when the upload contains a single tab or a CSV file."
            }
            active={activeStep === 2}
            collapsed={!needsWorksheetSelection || collapsedSteps[2]}
            onToggle={() => setCollapsedSteps((current) => ({ ...current, 2: !current[2] }))}
            toggleable={needsWorksheetSelection}
          >
            {needsWorksheetSelection && detection ? (
              <div className="space-y-4">
                <div className="rounded-[24px] border border-faint bg-panel p-4">
                  <label className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/45">Worksheet to analyse</label>
                  <select
                    value={selectedWorksheet}
                    onChange={(event) => {
                      setSelectedWorksheet(event.target.value);
                      setWorksheetSelectionConfirmed(false);
                    }}
                    className="mt-1.5 h-10 w-full rounded-xl border border-subtle bg-white px-3 text-sm font-medium text-slate-900 focus:border-orange-DEFAULT focus:outline-none"
                  >
                    {worksheetOptions.map((worksheet) => (
                      <option key={worksheet} value={worksheet}>
                        {worksheet}
                      </option>
                    ))}
                  </select>
                  <p className="mt-2 text-sm text-slate-300/78">
                    REVEAL detected {worksheetOptions.length} tabs in this workbook. Choose the one that contains the measured SCADA data before continuing.
                  </p>
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <Button onClick={() => void applyWorksheetSelection()} disabled={!selectedWorksheet || isDetecting}>
                      {isDetecting ? "Analysing worksheet…" : "Use this worksheet"}
                    </Button>
                    {worksheetSelectionConfirmed && selectedWorksheet ? (
                      <span className="text-sm text-emerald-200/90">REVEAL is now pointed at {selectedWorksheet}.</span>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
          </WorkflowPanel>

          <WorkflowPanel
            step="Step 3"
            title="Choose data and generate chart"
            description="Pick the timestamp, the period you want to view, the chart type for each series, and the colors. Then generate the chart directly in REVEAL."
            accent="from-violet-400/95 to-violet-600/70"
            summary={
              canOpenChartBuilder
                ? `Set the period, choose the series, and click ${chartResult ? "Update chart" : "Generate chart"}. REVEAL will render the result directly in the page.`
                : needsWorksheetSelection
                ? "Step 3 opens once the workbook tab has been selected."
                : "Step 3 opens once the uploaded file has been analysed."
            }
            active={activeStep === 3}
            collapsed={false}
            onToggle={() => undefined}
            toggleable={false}
          >
            {canOpenChartBuilder && detection ? (
              <>
                <div className="space-y-4">
                  <div className="rounded-[24px] border border-faint bg-panel p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/55">Chart controls</p>
                      <Button variant="ghost" size="sm" onClick={() => setChartControlsCollapsed((current) => !current)}>
                        {chartControlsCollapsed ? "Expand controls" : "Collapse controls"}
                      </Button>
                    </div>
                    {!chartControlsCollapsed ? (
                      <>
                        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                          <div>
                            <label className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/45">Timestamp column</label>
                            <select
                              value={timestampColumn}
                              onChange={(event) => setTimestampColumn(event.target.value)}
                              className="mt-1.5 h-10 w-full rounded-xl border border-subtle bg-white px-3 text-sm font-medium text-slate-900 focus:border-orange-DEFAULT focus:outline-none"
                            >
                              {availableColumns.map((column) => (
                                <option key={column} value={column}>
                                  {column}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/45">Time resolution</label>
                            <select
                              value={aggregation}
                              onChange={(event) => setAggregation(event.target.value as "auto" | "raw" | "hourly" | "daily" | "monthly")}
                              className="mt-1.5 h-10 w-full rounded-xl border border-subtle bg-white px-3 text-sm font-medium text-slate-900 focus:border-orange-DEFAULT focus:outline-none"
                            >
                              <option value="auto">Auto</option>
                              <option value="raw">Raw interval</option>
                              <option value="hourly">Hourly</option>
                              <option value="daily">Daily</option>
                              <option value="monthly">Monthly</option>
                            </select>
                          </div>
                          <DateFieldPicker
                            label="Start date"
                            value={startDate}
                            onChange={setStartDate}
                            min={resolvedDetectedRange?.[0]}
                            max={endDate || resolvedDetectedRange?.[1]}
                          />
                          <DateFieldPicker
                            label="End date"
                            value={endDate}
                            onChange={setEndDate}
                            min={startDate || resolvedDetectedRange?.[0]}
                            max={resolvedDetectedRange?.[1]}
                          />
                        </div>
                        <div className="mt-3 rounded-2xl border border-weak bg-row px-4 py-2.5 text-sm text-slate-200/82">
                          Data range detected: <span className="font-semibold text-white">{isLoadingTimeRange && !resolvedDetectedRange ? "Analysing selected timestamp column..." : formatDateRange(resolvedDetectedRange)}</span>. REVEAL will currently use <span className="font-semibold text-white">{effectiveAggregation}</span> resolution for the selected period.
                        </div>
                      </>
                    ) : (
                      <div className="mt-3 rounded-2xl border border-weak bg-row px-4 py-2.5 text-sm text-slate-200/82">
                        Chart controls are collapsed so the chart and series builder can stay in view.
                      </div>
                    )}
                  </div>

                  {shouldOfferReferenceIrradiance ? (
                    <div className="rounded-[24px] border border-sky-300/18 bg-sky-400/8 p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-sky-100/78">Reference irradiance</p>
                      <p className="mt-2 text-sm leading-7 text-sky-50/92">
                        No irradiance data was detected in this file. Do you want REVEAL to pull reference irradiance from ERA5-Land for this site?
                      </p>
                      <p className="mt-2 text-sm text-sky-100/78">
                        The fetched series will be labelled as reference irradiance and can be plotted alongside the uploaded site data.
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button variant="secondary" size="sm" onClick={fetchReferenceIrradiance} disabled={isFetchingReferenceIrradiance}>
                          {isFetchingReferenceIrradiance ? "Pulling ERA irradiance…" : "Use ERA reference irradiance"}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setReferencePromptDismissed(true)}>
                          Continue without irradiance
                        </Button>
                      </div>
                      {referenceIrradianceError ? (
                        <p className="mt-3 text-sm text-amber-100">{referenceIrradianceError}</p>
                      ) : null}
                    </div>
                  ) : null}

                  {referenceIrradiance ? (
                    <div className="rounded-[24px] border border-emerald-300/16 bg-emerald-400/8 p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-emerald-100/78">Reference irradiance ready</p>
                      <p className="mt-2 text-sm leading-7 text-emerald-50/92">
                        REVEAL fetched <span className="font-semibold text-white">{referenceIrradiance.label}</span> in <span className="font-semibold text-white">{referenceIrradiance.mode}</span> mode for this site and period.
                      </p>
                      <p className="mt-2 text-sm text-emerald-100/78">
                        Look for the reference irradiance series in the detected and derived plot items list.
                      </p>
                    </div>
                  ) : null}

                  <div className="rounded-[24px] border border-faint bg-panel p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/55">Series builder</p>
                      <div className="flex flex-wrap gap-2">
                        <Button variant="secondary" size="sm" onClick={selectAllColumns}>
                          Select all
                        </Button>
                        <Button variant="ghost" size="sm" onClick={clearSeries}>
                          Clear
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setSeriesBuilderCollapsed((current) => !current)}>
                          {seriesBuilderCollapsed ? "Expand series" : "Collapse series"}
                        </Button>
                      </div>
                    </div>
                    {!seriesBuilderCollapsed ? (
                      <>
                        <div className="mt-3 flex flex-wrap items-end gap-3 rounded-2xl border border-weak bg-[rgba(255,255,255,0.03)] p-3">
                          <div className="min-w-[180px] flex-1">
                            <label className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/45">Chart type for all</label>
                            <select
                              value={bulkChartType}
                              onChange={(event) => setBulkChartType(event.target.value as "line" | "bar")}
                              className="mt-1.5 h-10 w-full rounded-xl border border-subtle bg-white px-3 text-sm font-medium text-slate-900 focus:border-orange-DEFAULT focus:outline-none"
                            >
                              <option value="line">Line</option>
                              <option value="bar">Bar</option>
                            </select>
                          </div>
                          <div className="flex gap-2">
                            <Button variant="secondary" size="sm" onClick={applyChartTypeToAll}>
                              Apply to all
                            </Button>
                            {hasSpecificYieldOptions ? (
                              <Button variant="secondary" size="sm" onClick={convertSeriesToSpecificYield}>
                                Use specific yield
                              </Button>
                            ) : null}
                            {hasSpecificYieldOptions ? (
                              <Button variant="ghost" size="sm" onClick={convertSeriesToRawPower}>
                                Use raw power
                              </Button>
                            ) : null}
                            <Button variant="ghost" size="sm" onClick={addSeries}>
                              Add row
                            </Button>
                          </div>
                        </div>
                        {hasSpecificYieldOptions ? (
                          <p className="mt-2 text-sm text-slate-300/78">
                            <span className="font-semibold text-white">Use specific yield</span> converts selected inverter power series into their paired normalized <span className="font-semibold text-white">kWh/kWp</span> series. <span className="font-semibold text-white">Use raw power</span> switches them back.
                          </p>
                        ) : null}
                        <div className="mt-3">
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/55">Detected and derived plot items</p>
                            <div className="flex items-center gap-2">
                              <span className="rounded-full border border-faint bg-row px-3 py-1 text-xs font-semibold text-slate-100">
                                {cleanedSeries.length} selected
                              </span>
                              <Button variant="ghost" size="sm" onClick={() => setPlotItemsExpanded((current) => !current)}>
                                {plotItemsExpanded ? "Compact list" : "Expand list"}
                              </Button>
                            </div>
                          </div>
                          <div className="mt-3 flex flex-wrap items-center gap-3">
                            <div className="min-w-[220px] flex-1">
                              <input
                                value={plotSearch}
                                onChange={(event) => setPlotSearch(event.target.value)}
                                onFocus={selectAllOnFocus}
                                placeholder="Filter tags or derived items"
                                className="h-9 w-full rounded-xl border border-subtle bg-white px-3 text-sm font-medium text-slate-900 placeholder:text-slate-400 focus:border-orange-DEFAULT focus:outline-none"
                              />
                            </div>
                            <p className="text-xs text-slate-300/75">
                              {filteredPlotOptions.length} of {plotOptions.length} items shown
                            </p>
                          </div>
                          <div className={`mt-3 overflow-y-auto rounded-2xl border border-weak bg-[rgba(255,255,255,0.02)] p-2 ${plotItemsExpanded ? "max-h-[360px]" : "max-h-[120px]"}`}>
                            <div className="grid gap-1 md:grid-cols-4 xl:grid-cols-8">
                            {filteredPlotOptions.map((option) => {
                              const selected = cleanedSeries.some((item) => item.column === option.column);
                              return (
                                <button
                                  key={option.key}
                                  type="button"
                                  onClick={(e) => toggleColumnSelection(option.key, e)}
                                  className={`rounded-lg border px-2 py-1 text-left text-[11px] font-medium transition ${
                                    selected
                                      ? "selection-chip-selected"
                                      : "border-faint bg-row text-slate-200/82 hover:border-white/20 hover:text-white"
                                  }`}
                                >
                                  {option.label}
                                </button>
                              );
                            })}
                            </div>
                          </div>
                        </div>
                        <div className="mt-3 overflow-y-auto rounded-2xl border border-weak bg-[rgba(255,255,255,0.02)] p-2 max-h-[280px]">
                          <div className="space-y-1.5">
                            {seriesDrafts.map((item) => (
                              <div
                                key={item.id}
                                className="rounded-2xl border border-weak bg-[rgba(255,255,255,0.035)] px-3 py-1.5"
                              >
                                <div className="grid gap-1.5 xl:grid-cols-[minmax(0,2.45fr)_minmax(110px,0.82fr)_minmax(132px,0.92fr)_minmax(110px,0.72fr)_88px_auto] xl:items-center">
                                  <select
                                    value={item.column}
                                    onChange={(event) => updateSeriesFromOption(item.id, event.target.value)}
                                    className="h-8 rounded-xl border border-subtle bg-white px-3 text-sm font-medium text-slate-900 focus:border-orange-DEFAULT focus:outline-none"
                                  >
                                    <option value="">Select column…</option>
                                    {plotOptions.map((option) => (
                                      <option key={option.key} value={option.column}>
                                        {option.label}
                                      </option>
                                    ))}
                                  </select>
                                  <select
                                    value={item.chartType}
                                    onChange={(event) => updateSeries(item.id, { chartType: event.target.value as "line" | "bar" })}
                                    className="h-8 rounded-xl border border-subtle bg-white px-3 text-sm font-medium text-slate-900 focus:border-orange-DEFAULT focus:outline-none"
                                  >
                                    <option value="line">Line</option>
                                    <option value="bar">Bar</option>
                                  </select>
                                  <select
                                    value={item.yAxis}
                                    onChange={(event) => updateSeries(item.id, { yAxis: event.target.value as "left" | "right" })}
                                    className="h-8 rounded-xl border border-subtle bg-white px-3 text-sm font-medium text-slate-900 focus:border-orange-DEFAULT focus:outline-none"
                                  >
                                    <option value="left">Left axis</option>
                                    <option value="right">Right axis</option>
                                  </select>
                                  <input
                                    type="text"
                                    value={item.unit ?? ""}
                                    onChange={(event) => updateSeries(item.id, { unit: event.target.value })}
                                    onFocus={selectAllOnFocus}
                                    placeholder="Unit"
                                    className="h-8 rounded-xl border border-subtle bg-white px-3 text-sm font-medium text-slate-900 placeholder:text-slate-400 focus:border-orange-DEFAULT focus:outline-none"
                                  />
                                  <input
                                    type="color"
                                    value={item.color}
                                    onChange={(event) => updateSeries(item.id, { color: event.target.value })}
                                    className="h-8 w-full rounded-xl border border-subtle bg-white px-1.5 py-1.5"
                                  />
                                  <div className="flex justify-end">
                                    <Button variant="ghost" size="sm" onClick={() => removeSeries(item.id)} disabled={seriesDrafts.length === 1}>
                                      Remove
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="mt-3 rounded-2xl border border-weak bg-row px-4 py-2.5 text-sm text-slate-200/82">
                        Series builder is collapsed so the chart can take center stage.
                      </div>
                    )}
                    <div className="mt-3">
                      <Button variant="primary" className="font-semibold text-white" onClick={generateChart} disabled={!canGenerateChart}>
                        {chartResult ? "Update chart" : "Generate chart"}
                      </Button>
                    </div>
                  </div>
                </div>

                {isGeneratingChart || chartResult ? (
                  <div className="mt-5 rounded-[22px] border border-violet-300/20 bg-violet-400/10 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="progress-label text-[11px] font-semibold uppercase tracking-[0.28em]">Chart generation</p>
                      <span className="progress-pill rounded-full px-3 py-1 text-xs font-semibold">{Math.round(chartProgress)}%</span>
                    </div>
                    <div className="progress-track mt-3 h-2 overflow-hidden rounded-full">
                      <div className="progress-fill h-full rounded-full" style={{ width: `${Math.max(chartProgress, 4)}%` }} />
                    </div>
                    <p className="progress-copy mt-3 text-sm">{chartLabel || "REVEAL is preparing your chart."}</p>
                  </div>
                ) : null}

                {chartError ? (
                  <div className="mt-5 rounded-[22px] border border-red-300/25 bg-red-500/10 p-4 text-sm leading-7 text-danger">
                    {chartError}
                  </div>
                ) : null}

                {chartResult ? (() => {
                  const chartPanel = (
                    <>
                    {expandedChart ? <div className="fixed inset-0 z-[90] bg-[rgba(2,10,18,0.78)] backdrop-blur-sm" /> : null}
                    <div className={`${expandedChart ? "fixed inset-4 z-[100] flex h-[calc(100vh-2rem)] flex-col overflow-hidden rounded-[26px]" : "mt-5"} rounded-[26px] border border-faint bg-panel p-5`}>
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/55">Generated chart</p>
                        <h3 className="mt-2 font-dolfines text-[1.45rem] font-semibold tracking-[0.04em] text-white">{chartTitle}</h3>
                        <p className="mt-2 text-sm leading-7 text-slate-200/82">
                          {chartResult.summary.aggregation} view across {formatDateRange(chartResult.summary.dateRange)} with {chartResult.summary.rowCount.toLocaleString()} chart points.
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {focusedSeries ? (
                          <div className="rounded-full border border-sky-300/20 bg-sky-400/10 px-3 py-1.5 text-xs font-semibold text-sky-100">
                            Focused series: {getSeriesDisplayLabel(focusedSeries)}
                          </div>
                        ) : null}
                        {focusedSeries ? (
                          <Button variant="ghost" size="sm" onClick={() => setFocusedSeriesKey(null)}>
                            Clear focus
                          </Button>
                        ) : null}
                        {zoomDomain ? (
                          <Button variant="secondary" size="sm" onClick={() => setZoomDomain(null)}>
                            Reset zoom
                          </Button>
                        ) : null}
                        <Button variant="ghost" size="sm" onClick={() => setExpandedChart((current) => !current)}>
                          {expandedChart ? "Minimise" : "Expand to screen"}
                        </Button>
                      </div>
                    </div>
                    <div className="mt-3 rounded-2xl border border-weak bg-row px-4 py-2.5 text-sm text-slate-200/82">
                      Use the mouse wheel to zoom in and out on the chart. Click a line or bar to focus that equipment and make it easier to identify.
                    </div>
                    <div
                      className={`mt-5 grid min-h-0 flex-1 gap-4 ${expandedChart ? "xl:grid-cols-[minmax(0,1fr)_400px]" : "xl:grid-cols-[minmax(0,1fr)_360px]"}`}
                    >
                      <div
                        ref={chartWheelContainerRef}
                        className={`min-h-0 overscroll-contain rounded-[24px] border border-faint bg-[rgba(255,255,255,0.03)] p-5 ${expandedChart ? "h-full" : "h-[780px]"}`}
                        style={{ overscrollBehavior: "none" }}
                        onWheel={(event) => {
                          if (!chartTimestamps.length) return;
                          event.preventDefault();
                          applyWheelZoom(event.deltaY, event.clientX, event.currentTarget.getBoundingClientRect());
                        }}
                      >
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart
                          data={displayedRows}
                          margin={{ top: 18, right: 24, left: 8, bottom: 34 }}
                          onMouseMove={(state) => {
                            const activeLabel = state?.activeLabel ? String(state.activeLabel) : "";
                            const activePayload = (state?.activePayload ?? [])
                              .filter((item): item is { dataKey?: string; name?: string; value?: number | string; color?: string } => Boolean(item))
                              .map((item) => ({
                                key: String(item.dataKey ?? item.name ?? ""),
                                name: String(item.name ?? item.dataKey ?? ""),
                                value: item.value ?? "",
                                color: item.color,
                              }));
                            if (activeLabel && activePayload.length) {
                              setHoverSnapshot({ label: activeLabel, values: activePayload });
                            }
                          }}
                          >
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-axis-grid)" />
                          {/* Render only the cursor line — values are shown in the sidebar */}
                          <Tooltip
                            content={() => null}
                            cursor={{ stroke: "rgba(255,255,255,0.45)", strokeWidth: 1.5, strokeDasharray: "4 3" }}
                            wrapperStyle={{ pointerEvents: "none" }}
                          />
                          <XAxis
                            dataKey="timestamp"
                            ticks={xAxisTicks}
                            tick={<ChartTimeTick rangeDays={selectedRangeDays} timeZone={selectedSiteTimezone} />}
                            minTickGap={selectedRangeDays <= 7 ? 14 : 24}
                            axisLine={{ stroke: "var(--chart-axis-line)" }}
                            tickLine={false}
                            label={{ value: "Time", position: "insideBottom", offset: -8, fill: "var(--chart-axis-text-strong)", fontSize: 11 }}
                          />
                          <YAxis yAxisId="left" width={44} tickFormatter={formatAxisTick} tick={{ fill: "var(--chart-axis-text-strong)", fontSize: 11 }} domain={leftAxisDomain} axisLine={{ stroke: "var(--chart-axis-line)" }} tickLine={false} label={{ value: leftAxisLabel, angle: -90, position: "insideLeft", dy: 18, dx: -4, fill: "var(--chart-axis-text-strong)", fontSize: 11 }} />
                          {hasRightAxisSeries ? (
                            <YAxis yAxisId="right" width={44} tickFormatter={formatAxisTick} domain={rightAxisDomain} orientation="right" tick={{ fill: "var(--chart-axis-text-strong)", fontSize: 11 }} axisLine={{ stroke: "var(--chart-axis-line)" }} tickLine={false} label={{ value: rightAxisLabel, angle: 90, position: "insideRight", dy: 16, dx: 4, fill: "var(--chart-axis-text-strong)", fontSize: 11 }} />
                          ) : null}
                          <Legend
                            verticalAlign="bottom"
                            align="center"
                            content={(props) => (
                              <RevealLegend
                                payload={props.payload as Array<{ value?: string; color?: string; dataKey?: string }>}
                                focusedSeriesKey={focusedSeriesKey}
                                onSelect={(seriesKey) => setFocusedSeriesKey((current) => (current === seriesKey ? null : seriesKey))}
                              />
                            )}
                          />
                          {renderedSeries
                            .filter((series) => series.chartType === "bar")
                            .map((series) => (
                              <Bar
                                key={series.column}
                                yAxisId={series.yAxis}
                                dataKey={series.column}
                                name={getSeriesDisplayLabel(series)}
                                fill={series.color}
                                fillOpacity={focusedSeriesKey && focusedSeriesKey !== series.column ? 0.28 : 0.42}
                                radius={[4, 4, 0, 0]}
                                onClick={() => setFocusedSeriesKey(series.column)}
                              />
                            ))}
                          {renderedSeries
                            .filter((series) => series.chartType === "line")
                            .map((series) => (
                              <Line
                                key={series.column}
                                yAxisId={series.yAxis}
                                type="monotone"
                                dataKey={series.column}
                                name={getSeriesDisplayLabel(series)}
                                stroke={series.color}
                                strokeWidth={focusedSeriesKey === series.column ? 3.6 : 2.4}
                                strokeOpacity={focusedSeriesKey && focusedSeriesKey !== series.column ? 0.30 : 1}
                                activeDot={{ r: focusedSeriesKey === series.column ? 5 : 4 }}
                                onClick={() => setFocusedSeriesKey(series.column)}
                                dot={false}
                                isAnimationActive={false}
                              />
                            ))}
                        </ComposedChart>
                      </ResponsiveContainer>
                      </div>
                      <aside className={`flex min-h-0 flex-col overflow-hidden rounded-[24px] border border-faint bg-[rgba(255,255,255,0.03)] p-4 ${expandedChart ? "h-full" : "h-[780px]"}`}>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/55">Live values</p>
                        <p className="mt-2 text-sm text-slate-200/82">
                          {hoverSnapshot ? `Values at ${formatDisplayTimestamp(hoverSnapshot.label)}` : "Move across the chart to update values here without a floating hover box getting in the way."}
                        </p>
                        {hoverSnapshot ? (
                          <div className="mt-4 grid min-h-0 flex-1 content-start gap-1.5 overflow-y-auto pr-1 md:grid-cols-2 xl:grid-cols-2">
                            {hoverSnapshot.values.map((item) => {
                              const isFocused = focusedSeriesKey === item.key;
                              const isMuted = Boolean(focusedSeriesKey && !isFocused);
                              const matchingSeries = renderedSeries.find((series) => series.column === item.key);
                              return (
                                <button
                                  key={`${item.key}-${item.name}`}
                                  type="button"
                                  onClick={() => setFocusedSeriesKey((current) => (current === item.key ? null : item.key))}
                                  className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition ${
                                    isFocused
                                      ? "border-sky-300/60 lv-focused-chip text-white"
                                      : isMuted
                                        ? "border-weak bg-white/0 text-white/45"
                                        : "border-faint bg-white/0 text-slate-100 hover:border-white/20 hover:text-white"
                                  }`}
                                  title={`${item.name}: ${typeof item.value === "number"
                                    ? `${item.value.toFixed(2)}${matchingSeries?.unit ? ` ${matchingSeries.unit}` : ""}`
                                    : item.value}`}
                                >
                                  <span className="flex min-w-0 items-center gap-2">
                                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color ?? "#fff" }} />
                                    <span className="truncate text-[11px] font-medium leading-4">{item.name}</span>
                                  </span>
                                  <span className="text-[11px] font-semibold tabular-nums">
                                    {typeof item.value === "number"
                                      ? `${item.value.toFixed(2)}${matchingSeries?.unit ? ` ${matchingSeries.unit}` : ""}`
                                      : item.value}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        ) : null}
                      </aside>
                    </div>
                  </div>
                  </>
                  );
                  return expandedChart && isMounted ? createPortal(chartPanel, document.body) : chartPanel;
                })() : null}
              </>
            ) : (
              <div className="rounded-[22px] border border-faint bg-[rgba(255,255,255,0.04)] p-4 text-sm leading-7 text-slate-200/84">
                Upload one file in Step 1 and REVEAL will open the chart builder here automatically.
              </div>
            )}
          </WorkflowPanel>
        </div>
      </div>
    </div>
  );
}
