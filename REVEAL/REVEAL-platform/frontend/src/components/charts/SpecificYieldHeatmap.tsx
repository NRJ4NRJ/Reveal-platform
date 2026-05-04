"use client";

import { useMemo, useState } from "react";

interface SpecificYieldHeatmapProps {
  data: Array<{ month: string; inv_id: string; yield_kwh_kwp: number }>;
}

interface HoveredCell {
  invId: string;
  month: string;
  value?: number;
  x: number;
  y: number;
}

function formatMonthLabel(month: string) {
  const [year, monthPart] = month.split("-");
  if (!year || !monthPart) return month;
  return `${monthPart}/${year.slice(-2)}`;
}

function interpolateHex(from: string, to: string, ratio: number) {
  const safeRatio = Math.max(0, Math.min(1, ratio));
  const fromChannels = from.match(/[A-Fa-f0-9]{2}/g)?.map((part) => Number.parseInt(part, 16)) ?? [0, 0, 0];
  const toChannels = to.match(/[A-Fa-f0-9]{2}/g)?.map((part) => Number.parseInt(part, 16)) ?? [0, 0, 0];
  const mixed = fromChannels.map((channel, index) => Math.round(channel + (toChannels[index] - channel) * safeRatio));
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function colorFor(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return "rgba(226,232,240,0.45)";
  const spread = max - min;
  const ratio = spread > 0 ? (value - min) / spread : 0.5;

  if (ratio <= 0.5) {
    return interpolateHex("dc2626", "fde68a", ratio / 0.5);
  }
  return interpolateHex("fde68a", "1d4ed8", (ratio - 0.5) / 0.5);
}

export function SpecificYieldHeatmap({ data }: SpecificYieldHeatmapProps) {
  const [hoveredCell, setHoveredCell] = useState<HoveredCell | null>(null);

  const months = useMemo(() => [...new Set(data.map((item) => item.month))].sort(), [data]);
  const inverters = useMemo(
    () => [...new Set(data.map((item) => item.inv_id))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    [data]
  );
  const values = useMemo(() => data.map((item) => item.yield_kwh_kwp).filter(Number.isFinite), [data]);
  const minValue = values.length > 0 ? Math.min(...values) : 0;
  const maxValue = values.length > 0 ? Math.max(...values) : 0;
  const lookup = useMemo(() => new Map(data.map((item) => [`${item.inv_id}|${item.month}`, item.yield_kwh_kwp])), [data]);

  const cellW = 36;
  const cellH = 20;
  const labelW = 86;
  const legendW = 28;
  const headerH = 38;
  const footerH = 48;
  const totalW = labelW + months.length * cellW + legendW;
  const totalH = headerH + inverters.length * cellH + footerH;

  if (months.length === 0 || inverters.length === 0) {
    return <div className="rounded-2xl border border-subtle bg-row px-4 py-5 text-sm text-nav">Specific-yield heat map will appear once REVEAL has enough monthly inverter yield data.</div>;
  }

  return (
    <div className="relative overflow-x-auto" onMouseLeave={() => setHoveredCell(null)}>
      <svg
        width="100%"
        viewBox={`0 0 ${totalW} ${totalH}`}
        preserveAspectRatio="xMinYMin meet"
        style={{ fontFamily: "inherit", minWidth: `${totalW}px`, height: "auto" }}
      >
        {months.map((month, monthIndex) => (
          <text
            key={month}
            x={labelW + monthIndex * cellW + cellW / 2}
            y={headerH - 8}
            textAnchor="middle"
            fontSize={9}
            fill="var(--chart-axis-text-strong)"
            transform={`rotate(-40 ${labelW + monthIndex * cellW + cellW / 2} ${headerH - 8})`}
          >
            {formatMonthLabel(month)}
          </text>
        ))}

        {inverters.map((invId, inverterIndex) => (
          <g key={invId}>
            <text
              x={labelW - 6}
              y={headerH + inverterIndex * cellH + cellH / 2 + 3}
              textAnchor="end"
              fontSize={9}
              fill="var(--chart-axis-text-strong)"
            >
              {invId}
            </text>
            {months.map((month, monthIndex) => {
              const value = lookup.get(`${invId}|${month}`);
              const x = labelW + monthIndex * cellW + 1;
              const y = headerH + inverterIndex * cellH + 1;
              return (
                <rect
                  key={`${invId}-${month}`}
                  x={x}
                  y={y}
                  width={cellW - 2}
                  height={cellH - 2}
                  fill={value === undefined ? "rgba(226,232,240,0.45)" : colorFor(value, minValue, maxValue)}
                  rx={2}
                  onMouseEnter={() =>
                    setHoveredCell({
                      invId,
                      month,
                      value,
                      x: x + cellW / 2,
                      y,
                    })
                  }
                  onFocus={() =>
                    setHoveredCell({
                      invId,
                      month,
                      value,
                      x: x + cellW / 2,
                      y,
                    })
                  }
                />
              );
            })}
          </g>
        ))}

        <defs>
          <linearGradient id="specific-yield-legend" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="#dc2626" />
            <stop offset="50%" stopColor="#fde68a" />
            <stop offset="100%" stopColor="#1d4ed8" />
          </linearGradient>
        </defs>
        <rect
          x={labelW + months.length * cellW + 10}
          y={headerH}
          width={10}
          height={Math.max(inverters.length * cellH - 2, 48)}
          rx={4}
          fill="url(#specific-yield-legend)"
        />
        <text x={labelW + months.length * cellW + 24} y={headerH + 8} fontSize={9} fill="var(--chart-axis-text-strong)">
          {maxValue.toFixed(0)}
        </text>
        <text
          x={labelW + months.length * cellW + 24}
          y={headerH + Math.max(inverters.length * cellH - 6, 42)}
          fontSize={9}
          fill="var(--chart-axis-text-strong)"
        >
          {minValue.toFixed(0)}
        </text>
        <text
          x={labelW + (months.length * cellW) / 2}
          y={totalH - 10}
          textAnchor="middle"
          fontSize={10}
          fill="var(--chart-axis-text)"
        >
          Month
        </text>
      </svg>

      {hoveredCell ? (
        <div
          className="pointer-events-none absolute z-20 min-w-[220px] rounded-2xl border border-subtle bg-panel px-4 py-3 shadow-[0_18px_42px_rgba(2,18,28,0.3)]"
          style={{
            left: `${Math.min(Math.max(hoveredCell.x + 18, 12), totalW - 232)}px`,
            top: `${Math.max(hoveredCell.y - 6, 12)}px`,
          }}
        >
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/55">Specific yield</p>
          <p className="mt-2 text-sm font-semibold text-white">
            {hoveredCell.invId} · {formatMonthLabel(hoveredCell.month)}
          </p>
          <p className="mt-2 text-sm leading-6 text-slate-200/84">
            {hoveredCell.value === undefined ? "No monthly yield data was available for this inverter." : `${hoveredCell.value.toFixed(1)} kWh/kWp`}
          </p>
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-4 text-xs text-[color:var(--chart-axis-text)]">
        <div className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded" style={{ background: "#dc2626" }} />
          Lower specific yield
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded" style={{ background: "#fde68a" }} />
          Mid-range month
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded" style={{ background: "#1d4ed8" }} />
          Higher specific yield
        </div>
      </div>
    </div>
  );
}
