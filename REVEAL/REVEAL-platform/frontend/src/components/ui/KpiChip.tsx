import clsx from "clsx";

interface KpiChipProps {
  label: string;
  value: string | number;
  unit?: string;
  status?: "good" | "warning" | "bad" | "neutral";
}

export function KpiChip({ label, value, unit, status = "neutral" }: KpiChipProps) {
  return (
    <div className="rounded-lg border border-subtle bg-panel px-4 py-3">
      <p className="text-xs uppercase tracking-wider" style={{ color: "var(--nav-text)" }}>{label}</p>
      <p
        className={clsx("mt-1 text-2xl font-bold", {
          "text-success": status === "good",
          "text-warning": status === "warning",
          "text-danger": status === "bad",
          "text-nav-active": status === "neutral",
        })}
      >
        {value}
        {unit && <span className="ml-1 text-sm font-normal text-slate-400">{unit}</span>}
      </p>
    </div>
  );
}
