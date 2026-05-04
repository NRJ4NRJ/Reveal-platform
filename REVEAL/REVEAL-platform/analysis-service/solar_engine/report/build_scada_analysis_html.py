"""
build_scada_analysis_html.py  —  SCADA Daily Performance Analysis HTML report
==============================================================================
Generates a single self-contained HTML file (charts as base64 PNG) using the
exact visual style of REPAT_SCADA_Analysis_Report.

Sections
--------
  1. Cover page
  2. Data quality  —  completeness heatmap
  3. Performance overview  —  monthly energy, irradiation, PR
  4. Per-inverter specific yield  —  heatmap
  5. Energy loss waterfall
  6. Action punchlist

Entry point
-----------
  html_path = build_scada_analysis_html(site_cfg, data_dir, out_path)
"""
from __future__ import annotations

import base64
import html as _html_mod
import io
import warnings
from datetime import datetime
from pathlib import Path
from typing import Optional

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.colors as mcolors

# ── Use Montserrat for all chart text (falls back to DejaVu Sans in containers) ──
matplotlib.rcParams.update({
    "font.family":     "sans-serif",
    "font.sans-serif": ["Montserrat", "DejaVu Sans", "Liberation Sans", "Arial"],
    "axes.titlesize":  10,
    "axes.labelsize":  8.5,
    "xtick.labelsize": 7,
    "ytick.labelsize": 8,
})
import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

_HERE = Path(__file__).parent
_ROOT = _HERE.parent          # SCADA PV Analysis/

import re as _re

def _natural_key(s: str) -> list:
    """Sort key for natural ordering: BJ1, BJ2 … BJ21 instead of BJ1, BJ10, BJ11 …"""
    return [int(t) if t.isdigit() else t.lower() for t in _re.split(r"(\d+)", str(s))]

# ── Design tokens (match style_tokens.py) ────────────────────────────────────
_T = {
    "navy":    "#0B2A3D",
    "orange":  "#F39200",
    "slate":   "#3E516C",
    "text":    "#1F2933",
    "muted":   "#6B7785",
    "bg":      "#F4F6F8",
    "border":  "#D9E0E6",
    "green":   "#70AD47",
    "amber":   "#C98A00",
    "red":     "#C62828",
    "white":   "#FFFFFF",
}

# ── CSS: load verbatim from the same static files the comprehensive report uses ──
_ROOT_VARS = """
:root {
  --color-primary:   #0B2A3D;
  --color-accent:    #F39200;
  --color-secondary: #3E516C;
  --color-indigo:    #27275A;
  --color-text:      #1F2933;
  --color-muted:     #6B7785;
  --color-bg:        #F4F6F8;
  --color-border:    #D9E0E6;
  --color-success:   #70AD47;
  --color-warning:   #C98A00;
  --color-danger:    #C62828;
  --font-sans: 'Montserrat', Aptos, Calibri, Arial, Helvetica, sans-serif;
  --page-margin-top: 12mm;
  --page-margin-right: 12mm;
  --page-margin-bottom: 14mm;
  --page-margin-left: 12mm;
}
"""

def _load_static_css() -> tuple[str, str]:
    """Read report.css and print.css from report/static/."""
    report_css = (_HERE / "static" / "report.css").read_text(encoding="utf-8")
    print_css  = (_HERE / "static" / "print.css").read_text(encoding="utf-8")
    return report_css, print_css


# ─────────────────────────────────────────────────────────────────────────────
# DATA LOADERS
# ─────────────────────────────────────────────────────────────────────────────

