"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface SolarDayPoint {
  hour: string;
  energyMWh: number;
  irradianceWm2: number;
  prPct: number;
}

interface SolarDayProfileChartProps {
  data: SolarDayPoint[];
}

export function SolarDayProfileChart({ data }: SolarDayProfileChartProps) {
  return (
    <ResponsiveContainer width="100%" height={348}>
      <ComposedChart
        data={data}
        margin={{ top: 10, right: 28, left: 6, bottom: 4 }}
        barCategoryGap={18}
        barGap={0}
      >
        <defs>
          <linearGradient id="energyFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7dd3fc" stopOpacity={0.95} />
            <stop offset="100%" stopColor="#2563eb" stopOpacity={0.82} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-axis-grid)" />
        <XAxis dataKey="hour" tick={{ fill: "var(--chart-axis-text)", fontSize: 11 }} />
        <YAxis
          yAxisId="energy"
          tick={{ fill: "var(--chart-axis-text-strong)", fontSize: 11 }}
          tickFormatter={(value: number) => `${value.toFixed(1)}`}
          label={{ value: "MWh", angle: -90, position: "insideLeft", offset: 2, fill: "var(--chart-axis-text-strong)", fontSize: 11 }}
        />
        <YAxis
          yAxisId="irradiance"
          orientation="right"
          tick={{ fill: "var(--chart-axis-text-strong)", fontSize: 11 }}
          tickFormatter={(value: number) => `${value.toFixed(0)}`}
          label={{ value: "W/m²", angle: 90, position: "insideRight", offset: 0, fill: "var(--chart-axis-text-strong)", fontSize: 11 }}
        />
        <YAxis yAxisId="pr" hide domain={[60, 100]} />
        <Tooltip
          contentStyle={{ background: "var(--chart-tooltip-bg)", border: "1px solid var(--chart-tooltip-border)", borderRadius: 8, color: "var(--chart-tooltip-text)" }}
          labelStyle={{ color: "var(--chart-tooltip-text)", fontWeight: 600 }}
          itemStyle={{ color: "var(--chart-tooltip-muted)" }}
          formatter={(value: number, name: string) => {
            if (name === "PR") return [`${value.toFixed(1)}%`, "PR"];
            if (name === "Irradiance") return [`${value.toFixed(0)} W/m²`, "Irradiance"];
            return [`${value.toFixed(2)} MWh`, "Energy"];
          }}
        />
        <Legend wrapperStyle={{ color: "var(--chart-legend-text)", fontSize: 12 }} />
        <Bar
          yAxisId="energy"
          dataKey="energyMWh"
          name="Energy"
          fill="url(#energyFill)"
          radius={[8, 8, 0, 0]}
          barSize={88}
        />
        <Line
          yAxisId="irradiance"
          type="monotone"
          dataKey="irradianceWm2"
          name="Irradiance"
          stroke="#fbbf24"
          strokeWidth={2.6}
          dot={false}
          activeDot={{ r: 4, fill: "#fbbf24", stroke: "#0B2A3D", strokeWidth: 1.5 }}
        />
        <Line
          yAxisId="pr"
          type="monotone"
          dataKey="prPct"
          name="PR"
          stroke="#f8fafc"
          strokeWidth={2.2}
          strokeDasharray="4 4"
          dot={{ r: 3, fill: "#f8fafc", stroke: "#0B2A3D", strokeWidth: 1.5 }}
          activeDot={{ r: 4 }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
