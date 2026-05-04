"use client";

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Cell
} from "recharts";
import type { MonthlyPR } from "@/types/analysis";

interface PRMonthlyChartProps {
  data: MonthlyPR[];
  targetPR?: number; // e.g. 0.79
}

export function PRMonthlyChart({ data, targetPR = 0.79 }: PRMonthlyChartProps) {
  const target = targetPR * 100;

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-axis-grid)" />
        <XAxis
          dataKey="month"
          tick={{ fill: "var(--chart-axis-text)", fontSize: 11 }}
          tickFormatter={(v: string) => v.slice(5)} // "2024-03" → "03"
        />
        <YAxis
          domain={[0, 100]}
          tickFormatter={(v: number) => `${v}%`}
          tick={{ fill: "var(--chart-axis-text)", fontSize: 11 }}
        />
        <Tooltip
          formatter={(v: number) => [`${v.toFixed(1)}%`, "PR"]}
          contentStyle={{ background: "var(--chart-tooltip-bg)", border: "1px solid var(--chart-tooltip-border)", borderRadius: 6, color: "var(--chart-tooltip-text)" }}
          labelStyle={{ color: "var(--chart-tooltip-text)", fontWeight: 600 }}
          itemStyle={{ color: "var(--chart-tooltip-muted)" }}
          cursor={{ fill: "rgba(12, 37, 56, 0.42)" }}
        />
        <ReferenceLine
          y={target}
          stroke="#F39200"
          strokeDasharray="6 3"
          label={{ value: `Target ${target}%`, position: "insideTopRight", fill: "#F39200", fontSize: 11 }}
        />
        <Bar dataKey="PR_pct" radius={[3, 3, 0, 0]}>
          {data.map((entry, i) => (
            <Cell
              key={i}
              fill={entry.PR_pct >= target ? "#70AD47" : entry.PR_pct >= target * 0.95 ? "#C98A00" : "#C62828"}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