def _load_xlsx_wide(data_dir: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Load wide-format Excel files (e.g. test_data.xlsx).
    Expects: date column, BJ*/inverter energy columns (kWh/interval), irr_sat column (W/m²).
    Returns (inv_long, irr_df) both ready for the analysis pipeline.
    """
    inv_frames, irr_frames = [], []
    for p in sorted(data_dir.glob("*.xlsx")):
        try:
            df = pd.read_excel(p)
            df.columns = [c.strip() for c in df.columns]
            # Find timestamp column
            time_col = next((c for c in df.columns
                             if c.lower() in ("date", "time", "time_udt", "datetime", "timestamp")), None)
            if time_col is None:
                continue
            df[time_col] = pd.to_datetime(df[time_col], dayfirst=True, errors="coerce")
            df = df.dropna(subset=[time_col])

            # Detect interval from timestamps
            ts_sorted = df[time_col].sort_values().unique()
            interval_h = 0.0
            if len(ts_sorted) > 1:
                interval_h = (pd.Timestamp(ts_sorted[1]) - pd.Timestamp(ts_sorted[0])).total_seconds() / 3600.0
            if interval_h <= 0:
                interval_h = 5 / 60.0

            # ── Inverter columns: any column matching BJ*, INV*, or similar numeric patterns ──
            inv_cols = [c for c in df.columns
                        if c != time_col and pd.api.types.is_numeric_dtype(df[c])
                        and any(c.upper().startswith(pfx) for pfx in ("BJ", "INV", "WR", "G", "UNIT"))]
            # Fallback: any numeric column that isn't a known non-inverter column
            if not inv_cols:
                skip = {"irr_sat", "irr", "eond", "month", "prond"}
                inv_cols = [c for c in df.columns
                            if c != time_col and pd.api.types.is_numeric_dtype(df[c])
                            and c.lower() not in skip
                            and not c.lower().startswith("pr")]

            if inv_cols:
                melted = df[[time_col] + inv_cols].melt(
                    id_vars=time_col, var_name="EQUIP", value_name="_energy_kwh")
                melted = melted.rename(columns={time_col: "Time_UDT"})
                melted["_energy_kwh"] = pd.to_numeric(melted["_energy_kwh"], errors="coerce").fillna(0.0)
                # Convert kWh/interval → kW (power) so downstream code works correctly
                melted["PAC"] = melted["_energy_kwh"] / interval_h
                inv_frames.append(melted[["Time_UDT", "EQUIP", "PAC"]])

            # ── Irradiance: prefer irr_sat (W/m² instantaneous) ──
            ghi_col = next((c for c in df.columns if c.lower() == "irr_sat"), None)
            if ghi_col is None:
                ghi_col = next((c for c in df.columns
                                if "irr" in c.lower() or "ghi" in c.lower()), None)
            if ghi_col:
                irr_df = df[[time_col, ghi_col]].copy()
                irr_df = irr_df.rename(columns={time_col: "Time_UDT", ghi_col: "GHI"})
                irr_df["GHI"] = pd.to_numeric(irr_df["GHI"], errors="coerce").fillna(0.0)
                irr_frames.append(irr_df)

        except Exception:
            continue

    inv = pd.concat(inv_frames, ignore_index=True) if inv_frames else pd.DataFrame()
    irr = pd.concat(irr_frames, ignore_index=True) if irr_frames else pd.DataFrame()
    return inv, irr


def _load_inv(data_dir: Path) -> pd.DataFrame:
    # Excel files take priority — if xlsx has inverter data, skip CSVs entirely
    xlsx_inv, _ = _load_xlsx_wide(data_dir)
    if not xlsx_inv.empty:
        xlsx_inv["Time_UDT"] = pd.to_datetime(xlsx_inv["Time_UDT"], dayfirst=True, errors="coerce")
        xlsx_inv = xlsx_inv.dropna(subset=["Time_UDT"])
        xlsx_inv["PAC"] = pd.to_numeric(xlsx_inv["PAC"], errors="coerce").fillna(0.0)
        return xlsx_inv

    frames = []
    for p in sorted(data_dir.glob("*.csv")):
        nl = p.stem.lower()
        if any(k in nl for k in ("irr", "ghi", "irradiance", "meteo")):
            continue
        try:
            df = pd.read_csv(p, sep=";", decimal=",", encoding="utf-8-sig", low_memory=False)
            df.columns = [c.strip() for c in df.columns]
            if "Time_UDT" not in df.columns:
                df = df.rename(columns={df.columns[0]: "Time_UDT"})
            eq  = next((c for c in df.columns if c.upper() in ("EQUIP","EQUIPMENT","INV","INVERTER")), None)
            pac = next((c for c in df.columns if c.upper() in ("PAC","P_AC","POWER","ACTIVE_POWER")), None)
            if eq  and eq  != "EQUIP": df = df.rename(columns={eq:  "EQUIP"})
            if pac and pac != "PAC":   df = df.rename(columns={pac: "PAC"})
            frames.append(df)
        except Exception:
            continue
    if not frames:
        return pd.DataFrame()
    out = pd.concat(frames, ignore_index=True)
    out["Time_UDT"] = pd.to_datetime(out["Time_UDT"], dayfirst=True, errors="coerce")
    out = out.dropna(subset=["Time_UDT"])
    if "PAC" in out.columns:
        out["PAC"] = pd.to_numeric(out["PAC"], errors="coerce").fillna(0.0)
    return out


def _load_irr(data_dir: Path) -> pd.DataFrame:
    # Excel files take priority — if xlsx has irradiance data, skip CSVs entirely
    _, xlsx_irr = _load_xlsx_wide(data_dir)
    if not xlsx_irr.empty:
        xlsx_irr["Time_UDT"] = pd.to_datetime(xlsx_irr["Time_UDT"], dayfirst=True, errors="coerce")
        xlsx_irr = xlsx_irr.dropna(subset=["Time_UDT"])
        xlsx_irr["GHI"] = pd.to_numeric(xlsx_irr["GHI"], errors="coerce").fillna(0.0)
        return xlsx_irr

    frames = []
    for p in sorted(data_dir.glob("*.csv")):
        try:
            df = pd.read_csv(p, sep=";", decimal=",", encoding="utf-8-sig", low_memory=False)
            df.columns = [c.strip() for c in df.columns]
            ghi_col = next((c for c in df.columns
                            if "ghi" in c.lower() or "irr" in c.lower() or "global" in c.lower()), None)
            if ghi_col is None:
                continue
            if "Time_UDT" not in df.columns:
                df = df.rename(columns={df.columns[0]: "Time_UDT"})
            if ghi_col != "GHI":
                df = df.rename(columns={ghi_col: "GHI"})
            frames.append(df[["Time_UDT", "GHI"]])
        except Exception:
            continue
    if not frames:
        return pd.DataFrame()
    out = pd.concat(frames, ignore_index=True)
    out["Time_UDT"] = pd.to_datetime(out["Time_UDT"], dayfirst=True, errors="coerce")
    out = out.dropna(subset=["Time_UDT"])
    out["GHI"] = pd.to_numeric(out["GHI"], errors="coerce").fillna(0.0)
    return out


def _normalise_ghi(irr: pd.DataFrame, interval_h: float) -> pd.DataFrame:
    """Convert Wh/m²-per-interval → W/m² instantaneous if values look like Wh."""
    if irr.empty or "GHI" not in irr.columns:
        return irr
    # Auto-detect interval from data
    ts = irr.set_index("Time_UDT")["GHI"].sort_index()
    if len(ts) > 1:
        interval_h = (ts.index[1] - ts.index[0]).total_seconds() / 3600.0
    ghi = irr["GHI"].clip(lower=0)
    if ghi.max() < 200 and ghi.max() > 0:
        irr = irr.copy()
        irr["GHI"] = ghi / interval_h   # Wh/interval → W/m²
    return irr


# ─────────────────────────────────────────────────────────────────────────────
# ANALYSIS HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _detect_interval(df: pd.DataFrame, fallback_min: int = 10) -> float:
    """Return actual data interval in hours, inferred from timestamps."""
    if df.empty or "Time_UDT" not in df.columns:
        return fallback_min / 60.0
    ts = df["Time_UDT"].dropna().sort_values().unique()
    if len(ts) > 1:
        diff = (pd.Timestamp(ts[1]) - pd.Timestamp(ts[0])).total_seconds()
        if 0 < diff <= 3600:
            return diff / 3600.0
    return fallback_min / 60.0


def _choose_freq(inv: pd.DataFrame) -> str:
    """Return granularity for heatmap columns: 'interval', 'D', or 'ME'."""
    if inv.empty or "Time_UDT" not in inv.columns:
        return "D"
    span_days = (inv["Time_UDT"].max() - inv["Time_UDT"].min()).total_seconds() / 86400
    if span_days <= 3:
        return "interval"
    elif span_days <= 90:
        return "D"
    else:
        return "ME"


def _completeness_pivot(inv: pd.DataFrame, interval_h: float, freq: str = "D") -> pd.DataFrame:
    if inv.empty or "EQUIP" not in inv.columns:
        return pd.DataFrame()
    inv = inv.copy()
    if freq == "interval":
        slot_min = max(1, round(interval_h * 60))
        inv["slot"] = inv["Time_UDT"].dt.floor(f"{slot_min}min")
        all_slots = sorted(inv["slot"].unique())
        all_equip = sorted(inv["EQUIP"].unique())
        pres = inv.groupby(["EQUIP", "slot"])["PAC"].count().clip(0, 1)
        idx = pd.MultiIndex.from_product([all_equip, all_slots], names=["EQUIP", "slot"])
        pres = pres.reindex(idx, fill_value=0).reset_index()
        pres.columns = ["EQUIP", "slot", "pct"]
        pivot = pres.pivot(index="EQUIP", columns="slot", values="pct")
        pivot.columns = [pd.Timestamp(c).strftime("%H:%M") for c in pivot.columns]
        return pivot
    elif freq == "ME":
        inv["period"] = inv["Time_UDT"].dt.to_period("M").astype(str)
        inv["date"] = inv["Time_UDT"].dt.date
        all_days = inv.groupby("period")["date"].nunique()
        days_inv = inv.groupby(["EQUIP", "period"])["date"].nunique().reset_index()
        days_inv["pct"] = days_inv.apply(lambda r: r["date"] / all_days[r["period"]], axis=1)
        return days_inv.pivot(index="EQUIP", columns="period", values="pct").clip(0, 1)
    else:  # "D"
        expected = round(24 / interval_h)
        inv["date"] = inv["Time_UDT"].dt.date
        counts = inv.groupby(["EQUIP", "date"])["PAC"].count().reset_index()
        counts["pct"] = (counts["PAC"] / expected).clip(0, 1)
        return counts.pivot(index="EQUIP", columns="date", values="pct")


def _specific_yield_pivot(inv: pd.DataFrame, cap_per_inv: float,
                           interval_h: float, freq: str = "D") -> pd.DataFrame:
    if inv.empty or "EQUIP" not in inv.columns:
        return pd.DataFrame()
    inv = inv.copy()
    if freq == "interval":
        slot_min = max(1, round(interval_h * 60))
        inv["slot"] = inv["Time_UDT"].dt.floor(f"{slot_min}min")
        energy = inv.groupby(["EQUIP", "slot"])["PAC"].sum() * interval_h
        pivot = energy.reset_index().pivot(index="EQUIP", columns="slot", values="PAC")
        pivot.columns = [pd.Timestamp(c).strftime("%H:%M") for c in pivot.columns]
        return pivot / cap_per_inv
    elif freq == "ME":
        inv["period"] = inv["Time_UDT"].dt.to_period("M").astype(str)
        energy = inv.groupby(["EQUIP", "period"])["PAC"].sum() * interval_h
        pivot = energy.reset_index().pivot(index="EQUIP", columns="period", values="PAC")
        return pivot / cap_per_inv
    else:  # "D"
        inv["date"] = inv["Time_UDT"].dt.date
        daily = inv.groupby(["EQUIP", "date"])["PAC"].sum() * interval_h
        pivot = daily.reset_index().pivot(index="EQUIP", columns="date", values="PAC")
        return pivot / cap_per_inv


def _period_overview(inv: pd.DataFrame, irr: pd.DataFrame,
                     cap_dc: float, interval_h: float, freq: str = "ME") -> pd.DataFrame:
    """Energy / irradiation / PR grouped at the granularity chosen by _choose_freq."""
    rows: dict = {}
    slot_min = max(1, round(interval_h * 60))

    def _period_col(df: pd.DataFrame) -> pd.Series:
        if freq == "interval":
            return df["Time_UDT"].dt.floor(f"{slot_min}min")
        elif freq == "D":
            return df["Time_UDT"].dt.date
        else:
            return df["Time_UDT"].dt.to_period("M")

    if not inv.empty and "PAC" in inv.columns:
        inv = inv.copy()
        inv["_p"] = _period_col(inv)
        rows["energy_kwh"] = inv.groupby("_p")["PAC"].sum() * interval_h

    if not irr.empty and "GHI" in irr.columns:
        irr = irr.copy()
        irr["_p"] = _period_col(irr)
        if freq == "interval":
            # Keep as W/m² (instantaneous mean per slot)
            rows["ghi_w_m2"] = irr.groupby("_p")["GHI"].mean()
        else:
            rows["irradiation_kwh_m2"] = irr.groupby("_p")["GHI"].sum() * interval_h / 1000

    if not rows:
        return pd.DataFrame()
    overview = pd.DataFrame(rows)

    irr_min = 50   # W/m² — only compute PR where irradiance > 50 W/m²

    if "energy_kwh" in overview:
        if "irradiation_kwh_m2" in overview:
            denom = overview["irradiation_kwh_m2"] * cap_dc
            overview["pr_pct"] = overview["energy_kwh"] / denom.replace(0, np.nan) * 100
            min_irr_kwh = irr_min / 1000 * 4  # ~0.2 kWh/m² minimum
            overview.loc[overview["irradiation_kwh_m2"] < min_irr_kwh, "pr_pct"] = np.nan
        elif "ghi_w_m2" in overview:
            # PR = actual_kW / (GHI_kW/m² × cap_dc_kWp)
            actual_kw = overview["energy_kwh"] / interval_h
            ref_kw    = overview["ghi_w_m2"] / 1000 * cap_dc
            overview["pr_pct"] = actual_kw / ref_kw.replace(0, np.nan) * 100
            # Only suppress slots below irradiance threshold; show all other values as-is
            overview.loc[overview["ghi_w_m2"] < irr_min, "pr_pct"] = np.nan

    return overview.dropna(how="all")


def _waterfall(inv: pd.DataFrame, irr: pd.DataFrame,
               cap_dc: float, pr_target: float, interval_h: float,
               design_pr: float = 0.85) -> dict:
    """Build the full 13-category waterfall matching pipeline.py / WaterfallChart.tsx."""
    # ── Site totals ──────────────────────────────────────────────────────────
    irradiation  = (irr["GHI"].clip(lower=0).sum() * interval_h / 1000
                    if not irr.empty and "GHI" in irr.columns else 0.0)   # kWh/m²
    total_actual = (inv["PAC"].sum() * interval_h if not inv.empty else 0.0)  # kWh

    # Weather-corrected yield = irradiation × capacity × operating PR
    total_reference = irradiation * cap_dc * pr_target   # kWh

    # Irradiance impact: 6% of reference (pipeline.py heuristic)
    irradiance_impact = max(total_reference * 0.06, 0.0)
    temperature_loss  = 0.0   # no temperature sensor in quick-check data

    design_yield          = total_reference + irradiance_impact + temperature_loss
    weather_corrected_yield = total_reference   # = design_yield – irr_impact – temp_loss

    # ── Availability loss (per-inverter) ─────────────────────────────────────
    availability_loss = 0.0
    irr_thr = 50.0
    daylight_ts: set = set()
    if not irr.empty and "GHI" in irr.columns:
        daylight_ts = set(irr.loc[irr["GHI"] > irr_thr, "Time_UDT"].dt.floor("min"))

    cap_per_inv = cap_dc / max(1, (inv["EQUIP"].nunique() if not inv.empty else 1))
    if not inv.empty and "EQUIP" in inv.columns and daylight_ts:
        total_ts = len(daylight_ts)
        for _, grp in inv.groupby("EQUIP"):
            grp_ts   = set(grp["Time_UDT"].dt.floor("min"))
            avail    = len(grp_ts & daylight_ts) / max(total_ts, 1)
            if avail < 1.0:
                availability_loss += (1 - avail) * cap_per_inv * irradiation * pr_target

    # ── String / faulty-string loss (yield spread) ───────────────────────────
    string_loss = 0.0
    if not inv.empty and "EQUIP" in inv.columns and irradiation > 0:
        sy_per_inv = (inv.groupby("EQUIP")["PAC"].sum() * interval_h / cap_per_inv)
        if len(sy_per_inv) >= 2:
            spread = sy_per_inv.max() - sy_per_inv.min()
            total_gap = max(0.0, total_reference - total_actual)
            remaining = max(0.0, total_gap - availability_loss)
            if spread > 120:
                string_loss = min(remaining,
                                  remaining * min(spread / 350.0, 0.45))

    # ── Residual / over-under performance ────────────────────────────────────
    recoverable_total = availability_loss + string_loss
    over_under = max(weather_corrected_yield - recoverable_total - total_actual, 0.0)

    # ── 13-item waterfall list (matches pipeline.py exactly) ─────────────────
    def _mwh(kwh): return round(kwh / 1000, 3)

    items = [
        {"label": "Design yield",                    "value_mwh": _mwh(design_yield),             "type": "base", "color": "#1e3a5f"},
        {"label": "Irradiance impact",               "value_mwh": _mwh(irradiance_impact),        "type": "loss", "color": "#64748b"},
        {"label": "Temperature loss",                "value_mwh": _mwh(temperature_loss),         "type": "loss", "color": "#94a3b8"},
        {"label": "Weather-corrected yield",         "value_mwh": _mwh(weather_corrected_yield),  "type": "base", "color": "#2563eb"},
        {"label": "Inverter losses",                 "value_mwh": _mwh(availability_loss),        "type": "loss", "color": "#1d4ed8"},
        {"label": "Site trips",                      "value_mwh": 0.0,                            "type": "loss", "color": "#3b82f6"},
        {"label": "Inverter clipping",               "value_mwh": 0.0,                            "type": "loss", "color": "#7c3aed"},
        {"label": "Grid curtailment & neg. hours",   "value_mwh": 0.0,                            "type": "loss", "color": "#d97706"},
        {"label": "Module soiling",                  "value_mwh": 0.0,                            "type": "loss", "color": "#b45309"},
        {"label": "Snow",                            "value_mwh": 0.0,                            "type": "loss", "color": "#0ea5e9"},
        {"label": "Faulty strings",                  "value_mwh": _mwh(string_loss),              "type": "loss", "color": "#dc2626"},
        {"label": "Over / under performance",        "value_mwh": _mwh(over_under),               "type": "loss", "color": "#475569"},
        {"label": "Actual yield",                    "value_mwh": _mwh(total_actual),             "type": "base", "color": "#059669"},
    ]

    return dict(
        items=items,
        reference=total_reference, actual=total_actual,
        loss=max(0.0, total_reference - total_actual),
        surplus=max(0.0, total_actual - total_reference),
        irradiation=irradiation,
        design_yield=design_yield,
        pr_design_gap=max(0.0, design_yield - total_reference),
    )


def _punchlist(inv: pd.DataFrame, irr: pd.DataFrame,
               site_cfg: dict, interval_h: float) -> list[dict]:
    if inv.empty or "EQUIP" not in inv.columns:
        return []
    cap_per_inv = site_cfg["cap_dc_kwp"] / max(site_cfg["n_inverters"], 1)
    pr_target   = site_cfg.get("operating_pr_target", 0.80)
    irr_thr     = site_cfg.get("irr_threshold", 50)

    irradiation = 0.0
    daylight_ts: set = set()
    if not irr.empty and "GHI" in irr.columns:
        irradiation = irr["GHI"].clip(lower=0).sum() * interval_h / 1000
        daylight_ts = set(irr.loc[irr["GHI"] > irr_thr, "Time_UDT"].dt.floor("min"))

    issues: list[dict] = []
    for equip, grp in inv.groupby("EQUIP"):
        energy = grp["PAC"].sum() * interval_h
        sy     = energy / cap_per_inv

        # availability
        if daylight_ts:
            grp_ts = set(grp["Time_UDT"].dt.floor("min"))
            avail  = len(grp_ts & daylight_ts) / max(len(daylight_ts), 1)
        else:
            avail = (grp["PAC"] > 1.0).sum() / max(len(grp), 1)

        # PR
        pr = (energy / (irradiation * cap_per_inv) * 100) if irradiation > 0 else None

        # completeness
        total_ts = inv["Time_UDT"].nunique()
        completeness = len(grp) / max(total_ts, 1)

        energy_loss = 0.0
        issue_type = sev = desc = action = ""

        if avail < 0.85:
            energy_loss = (1 - avail) * cap_per_inv * irradiation * pr_target if irradiation > 0 else 0
            issue_type = "Low Availability"
            sev  = "HIGH" if avail < 0.50 else "MEDIUM"
            desc = f"Availability {avail*100:.1f}% (target ≥85%). Inverter may have experienced outages."
            action = "Check fault log, verify AC/DC breakers, attempt remote restart."
        elif pr is not None and pr < (pr_target * 100) - 5:
            energy_loss = max(0, (pr_target - pr/100) * irradiation * cap_per_inv) if irradiation > 0 else 0
            issue_type = "Below-Target PR"
            sev  = "HIGH" if pr < (pr_target*100 - 15) else "MEDIUM"
            desc = f"PR {pr:.1f}% vs target {pr_target*100:.0f}%. Underperformance detected."
            action = "Inspect string health, check soiling level, verify MPPT tracking."
        elif completeness < 0.80:
            issue_type = "Data Gaps"
            sev  = "MEDIUM"
            desc = f"Data completeness {completeness*100:.1f}% — records missing from SCADA export."
            action = "Check SCADA data logger connectivity and export schedule."
        else:
            continue

        issues.append(dict(equip=equip, type=issue_type, severity=sev,
                           sy=round(sy, 3), avail=f"{avail*100:.1f}%",
                           pr=f"{pr:.1f}%" if pr is not None else "n/a",
                           energy_loss=round(energy_loss, 0),
                           description=desc, action=action))

    issues.sort(key=lambda x: x["energy_loss"], reverse=True)

    # ── Irradiance sensor quality check ────────────────────────────────────
    if not irr.empty and "GHI" in irr.columns:
        ghi = irr["GHI"].clip(lower=0).sort_values().reset_index(drop=True)
        active = ghi[ghi > 0]
        if len(active) >= 10:
            # Detect sensor floor: if the first 10 non-zero readings are all the same value
            first10_std = active.iloc[:10].std()
            sensor_floor = active.iloc[:10].min()
            if first10_std < 1.0 and sensor_floor > 50:
                issues.append(dict(
                    equip="Site",
                    type="Irradiance Sensor",
                    severity="MEDIUM",
                    sy="-", avail="-", pr="-",
                    energy_loss=0,
                    description=(
                        f"Irradiance sensor (irr_sat) appears to have a measurement floor at "
                        f"{sensor_floor:.0f}\u00a0W/m\u00b2. The sensor reports a constant minimum "
                        f"during morning and evening ramp-up instead of the actual irradiance. "
                        f"This inflates per-slot PR calculations and may affect energy yield assessments."
                    ),
                    action=(
                        "Recalibrate or replace the irradiance sensor. Clean the sensor surface. "
                        "Verify wiring and data logger settings. "
                        "Cross-check against an alternative GHI measurement source."
                    ),
                ))

    return issues


# ─────────────────────────────────────────────────────────────────────────────
# CHART GENERATORS  (return base64 PNG string or "")
# ─────────────────────────────────────────────────────────────────────────────

def _b64_png(fig) -> str:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=130, bbox_inches="tight",
                facecolor="white", edgecolor="none")
    plt.close(fig)
    buf.seek(0)
    return "data:image/png;base64," + base64.b64encode(buf.read()).decode()


def _cmap_completeness():
    """Discrete thresholds matching the app AvailabilityHeatmap component:
    <85% red | 85-95% orange | 95-98% amber | ≥98% green."""
    colors = ["#C62828", "#E07820", "#C98A00", "#70AD47"]
    bounds = [0.0, 0.85, 0.95, 0.98, 1.001]
    cmap  = mcolors.ListedColormap(colors, name="dq_threshold")
    norm  = mcolors.BoundaryNorm(bounds, ncolors=4)
    return cmap, norm


def _cmap_yield():
    """RdYlBu: red = low yield (bad), blue = high yield (good) — matches reference report."""
    return plt.get_cmap("RdYlBu")


# ─────────────────────────────────────────────────────────────────────────────
# HTML HEATMAP TABLE  (replaces matplotlib chart for completeness heatmaps)
# Matches the app's AvailabilityHeatmap component: cell grid with % values.
# ─────────────────────────────────────────────────────────────────────────────

def _heatmap_cell_style(v: float) -> tuple[str, str]:
    """Return (background, foreground) CSS colours for a 0–1 completeness value."""
    if v >= 0.98: return "#70AD47", "#fff"
    if v >= 0.95: return "#C98A00", "#fff"
    if v >= 0.85: return "#E07820", "#fff"
    return "#C62828", "#fff"


def html_heatmap_table(pivot: pd.DataFrame, freq: str = "ME") -> str:
    """Generate a scrollable HTML table heatmap from a completeness pivot (values 0–1)."""
    if pivot.empty:
        return ""
    pivot = pivot.loc[sorted(pivot.index, key=_natural_key)]
    cols = list(pivot.columns)

    if freq == "ME":
        col_labels = [str(c)[:7] for c in cols]     # "2024-01"
    elif freq == "D":
        col_labels = [str(c)[5:] for c in cols]      # "MM-DD"
    else:
        col_labels = [str(c) for c in cols]

    th_cells = "".join(
        f'<th style="min-width:34px;max-width:46px;font-size:6.5pt;padding:2px 1px;'
        f'writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap;'
        f'font-weight:600;color:#3E516C;text-align:center;">{lbl}</th>'
        for lbl in col_labels
    )
    header = (
        '<thead><tr>'
        '<th style="min-width:72px;text-align:left;font-size:8pt;padding:4px 8px;'
        'position:sticky;left:0;background:#F4F6F8;z-index:2;border-right:1px solid #D9E0E6;'
        'color:#0B2A3D;font-weight:600;">Inverter</th>'
        + th_cells + '</tr></thead>'
    )

    rows_html = []
    for inv_id, row in pivot.iterrows():
        cells = []
        for v in row:
            if pd.isna(v):
                cells.append('<td style="background:#ECEFF1;"></td>')
            else:
                bg, fg = _heatmap_cell_style(float(v))
                pct = f"{v * 100:.0f}%"
                cells.append(
                    f'<td style="background:{bg};color:{fg};text-align:center;'
                    f'font-size:6.5pt;font-weight:700;padding:2px 0;">{pct}</td>'
                )
        rows_html.append(
            f'<tr><td style="font-size:7.5pt;padding:2px 8px;white-space:nowrap;'
            f'position:sticky;left:0;background:#fff;z-index:1;'
            f'border-right:1px solid #D9E0E6;color:#1F2933;">{inv_id}</td>'
            + "".join(cells) + "</tr>"
        )

    body = "<tbody>" + "".join(rows_html) + "</tbody>"
    legend = (
        '<div style="display:flex;gap:14px;margin-top:6px;font-size:7.5pt;color:#1F2933;">'
        '<span><span style="display:inline-block;width:11px;height:11px;border-radius:2px;'
        'background:#70AD47;margin-right:3px;vertical-align:middle;"></span>&#8805;98%</span>'
        '<span><span style="display:inline-block;width:11px;height:11px;border-radius:2px;'
        'background:#C98A00;margin-right:3px;vertical-align:middle;"></span>&#8805;95%</span>'
        '<span><span style="display:inline-block;width:11px;height:11px;border-radius:2px;'
        'background:#E07820;margin-right:3px;vertical-align:middle;"></span>&#8805;85%</span>'
        '<span><span style="display:inline-block;width:11px;height:11px;border-radius:2px;'
        'background:#C62828;margin-right:3px;vertical-align:middle;"></span>&lt;85%</span>'
        '</div>'
    )
    return (
        '<div style="overflow-x:auto;max-height:185mm;border:1px solid #D9E0E6;'
        'border-radius:8px;background:#fff;">'
        f'<table style="border-collapse:collapse;width:100%;font-family:var(--font-sans);">'
        f'{header}{body}</table></div>{legend}'
    )


def _inv_to_pivot(inv: pd.DataFrame, interval_h: float) -> pd.DataFrame:
    """Convert long inv df (Time_UDT, EQUIP, PAC) → wide datetime-indexed pivot."""
    if inv.empty or "EQUIP" not in inv.columns or "PAC" not in inv.columns:
        return pd.DataFrame()
    inv = inv.copy()
    inv["Time_UDT"] = pd.to_datetime(inv["Time_UDT"])
    slot_min = max(1, round(interval_h * 60))
    inv["ts"] = inv["Time_UDT"].dt.floor(f"{slot_min}min")
    piv = inv.pivot_table(index="ts", columns="EQUIP", values="PAC", aggfunc="mean")
    piv.index = pd.DatetimeIndex(piv.index)
    return piv


def _dq_monthly_rows_from_inv(inv: pd.DataFrame, interval_h: float) -> list:
    """Compute per-inverter monthly completeness/missing/frozen — same logic as pipeline."""
    import sys as _sys
    piv_raw = _inv_to_pivot(inv, interval_h)
    if piv_raw.empty:
        return []
    try:
        _sys.path.insert(0, str(Path(__file__).parent.parent))
        from repat_solar_scada_analysis import clean_stuck_values as _csv
        piv_clean, _ = _csv(piv_raw)
    except Exception:
        piv_clean = piv_raw.copy()

    expected_index = piv_raw.index
    month_periods = expected_index.to_period("M")
    unique_months = sorted(month_periods.unique())
    rows = []
    for inv_id in piv_raw.columns:
        raw_s = piv_raw[inv_id]
        clean_s = piv_clean[inv_id] if inv_id in piv_clean.columns else raw_s.copy()
        for month in unique_months:
            mask = month_periods == month
            expected = int(mask.sum())
            if expected == 0:
                continue
            raw_present = int(raw_s.loc[mask].notna().sum())
            clean_present = int(clean_s.loc[mask].notna().sum())
            missing_count = max(expected - raw_present, 0)
            frozen_count = max(raw_present - clean_present, 0)
            rows.append({
                "month": str(month),
                "inv_id": str(inv_id),
                "completeness_pct": round(clean_present / expected * 100.0, 2),
                "missing_pct": round(missing_count / expected * 100.0, 2),
                "frozen_pct": round(frozen_count / expected * 100.0, 2),
            })
    return rows


def _irr_monthly_rows_from_irr(irr: pd.DataFrame, inv_index: "pd.DatetimeIndex") -> list:
    """Per-month irradiance completeness — same logic as pipeline._build_monthly_irradiance_rows."""
    if irr.empty or "Time_UDT" not in irr.columns or inv_index is None or len(inv_index) == 0:
        return []
    month_periods = inv_index.to_period("M")
    unique_months = sorted(month_periods.unique())
    irr_ts = pd.DatetimeIndex(irr["Time_UDT"])
    irr_months = irr_ts.to_period("M") if len(irr_ts) else pd.PeriodIndex([])
    rows = []
    for month in unique_months:
        expected = int((month_periods == month).sum())
        if expected == 0:
            continue
        present = int((irr_months == month).sum()) if len(irr_months) else 0
        completeness = round(min(present / expected * 100.0, 100.0), 2)
        missing = round(max(100.0 - completeness, 0.0), 2)
        rows.append({"month": str(month), "completeness_pct": completeness, "missing_pct": missing})
    return rows


def _cell_style_from_row(completeness_pct: float, missing_pct: float, frozen_pct: float) -> tuple:
    """Return (background CSS, text color, label) matching app getHeatTileClass exactly."""
    if frozen_pct > 0 and missing_pct > 0:
        bg = ("linear-gradient(135deg,"
              "rgba(220,38,38,0.55) 0%,rgba(220,38,38,0.55) 49%,"
              "rgba(244,114,182,0.32) 51%,rgba(244,114,182,0.32) 100%)")
        fg = "#1F2933"
        lbl = f"F+M"
    elif frozen_pct > 0:
        bg = "rgba(220,38,38,0.5)"
        fg = "#1F2933"
        lbl = f"F {frozen_pct:.0f}%"
    elif completeness_pct >= 95:
        bg = "rgba(52,211,153,0.22)"
        fg = "#1F2933"
        lbl = f"{completeness_pct:.0f}%"
    elif missing_pct > 0:
        bg = "rgba(251,113,133,0.28)"
        fg = "#1F2933"
        lbl = f"M {missing_pct:.0f}%"
    elif completeness_pct >= 85:
        bg = "rgba(56,189,248,0.22)"
        fg = "#1F2933"
        lbl = f"{completeness_pct:.0f}%"
    else:
        bg = "rgba(148,163,184,0.18)"
        fg = "#6B7785"
        lbl = f"{completeness_pct:.0f}%"
    return bg, fg, lbl


def html_heatmap_table_from_rows(
    dq_rows: list,
    irr_rows: list | None = None,
) -> str:
    """Render the completeness heatmap using EXACT same colors/display as the app's generate page."""
    if not dq_rows:
        return ""

    # Build month list and inverter list
    months = sorted({r["month"] for r in dq_rows})
    inverters = sorted({r["inv_id"] for r in dq_rows}, key=_natural_key)

    # Lookup: (month, inv_id) → row
    lookup: dict = {}
    for r in dq_rows:
        lookup[(r["month"], r["inv_id"])] = r

    # Column headers (show "Jan 24" style)
    def _fmt_month(m: str) -> str:
        try:
            dt = datetime.strptime(m[:7], "%Y-%m")
            return dt.strftime("%b %y")
        except Exception:
            return m[:7]

    col_min_w = max(34, min(56, 640 // max(len(months), 1)))
    th_cells = "".join(
        f'<th style="min-width:{col_min_w}px;font-size:6pt;padding:2px 1px;'
        f'writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap;'
        f'font-weight:600;color:#3E516C;text-align:center;">{_fmt_month(m)}</th>'
        for m in months
    )
    header = (
        '<thead><tr>'
        '<th style="min-width:80px;text-align:left;font-size:7.5pt;padding:4px 8px;'
        'position:sticky;left:0;background:#F4F6F8;z-index:2;border-right:1px solid #D9E0E6;'
        'color:#0B2A3D;font-weight:600;">Inverter</th>'
        + th_cells + '</tr></thead>'
    )

    rows_html = []
    for inv_id in inverters:
        cells = []
        for month in months:
            r = lookup.get((month, inv_id))
            if r is None:
                cells.append('<td style="background:#ECEFF1;"></td>')
            else:
                bg, fg, lbl = _cell_style_from_row(
                    r["completeness_pct"], r["missing_pct"], r["frozen_pct"]
                )
                title = (f'{inv_id} · {month} · '
                         f'{r["completeness_pct"]:.1f}% valid · '
                         f'{r["missing_pct"]:.1f}% missing · '
                         f'{r["frozen_pct"]:.1f}% frozen')
                cells.append(
                    f'<td title="{title}" style="background:{bg};color:{fg};text-align:center;'
                    f'font-size:6pt;font-weight:700;padding:2px 0;border-bottom:1px solid rgba(0,0,0,0.04);">'
                    f'{lbl}</td>'
                )
        rows_html.append(
            f'<tr><td style="font-size:7pt;padding:2px 8px;white-space:nowrap;'
            f'position:sticky;left:0;background:#fff;z-index:1;'
            f'border-right:1px solid #D9E0E6;color:#1F2933;font-weight:600;">{inv_id}</td>'
            + "".join(cells) + "</tr>"
        )

    # Irradiance row(s) at the bottom with separator
    irr_rows_html = ""
    if irr_rows:
        irr_lookup = {r["month"]: r for r in irr_rows}
        separator = (
            f'<tr><td colspan="{1 + len(months)}" '
            'style="padding:0;border-top:2px solid #D9E0E6;"></td></tr>'
        )
        cells = []
        for month in months:
            r = irr_lookup.get(month)
            if r is None:
                cells.append('<td style="background:#ECEFF1;"></td>')
            else:
                bg, fg, lbl = _cell_style_from_row(r["completeness_pct"], r["missing_pct"], 0)
                title = f'Irradiance · {month} · {r["completeness_pct"]:.1f}% valid · {r["missing_pct"]:.1f}% missing'
                cells.append(
                    f'<td title="{title}" style="background:{bg};color:{fg};text-align:center;'
                    f'font-size:6pt;font-weight:700;padding:2px 0;">{lbl}</td>'
                )
        irr_label = (
            '<td style="font-size:7pt;padding:2px 8px;white-space:nowrap;'
            'position:sticky;left:0;background:#EFF6FF;z-index:1;'
            'border-right:1px solid #D9E0E6;color:#1D4ED8;font-weight:600;">'
            'Irradiance</td>'
        )
        irr_rows_html = separator + "<tr>" + irr_label + "".join(cells) + "</tr>"

    legend = (
        '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:6px;font-size:7.5pt;color:#1F2933;">'
        '<span><span style="display:inline-block;width:11px;height:11px;border-radius:2px;'
        'background:rgba(52,211,153,0.4);margin-right:3px;vertical-align:middle;"></span>&#8805;95% valid</span>'
        '<span><span style="display:inline-block;width:11px;height:11px;border-radius:2px;'
        'background:rgba(56,189,248,0.4);margin-right:3px;vertical-align:middle;"></span>&#8805;85%</span>'
        '<span><span style="display:inline-block;width:11px;height:11px;border-radius:2px;'
        'background:rgba(251,113,133,0.4);margin-right:3px;vertical-align:middle;"></span>Missing (M)</span>'
        '<span><span style="display:inline-block;width:11px;height:11px;border-radius:2px;'
        'background:rgba(220,38,38,0.5);margin-right:3px;vertical-align:middle;"></span>Frozen (F)</span>'
        '</div>'
    )
    body = "<tbody>" + "".join(rows_html) + irr_rows_html + "</tbody>"
    return (
        '<div style="overflow-x:auto;max-height:185mm;border:1px solid #D9E0E6;'
        'border-radius:8px;background:#fff;">'
        f'<table style="border-collapse:collapse;width:100%;font-family:var(--font-sans);">'
        f'{header}{body}</table></div>{legend}'
    )


def _apply_spine(ax):
    ax.set_facecolor("white")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_color(_T["border"])
    ax.spines["bottom"].set_color(_T["border"])
    ax.tick_params(colors=_T["text"], labelsize=8.5)
    ax.grid(True, axis="y", color=_T["border"], alpha=0.5, linewidth=0.7, zorder=0)


def chart_completeness(pivot: pd.DataFrame, freq: str = "D") -> str:
    if pivot.empty:
        return ""
    pivot = pivot.loc[sorted(pivot.index, key=_natural_key)]
    cols = list(pivot.columns)
    max_cols = 288 if freq == "interval" else 90
    if len(cols) > max_cols:
        step = max(1, len(cols) // max_cols)
        pivot = pivot.iloc[:, ::step]
        cols = list(pivot.columns)

    _titles = {"interval": "Data Completeness — by Inverter & Time Slot",
               "D":        "Data Completeness Heatmap — by Inverter & Day",
               "ME":       "Data Completeness Heatmap — by Inverter & Month"}
    _xlabels = {"interval": "Time", "D": "Date", "ME": "Month"}

    cmap, norm = _cmap_completeness()
    n_inv = len(pivot)
    fig, ax = plt.subplots(figsize=(11, max(3.5, n_inv * 0.35 + 1.5)))
    im = ax.imshow(pivot.values, aspect="auto", cmap=cmap, norm=norm,
                   interpolation="nearest")
    ax.set_yticks(range(n_inv))
    ax.set_yticklabels(list(pivot.index), fontsize=8)
    max_ticks = 30 if freq == "interval" else 20
    step = max(1, len(cols) // max_ticks)
    ax.set_xticks(range(0, len(cols), step))
    ax.set_xticklabels([str(cols[i]) for i in range(0, len(cols), step)],
                       rotation=45, ha="right", fontsize=7)
    cbar = plt.colorbar(im, ax=ax, fraction=0.02, pad=0.02,
                        ticks=[0.0, 0.85, 0.95, 0.98, 1.0])
    cbar.ax.set_yticklabels(["0%", "85%", "95%", "98%", "100%"], fontsize=8)
    ax.set_title(_titles.get(freq, _titles["D"]),
                 color=_T["navy"], fontweight="bold", pad=8)
    ax.set_xlabel(_xlabels.get(freq, "Date"), color=_T["text"])
    ax.set_ylabel("Inverter / Unit", color=_T["text"])
    fig.patch.set_facecolor("white")
    plt.tight_layout()
    return _b64_png(fig)


# ─── Inline-SVG chart helpers (no matplotlib) ─────────────────────────────

def _sfv(value, default: float = 0.0) -> float:
    """Safe float conversion for SVG chart data."""
    try:
        return float(value) if value is not None else default
    except Exception:
        return default


def _svg_polyline_pts(points: list, color: str, stroke_width: float = 2.2) -> str:
    if not points:
        return ""
    coords = " ".join(f"{x:.1f},{y:.1f}" for x, y in points)
    markers = "".join(
        f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3" fill="#fff" stroke="{color}" stroke-width="1.5"/>'
        for x, y in points
    )
    return f'<polyline fill="none" stroke="{color}" stroke-width="{stroke_width}" points="{coords}"/>{markers}'


def _svg_chart(
    labels: list,
    bar_series: list,
    line_series: list,
    left_label: str = "",
    right_label: str = "",
    left_max: "float | None" = None,
    right_max: "float | None" = None,
    left_min: float = 0.0,
    right_min: float = 0.0,
) -> str:
    """Return a self-contained inline SVG dual-axis chart.

    bar_series  — list of {"label": str, "values": list, "color": str}
    line_series — list of {"label": str, "values": list, "color": str}
    Bars use the RIGHT axis; lines use the LEFT axis.
    """
    if not labels:
        return '<p style="color:#6B7785;font-style:italic;padding:8px 0;">No chart data available.</p>'

    W, H = 900.0, 280.0
    PL, PR, PT, PB = 58.0, 58.0, 14.0, 60.0
    pw = W - PL - PR
    ph = H - PT - PB
    n = len(labels)

    bar_vals = [_sfv(v) for s in bar_series for v in s.get("values", [])]
    line_vals = [_sfv(v) for s in line_series for v in s.get("values", [])]

    r_hi = right_max if right_max is not None else max(bar_vals or [0.0]) * 1.12 or 1.0
    l_hi = left_max if left_max is not None else max(line_vals or [0.0]) * 1.12 or 1.0
    if r_hi <= right_min:
        r_hi = right_min + 1.0
    if l_hi <= left_min:
        l_hi = left_min + 1.0

    def xc(i: int) -> float:
        return PL + (i + 0.5) * pw / n

    def ry(v: float) -> float:
        ratio = (_sfv(v) - right_min) / max(r_hi - right_min, 1e-9)
        return PT + (1.0 - ratio) * ph

    def ly(v: float) -> float:
        ratio = (_sfv(v) - left_min) / max(l_hi - left_min, 1e-9)
        return PT + (1.0 - ratio) * ph

    # Grid
    grid_els = []
    for step in range(5):
        yg = PT + step * ph / 4
        lv = l_hi - step * (l_hi - left_min) / 4
        rv = r_hi - step * (r_hi - right_min) / 4
        grid_els.append(
            f'<line x1="{PL:.0f}" y1="{yg:.0f}" x2="{W-PR:.0f}" y2="{yg:.0f}"'
            f' stroke="#e5e7eb" stroke-dasharray="3 6"/>'
            f'<text x="{PL-6:.0f}" y="{yg+4:.0f}" text-anchor="end"'
            f' font-size="10" fill="#6b7280">{lv:.0f}</text>'
        )
        if bar_series:
            grid_els.append(
                f'<text x="{W-PR+6:.0f}" y="{yg+4:.0f}" text-anchor="start"'
                f' font-size="10" fill="#6b7280">{rv:.0f}</text>'
            )

    # Bars
    bar_els = []
    nb = max(len(bar_series), 1)
    bw = max(6.0, pw / n * 0.72 / nb)
    for si, series in enumerate(bar_series):
        color = str(series.get("color", "#94a3b8"))
        vals = series.get("values", [])
        total_bw = bw * nb
        offset = (si - nb / 2.0 + 0.5) * bw
        for i, v in enumerate(vals[:n]):
            cx = xc(i) + offset
            y_top = ry(_sfv(v))
            h_bar = max(0.0, PT + ph - y_top)
            bar_els.append(
                f'<rect x="{cx - bw/2:.1f}" y="{y_top:.1f}" width="{bw - 1:.1f}"'
                f' height="{h_bar:.1f}" rx="3" fill="{color}" opacity="0.86"/>'
            )

    # Lines
    line_els = []
    for series in line_series:
        color = str(series.get("color", "#3b82f6"))
        vals = series.get("values", [])
        pts = [(xc(i), ly(_sfv(v))) for i, v in enumerate(vals[:n])]
        line_els.append(_svg_polyline_pts(pts, color))

    # X-axis labels
    xlabel_els = "".join(
        f'<text x="{xc(i):.1f}" y="{H - PB + 16:.1f}" text-anchor="end"'
        f' font-size="10" fill="#6b7280"'
        f' transform="rotate(-38 {xc(i):.1f} {H-PB+16:.1f})">{label}</text>'
        for i, label in enumerate(labels)
    )

    # Axis titles
    ax_left = (
        f'<text x="13" y="{PT + ph/2:.0f}" text-anchor="middle"'
        f' transform="rotate(-90 13 {PT+ph/2:.0f})" font-size="10" fill="#374151">{left_label}</text>'
    ) if left_label else ""
    ax_right = (
        f'<text x="{W-13:.0f}" y="{PT + ph/2:.0f}" text-anchor="middle"'
        f' transform="rotate(90 {W-13:.0f} {PT+ph/2:.0f})" font-size="10" fill="#374151">{right_label}</text>'
    ) if right_label else ""

    # Legend
    all_s = [*bar_series, *line_series]
    legend = "".join(
        f'<span style="display:inline-flex;align-items:center;gap:5px;margin:0 10px;font-size:11px;color:#374151;">'
        f'<span style="width:10px;height:10px;border-radius:50%;background:{s.get("color","#94a3b8")};display:inline-block;"></span>'
        f'{s.get("label","")}</span>'
        for s in all_s
    )

    border = f'<rect x="{PL:.0f}" y="{PT:.0f}" width="{pw:.0f}" height="{ph:.0f}" fill="none" stroke="#e5e7eb"/>'
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.0f} {H:.0f}"'
        f' style="width:100%;height:auto;display:block;overflow:visible;">'
        f'{"".join(grid_els)}{border}{"".join(bar_els)}{"".join(line_els)}{xlabel_els}{ax_left}{ax_right}'
        f'</svg>'
    )
    return (
        f'<div style="overflow:visible;">{svg}'
        f'<div style="text-align:center;margin-top:4px;">{legend}</div></div>'
    )


def chart_period_overview(overview: pd.DataFrame, pr_target: float,
                           freq: str = "ME") -> str:
    if overview.empty:
        return ""

    x_labels = [str(m) for m in overview.index]
    x = np.arange(len(x_labels))

    # Axis labels / units depend on freq
    if freq == "interval":
        energy_col   = "energy_kwh"
        energy_label = "Energy (kWh)"
        irr_col      = "ghi_w_m2"
        irr_label    = "GHI (W/m\u00b2)"
        title        = "Intra-day Energy, GHI & Performance Ratio"
        marker_size  = 3
        bar_offset   = 0.15
    elif freq == "D":
        energy_col   = "energy_kwh"
        energy_label = "Energy (kWh)"
        irr_col      = "irradiation_kwh_m2"
        irr_label    = "Irradiation (kWh/m\u00b2)"
        title        = "Daily Energy, Irradiation & Performance Ratio"
        marker_size  = 5
        bar_offset   = 0.2
    else:  # ME
        energy_col   = "energy_kwh"
        energy_label = "Energy (MWh)"
        irr_col      = "irradiation_kwh_m2"
        irr_label    = "Irradiation (kWh/m\u00b2)"
        title        = "Monthly Energy, Irradiation & Performance Ratio"
        marker_size  = 6
        bar_offset   = 0.2

    fig, ax1 = plt.subplots(figsize=(11, 4.8))
    _apply_spine(ax1)

    # Irradiance / irradiation bars (orange)
    ax_irr = None
    ax_pr  = None
    if irr_col in overview.columns:
        ax_irr = ax1.twinx()
        iv = overview[irr_col]
        iv_max = max(iv.max(), 0.1)
        ax_irr.bar(x, iv, width=bar_offset * 2,
                   color=_T["orange"], alpha=0.75, label=irr_label, zorder=2)
        ax_irr.set_ylabel(irr_label, color=_T["orange"], fontsize=9)
        ax_irr.set_ylim(0, iv_max * 1.45)
        ax_irr.spines["top"].set_visible(False)
        ax_irr.spines["left"].set_visible(False)
        ax_irr.tick_params(colors=_T["orange"], labelsize=8.5)
        ax_irr.grid(False)

    # Energy line (slate grey)
    if energy_col in overview.columns:
        raw = overview[energy_col]
        ev  = raw / 1000 if freq == "ME" else raw   # MWh for monthly, kWh otherwise
        ev_max = max(ev.max(), 0.1)
        ax1.plot(x, ev, color=_T["slate"], linewidth=1.8, marker="o",
                 markersize=marker_size, label=energy_label, zorder=3)
        ax1.set_ylabel(energy_label, color=_T["slate"], fontsize=9)
        ax1.set_ylim(0, ev_max * 1.45)
        ax1.tick_params(axis="y", colors=_T["slate"])

    # PR line
    if "pr_pct" in overview.columns:
        ax_pr = ax1.twinx()
        if ax_irr:
            ax_pr.spines["right"].set_position(("axes", 1.10))
        pr_vals = overview["pr_pct"].clip(lower=0)
        pr_ymax = max(pr_vals.dropna().max() * 1.15, 110) if not pr_vals.dropna().empty else 110
        ax_pr.plot(x, pr_vals, color=_T["green"],
                   marker="o", markersize=marker_size, linewidth=1.5,
                   zorder=4, label="PR (%)")
        ax_pr.axhline(pr_target * 100, color=_T["green"], linestyle=":",
                      linewidth=1, alpha=0.7)
        ax_pr.set_ylabel("PR (%)", color=_T["green"], fontsize=9)
        ax_pr.set_ylim(0, pr_ymax)
        ax_pr.spines["top"].set_visible(False)
        ax_pr.spines["left"].set_visible(False)
        ax_pr.tick_params(colors=_T["green"], labelsize=8.5)
        ax_pr.grid(False)

    # X-axis ticks — limit labels when many points
    max_ticks = 30 if freq == "interval" else len(x)
    step = max(1, len(x) // max_ticks)
    ax1.set_xticks(x[::step])
    ax1.set_xticklabels(x_labels[::step], rotation=45, ha="right", fontsize=8)
    ax1.set_title(title, color=_T["navy"], fontsize=10, fontweight="bold", pad=8)

    # Unified legend
    handles, lbls = ax1.get_legend_handles_labels()
    for _axx in [ax_irr, ax_pr]:
        if _axx:
            h, l = _axx.get_legend_handles_labels()
            handles += h; lbls += l
    ax1.legend(handles, lbls, loc="upper left", fontsize=8, framealpha=0.9)

    fig.patch.set_facecolor("white")
    plt.tight_layout()
    return _b64_png(fig)


def chart_specific_yield(pivot: pd.DataFrame, freq: str = "D") -> str:
    if pivot.empty:
        return ""
    pivot = pivot.loc[sorted(pivot.index, key=_natural_key)]
    cols = list(pivot.columns)
    max_cols = 288 if freq == "interval" else 90
    if len(cols) > max_cols:
        step = max(1, len(cols) // max_cols)
        pivot = pivot.iloc[:, ::step]
        cols = list(pivot.columns)

    _titles = {"interval": "Per-Inverter Specific Yield (kWh/kWp per Interval)",
               "D":        "Per-Inverter Specific Yield Heatmap (kWh/kWp per Day)",
               "ME":       "Per-Inverter Specific Yield Heatmap (kWh/kWp per Month)"}
    _xlabels = {"interval": "Time", "D": "Date", "ME": "Month"}
    _cbarlabels = {"interval": "kWh/kWp / interval", "D": "kWh/kWp / day",
                   "ME": "kWh/kWp / month"}

    n_inv = len(pivot)
    fig, ax = plt.subplots(figsize=(11, max(3.5, n_inv * 0.35 + 1.5)))
    vmax = np.nanpercentile(pivot.values[pivot.values > 0], 98) if (pivot.values > 0).any() else 1
    im = ax.imshow(pivot.values, aspect="auto", cmap=_cmap_yield(),
                   vmin=0, vmax=vmax, interpolation="nearest")
    ax.set_yticks(range(n_inv))
    ax.set_yticklabels(list(pivot.index), fontsize=8)
    max_ticks = 30 if freq == "interval" else 20
    step = max(1, len(cols) // max_ticks)
    ax.set_xticks(range(0, len(cols), step))
    ax.set_xticklabels([str(cols[i]) for i in range(0, len(cols), step)],
                       rotation=45, ha="right", fontsize=7)
    cbar = plt.colorbar(im, ax=ax, fraction=0.02, pad=0.02)
    cbar.set_label(_cbarlabels.get(freq, "kWh/kWp"), fontsize=8)
    cbar.ax.tick_params(labelsize=8)
    ax.set_title(_titles.get(freq, _titles["D"]),
                 color=_T["navy"], fontsize=10, fontweight="bold", pad=8)
    ax.set_xlabel(_xlabels.get(freq, "Date"), fontsize=8.5, color=_T["text"])
    ax.set_ylabel("Inverter / Unit", fontsize=8.5, color=_T["text"])
    fig.patch.set_facecolor("white")
    plt.tight_layout()
    return _b64_png(fig)


def chart_waterfall(wf: dict) -> str:
    """Floating-bar waterfall matching WaterfallChart.tsx / toWaterfallBars().
    Uses the same 13 categories and exact hex colours as the app."""
    items = wf.get("items", [])
    if not items:
        return ""

    # ── toWaterfallBars algorithm (mirrors the app's JS) ──────────────────
    cumulative = 0.0
    bars = []   # (label, bottom, height, color, itype)
    for item in items:
        val   = float(item.get("value_mwh", 0.0))
        itype = item.get("type", "loss")
        color = item.get("color", "#666666")
        label = item.get("label", "")
        if itype == "base":
            start, end = 0.0, val
        elif itype == "loss":
            start, end = cumulative, cumulative - abs(val)
        else:  # gain
            start, end = cumulative, cumulative + val
        cumulative = end
        bars.append((label, min(start, end), abs(end - start), color, itype, val))

    n = len(bars)
    fig, ax = plt.subplots(figsize=(max(14, n * 1.3), 5.5))

    for i, (lbl, bot, height, color, itype, val) in enumerate(bars):
        if height < 1e-6:
            # Zero-value: thin horizontal marker
            ax.plot([i - 0.28, i + 0.28], [bot, bot],
                    color=color, linewidth=2.0, zorder=3, solid_capstyle="round")
        else:
            ax.bar(i, height, bottom=bot, color=color, alpha=0.9, width=0.55,
                   zorder=2, edgecolor="white", linewidth=0.4)

    ax.set_xticks(range(n))
    ax.set_xticklabels(
        [b[0] for b in bars],
        fontsize=7.5, rotation=35, ha="right", rotation_mode="anchor"
    )
    ax.set_ylabel("Yield (MWh)", color=_T["text"])
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v:,.0f}"))
    ax.set_title("Yield Waterfall",
                 color=_T["navy"], fontweight="bold", pad=8)
    _apply_spine(ax)
    ax.grid(False, axis="x")
    fig.patch.set_facecolor("white")
    plt.tight_layout()
    return _b64_png(fig)


# ─────────────────────────────────────────────────────────────────────────────
# SECTION A–F CHART GENERATORS
# ─────────────────────────────────────────────────────────────────────────────

def chart_monthly_energy(pr_monthly: list) -> str:
    """Bar: actual vs reference energy MWh per month."""
    if not pr_monthly:
        return ""
    labels = [r.get("month", "") for r in pr_monthly]
    return _svg_chart(
        labels=labels,
        bar_series=[
            {"label": "Actual (MWh)", "values": [_sfv(r.get("E_act_mwh")) for r in pr_monthly], "color": "#58b0ff"},
            {"label": "Reference (MWh)", "values": [_sfv(r.get("E_ref_mwh")) for r in pr_monthly], "color": "#fbbf24"},
        ],
        line_series=[],
        left_label="", right_label="Energy (MWh)",
    )


def chart_monthly_pr_irradiation(pr_monthly: list) -> str:
    """Dual-axis: PR% line (left) + irradiation bar (right)."""
    if not pr_monthly:
        return ""
    labels = [r.get("month", "") for r in pr_monthly]
    return _svg_chart(
        labels=labels,
        bar_series=[{"label": "Irradiation (kWh/m²)", "values": [_sfv(r.get("irrad_kwh_m2")) for r in pr_monthly], "color": "#f59e0b"}],
        line_series=[{"label": "PR (%)", "values": [_sfv(r.get("PR_pct")) for r in pr_monthly], "color": "#60a5fa"}],
        left_label="PR (%)", right_label="Irradiation (kWh/m²)",
        left_max=100.0,
    )


def chart_site_availability(avail_monthly: list) -> str:
    """Line chart of site availability % per month."""
    if not avail_monthly:
        return ""
    labels = [r.get("month", "") for r in avail_monthly]
    return _svg_chart(
        labels=labels,
        bar_series=[],
        line_series=[{"label": "Availability (%)", "values": [_sfv(r.get("avail_pct", r.get("availability_pct"))) for r in avail_monthly], "color": "#34d399"}],
        left_label="Availability (%)", right_label="",
        left_max=100.0, left_min=0.0,
    )


def chart_mttf(mttf_by_inv: list, start_stop: list) -> str:
    """Bar: MTTF hours. Line: |start_dev_min|. Dual axis."""
    if not mttf_by_inv:
        return ""
    sorted_inv = sorted(mttf_by_inv, key=lambda r: _sfv(r.get("mttf_hours")))
    labels = [r.get("inv_id", "") for r in sorted_inv]
    mttf_h = [_sfv(r.get("mttf_hours")) for r in sorted_inv]
    dev_lu = {r.get("inv_id", ""): abs(_sfv(r.get("start_dev", r.get("start_dev_min")))) for r in (start_stop or [])}
    dev_vals = [dev_lu.get(lbl, 0.0) for lbl in labels]
    return _svg_chart(
        labels=labels,
        bar_series=[{"label": "MTTF (h)", "values": mttf_h, "color": "#fb923c"}],
        line_series=[{"label": "|Start dev.| (min)", "values": dev_vals, "color": "#60a5fa"}],
        left_label="|Start dev.| (min)", right_label="MTTF (h)",
    )


def chart_clipping_bins(clipping_bins: list) -> str:
    """Bar: near_clip_pct per irradiance bin."""
    if not clipping_bins:
        return ""
    labels = [r.get("label", r.get("bin_label", "")) for r in clipping_bins]
    vals = [_sfv(r.get("near_clip_pct")) for r in clipping_bins]
    return _svg_chart(
        labels=labels,
        bar_series=[{"label": "Near-clip (%)", "values": vals, "color": "#f59e0b"}],
        line_series=[],
        left_label="", right_label="Near-clip (%)",
    )


def chart_annual_pr(annual: list) -> str:
    """Bar: annual energy MWh. Line: annual PR%."""
    if not annual:
        return ""
    labels = [str(r.get("year", "")) for r in annual]
    return _svg_chart(
        labels=labels,
        bar_series=[{"label": "Energy (MWh)", "values": [_sfv(r.get("E_act_mwh", r.get("energy_mwh"))) for r in annual], "color": "#7ad28b"}],
        line_series=[{"label": "PR (%)", "values": [_sfv(r.get("PR_pct", r.get("pr_pct"))) for r in annual], "color": "#4f86f7"}],
        left_label="PR (%)", right_label="Energy (MWh)",
        left_max=100.0,
    )


def chart_event_overlay(pr_monthly, avail_monthly, dq_rows, curtailment_candidates) -> str:
    """Multi-series: PR + availability lines; missing/frozen/curtailment bars."""
    if not pr_monthly:
        return ""
    labels = [r.get("month", "") for r in pr_monthly]
    avail_lu = {r.get("month", ""): _sfv(r.get("avail_pct", r.get("availability_pct"))) for r in (avail_monthly or [])}
    dq_miss: dict = {}
    dq_froz: dict = {}
    for row in (dq_rows or []):
        mo = row.get("month", "")
        dq_miss.setdefault(mo, []).append(_sfv(row.get("missing_pct")))
        dq_froz.setdefault(mo, []).append(_sfv(row.get("frozen_pct")))
    curt_lu = {str(r.get("month", "")): _sfv(r.get("loss_mwh")) for r in (curtailment_candidates or [])}
    import numpy as _np
    miss_vals = [float(_np.mean(dq_miss[m])) if m in dq_miss else 0.0 for m in labels]
    froz_vals = [float(_np.mean(dq_froz[m])) if m in dq_froz else 0.0 for m in labels]
    curt_vals = [curt_lu.get(m, 0.0) for m in labels]
    return _svg_chart(
        labels=labels,
        bar_series=[
            {"label": "Missing (%)", "values": miss_vals, "color": "#f9a8d4"},
            {"label": "Frozen (%)", "values": froz_vals, "color": "#ef4444"},
            {"label": "Curtailment (MWh)", "values": curt_vals, "color": "#fbbf24"},
        ],
        line_series=[
            {"label": "PR (%)", "values": [_sfv(r.get("PR_pct", r.get("pr_pct"))) for r in pr_monthly], "color": "#60a5fa"},
            {"label": "Availability (%)", "values": [avail_lu.get(m, 0.0) for m in labels], "color": "#34d399"},
        ],
        left_label="Percent (%)", right_label="MWh / %",
        left_max=100.0,
    )


def chart_loss_breakdown(loss_breakdown: list) -> str:
    """Horizontal bar chart of loss categories (SVG)."""
    if not loss_breakdown:
        return ""
    sorted_lb = sorted(loss_breakdown, key=lambda r: _sfv(r.get("value_mwh")), reverse=True)
    labels = [r.get("label", "") for r in sorted_lb]
    vals = [_sfv(r.get("value_mwh")) for r in sorted_lb]
    colors_map = {"availability": "#dc2626", "clipping": "#d97706", "soiling": "#92400e", "curtailment": "#d97706", "string": "#dc2626"}
    colors = [next((c for k, c in colors_map.items() if k in r.get("label", "").lower()), "#64748b") for r in sorted_lb]
    # Render as horizontal bars in SVG
    W, H = 900.0, max(160.0, len(labels) * 32.0 + 40.0)
    PL, PR, PT, PB = 200.0, 80.0, 20.0, 20.0
    pw = W - PL - PR
    ph = H - PT - PB
    max_val = max(vals) if vals else 1.0
    bar_h = min(22.0, ph / max(len(labels), 1) * 0.72)
    bar_els = []
    text_els = []
    for i, (lbl, val, color) in enumerate(zip(labels, vals, colors)):
        yc = PT + (i + 0.5) * ph / len(labels)
        bw = val / max(max_val, 1e-9) * pw
        bar_els.append(f'<rect x="{PL:.0f}" y="{yc - bar_h/2:.1f}" width="{bw:.1f}" height="{bar_h:.1f}" rx="3" fill="{color}" opacity="0.85"/>')
        text_els.append(f'<text x="{PL - 6:.0f}" y="{yc + 4:.0f}" text-anchor="end" font-size="11" fill="#374151">{lbl}</text>')
        text_els.append(f'<text x="{PL + bw + 6:.0f}" y="{yc + 4:.0f}" font-size="11" fill="#374151">{val:.2f} MWh</text>')
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.0f} {H:.0f}"'
        f' style="width:100%;height:auto;display:block;">'
        f'{"".join(bar_els)}{"".join(text_els)}'
        f'</svg>'
    )
    return f'<div>{svg}</div>'


def chart_irradiance_benchmark(irradiance_check: dict) -> str:
    """Measured irradiance (amber bars) vs ERA reference irradiance (blue line) — SVG."""
    if not irradiance_check:
        return ""
    monthly = irradiance_check.get("monthly") or []
    if not monthly:
        return ""
    labels = [r.get("month", "") for r in monthly]
    measured = [_sfv(r.get("measured_kwh_m2")) for r in monthly]
    reference = [_sfv(r.get("reference_kwh_m2")) for r in monthly]
    combined_max = max(measured + reference) * 1.12 if (measured or reference) else 1.0
    return _svg_chart(
        labels=labels,
        bar_series=[{"label": "Measured irradiance (kWh/m²)", "values": measured, "color": "#f59e0b"}],
        line_series=[{"label": "ERA reference irradiance (kWh/m²)", "values": reference, "color": "#60a5fa"}],
        left_label="kWh/m²",
        right_label="kWh/m²",
        left_max=combined_max,
        right_max=combined_max,
    )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION A–F HTML BUILDERS
# ─────────────────────────────────────────────────────────────────────────────

def _html_section_a(result: dict) -> str:
    """Weather context: KPI chips + monthly rain tile grid + heavy-rain events table."""
    if not result:
        return '<p style="color:#6B7785;font-style:italic;">No data available.</p>'
    weather = result.get("weather") or {}
    if not weather:
        return '<p style="color:#6B7785;font-style:italic;">No weather data available.</p>'

    # KPI chips — summary figures come from weather["summary"] sub-dict
    kpis = []
    summary = weather.get("summary") or {}
    total_rain = summary.get("total_rain_mm")
    max_hourly = summary.get("max_daily_rain_mm")  # best available from pipeline summary
    rainy_hours = None  # not in pipeline summary; skip
    heavy_events = (
        (summary.get("heavy_rain_days") or 0) + (summary.get("very_heavy_rain_days") or 0)
        or len([e for e in (weather.get("events") or [])
                if str(e.get("classification", "")).lower() in ("heavy", "very_heavy", "extreme")])
    )
    if total_rain is not None:
        kpis.append(("Total Rainfall", f"{float(total_rain):,.1f} mm"))
    if max_hourly is not None:
        kpis.append(("Peak Hourly Rain", f"{float(max_hourly):,.1f} mm/h"))
    if rainy_hours is not None:
        kpis.append(("Rainy Hours", str(rainy_hours)))
    kpis.append(("Significant Events", str(heavy_events)))

    chips_html = "".join(
        f'<div style="border:1px solid #D9E0E6;border-radius:10px;padding:8px 14px;min-width:110px;">'
        f'<p style="font-size:6.5pt;text-transform:uppercase;letter-spacing:0.12em;'
        f'color:#6B7785;margin:0 0 4px;">{lbl}</p>'
        f'<p style="font-size:12pt;font-weight:700;color:#0B2A3D;margin:0;">{val}</p>'
        f'</div>'
        for lbl, val in kpis
    )
    chips_block = (
        f'<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:8mm;">'
        f'{chips_html}</div>'
    )

    # Monthly rain tile grid
    rain_color_map = {
        "dry":        "rgba(255,255,255,0.8)",
        "light":      "rgba(255,255,255,0.8)",
        "moderate":   "rgba(252,165,165,0.4)",
        "heavy":      "rgba(248,113,113,0.6)",
        "very_heavy": "rgba(239,68,68,0.8)",
        "extreme":    "rgba(185,28,28,1.0)",
    }
    monthly = weather.get("monthly") or []
    monthly_html = ""
    if monthly:
        tile_cells = ""
        for row in monthly:
            intensity = str(row.get("intensity", "dry")).lower()
            bg = rain_color_map.get(intensity, "rgba(255,255,255,0.8)")
            mo  = row.get("month", "")
            mm  = row.get("total_rain_mm", 0)
            tile_cells += (
                f'<div style="border:1px solid #D9E0E6;border-radius:8px;padding:6px 8px;'
                f'background:{bg};text-align:center;min-width:70px;">'
                f'<p style="font-size:6.5pt;font-weight:600;color:#0B2A3D;margin:0;">{mo}</p>'
                f'<p style="font-size:9pt;font-weight:700;color:#0B2A3D;margin:2px 0 0;">'
                f'{float(mm or 0):,.0f} mm</p>'
                f'<p style="font-size:6pt;color:#6B7785;margin:1px 0 0;">{intensity}</p>'
                f'</div>'
            )
        monthly_html = (
            f'<p style="font-size:8.5pt;font-weight:700;color:#0B2A3D;margin:0 0 5px;">'
            f'Monthly Rainfall</p>'
            f'<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8mm;">'
            f'{tile_cells}</div>'
        )

    # Events table
    events = weather.get("events") or []
    events_html = ""
    if events:
        ev_rows = ""
        for ev in events:
            clf = str(ev.get("classification", "")).replace("_", " ").title()
            ev_rows += (
                f'<tr><td style="padding:4px 8px;">{ev.get("date","")}</td>'
                f'<td style="padding:4px 8px;text-align:right;">'
                f'{float(ev.get("total_rain_mm",0) or 0):,.1f}</td>'
                f'<td style="padding:4px 8px;text-align:right;">'
                f'{float(ev.get("peak_hourly_rain_mm",0) or 0):,.1f}</td>'
                f'<td style="padding:4px 8px;">'
                f'<span style="background:rgba(239,68,68,0.15);color:#DC2626;border-radius:6px;'
                f'padding:1px 7px;font-size:7pt;font-weight:600;">{clf}</span>'
                f'</td></tr>'
            )
        events_html = (
            f'<p style="font-size:8.5pt;font-weight:700;color:#0B2A3D;margin:0 0 5px;">'
            f'Significant Rainfall Events</p>'
            f'<div style="overflow-x:auto;border:1px solid #D9E0E6;border-radius:8px;">'
            f'<table style="border-collapse:collapse;width:100%;font-family:var(--font-sans);font-size:8pt;">'
            f'<thead><tr style="background:#F4F6F8;font-size:6.5pt;text-transform:uppercase;'
            f'letter-spacing:0.12em;color:#6B7785;">'
            f'<th style="padding:5px 8px;text-align:left;">Date</th>'
            f'<th style="padding:5px 8px;text-align:right;">Total Rain (mm)</th>'
            f'<th style="padding:5px 8px;text-align:right;">Peak Hourly (mm/h)</th>'
            f'<th style="padding:5px 8px;text-align:left;">Classification</th>'
            f'</tr></thead><tbody style="color:#1F2933;">{ev_rows}</tbody></table></div>'
        )

    return chips_block + monthly_html + events_html


def _html_section_b_commentary(result: dict) -> str:
    """Diagnosis commentary paragraphs from result['diagnosis']['commentary']."""
    if not result:
        return '<p style="color:#6B7785;font-style:italic;">No data available.</p>'
    commentary = (result.get("diagnosis") or {}).get("commentary") or ""
    if not commentary:
        return '<p style="color:#6B7785;font-style:italic;">No commentary available.</p>'
    # Split on double newline or single newline
    import html as _html_mod
    paras = [p.strip() for p in str(commentary).split("\n\n") if p.strip()]
    if not paras:
        paras = [str(commentary).strip()]
    return "".join(
        f'<p style="font-size:8.5pt;color:#1F2933;line-height:1.6;margin:0 0 8px;">'
        f'{_html_mod.escape(p)}</p>'
        for p in paras
    )


def _html_section_b_root_causes(result: dict) -> str:
    """Root causes cards from result['diagnosis']['root_causes']."""
    if not result:
        return ""
    root_causes = (result.get("diagnosis") or {}).get("root_causes") or []
    if not root_causes:
        return '<p style="color:#6B7785;font-style:italic;">No root causes identified.</p>'
    import html as _html_mod
    recov_colors = {
        "fully":      ("#059669", "rgba(5,150,105,0.12)"),
        "partial":    ("#C98A00", "rgba(201,138,0,0.12)"),
        "none":       ("#C62828", "rgba(198,40,40,0.12)"),
    }
    cards = ""
    for rc in root_causes:
        recov = str(rc.get("recoverability", "partial")).lower()
        txt_c, bg_c = recov_colors.get(recov, ("#3E516C", "rgba(62,81,108,0.08)"))
        cards += (
            f'<div style="border:1px solid #D9E0E6;border-radius:10px;padding:10px 14px;'
            f'background:{bg_c};margin-bottom:8px;">'
            f'<p style="font-size:8pt;font-weight:700;color:#0B2A3D;margin:0 0 3px;">'
            f'{_html_mod.escape(str(rc.get("title","")))} &mdash; '
            f'<span style="color:{txt_c};">{rc.get("cause","")}</span></p>'
            f'<p style="font-size:7.5pt;color:#1F2933;margin:0 0 3px;">'
            f'{_html_mod.escape(str(rc.get("action","")))} </p>'
            f'<span style="font-size:6.5pt;font-weight:600;color:{txt_c};">'
            f'Recoverability: {recov.title()}</span>'
            f'</div>'
        )
    return cards


def _html_section_b_curtailment(result: dict) -> str:
    """Curtailment candidate cards from result['diagnosis']['curtailment_candidates']."""
    if not result:
        return ""
    candidates = (result.get("diagnosis") or {}).get("curtailment_candidates") or []
    if not candidates:
        return '<p style="color:#6B7785;font-style:italic;">No curtailment events identified.</p>'
    import html as _html_mod
    cards = ""
    for c in candidates:
        loss = float(c.get("estimated_loss_mwh", 0) or 0)
        cards += (
            f'<div style="border:1px solid #D9E0E6;border-radius:10px;padding:10px 14px;'
            f'background:rgba(245,158,11,0.08);margin-bottom:8px;">'
            f'<p style="font-size:8pt;font-weight:700;color:#0B2A3D;margin:0 0 2px;">'
            f'{_html_mod.escape(str(c.get("month","")))} — '
            f'{_html_mod.escape(str(c.get("type","Curtailment")))}</p>'
            f'<p style="font-size:7.5pt;color:#1F2933;margin:0;">'
            f'Estimated loss: <strong>{loss:,.2f} MWh</strong></p>'
            f'</div>'
        )
    return cards


def _html_yield_ranking(result: dict) -> str:
    """Top 3 + bottom 3 inverters from result['specific_yield'] by rank."""
    if not result:
        return ""
    sy_data = result.get("specific_yield") or []
    if not sy_data:
        return '<p style="color:#6B7785;font-style:italic;">No specific yield data available.</p>'
    import html as _html_mod
    sorted_sy = sorted(sy_data, key=lambda r: float(r.get("rank", 0) or 0))
    n = len(sorted_sy)
    top3 = sorted_sy[:3]
    bot3 = sorted_sy[max(0, n - 3):]

    def _row(r, is_good: bool):
        color = "#059669" if is_good else "#C62828"
        bg    = "rgba(5,150,105,0.08)" if is_good else "rgba(198,40,40,0.08)"
        sy    = float(r.get("yield_kwh_kwp", r.get("specific_yield_kwh_kwp", 0)) or 0)
        return (
            f'<tr style="background:{bg};">'
            f'<td style="padding:4px 8px;font-weight:600;color:{color};">'
            f'{_html_mod.escape(str(r.get("inv_id","")))} </td>'
            f'<td style="padding:4px 8px;text-align:right;">{sy:,.1f}</td>'
            f'<td style="padding:4px 8px;text-align:right;">#{int(r.get("rank",0))}</td>'
            f'</tr>'
        )

    top_rows = "".join(_row(r, True) for r in top3)
    bot_rows = "".join(_row(r, False) for r in bot3)
    thead = (
        '<thead><tr style="background:#F4F6F8;font-size:6.5pt;text-transform:uppercase;'
        'letter-spacing:0.12em;color:#6B7785;">'
        '<th style="padding:5px 8px;text-align:left;">Inverter</th>'
        '<th style="padding:5px 8px;text-align:right;">Specific Yield (kWh/kWp)</th>'
        '<th style="padding:5px 8px;text-align:right;">Rank</th>'
        '</tr></thead>'
    )
    return (
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">'
        '<div>'
        '<p style="font-size:8pt;font-weight:700;color:#059669;margin:0 0 5px;">Top 3 Inverters</p>'
        '<div style="border:1px solid #D9E0E6;border-radius:8px;overflow:hidden;">'
        f'<table style="border-collapse:collapse;width:100%;font-size:8pt;'
        f'font-family:var(--font-sans);">{thead}<tbody>{top_rows}</tbody></table></div></div>'
        '<div>'
        '<p style="font-size:8pt;font-weight:700;color:#C62828;margin:0 0 5px;">Bottom 3 Inverters</p>'
        '<div style="border:1px solid #D9E0E6;border-radius:8px;overflow:hidden;">'
        f'<table style="border-collapse:collapse;width:100%;font-size:8pt;'
        f'font-family:var(--font-sans);">{thead}<tbody>{bot_rows}</tbody></table></div></div>'
        '</div>'
    )


def _html_section_d(result: dict, tariff_eur_mwh: float) -> str:
    """Loss deep-dive table from result['diagnosis']['loss_breakdown']."""
    if not result:
        return '<p style="color:#6B7785;font-style:italic;">No data available.</p>'
    loss_breakdown = (result.get("diagnosis") or {}).get("loss_breakdown") or []
    if not loss_breakdown:
        return '<p style="color:#6B7785;font-style:italic;">No loss breakdown data available.</p>'
    import html as _html_mod
    tariff = float(tariff_eur_mwh or 0)
    class_colors = {
        "availability": "#DC2626",
        "clipping": "#D97706",
        "soiling": "#92400E",
        "curtailment": "#D97706",
        "string": "#DC2626",
        "irradiance": "#6B7785",
        "temperature": "#6B7785",
    }
    rows_html = ""
    total_mwh = 0.0
    total_keur = 0.0
    for row in sorted(loss_breakdown, key=lambda r: float(r.get("value_mwh", 0) or 0), reverse=True):
        lbl  = str(row.get("label", ""))
        clf  = str(row.get("classification", "")).lower()
        vmwh = float(row.get("value_mwh", 0) or 0)
        vkeur = vmwh * tariff / 1000.0
        total_mwh  += vmwh
        total_keur += vkeur
        action = str(row.get("commentary", "") or row.get("action", ""))
        dot_color = class_colors.get(clf, "#6B7785")
        badge = (
            f'<span style="background:rgba(0,0,0,0.06);border-radius:6px;'
            f'padding:1px 7px;font-size:7pt;font-weight:600;color:{dot_color};">'
            f'{clf.title()}</span>'
        )
        rows_html += (
            f'<tr>'
            f'<td style="padding:5px 8px;font-weight:600;">{_html_mod.escape(lbl)}</td>'
            f'<td style="padding:5px 8px;">{badge}</td>'
            f'<td style="padding:5px 8px;text-align:right;">{vmwh:,.2f}</td>'
            f'<td style="padding:5px 8px;text-align:right;">{vkeur:,.1f}</td>'
            f'<td style="padding:5px 8px;font-size:7.5pt;color:#6B7785;">'
            f'{_html_mod.escape(action)}</td>'
            f'</tr>'
        )
    rows_html += (
        f'<tr style="background:#F4F6F8;font-weight:700;border-top:2px solid #D9E0E6;">'
        f'<td style="padding:5px 8px;" colspan="2">Total Losses</td>'
        f'<td style="padding:5px 8px;text-align:right;">{total_mwh:,.2f} MWh</td>'
        f'<td style="padding:5px 8px;text-align:right;">{total_keur:,.1f} k€</td>'
        f'<td style="padding:5px 8px;"></td>'
        f'</tr>'
    )
    return (
        '<div style="overflow-x:auto;border:1px solid #D9E0E6;border-radius:8px;">'
        '<table style="border-collapse:collapse;width:100%;font-family:var(--font-sans);font-size:8pt;">'
        '<thead><tr style="background:#F4F6F8;font-size:6.5pt;text-transform:uppercase;'
        'letter-spacing:0.12em;color:#6B7785;">'
        '<th style="padding:5px 8px;text-align:left;">Loss Category</th>'
        '<th style="padding:5px 8px;text-align:left;">Classification</th>'
        '<th style="padding:5px 8px;text-align:right;">Loss (MWh)</th>'
        '<th style="padding:5px 8px;text-align:right;">Loss (k€)</th>'
        '<th style="padding:5px 8px;text-align:left;">Recommended Action</th>'
        f'</tr></thead><tbody style="color:#1F2933;">{rows_html}</tbody></table></div>'
    )


def _html_section_f(result: dict) -> str:
    """Data quality KPI chips + data-quality commentary."""
    import html as _html_mod
    if not result:
        return '<p style="color:#6B7785;font-style:italic;">No data available.</p>'
    dq = result.get("data_quality") or {}

    # KPI chips — field names match pipeline data_quality dict
    chip_keys = [
        ("Overall Completeness", "overall_power_pct", "%"),
        ("Irradiance Completeness", "irradiance_pct", "%"),
        ("Stuck Inverters", "stuck_inverters_count", ""),
    ]
    chips = ""
    for lbl, key, unit in chip_keys:
        val = dq.get(key)
        if val is not None:
            chips += (
                f'<div style="border:1px solid #D9E0E6;border-radius:10px;'
                f'padding:8px 14px;min-width:110px;">'
                f'<p style="font-size:6.5pt;text-transform:uppercase;'
                f'letter-spacing:0.12em;color:#6B7785;margin:0 0 4px;">{lbl}</p>'
                f'<p style="font-size:12pt;font-weight:700;color:#0B2A3D;margin:0;">'
                f'{float(val):.1f}{unit}</p>'
                f'</div>'
            )
    chips_block = (
        f'<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:8mm;">'
        f'{chips}</div>'
    ) if chips else ""

    # Data quality completeness heatmap (same source as app)
    dq_rows = dq.get("monthly") or []
    irr_rows = dq.get("monthly_irradiance") or []
    # Data quality commentary from diagnosis
    dq_commentary = ((result.get("diagnosis") or {}).get("section_commentary") or {}).get("data_quality") or []
    commentary_html = ""
    if dq_commentary:
        paras = "".join(
            f'<p style="font-size:8pt;color:#1F2933;line-height:1.6;margin:0 0 6px;">'
            f'{_html_mod.escape(str(p))}</p>'
            for p in dq_commentary
        )
        commentary_html = f'<div style="margin-top:6mm;">{paras}</div>'

    if not chips_block and not commentary_html:
        return '<p style="color:#6B7785;font-style:italic;">No data quality information available.</p>'

    note = ""
    if dq_rows or irr_rows:
        note = (
            '<div style="margin-top:5mm;border:1px solid #D9E0E6;border-radius:10px;padding:10px 12px;background:#F9FBFD;">'
            '<p style="font-size:8pt;color:#1F2933;line-height:1.6;margin:0;">'
            'The detailed data-completeness heat map is shown once in the dedicated site-overview/data-quality page. '
            'This section keeps only the KPI summary and analytical assumptions so the export does not repeat the same figure.'
            '</p></div>'
        )

    return chips_block + note + commentary_html


def _html_detailed_punchlist(result: dict, tariff_eur_mwh: float) -> str:
    punchlist = result.get("punchlist") or []
    if not punchlist:
        return '<p style="color:#6B7785;font-style:italic;">No detailed punchlist findings are available for this run.</p>'

    rows_html = ""
    for item in punchlist:
        priority = str(item.get("priority", "LOW")).upper()
        row_class = "row-danger" if priority == "HIGH" else "row-warning" if priority == "MEDIUM" else "row-success"
        impact_mwh = item.get("impact_mwh")
        impact_eur = item.get("impact_eur")
        if impact_eur is None and impact_mwh is not None and tariff_eur_mwh > 0:
            impact_eur = float(impact_mwh) * tariff_eur_mwh
        issue_lines = [
            f'<div style="font-weight:700;color:#0B2A3D;margin-bottom:4px;">{_html_mod.escape(str(item.get("title") or item.get("category") or "Finding"))}</div>',
            f'<div>{_html_mod.escape(str(item.get("finding", "")))}</div>',
        ]
        action_lines = [f'<div>{_html_mod.escape(str(item.get("recommendation", "")))}</div>']
        rows_html += (
            f'<tr class="{row_class}">'
            f'<td>{priority}</td>'
            f'<td>{_html_mod.escape(str(item.get("category", "Finding")))}</td>'
            f'<td style="text-align:right;">{f"{float(impact_mwh):,.0f}" if impact_mwh is not None else "—"}</td>'
            f'<td style="text-align:right;">{f"{float(impact_eur):,.0f}" if impact_eur is not None else "—"}</td>'
            f'<td>{"".join(issue_lines)}</td>'
            f'<td>{"".join(action_lines)}</td>'
            f'</tr>'
        )

    return (
        '<div style="overflow-x:auto;border:1px solid #D9E0E6;border-radius:8px;">'
        '<table style="border-collapse:collapse;width:100%;font-family:var(--font-sans);font-size:8pt;">'
        '<thead><tr style="background:#F4F6F8;font-size:6.5pt;text-transform:uppercase;letter-spacing:0.12em;color:#6B7785;">'
        '<th style="padding:5px 8px;text-align:left;">Priority</th>'
        '<th style="padding:5px 8px;text-align:left;">Category</th>'
        '<th style="padding:5px 8px;text-align:right;">Estimated loss (MWh)</th>'
        '<th style="padding:5px 8px;text-align:right;">Estimated loss (€)</th>'
        '<th style="padding:5px 8px;text-align:left;">Issue</th>'
        '<th style="padding:5px 8px;text-align:left;">Recommended action</th>'
        f'</tr></thead><tbody style="color:#1F2933;">{rows_html}</tbody></table></div>'
    )


def _html_technology_risk_register() -> str:
    rows = [
        ("HIGH", "Sungrow SG250HX", "AC Relay Wear (Fault 038) — high trip-count sites develop pitted contacts; inverter fails to reconnect after trip.", "Extract trip count from iSolarCloud Event Log. If >500 trips/yr, replace relay proactively. Check SPDs in LV cabinet for earth short. Listen for relay click on restart — absent = failed relay."),
        ("HIGH", "Sungrow SG250HX", "DC Insulation Fault (Fault 039) — triggered after rain if string Riso < 50 kΩ. High risk with third-party MC4 connectors or cables pinched under tracker rails.", "String-by-string isolation test to locate affected string. Megger at 1000 V DC (target >1 MΩ). Replace third-party MC4 connectors with OEM-compatible type."),
        ("HIGH", "Sungrow SG250HX", "MPPT Wiring Error — persistent single-inverter PR 10–15% below fleet with no fault alarms and no seasonal variation. Can persist for years undetected.", "Audit strings per MPPT vs single-line diagram. Calculate DC power per MPPT vs rated input. Run iSolarCloud I-V curve scan to identify anomalous MPPT channels."),
        ("HIGH", "First Solar Series 6", "PID / TCO Corrosion — power loss at negative-string-end modules from sodium migration and TCO corrosion. Risk elevated in ungrounded high-voltage systems.", "EL imaging survey prioritising negative-string-end modules. IV-curve for Voc and fill factor loss signature. Verify edge seal integrity on suspect modules."),
        ("HIGH", "First Solar Series 6", "PR Decline Exceeding Warranted Rate — warranted 0.55%/yr (Cu back contact) or 0.2%/yr (CuRe). Fleet-wide PR decline >1%/yr requires priority investigation.", "EL/IV testing on module sample. Review soiling log and cleaning records. Check inverter efficiency trending. Compare irradiance sensor vs PVGIS-SARAH3 for sensor drift."),
        ("MEDIUM", "Sungrow SG250HX", "Thermal Overtemperature (Faults 036/037) — summer midday trips if ambient >45°C near cabinet, seized fan bearings, or blocked air inlet filters.", "Inspect fans and air filters at every maintenance visit. 500 mm clearance required around enclosure. Install shade canopy if ambient routinely >45°C in summer."),
        ("MEDIUM", "Sungrow SG250HX", "French Grid Curtailment Not Logged (SUN-014) — RTE/Enedis curtailment appearing as unexplained PR dips. ~3 TWh curtailed in France in 2025, rising sharply.", "Verify curtailment command timestamps logged in SCADA. Cross-reference with grid operator records for months with unexplained PR drops. Exclude curtailed periods from contractual PR."),
        ("MEDIUM", "SCADA / Irradiance", "Irradiance Sensor Drift — thermopile pyranometers drift +1–3%/yr without heating in humid climates, making PR appear to decline. Reference cells overestimate daily irradiation by >2%.", "Monthly comparison of on-site irradiation vs PVGIS-SARAH3. Annual sensor calibration (IEC 61724-1 Class A). Weekly cleaning log. Replace Class C instruments with ISO 9060 Class A for contractual PR."),
        ("MEDIUM", "First Solar Series 6", "Hot Spot Detection Difficulty — monolithic CdTe structure and glass-glass encapsulation produce smaller surface temperature gradients than c-Si; standard IR surveys miss them.", "Use high-sensitivity IR camera (NETD <50 mK). Perform thermographic survey at >600 W/m² irradiance. Confirm with IV-curve fill factor loss measurement on suspect modules."),
        ("INFO", "First Solar Series 6", "CdTe Temperature Coefficient Advantage — Pmax coeff. −0.28%/°C vs c-Si −0.35 to −0.50%/°C. Summer PR should exceed c-Si benchmarks — this is expected, not a fault.", "Do not apply c-Si PR benchmarks to CdTe plants in hot conditions. Summer PR declining toward c-Si levels may signal module degradation or soiling eroding the thermal advantage."),
        ("INFO", "Sungrow SG250HX", "iSolarCloud Remote I-V Curve Scan — full-plant diagnostic identifies dust, cracks, diode shorts, MPPT mismatch, and PID attenuation in ~15 minutes with <0.5% accuracy.", "Schedule remote I-V curve scan via iSolarCloud before any field dispatch for unexplained underperformance. Results localise affected strings without site visit."),
        ("INFO", "Sungrow SG250HX", "Clipping Loss Underestimation — at DC/AC ratio 1.27 (this site), clipping occurs ~3–4% of annual operating hours. 10-min SCADA averages mask true clipping magnitude.", "Configure SCADA at 5-min resolution to capture clipping accurately. Apply clipping correction factor when comparing SCADA PR to hourly yield model."),
    ]
    rows_html = ""
    for priority, equipment, risk, action in rows:
        row_class = "row-danger" if priority == "HIGH" else "row-warning" if priority == "MEDIUM" else "row-info"
        rows_html += (
            f'<tr class="{row_class}">'
            f'<td>{priority}</td><td>{equipment}</td><td>{risk}</td><td>{action}</td>'
            f'</tr>'
        )
    return (
        '<div class="commentary-card" style="margin-bottom:6mm;">'
        '<h3>Risk context</h3>'
        '<p>This register consolidates 5 HIGH-priority and 4 MEDIUM-priority technology-specific risks derived from field experience across comparable French utility-scale PV sites, Sungrow EMEA fault documentation, First Solar technical papers, and NREL/IEA monitoring standards.</p>'
        '<p>HIGH items represent failure modes with confirmed field precedent and material energy loss potential that can persist undetected without targeted inspection. MEDIUM items are relevant operational watch-points. INFO items provide benchmarking context to avoid misinterpreting normal technology behaviour as faults.</p>'
        '</div>'
        '<div style="overflow-x:auto;border:1px solid #D9E0E6;border-radius:8px;">'
        '<table style="border-collapse:collapse;width:100%;font-family:var(--font-sans);font-size:8pt;">'
        '<thead><tr style="background:#F4F6F8;font-size:6.5pt;text-transform:uppercase;letter-spacing:0.12em;color:#6B7785;">'
        '<th style="padding:5px 8px;text-align:left;">Priority</th>'
        '<th style="padding:5px 8px;text-align:left;">Equipment</th>'
        '<th style="padding:5px 8px;text-align:left;">Risk / What to Watch</th>'
        '<th style="padding:5px 8px;text-align:left;">Diagnostic / Action</th>'
        f'</tr></thead><tbody style="color:#1F2933;">{rows_html}</tbody></table></div>'
    )


def _html_appendix_limitations(result: dict) -> str:
    punchlist = result.get("punchlist") or []
    scope_rows = [
        ("Data availability assessment", "Completed", "Per-inverter and site-level telemetry completeness reviewed."),
        ("Performance ratio assessment", "Completed", "Monthly and annual PR calculated on the IEC 61724 DC-kWp basis."),
        ("Irradiance coherence (SARAH-3)", "Completed", "On-site irradiance cross-checked against SARAH reference, including bias and suspect-reading screening."),
        ("Availability and reliability review", "Completed", "Fleet uptime, inverter-level availability, and fault recurrence screened."),
        ("Loss attribution", "Completed", "Budget, weather correction, availability loss, technical loss, and residual reviewed."),
        ("Per-inverter specific yield", "Completed", "Monthly inverter heatmaps reviewed for recurring underperformance patterns."),
        ("Start/stop signature screening", "Completed", "Fleet-relative wake-up and shut-down timing deviations screened for threshold anomalies."),
        ("Weather-correlation review", "Completed", "Rainfall and temperature context considered in the diagnostic workflow."),
    ]
    constraint_rows = [
        ("Inverter AC/DC efficiency", "Not possible", "No DC current or DC power channels are available in the export."),
        ("String-level fault detection", "Not possible", "The SCADA extract is limited to inverter-level AC production."),
        ("Short transients", "Limited", "The 10-minute sampling interval is too coarse for sub-interval fault isolation."),
        ("Downtime root cause", "Limited", "Alarm and fault-code channels are absent, so trips are classified indirectly."),
        ("Curtailment certainty", "Limited", "Without explicit export-limit flags, curtailment remains heuristic."),
        ("Degradation certainty", "Limited", "The available time horizon remains too short for a statistically robust long-term degradation estimate."),
        ("Soiling quantification", "Not possible", "No dedicated soiling sensor or IV-curve dataset is available to isolate accumulation rates."),
    ]

    def _table(headers: list[str], rows: list[tuple[str, ...]]) -> str:
        head_html = "".join(f'<th style="padding:5px 8px;text-align:left;">{_html_mod.escape(header)}</th>' for header in headers)
        body_html = "".join(
            '<tr>' + "".join(f'<td style="padding:6px 8px;vertical-align:top;">{_html_mod.escape(str(cell))}</td>' for cell in row) + '</tr>'
            for row in rows
        )
        return (
            '<div style="overflow-x:auto;border:1px solid #D9E0E6;border-radius:8px;margin-top:4mm;">'
            '<table style="border-collapse:collapse;width:100%;font-family:var(--font-sans);font-size:8pt;">'
            f'<thead><tr style="background:#F4F6F8;font-size:6.5pt;text-transform:uppercase;letter-spacing:0.12em;color:#6B7785;">{head_html}</tr></thead>'
            f'<tbody style="color:#1F2933;">{body_html}</tbody></table></div>'
        )

    top_actions = []
    for item in punchlist[:5]:
        impact_text = f"{float(item.get('impact_mwh')):,.0f} MWh" if item.get("impact_mwh") is not None else "—"
        top_actions.append((
            str(item.get("priority", "LOW")),
            str(item.get("category", "Finding")),
            impact_text,
            str(item.get("recommendation", "")),
        ))

    return (
        '<div class="commentary-card">'
        '<h3>Summary</h3>'
        '<p>Summary of the analytical scope completed for this assessment and the principal data constraints affecting interpretation.</p>'
        '</div>'
        '<div style="margin-top:6mm;"><p style="font-size:8.5pt;font-weight:700;color:#0B2A3D;margin:0 0 5px;">Analytical Scope Completed</p>'
        + _table(["Activity", "Status", "Notes"], scope_rows)
        + '</div>'
        + '<div style="margin-top:6mm;"><p style="font-size:8.5pt;font-weight:700;color:#0B2A3D;margin:0 0 5px;">Analytical Constraints</p>'
        + _table(["Analysis", "Status", "Notes"], constraint_rows)
        + '</div>'
        + (
            '<div style="margin-top:6mm;"><p style="font-size:8.5pt;font-weight:700;color:#0B2A3D;margin:0 0 5px;">Priority Action Snapshot</p>'
            + _table(["Priority", "Category", "Estimated loss", "Recommended action"], top_actions)
            + '</div>'
            if top_actions
            else ''
        )
    )


# ─────────────────────────────────────────────────────────────────────────────
# HTML ASSEMBLY
# ─────────────────────────────────────────────────────────────────────────────

def _b64_file(path: Path, mime: str = "image/png") -> str:
    if path and path.exists():
        return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()
    return ""


def _reveal_svg_logo(height: str = "28px") -> str:
    """Inline SVG REVEAL wordmark — white text, orange accent bar."""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 210 44" '
        f'style="height:{height};width:auto;display:inline-block;vertical-align:middle;" '
        f'aria-label="REVEAL logo">'
        f'<text x="2" y="34" font-family="Aptos,Calibri,Arial,Helvetica,sans-serif" '
        f'font-size="30" font-weight="700" letter-spacing="0.10em" fill="#FFFFFF">REVEAL</text>'
        f'<rect x="2" y="39" width="52" height="3" rx="1.5" fill="#F39200"/>'
        f'</svg>'
    )


def _header(logo_b64: str, site_name: str, report_title: str) -> str:
    logo_tag = (f'<img src="{logo_b64}" alt="REVEAL logo">' if logo_b64
                else _reveal_svg_logo(height="26px"))
    return f"""
<div class="header-shell">
  <div class="header-band">
    {logo_tag}
    <div class="header-copy">
      <p class="header-site">{site_name}</p>
      <p class="header-company">{report_title}</p>
    </div>
  </div>
  <div class="header-accent"></div>
</div>"""


def _section_heading(eyebrow: str, title: str, summary: str = "") -> str:
    s = f'<p class="section-summary">{summary}</p>' if summary else ""
    return f"""
<div class="section-heading">
  <p class="eyebrow">{eyebrow}</p>
  <h2>{title}</h2>
  {s}
</div>"""


def _html_specific_yield_heatmap(sy_monthly: list) -> str:
    """REVEAL-style specific yield heatmap: inverter rows x month columns, colour-coded by yield."""
    if not sy_monthly:
        return '<p style="color:#6B7785;font-style:italic;padding:4mm 0;">No specific yield data available.</p>'

    months = sorted({r["month"] for r in sy_monthly})
    inverters = sorted({r["inv_id"] for r in sy_monthly}, key=_natural_key)
    lookup = {(r["inv_id"], r["month"]): float(r.get("yield_kwh_kwp") or 0) for r in sy_monthly}

    all_vals = [v for v in lookup.values() if v > 0]
    val_min = min(all_vals) if all_vals else 0.0
    val_max = max(all_vals) if all_vals else 1.0

    def _fmt_month(m: str) -> str:
        try:
            dt = datetime.strptime(m[:7], "%Y-%m")
            return dt.strftime("%b %y")
        except Exception:
            return m[:7]

    def _yield_color(v: float) -> tuple:
        if v <= 0:
            return "#ECEFF1", "#9E9E9E"
        span = max(val_max - val_min, 1e-9)
        ratio = (v - val_min) / span
        if ratio >= 0.75:
            return "rgba(52,211,153,0.65)", "#065f46"
        if ratio >= 0.50:
            return "rgba(52,211,153,0.30)", "#0B2A3D"
        if ratio >= 0.25:
            return "rgba(56,189,248,0.30)", "#0369a1"
        return "rgba(239,68,68,0.25)", "#C62828"

    col_min_w = max(34, min(56, 640 // max(len(months), 1)))
    th_cells = "".join(
        f'<th style="min-width:{col_min_w}px;font-size:6pt;padding:2px 1px;'
        f'writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap;'
        f'font-weight:600;color:#3E516C;text-align:center;">{_fmt_month(m)}</th>'
        for m in months
    )
    header = (
        '<thead><tr>'
        '<th style="min-width:80px;text-align:left;font-size:7.5pt;padding:4px 8px;'
        'position:sticky;left:0;background:#F4F6F8;z-index:2;border-right:1px solid #D9E0E6;'
        'color:#0B2A3D;font-weight:600;">Inverter</th>'
        + th_cells + '</tr></thead>'
    )
    rows_html = []
    for inv_id in inverters:
        cells = []
        for month in months:
            v = lookup.get((inv_id, month))
            if v is None:
                cells.append('<td style="background:#ECEFF1;"></td>')
            else:
                bg, fg = _yield_color(v)
                title = f"{inv_id} · {month} · {v:.1f} kWh/kWp"
                cells.append(
                    f'<td title="{title}" style="background:{bg};color:{fg};text-align:center;'
                    f'font-size:6pt;font-weight:700;padding:2px 0;border-bottom:1px solid rgba(0,0,0,0.04);">'
                    f'{v:.0f}</td>'
                )
        rows_html.append(
            f'<tr><td style="font-size:7pt;padding:2px 8px;white-space:nowrap;'
            f'position:sticky;left:0;background:#fff;z-index:1;'
            f'border-right:1px solid #D9E0E6;color:#1F2933;font-weight:600;">{inv_id}</td>'
            + "".join(cells) + '</tr>'
        )
    return (
        f'<div style="overflow-x:auto;max-width:100%;">'
        f'<table style="border-collapse:collapse;width:100%;table-layout:fixed;">'
        f'{header}<tbody>{"".join(rows_html)}</tbody>'
        f'</table></div>'
    )


def _kpi_card(label: str, value: str, sub: str = "", status: str = "") -> str:
    return f"""
<div class="kpi-card {status}">
  <p class="kpi-label">{label}</p>
  <p class="kpi-value">{value}</p>
  <p class="kpi-subtext">{sub}</p>
</div>"""


def _figure(img_or_svg: str, caption: str = "", full: bool = True) -> str:
    w_cls = "width-full" if full else "width-half"
    cap = f"<figcaption>{caption}</figcaption>" if caption else ""
    if not img_or_svg:
        return ""
    if img_or_svg.startswith("<"):
        # Inline SVG or HTML — pass through directly
        return f'<div class="figure-card {w_cls}"><figure>{img_or_svg}{cap}</figure></div>'
    # base64 PNG (legacy charts still using matplotlib)
    return f'<div class="figure-card {w_cls}"><figure><img src="{img_or_svg}" alt="{caption}">{cap}</figure></div>'


def _build_sections_af(
    analysis_result: "dict | None",
    site_cfg: dict,
    hdr: str,
) -> str:
    """Build all Section A–F pages from the pipeline analysis_result dict.

    Returns an HTML string of zero or more <section class="page ..."> blocks.
    Gracefully handles missing/None analysis_result — returns empty string.
    """
    if not analysis_result or not isinstance(analysis_result, dict):
        return ""

    parts: list[str] = []
    tariff_eur_mwh = float(site_cfg.get("tariff_eur_mwh") or 0)

    # ── SECTION A: Weather context ────────────────────────────────────────────
    _irr_check = (analysis_result.get("diagnosis") or {}).get("irradiance_check") or {}
    _img_irr_benchmark = chart_irradiance_benchmark(_irr_check)
    if analysis_result.get("weather") or _img_irr_benchmark:
        _irr_chart_html = ""
        if _img_irr_benchmark:
            _irr_source = _irr_check.get("source") or "ERA5"
            _irr_chart_html = (
                f'<p style="font-size:8.5pt;font-weight:700;color:#0B2A3D;margin:8mm 0 3px;">'
                f'Measured Irradiance vs {_irr_source} Reference</p>'
                f'<p style="font-size:7.5pt;color:#6B7785;margin:0 0 4px;">Month-by-month comparison. '
                f'Persistent bias can point to pyranometer calibration, cleaning, shading, or scaling issues.</p>'
                f'{_figure(_img_irr_benchmark, f"Measured irradiance vs {_irr_source} reference (kWh/m²)")}'
            )
        parts.append(f"""
<!-- ═══════════════ SECTION A: WEATHER CONTEXT ═══════════════ -->
<section class="page standard-page">
  {hdr}
  <div class="page-content layout-block">
    {_section_heading("Section A", "Weather Context",
        "Rainfall analysis, significant weather events, and irradiance benchmark comparison.")}
    {_html_section_a(analysis_result)}
    {_irr_chart_html}
  </div>
</section>""")

    # ── SECTION B: Monthly performance story ──────────────────────────────────
    pr_monthly   = (analysis_result.get("pr") or {}).get("monthly") or []
    avail_monthly = (analysis_result.get("availability") or {}).get("site_monthly") or []
    diagnosis    = analysis_result.get("diagnosis") or {}
    loss_breakdown = diagnosis.get("loss_breakdown") or []
    curtailment_candidates = diagnosis.get("curtailment_candidates") or []

    img_monthly_energy  = chart_monthly_energy(pr_monthly)
    img_monthly_pr_irr  = chart_monthly_pr_irradiation(pr_monthly)
    img_loss_breakdown  = chart_loss_breakdown(loss_breakdown)

    sec_b_charts = ""
    if img_monthly_energy and img_monthly_pr_irr:
        sec_b_charts = (
            f'<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:6mm;">'
            f'<div class="section-b-primary">{_figure(img_monthly_energy, "Monthly actual vs reference energy (MWh)", full=False)}</div>'
            f'<div class="section-b-primary">{_figure(img_monthly_pr_irr, "Monthly PR (%) and irradiation (kWh/m²)", full=False)}</div>'
            f'</div>'
        )
    elif img_monthly_energy:
        sec_b_charts = f'<div class="section-b-primary">{_figure(img_monthly_energy, "Monthly actual vs reference energy (MWh)")}</div>'
    elif img_monthly_pr_irr:
        sec_b_charts = f'<div class="section-b-primary">{_figure(img_monthly_pr_irr, "Monthly PR (%) and irradiation (kWh/m²)")}</div>'

    parts.append(f"""
<!-- ═══════════════ SECTION B: MONTHLY PERFORMANCE ═══════════════ -->
<section class="page standard-page page-section-b">
  {hdr}
  <div class="page-content layout-block">
    {_section_heading("Section B", "Monthly Performance Story",
        "Energy, PR and irradiation trends; diagnosis commentary and identified root causes.")}
    {sec_b_charts}
    {(f'<div class="section-b-loss-breakdown">{_figure(img_loss_breakdown, "Energy loss breakdown by category")}</div>' if img_loss_breakdown else "")}
    <div class="commentary-card" style="margin-top:6mm;">
      <h3>Diagnosis Commentary</h3>
      {_html_section_b_commentary(analysis_result)}
    </div>
    <div style="margin-top:6mm;">
      <p style="font-size:8.5pt;font-weight:700;color:#0B2A3D;margin:0 0 5px;">Root Causes</p>
      {_html_section_b_root_causes(analysis_result)}
    </div>
    <div style="margin-top:6mm;">
      <p style="font-size:8.5pt;font-weight:700;color:#0B2A3D;margin:0 0 5px;">Curtailment Events</p>
      {_html_section_b_curtailment(analysis_result)}
    </div>
  </div>
</section>""")

    # ── SECTION C: Inverter diagnostics ───────────────────────────────────────
    mttf_by_inv = (analysis_result.get("mttf") or {}).get("by_inverter") or []
    start_stop  = analysis_result.get("start_stop") or []
    clipping_bins_data = (analysis_result.get("clipping") or {}).get("by_irradiance_bin") or []

    img_mttf         = chart_mttf(mttf_by_inv, start_stop)
    img_clipping     = chart_clipping_bins(clipping_bins_data)

    yield_ranking_html = _html_yield_ranking(analysis_result)

    clipping_pair = ""
    if img_mttf and img_clipping:
        clipping_pair = (
            f'<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:6mm;">'
            f'{_figure(img_mttf, "MTTF by inverter (worst-first) with start deviation", full=False)}'
            f'{_figure(img_clipping, "Clipping frequency by irradiance bin", full=False)}'
            f'</div>'
        )
    elif img_mttf:
        clipping_pair = _figure(img_mttf, "MTTF by inverter (worst-first) with start deviation")
    elif img_clipping:
        clipping_pair = _figure(img_clipping, "Clipping frequency by irradiance bin")

    parts.append(f"""
<!-- ═══════════════ SECTION C: INVERTER DIAGNOSTICS ═══════════════ -->
<section class="page standard-page">
  {hdr}
  <div class="page-content layout-block">
    {_section_heading("Section C", "Inverter Diagnostics",
        "Mean Time To Failure (MTTF), start-deviation and clipping analysis per inverter.")}
    {clipping_pair}
    <div style="margin-top:6mm;">
      <p style="font-size:8.5pt;font-weight:700;color:#0B2A3D;margin:0 0 5px;">
        Specific Yield Ranking</p>
      {yield_ranking_html}
    </div>
  </div>
</section>""")

    # ── SECTION D: Loss deep-dive ─────────────────────────────────────────────
    parts.append(f"""
<!-- ═══════════════ SECTION D: LOSS DEEP-DIVE ═══════════════ -->
<section class="page standard-page">
  {hdr}
  <div class="page-content layout-block">
    {_section_heading("Section D", "Loss Deep-Dive",
        "Detailed energy loss breakdown by category with financial impact and recommended actions.")}
    {_html_section_d(analysis_result, tariff_eur_mwh)}
  </div>
</section>""")

    # ── SECTION E: Trend annex ────────────────────────────────────────────────
    annual_data  = analysis_result.get("annual") or \
                   (analysis_result.get("pr") or {}).get("annual") or []
    dq_rows_data = (analysis_result.get("data_quality") or {}).get("monthly") or []

    img_annual_pr    = chart_annual_pr(annual_data)
    img_event_overlay = chart_event_overlay(
        pr_monthly, avail_monthly, dq_rows_data, curtailment_candidates)

    trend_charts = ""
    if img_annual_pr:
        trend_charts += _figure(img_annual_pr, "Annual PR (%) and energy (MWh) trend")
    if img_event_overlay:
        trend_charts += _figure(img_event_overlay,
                                "Event overlay: PR / availability / data quality / curtailment")

    parts.append(f"""
<!-- ═══════════════ SECTION E: TREND ANNEX ═══════════════ -->
<section class="page standard-page">
  {hdr}
  <div class="page-content layout-block">
    {_section_heading("Section E", "Trend Annex",
        "Multi-year PR and energy trend; event overlay combining PR, availability, "
        "data quality metrics and curtailment.")}
    {trend_charts if trend_charts else
     '<p style="color:#6B7785;font-style:italic;padding:4mm 0;">Insufficient data for trend analysis.</p>'}
  </div>
</section>""")

    # ── SECTION F: Data quality assumptions ───────────────────────────────────
    parts.append(f"""
<!-- ═══════════════ SECTION F: DATA QUALITY ASSUMPTIONS ═══════════════ -->
<section class="page standard-page">
  {hdr}
  <div class="page-content layout-block">
    {_section_heading("Section F", "Data Quality &amp; Analytical Assumptions",
        "Overview of data completeness KPIs and assumptions used in this analysis.")}
    {_html_section_f(analysis_result)}
  </div>
</section>""")

    return "\n".join(parts)


def _assemble_html(*, site_cfg: dict, report_date_str: str, period_str: str,
                   logo_b64: str, cover_img_b64: str,
                   html_completeness: str, html_irr_heatmap: str,
                   img_monthly: str,
                   img_sy: str, img_waterfall: str,
                   overview: pd.DataFrame, wf: dict,
                   issues: list[dict], pr_target: float,
                   analysis_result: "dict | None" = None) -> str:

    report_css, print_css = _load_static_css()

    site_name    = site_cfg["display_name"]
    cap_dc       = site_cfg["cap_dc_kwp"]
    cap_ac       = site_cfg.get("cap_ac_kw", 0)
    n_inv        = site_cfg["n_inverters"]
    technology   = site_cfg.get("technology", "-")
    inv_model    = site_cfg.get("inverter_model", "-")
    report_title = "REVEAL Performance Analysis"
    generated    = datetime.now().strftime("%Y-%m-%d %H:%M UTC")

    # ── Additional site data from the REVEAL app dashboard ───────────────────
    module_parts = [site_cfg.get("module_brand", ""), site_cfg.get("module_model", "")]
    module_str   = " ".join(p for p in module_parts if p).strip() or "-"
    country      = site_cfg.get("country", "")
    region       = site_cfg.get("region", "")
    location_str = ", ".join(p for p in [region, country] if p) or "-"
    design_pr_raw = site_cfg.get("design_pr")
    design_pr_str = f"{float(design_pr_raw) * 100:.0f}%" if design_pr_raw else "-"
    irr_basis    = str(site_cfg.get("irradiance_basis", "")).upper() or "-"

    extra_meta_rows = ""
    if location_str != "-":
        extra_meta_rows += f"<div><dt>Location</dt><dd>{location_str}</dd></div>"
    if module_str != "-":
        extra_meta_rows += f"<div><dt>Modules</dt><dd>{module_str}</dd></div>"
    if design_pr_str != "-":
        extra_meta_rows += f"<div><dt>Design PR</dt><dd>{design_pr_str}</dd></div>"
    if irr_basis not in ("-", ""):
        extra_meta_rows += f"<div><dt>Irradiance basis</dt><dd>{irr_basis}</dd></div>"

    logo_tag  = (f'<img class="cover-logo" src="{logo_b64}" alt="REVEAL logo">'
                 if logo_b64 else _reveal_svg_logo())
    hero_html = (f'<div class="cover-hero"><img src="{cover_img_b64}" alt="Solar farm"></div>'
                 if cover_img_b64 else f'''<div class="cover-hero cover-hero-fallback" style="background:linear-gradient(135deg,#0B2A3D 0%,#3E516C 100%);">
  <div style="text-align:center;color:#ffffff;">
    <p style="font-size:9pt;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:#F39200;margin:0 0 10px;">REVEAL &#8212; Renewable Energy Analytics</p>
    <p style="font-size:26pt;font-weight:700;margin:0;line-height:1.1;">{site_name}</p>
    <p style="font-size:10pt;font-weight:400;color:rgba(255,255,255,0.7);margin:10px 0 0;">{report_title}</p>
  </div>
</div>''')

    hdr = _header(logo_b64, site_name, report_title)

    # ── Site Overview page (page 2): map + tech specs + inverter table ──────────
    _loc = site_cfg.get("location") if isinstance(site_cfg.get("location"), dict) else {}
    lat_raw = site_cfg.get("lat") or site_cfg.get("latitude") or _loc.get("lat") or _loc.get("latitude")
    lon_raw = site_cfg.get("lon") or site_cfg.get("longitude") or site_cfg.get("lng") or _loc.get("lon") or _loc.get("lng") or _loc.get("longitude")
    map_section = ""
    try:
        # ── Tech specs grid (matches solarSpecs in site/[siteId]/page.tsx) ──
        dc_ac_ratio_val = (cap_dc / cap_ac) if cap_ac > 0 else 0
        solar_specs = [
            ("Technology",                site_cfg.get("technology", "—")),
            ("Inverter model",            site_cfg.get("inv_model") or site_cfg.get("inverter_model") or "—"),
            ("Inverter AC (kW)",          str(site_cfg.get("inv_ac_kw") or (cap_ac / max(n_inv, 1))) ),
            ("Module brand",              site_cfg.get("module_brand") or "—"),
            ("Module Wp",                 str(site_cfg.get("module_wp") or "—")),
            ("Modules",                   f"{int(site_cfg.get('n_modules', 0)):,}" if site_cfg.get("n_modules") else "—"),
            ("Module tilt",               f"{site_cfg.get('module_tilt_deg')} deg" if site_cfg.get("module_tilt_deg") is not None else "—"),
            ("Irradiance basis",          str(site_cfg.get("irradiance_basis", "—")).upper()),
            ("Tariff",                    f"{site_cfg.get('tariff_eur_mwh')} EUR/MWh" if site_cfg.get("tariff_eur_mwh") is not None else "—"),
            ("Timezone",                  site_cfg.get("site_timezone") or site_cfg.get("timezone") or "—"),
            ("Configured inverter DC units", str(n_inv)),
            ("DC/AC ratio",               f"{dc_ac_ratio_val:.3f}"),
            ("SCADA interval",            f"{site_cfg.get('interval_min', 10)} min"),
            ("Irradiance threshold",      f"{site_cfg.get('irr_threshold', 50)} W/m²"),
        ]
        specs_html = "".join(
            f'<div style="min-width:0;">'
            f'<dt style="font-size:7pt;color:#6B7785;text-transform:uppercase;letter-spacing:0.12em;">{lbl}</dt>'
            f'<dd style="font-size:9pt;font-weight:600;color:#1F2933;margin:2px 0 0;">{val}</dd>'
            f'</div>'
            for lbl, val in solar_specs
        )

        # ── Inverter capacity table (matches inverterBreakdownWithDerived) ──
        solar_inv_units = site_cfg.get("solar_inverter_units") or []
        inv_ac_kw_each  = float(site_cfg.get("inv_ac_kw") or (cap_ac / max(n_inv, 1)))
        module_wp       = float(site_cfg.get("module_wp") or 0)

        if solar_inv_units:
            rows = []
            for item in sorted(solar_inv_units, key=lambda x: x.get("tag", "")):
                dc_kwp  = float(item.get("dc_capacity_kwp") or 0)
                mods    = item.get("module_count") or (int(dc_kwp * 1000 / module_wp) if module_wp > 0 else 0)
                dc_ac   = dc_kwp / inv_ac_kw_each if inv_ac_kw_each > 0 else 0
                share   = dc_kwp / cap_dc * 100 if cap_dc > 0 else 0
                rows.append((item.get("tag", "—"), mods, inv_ac_kw_each, dc_kwp, dc_ac, share))
            max_dc  = max((r[3] for r in rows), default=1)
            total_mods = sum(r[1] for r in rows)
            total_ac   = sum(r[2] for r in rows)
            total_dc   = sum(r[3] for r in rows)
        else:
            dc_per_inv = cap_dc / n_inv if n_inv > 0 else 0
            mods_per   = int(dc_per_inv * 1000 / module_wp) if module_wp > 0 else 0
            share_each = 100.0 / n_inv if n_inv > 0 else 0
            dc_ac_each = dc_per_inv / inv_ac_kw_each if inv_ac_kw_each > 0 else 0
            rows = [(f"INV{i+1}", mods_per, inv_ac_kw_each, dc_per_inv, dc_ac_each, share_each)
                    for i in range(n_inv)]
            max_dc = dc_per_inv or 1
            total_mods = sum(r[1] for r in rows)
            total_ac   = sum(r[2] for r in rows)
            total_dc   = sum(r[3] for r in rows)

        def _bar(dc_kwp, max_dc_kwp):
            pct = max(dc_kwp / max(max_dc_kwp, 1) * 100, 2)
            return (
                f'<div style="display:flex;align-items:center;gap:6px;">'
                f'<span style="min-width:52px;">{dc_kwp:,.2f}</span>'
                f'<div style="flex:1;height:7px;background:#ECEFF1;border-radius:4px;overflow:hidden;min-width:80px;">'
                f'<div style="height:100%;width:{pct:.0f}%;border-radius:4px;'
                f'background:linear-gradient(90deg,rgba(198,40,40,.9),rgba(243,146,0,.9) 60%,rgba(52,211,153,.9));"></div>'
                f'</div>'
                f'<span style="font-size:7pt;color:#6B7785;min-width:30px;text-align:right;">'
                f'{dc_kwp/max(max_dc_kwp,1)*100:.0f}%</span>'
                f'</div>'
            )

        inv_rows_html = "".join(
            f'<tr>'
            f'<td style="padding:4px 8px;font-weight:600;white-space:nowrap;">{tag}</td>'
            f'<td style="padding:4px 8px;">{mods:,}</td>'
            f'<td style="padding:4px 8px;">{ac_kw:,.0f}</td>'
            f'<td style="padding:4px 8px;min-width:200px;">{_bar(dc_kwp, max_dc)}</td>'
            f'<td style="padding:4px 8px;">{dc_ac:.3f}</td>'
            f'<td style="padding:4px 8px;">{share:.2f}%</td>'
            f'</tr>'
            for tag, mods, ac_kw, dc_kwp, dc_ac, share in rows
        )
        total_dc_ac = total_dc / total_ac if total_ac > 0 else 0
        inv_rows_html += (
            f'<tr style="background:#F4F6F8;font-weight:700;border-top:2px solid #D9E0E6;">'
            f'<td style="padding:5px 8px;">Total</td>'
            f'<td style="padding:5px 8px;">{total_mods:,}</td>'
            f'<td style="padding:5px 8px;">{total_ac:,.0f}</td>'
            f'<td style="padding:5px 8px;">{total_dc:,.2f}</td>'
            f'<td style="padding:5px 8px;">{total_dc_ac:.3f}</td>'
            f'<td style="padding:5px 8px;">100.00%</td>'
            f'</tr>'
        )

        # ── Map HTML ──
        # Leaflet CSS + JS are injected into <head> via leaflet_head_html below.
        # Here we only place the div and the deferred init script.
        if lat_raw is not None and lon_raw is not None:
            lat_f, lon_f = float(lat_raw), float(lon_raw)
            site_name_js = site_name.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("'", "&#39;")
            map_div = f"""
    <div id="reveal-site-map" style="width:100%;height:340px;border-radius:10px;border:1px solid #D9E0E6;overflow:hidden;margin-bottom:8mm;"></div>
    <script>
    window.addEventListener('load', function() {{
      if (typeof L === 'undefined') return;
      var m = L.map('reveal-site-map', {{ center: [{lat_f}, {lon_f}], zoom: 5, zoomControl: true }});
      L.tileLayer('https://{{s}}.basemaps.cartocdn.com/rastertiles/voyager/{{z}}/{{x}}/{{y}}{{r}}.png', {{
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19
      }}).addTo(m);
      var icon = L.divIcon({{ className: '',
        html: '<div style="width:16px;height:16px;border-radius:50%;background:#F39200;border:3px solid #0B2A3D;box-shadow:0 2px 8px rgba(0,0,0,0.5);"></div>',
        iconSize: [16,16], iconAnchor: [8,8] }});
      L.marker([{lat_f},{lon_f}], {{icon:icon}}).addTo(m)
        .bindPopup(
          '<div style="text-align:center;padding:2px 4px;">'
          + '<div style="font-size:10pt;font-weight:700;color:#fff;margin-bottom:3px;">{site_name_js}</div>'
          + '<div style="font-size:7.5pt;color:rgba(255,255,255,.6);">{lat_f:.5f}°N,&nbsp;{lon_f:.5f}°E</div>'
          + '</div>',
          {{className:'reveal-popup'}}
        ).openPopup();
      setTimeout(function() {{ m.invalidateSize(); }}, 100);
    }});
    </script>"""
            coord_note = f" &nbsp;·&nbsp; {lat_f:.5f}&#176;N, {lon_f:.5f}&#176;E"
        else:
            map_div   = ""
            coord_note = ""

        map_section = f"""
<!-- ═══════════════ PAGE 2: SITE OVERVIEW ═══════════════ -->
<section class="page standard-page page-site-overview">
  {hdr}
  <div class="page-content layout-block">
    {_section_heading("Site Overview", site_name,
        f"{site_cfg.get('region','')}{', ' if site_cfg.get('region') and site_cfg.get('country') else ''}{site_cfg.get('country','')}{coord_note}")}
    {map_div}

    <!-- Technical Specifications -->
    <p style="font-size:8.5pt;font-weight:700;color:#0B2A3D;margin:0 0 6px;">Technical Specifications</p>
    <dl style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px 24px;margin:0 0 10mm;">
      {specs_html}
    </dl>

    <!-- Inverter Capacity Table -->
    <p style="font-size:8.5pt;font-weight:700;color:#0B2A3D;margin:0 0 6px;">Inverter Capacity Breakdown</p>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:6mm;">
      <div style="border:1px solid #D9E0E6;border-radius:8px;padding:6px 10px;">
        <p style="font-size:6.5pt;text-transform:uppercase;letter-spacing:0.12em;color:#6B7785;margin:0;">Configured inverter units</p>
        <p style="font-size:11pt;font-weight:700;color:#0B2A3D;margin:3px 0 0;">{len(rows)}</p>
      </div>
      <div style="border:1px solid #D9E0E6;border-radius:8px;padding:6px 10px;">
        <p style="font-size:6.5pt;text-transform:uppercase;letter-spacing:0.12em;color:#6B7785;margin:0;">Total configured inverter DC</p>
        <p style="font-size:11pt;font-weight:700;color:#0B2A3D;margin:3px 0 0;">{total_dc:,.2f} kWp</p>
      </div>
      <div style="border:1px solid #D9E0E6;border-radius:8px;padding:6px 10px;">
        <p style="font-size:6.5pt;text-transform:uppercase;letter-spacing:0.12em;color:#6B7785;margin:0;">Site DC capacity</p>
        <p style="font-size:11pt;font-weight:700;color:#0B2A3D;margin:3px 0 0;">{cap_dc:,.2f} kWp</p>
      </div>
      <div style="border:1px solid #D9E0E6;border-radius:8px;padding:6px 10px;">
        <p style="font-size:6.5pt;text-transform:uppercase;letter-spacing:0.12em;color:#6B7785;margin:0;">Difference</p>
        <p style="font-size:11pt;font-weight:700;color:#0B2A3D;margin:3px 0 0;">{cap_dc - total_dc:,.2f} kWp</p>
      </div>
    </div>
    <div style="overflow-x:auto;border:1px solid #D9E0E6;border-radius:8px;">
      <table style="border-collapse:collapse;width:100%;font-family:var(--font-sans);font-size:8pt;">
        <thead>
          <tr style="background:#F4F6F8;text-transform:uppercase;font-size:6.5pt;letter-spacing:0.12em;color:#6B7785;">
            <th style="padding:6px 8px;text-align:left;font-weight:600;">Inverter tag</th>
            <th style="padding:6px 8px;text-align:left;font-weight:600;"># Modules</th>
            <th style="padding:6px 8px;text-align:left;font-weight:600;">AC capacity (kW)</th>
            <th style="padding:6px 8px;text-align:left;font-weight:600;">DC capacity (kWp)</th>
            <th style="padding:6px 8px;text-align:left;font-weight:600;">DC/AC ratio</th>
            <th style="padding:6px 8px;text-align:left;font-weight:600;">Share of site DC</th>
          </tr>
        </thead>
        <tbody style="color:#1F2933;">
          {inv_rows_html}
        </tbody>
      </table>
    </div>
  </div>
</section>"""
    except (TypeError, ValueError):
        pass

    # ── KPIs from overview + waterfall ──────────────────────────────────────
    total_energy = overview["energy_kwh"].sum() if "energy_kwh" in overview.columns else 0
    # For single-day interval data, overview has ghi_w_m2 (W/m²) not irradiation_kwh_m2.
    # Use the waterfall irradiation (correctly computed as Σ GHI × interval_h / 1000).
    total_irr    = (overview["irradiation_kwh_m2"].sum()
                    if "irradiation_kwh_m2" in overview.columns
                    else wf.get("irradiation", 0))
    # Period PR = actual / (irradiation × cap_dc) — more stable than mean of per-slot PRs
    # which are distorted by sensor floors and low-irradiance slots.
    _wf_irr = wf.get("irradiation", 0)
    mean_pr = (wf.get("actual", 0) / (_wf_irr * cap_dc) * 100
               if _wf_irr > 0 and cap_dc > 0
               else (overview["pr_pct"].mean() if "pr_pct" in overview.columns else 0))
    spec_yield   = (total_energy / cap_dc) if cap_dc > 0 else 0
    n_high       = sum(1 for i in issues if i["severity"] == "HIGH")
    n_med        = sum(1 for i in issues if i["severity"] == "MEDIUM")

    def pr_status(pr):
        if pr >= pr_target * 100 - 2:  return "status-success"
        if pr >= pr_target * 100 - 8:  return "status-warning"
        return "status-danger"

    kpi_html = "".join([
        _kpi_card("Total Energy (period)", f"{total_energy/1000:,.1f} MWh", "measured output"),
        _kpi_card("Specific Yield",        f"{spec_yield:.2f}",             "kWh/kWp"),
        _kpi_card("Mean PR",               f"{mean_pr:.1f}%",
                  f"Target {pr_target*100:.0f}%", pr_status(mean_pr)),
        _kpi_card("Total Irradiation",     f"{total_irr:.1f}",              "kWh/m\u00b2"),
        _kpi_card("Actual Energy",         f"{wf.get('actual',0)/1000:,.1f} MWh",
                  f"vs {wf.get('reference',0)/1000:,.1f} MWh ref."),
        _kpi_card("Issues Detected",       f"{n_high}H / {n_med}M",
                  "HIGH / MEDIUM",
                  "status-danger" if n_high else "status-warning" if n_med else "status-success"),
    ])

    # ── Punchlist rows (6 columns) ─────────────────────────────────────────
    sev_class = {"HIGH": "row-danger", "MEDIUM": "row-warning", "LOW": "row-success"}
    punchlist_rows = ""
    for iss in issues:
        rc  = sev_class.get(iss["severity"], "")
        metrics = f"SY&#160;{iss['sy']}&#160;kWh/kWp | Avail.&#160;{iss['avail']} | PR&#160;{iss['pr']}"
        punchlist_rows += f"""
<tr class="{rc}">
  <td>{iss['equip']}</td>
  <td>{iss['severity']}</td>
  <td>{iss['type']}</td>
  <td style="white-space:nowrap">{iss['energy_loss']:,.0f}</td>
  <td>{iss['description']}<br><span style="color:#6B7785;font-size:6.4pt">{metrics}</span></td>
  <td>{iss['action']}</td>
</tr>"""
    if not punchlist_rows:
        punchlist_rows = """<tr class="row-success">
  <td colspan="6" style="text-align:center;font-style:italic;color:#6B7785;">
    No significant issues detected &#8212; all inverters within normal operating parameters.
  </td></tr>"""

    # ── Waterfall summary rows (from items list) ─────────────────────────────
    _base_labels = {"Design yield", "Weather-corrected yield", "Actual yield"}
    wf_rows = ""
    for itm in wf.get("items", []):
        lbl   = itm.get("label", "")
        val   = float(itm.get("value_mwh", 0.0))
        itype = itm.get("type", "loss")
        color = itm.get("color", "#1F2933")
        if itype == "base":
            row_cls = "row-success" if lbl == "Actual yield" else ""
            val_str = f"<strong>{val:,.1f} MWh</strong>" if lbl == "Actual yield" else f"{val:,.1f} MWh"
            prefix  = ""
        else:
            row_cls = "row-danger" if val > 0 else ""
            val_str = f"&#8722;{val:,.1f} MWh" if val > 0 else "&#8212;"
            prefix  = ""
        dot = f'<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:{color};margin-right:5px;vertical-align:middle;"></span>'
        wf_rows += (
            f'<tr class="{row_cls}">'
            f'<td>{dot}{lbl}</td>'
            f'<td style="text-align:right;">{val_str}</td>'
            f'</tr>'
        )

    # Leaflet in <head> so CSS is guaranteed loaded before map init
    _has_map = (lat_raw is not None and lon_raw is not None)
    leaflet_head = (
        '<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>\n'
        '  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>\n'
        '  <style>'
        '.reveal-popup .leaflet-popup-content-wrapper{'
        'background:#0B2A3D;color:#fff;border-radius:12px;'
        'box-shadow:0 4px 20px rgba(0,0,0,.45);border:none;padding:0;}'
        '.reveal-popup .leaflet-popup-content{margin:12px 16px;}'
        '.reveal-popup .leaflet-popup-tip-container .leaflet-popup-tip{background:#0B2A3D;}'
        '.reveal-popup .leaflet-popup-close-button{color:rgba(255,255,255,.55)!important;}'
        '</style>'
        if _has_map else ""
    )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{site_name} &#8212; {report_title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap" rel="stylesheet">
  {leaflet_head}
  <style>{_ROOT_VARS}</style>
  <style>{report_css}</style>
  <style>{print_css}</style>
  <style>
/* ── Per-section overrides for this report ── */
.page-performance-overview .kpi-grid {{
  grid-template-columns: repeat(3, minmax(0, 1fr));
}}
.page-data-quality .figure-card img      {{ max-height: 200mm; }}
.page-specific-yield .figure-card img    {{ max-height: 220mm; }}
.page-performance-overview .figure-card.width-full img {{ max-height: 112mm; }}
.page-section-b .section-b-primary .figure-card img {{ max-height: 132mm; width: 100%; object-fit: contain; }}
.page-section-b .section-b-loss-breakdown .figure-card img {{ max-height: 72mm; width: 100%; object-fit: contain; }}
.page-losses .figure-grid {{ display:block; }}
.page-losses .figure-card img {{ width:100%; max-height:none; object-fit:contain; }}
/* ── Punchlist column widths (6-col layout) ── */
.page-action-punchlist .report-table {{
  table-layout: fixed;
  width: 100%;
}}
.page-action-punchlist .report-table th:nth-child(1),
.page-action-punchlist .report-table td:nth-child(1) {{ width: 8%; white-space: nowrap; }}
.page-action-punchlist .report-table th:nth-child(2),
.page-action-punchlist .report-table td:nth-child(2) {{ width: 10%; }}
.page-action-punchlist .report-table th:nth-child(3),
.page-action-punchlist .report-table td:nth-child(3) {{ width: 10%; }}
.page-action-punchlist .report-table th:nth-child(4),
.page-action-punchlist .report-table td:nth-child(4) {{ width: 10%; }}
.page-action-punchlist .report-table th:nth-child(5),
.page-action-punchlist .report-table td:nth-child(5) {{ width: 31%; }}
.page-action-punchlist .report-table th:nth-child(6),
.page-action-punchlist .report-table td:nth-child(6) {{ width: 31%; }}
  </style>
</head>
<body>

<!-- ═══════════════ PAGE 1: COVER ═══════════════ -->
<section class="page cover-page">
  <div class="cover-band">
    {logo_tag}
    <div class="header-copy">
      <p class="header-site">{site_name}</p>
      <p class="header-company">REVEAL | 8p2 Advisory</p>
    </div>
  </div>
  <div class="cover-accent"></div>
  <div class="cover-body layout-block">
    {hero_html}
    <div class="cover-panel">
      <p class="eyebrow">REVEAL &#8212; Renewable Energy Analytics</p>
      <h1>{site_name} &#8212; {report_title}</h1>
      <p class="cover-subtitle">REVEAL Performance Report</p>
      <dl class="cover-metadata">
        <div><dt>Project</dt><dd>{site_name}</dd></div>
        <div><dt>Asset</dt><dd>{cap_dc:,.0f} kWp DC / {cap_ac:,.0f} kW AC</dd></div>
        <div><dt>Analysis period</dt><dd>{period_str}</dd></div>
        <div><dt>Technology</dt><dd>{technology}</dd></div>
        <div><dt>Inverters</dt><dd>{n_inv} &#215; {inv_model}</dd></div>
        {extra_meta_rows}
        <div><dt>Issued</dt><dd>{generated}</dd></div>
      </dl>
    </div>
  </div>
</section>

{map_section}

<!-- ═══════════════ PAGE 3: DATA QUALITY ═══════════════ -->
<section class="page standard-page page-data-quality">
  {hdr}
  <div class="page-content layout-block">
    {_section_heading("Data Quality", "Data Completeness",
        "Monthly fraction of expected SCADA records per inverter and irradiance sensor. "
        "Green&#160;&#8805;95% valid &nbsp;|&nbsp; Blue&#160;&#8805;85% &nbsp;|&nbsp; "
        "Pink&#160;=&#160;missing (M) &nbsp;|&nbsp; Red&#160;=&#160;frozen/stuck (F).")}
    {html_completeness if html_completeness else
     '<p style="color:#6B7785;font-style:italic;padding:4mm 0;">No inverter data available.</p>'}
    {(f'<div style="margin-top:5mm;">'
      f'<p style="font-size:8.5pt;font-weight:700;color:#0B2A3D;margin:0 0 3px;">Irradiance Sensor Completeness</p>'
      f'<p style="font-size:7.5pt;color:#6B7785;margin:0 0 5px;">Fraction of time slots with valid irradiance readings (GHI &#8805; 0).</p>'
      f'{html_irr_heatmap}</div>') if html_irr_heatmap else ""}
    <div class="commentary-card" style="margin-top:8mm;">
      <h3>Interpretation</h3>
      <p>Green cells (&#8805;95%) indicate full data coverage. Amber/orange cells suggest occasional
         gaps &#8212; check SCADA data-logger connectivity and export schedule for flagged inverters
         and periods. Red cells (&lt;85%) indicate significant missing data that may affect KPI accuracy.</p>
    </div>
  </div>
</section>

<!-- ═══════════════ PAGE 3: PERFORMANCE OVERVIEW ═══════════════ -->
<section class="page standard-page page-performance-overview">
  {hdr}
  <div class="page-content layout-block">
    {_section_heading("Performance Overview",
        "Key Performance Indicators",
        "Site-level summary for the analysis period.")}
    <div class="kpi-grid">
      {kpi_html}
    </div>
  </div>
</section>

<!-- ═══════════════ PAGE 4: SPECIFIC YIELD HEATMAP ═══════════════ -->
<section class="page standard-page page-specific-yield">
  {hdr}
  <div class="page-content layout-block">
    {_section_heading("Per-Inverter Analysis", "Specific Yield — Monthly Heat Map",
        "Monthly specific yield (kWh/kWp) per inverter. Green&#160;=&#160;high yield · Red&#160;=&#160;low yield.")}
    <div class="commentary-card">
      <p>Compare rows horizontally &#8212; an inverter consistently below its peers indicates a
         systematic underperformance issue (soiling, shading, MPPT fault, string disconnection).
         Compare columns vertically to identify site-wide resource variation vs.&#160;isolated faults.</p>
    </div>
    {_html_specific_yield_heatmap((analysis_result or {}).get("specific_yield_monthly") or [])}
  </div>
</section>

<!-- ═══════════════ PAGE 5: ENERGY LOSS WATERFALL ═══════════════ -->
<section class="page standard-page page-losses">
  {hdr}
  <div class="page-content layout-block">
    {_section_heading("Energy Losses", "Energy Loss Waterfall",
        "Decomposition of reference energy into successive loss categories through to actual measured output.")}
    <div class="figure-grid">
      {_figure(img_waterfall, "Waterfall: reference (GHI &#215; capacity) &#8594; efficiency losses &#8594; operational losses &#8594; actual.") if img_waterfall else ""}
    </div>
    <div class="table-card">
      <div class="table-card-header"><h3>Waterfall Summary</h3></div>
      <table class="report-table" style="table-layout:auto;">
        <thead><tr><th>Category</th><th style="width:16%;text-align:right;">Energy (MWh)</th></tr></thead>
        <tbody>{wf_rows}</tbody>
      </table>
    </div>
  </div>
</section>

{_build_sections_af(analysis_result=analysis_result, site_cfg=site_cfg, hdr=hdr)}

<!-- ═══════════════ ACTION PUNCHLIST ═══════════════ -->
<section class="page standard-page page-action-punchlist">
  {hdr}
  <div class="page-content layout-block">
    {_section_heading("Action Punchlist", "Prioritised Issue Register",
        "Issues ranked by estimated energy loss impact. HIGH&#160;=&#160;immediate action required.")}
    <div class="commentary-card">
      <h3>Methodology</h3>
      <p>The punchlist below uses the live REVEAL diagnosis payload rather than the older compact issue list, so each action can carry quantified loss, detailed issue wording, and recommended follow-up steps.</p>
    </div>
    <div class="table-card">
      <div class="table-card-header"><h3>Full Action Punchlist</h3></div>
      {_html_detailed_punchlist(analysis_result or {}, tariff_eur_mwh)}
    </div>
  </div>
</section>

<!-- ═══════════════ TECHNOLOGY RISK REGISTER ═══════════════ -->
<section class="page standard-page page-tech-risk">
  {hdr}
  <div class="page-content layout-block">
    {_section_heading("Technology Risk Register", "Technology Risk Register",
        "Key failure modes, performance risks, and diagnostic actions specific to the inverter and module technologies deployed at this site.")}
    {_html_technology_risk_register()}
  </div>
</section>

<!-- ═══════════════ APPENDIX: LIMITATIONS ═══════════════ -->
<section class="page standard-page page-appendix-limitations">
  {hdr}
  <div class="page-content layout-block">
    {_section_heading("Appendix", "Appendix - Analytical Scope And Data Limitations",
        "Summary of the analytical scope completed for this assessment and the principal data constraints affecting interpretation.")}
    {_html_appendix_limitations(analysis_result or {})}
  </div>
</section>

</body>
</html>"""


# ─────────────────────────────────────────────────────────────────────────────
# PUBLIC ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

def build_scada_analysis_html(
    site_cfg: dict,
    data_dir: Path,
    out_path: Optional[Path] = None,
    skip_pdf: bool = False,
    analysis_result: "dict | None" = None,
) -> tuple:
    """
    Generate the SCADA analysis HTML report and optionally convert to PDF.

    Parameters
    ----------
    site_cfg  : dict  — platform site configuration
    data_dir  : Path  — directory containing normalised inverter & irradiance CSVs
    out_path  : Path  — where to write the HTML (default: temp dir)
    skip_pdf  : bool  — if True skip PDF conversion and return (None, html_path)

    Returns
    -------
    (pdf_path | None, html_path)
    """
    import tempfile
    data_dir = Path(data_dir)

    if out_path is None:
        td = Path(tempfile.mkdtemp(prefix="repat_"))
        site_safe = "".join(c if c.isalnum() else "_" for c in site_cfg["display_name"])
        out_path = td / f"REPAT_SCADA_{site_safe}.html"
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # ── Load data ─────────────────────────────────────────────────────────
    inv = _load_inv(data_dir)
    irr = _load_irr(data_dir)

    interval_h = _detect_interval(inv if not inv.empty else irr,
                                   fallback_min=site_cfg.get("interval_min", 10))
    irr = _normalise_ghi(irr, interval_h)

    cap_dc      = site_cfg["cap_dc_kwp"]
    n_inv       = max(site_cfg["n_inverters"], 1)
    cap_per_inv = cap_dc / n_inv
    pr_target   = site_cfg.get("operating_pr_target", 0.80)

    # ── Analysis ──────────────────────────────────────────────────────────
    design_pr  = float(site_cfg.get("design_pr") or 0.85)
    freq       = _choose_freq(inv)
    # Heatmap: prefer pipeline result data (already frozen-detected, consistent with app)
    # Fall back to re-computing from raw CSVs if pipeline result is unavailable.
    _ar_dq = (analysis_result or {}).get("data_quality") or {}
    dq_rows = _ar_dq.get("monthly") or []
    irr_rows = _ar_dq.get("monthly_irradiance") or []
    if not dq_rows:
        # Fallback: compute from raw CSV data
        inv_pivot  = _inv_to_pivot(inv, interval_h)
        dq_rows    = _dq_monthly_rows_from_inv(inv, interval_h)
        irr_rows   = _irr_monthly_rows_from_irr(irr, inv_pivot.index if not inv_pivot.empty else pd.DatetimeIndex([]))
    sy_pivot   = _specific_yield_pivot(inv, cap_per_inv, interval_h, freq)
    overview   = _period_overview(inv, irr, cap_dc, interval_h, freq)
    wf         = _waterfall(inv, irr, cap_dc, pr_target, interval_h, design_pr)
    issues     = _punchlist(inv, irr, site_cfg, interval_h)

    # ── Period string ─────────────────────────────────────────────────────
    if not inv.empty:
        d0 = inv["Time_UDT"].min().strftime("%d %b %Y")
        d1 = inv["Time_UDT"].max().strftime("%d %b %Y")
        period_str = f"{d0} to {d1}"
    else:
        period_str = "n/a"

    # ── HTML heatmap tables + charts ──────────────────────────────────────
    html_completeness = html_heatmap_table_from_rows(dq_rows, irr_rows)
    html_irr_heatmap  = ""   # now embedded inside html_completeness
    img_monthly      = chart_period_overview(overview, pr_target, freq)
    img_sy           = chart_specific_yield(sy_pivot, freq)
    img_wf           = chart_waterfall(wf)

    # ── Assets ────────────────────────────────────────────────────────────
    logo_b64 = (_b64_file(_HERE / "static" / "8p2_logo_white.png") or
                _b64_file(_ROOT / "reveal_logo_white.png") or
                _b64_file(_ROOT / "8p2_logo_white.png") or
                _b64_file(_ROOT / "dolfines_logo_white.png"))

    cover_img_b64 = ""
    for candidate_path in (
        _HERE / "static" / "cover_hero.jpg",          # bundled default
        _ROOT / "bg_solar.jpg",
        _ROOT / "00orig" / "solar_farm_2.jpg",
        _ROOT / "00orig" / "solar_farm.jpg",
        _ROOT / "france.jpg",
    ):
        if candidate_path.exists():
            cover_img_b64 = _b64_file(candidate_path, mime="image/jpeg")
            break

    # ── Assemble ──────────────────────────────────────────────────────────
    html = _assemble_html(
        site_cfg       = site_cfg,
        report_date_str= datetime.now().strftime("%d %B %Y"),
        period_str     = period_str,
        logo_b64       = logo_b64,
        cover_img_b64  = cover_img_b64,
        html_completeness = html_completeness,
        html_irr_heatmap  = html_irr_heatmap,
        img_monthly      = img_monthly,
        img_sy           = img_sy,
        img_waterfall    = img_wf,
        overview         = overview,
        wf               = wf,
        issues           = issues,
        pr_target        = pr_target,
        analysis_result  = analysis_result,
    )

    out_path.write_text(html, encoding="utf-8")

    if skip_pdf:
        return None, out_path

    pdf_path = out_path.with_suffix(".pdf")

    _pdf_errors: list[str] = []

    # ── Try Playwright (Chromium headless) ────────────────────────────────
    # setup.sh installs Chromium at deploy time, but Streamlit Cloud can
    # restart the app process within a deployment and wipe the HOME cache.
    # Re-running the install here is near-instant when already present.
    try:
        import subprocess as _sp, sys as _sys
        _sp.run(
            [_sys.executable, "-m", "playwright", "install", "chromium"],
            capture_output=True, timeout=180,
        )
    except Exception:
        pass

    try:
        from playwright.sync_api import sync_playwright as _spw
        with _spw() as pw:
            browser = pw.chromium.launch()
            page    = browser.new_page(viewport={"width": 1240, "height": 1754})
            page.emulate_media(media="screen")
            page.set_content(html, wait_until="networkidle")
            page.pdf(
                path             = str(pdf_path),
                format           = "A4",
                print_background = True,
                margin           = {"top": "0", "bottom": "0",
                                    "left": "0", "right": "0"},
            )
            browser.close()
        return pdf_path, out_path
    except Exception as _e:
        _pdf_errors.append(f"Playwright: {_e}")

    # ── Fallback: WeasyPrint (Linux system-lib install) ────────────────────
    try:
        from weasyprint import HTML as _WP_HTML
        _WP_HTML(string=html, base_url=str(out_path.parent)).write_pdf(str(pdf_path))
        return pdf_path, out_path
    except Exception as _e:
        _pdf_errors.append(f"WeasyPrint: {_e}")

    return None, out_path, _pdf_errors
