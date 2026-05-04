"""
Ger (Les Herbreux) — Enercon E82 Fleet SCADA Analysis
======================================================
Loads 10-minute SCADA data for 4 E82-2.0MW turbines (2021-2024) and computes
all statistics required for the Lifetime Assessment Report.

Usage
-----
    from ger_analysis import build_analysis
    analysis = build_analysis()

Or from the command line:
    python ger_analysis.py
"""

from __future__ import annotations

import json
import warnings
from math import gamma
from pathlib import Path
from typing import Dict, Any

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Optional scipy imports — fall back gracefully
# ---------------------------------------------------------------------------
try:
    from scipy.stats import weibull_min as _weibull_min
    _HAS_SCIPY = True
except ImportError:
    _HAS_SCIPY = False

try:
    from lifetime_model import fit_weibull, compute_del_ratio, weibull_mean
    _HAS_LIFETIME_MODEL = True
except ImportError:
    _HAS_LIFETIME_MODEL = False


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_YEARS = ["2021", "2022", "2023", "2024"]   # skip 2025 (partial year)
_RATED_POWER_KW = 2050.0                     # Enercon E82-2.0MW rated power
_HOURS_PER_YEAR = 8760.0
_SECTOR_LABELS = [
    "N (0-30°)", "NNE (30-60°)", "ENE (60-90°)", "E (90-120°)",
    "ESE (120-150°)", "SSE (150-180°)", "S (180-210°)", "SSW (210-240°)",
    "WSW (240-270°)", "W (270-300°)", "WNW (300-330°)", "NNW (330-360°)",
]


# ---------------------------------------------------------------------------
# Low-level Weibull helpers (used when lifetime_model is not available)
# ---------------------------------------------------------------------------

def _fit_weibull_fallback(ws: np.ndarray):
    """
    Fit a 2-parameter Weibull using scipy MLE if available, else method of
    moments (Justus 1978 approximation).

    Returns (k, A).
    """
    ws = np.asarray(ws, dtype=float)
    ws = ws[np.isfinite(ws) & (ws > 0.0)]

    if len(ws) < 10:
        mean_v = float(np.mean(ws)) if len(ws) > 0 else 6.0
        return 2.0, mean_v / gamma(1.5)

    if _HAS_SCIPY:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                c, _loc, scale = _weibull_min.fit(ws, floc=0)
            k = float(np.clip(c, 0.5, 10.0))
            A = float(np.clip(scale, 0.1, 50.0))
            return k, A
        except Exception:
            pass

    # Method of moments fallback
    sigma = float(np.std(ws))
    mean_v = float(np.mean(ws))
    k_est = (sigma / mean_v) ** (-1.086) if mean_v > 0 else 2.0
    k_est = float(np.clip(k_est, 0.5, 10.0))
    A_est = mean_v / gamma(1.0 + 1.0 / k_est)
    A_est = max(0.1, A_est)
    return k_est, A_est


def _weibull_mean_local(k: float, A: float) -> float:
    """E[V] = A * Gamma(1 + 1/k)."""
    return float(A * gamma(1.0 + 1.0 / k))


def _compute_del_ratio_local(
    site_k: float,
    site_A: float,
    cert_vave: float,
    cert_k: float = 2.0,
    wohler_m: int = 10,
) -> float:
    """
    Damage Equivalent Load ratio: site / design using m-th moment of the
    Weibull distribution.
    """
    m = float(wohler_m)
    site_E_Vm = (site_A ** m) * gamma(1.0 + m / site_k)
    cert_A = cert_vave / gamma(1.0 + 1.0 / cert_k)
    cert_E_Vm = (cert_A ** m) * gamma(1.0 + m / cert_k)
    if cert_E_Vm <= 0.0:
        return 1.0
    return float(np.clip(site_E_Vm / cert_E_Vm, 0.01, 20.0))


# Resolve which implementations to use
if _HAS_LIFETIME_MODEL:
    _fit_weibull = fit_weibull
    _weibull_mean = weibull_mean
    _del_ratio = compute_del_ratio
else:
    _fit_weibull = _fit_weibull_fallback
    _weibull_mean = _weibull_mean_local
    _del_ratio = _compute_del_ratio_local


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def _turbine_id_from_filename(path: Path) -> str:
    """
    Extract turbine ID from filename.
    'GER_E1_822880.xls'  ->  'E1-822880'
    """
    stem = path.stem          # e.g. GER_E1_822880
    parts = stem.split("_")   # ['GER', 'E1', '822880']
    if len(parts) >= 3:
        return f"{parts[1]}-{parts[2]}"
    return stem


def _load_turbine_file(xls_path: Path) -> pd.DataFrame:
    """
    Load one turbine XLS file (all years 2021-2024), return cleaned DataFrame.
    """
    turbine_id = _turbine_id_from_filename(xls_path)
    print(f"  Loading {xls_path.name}  [{turbine_id}]")
    frames = []

    for year_str in _YEARS:
        try:
            df = pd.read_excel(
                xls_path,
                sheet_name=year_str,
                header=2,
                engine="xlrd",
            )
        except Exception as exc:
            warnings.warn(
                f"Could not read sheet {year_str} from {xls_path.name}: {exc}",
                RuntimeWarning,
            )
            continue

        # Rename columns to standard names (handle minor whitespace variants)
        df.columns = [str(c).strip() for c in df.columns]

        # Drop ghost header rows (rows where windSpeedAvg == 'windSpeedAvg')
        if "windSpeedAvg" in df.columns:
            mask_ghost = df["windSpeedAvg"].astype(str) == "windSpeedAvg"
            df = df.loc[~mask_ghost]

        # Parse timestamp
        if "timestamp" in df.columns:
            df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")

        # Cast numeric columns
        for col in ("windSpeedAvg", "powerAvg", "windDirection", "tempEnvironment"):
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors="coerce")

        # Drop rows with no valid wind speed
        if "windSpeedAvg" in df.columns:
            df = df.loc[df["windSpeedAvg"].notna() & (df["windSpeedAvg"] > 0.0)]

        df["turbine_id"] = turbine_id
        df["year"] = year_str
        frames.append(df)

    if not frames:
        warnings.warn(f"No usable data loaded from {xls_path.name}", RuntimeWarning)
        return pd.DataFrame()

    return pd.concat(frames, ignore_index=True)


def load_fleet_data(scada_dir: Path) -> pd.DataFrame:
    """
    Load all 4 turbine XLS files from *scada_dir* and return a combined fleet
    DataFrame for years 2021-2024.
    """
    xls_files = sorted(scada_dir.glob("GER_E*.xls"))
    if not xls_files:
        raise FileNotFoundError(f"No GER_E*.xls files found in: {scada_dir}")

    all_frames = []
    for path in xls_files:
        df_t = _load_turbine_file(path)
        if not df_t.empty:
            all_frames.append(df_t)

    if not all_frames:
        raise ValueError("No SCADA data could be loaded.")

    fleet = pd.concat(all_frames, ignore_index=True)
    print(f"  Fleet DataFrame: {len(fleet):,} rows across {fleet['turbine_id'].nunique()} turbines")
    return fleet


# ---------------------------------------------------------------------------
# Statistical computations
# ---------------------------------------------------------------------------

def compute_fleet_weibull(fleet: pd.DataFrame) -> tuple:
    """Return (k, A, mean_ws, P10, P50, P90) for the full fleet wind speed."""
    ws = fleet["windSpeedAvg"].dropna().values
    ws = ws[ws > 0.0].astype(float)

    k, A = _fit_weibull(ws)
    mean_ws = float(np.mean(ws))
    p10 = float(np.percentile(ws, 10))
    p50 = float(np.percentile(ws, 50))
    p90 = float(np.percentile(ws, 90))
    return k, A, mean_ws, p10, p50, p90


def compute_annual_stats(
    fleet: pd.DataFrame,
    rated_power_kw: float = _RATED_POWER_KW,
    n_turbines: int = 4,
) -> Dict[str, Dict[str, float]]:
    """
    Per-year fleet statistics:
      - mean_ws (m/s)
      - energy_mwh (total production across all turbines)
      - cf_pct (capacity factor %)
    """
    annual = {}
    for year_str in _YEARS:
        df_yr = fleet.loc[fleet["year"] == year_str]
        if df_yr.empty:
            annual[year_str] = {"mean_ws": float("nan"), "energy_mwh": float("nan"), "cf_pct": float("nan")}
            continue

        mean_ws = float(df_yr["windSpeedAvg"].mean())

        # Energy: sum(powerAvg * 10min interval) converted to MWh
        # powerAvg is in kW; 10 min = 10/60 h
        if "powerAvg" in df_yr.columns:
            energy_kwh = float(df_yr["powerAvg"].clip(lower=0).sum() * (10.0 / 60.0))
            energy_mwh = energy_kwh / 1000.0
        else:
            energy_mwh = float("nan")

        # Capacity factor: actual energy / theoretical maximum energy
        # max energy = rated_power_kw * hours_in_year * n_turbines / 1000
        # Use 8760 h/year
        max_energy_mwh = rated_power_kw * _HOURS_PER_YEAR * n_turbines / 1000.0
        cf_pct = (energy_mwh / max_energy_mwh * 100.0) if max_energy_mwh > 0 else float("nan")

        annual[year_str] = {
            "mean_ws": round(mean_ws, 3),
            "energy_mwh": round(energy_mwh, 1),
            "cf_pct": round(cf_pct, 2),
        }

    return annual


def compute_per_turbine_stats(
    fleet: pd.DataFrame,
    rated_power_kw: float = _RATED_POWER_KW,
) -> Dict[str, Dict[str, float]]:
    """
    Per-turbine statistics over the full 2021-2024 period:
      - mean_ws, energy_mwh, cf_pct
    """
    per_turbine = {}
    # 4 years * 8760 hours/year
    total_hours = _HOURS_PER_YEAR * len(_YEARS)
    max_energy_mwh = rated_power_kw * total_hours / 1000.0

    for tid in sorted(fleet["turbine_id"].unique()):
        df_t = fleet.loc[fleet["turbine_id"] == tid]
        mean_ws = float(df_t["windSpeedAvg"].mean())

        if "powerAvg" in df_t.columns:
            energy_kwh = float(df_t["powerAvg"].clip(lower=0).sum() * (10.0 / 60.0))
            energy_mwh = energy_kwh / 1000.0
        else:
            energy_mwh = float("nan")

        cf_pct = (energy_mwh / max_energy_mwh * 100.0) if max_energy_mwh > 0 else float("nan")

        per_turbine[tid] = {
            "mean_ws": round(mean_ws, 3),
            "energy_mwh": round(energy_mwh, 1),
            "cf_pct": round(cf_pct, 2),
        }

    return per_turbine


def compute_sector_frequency(fleet: pd.DataFrame) -> Dict[str, float]:
    """
    Wind direction distribution in 12 × 30° sectors.
    Returns dict with sector label -> frequency (%).
    """
    if "windDirection" not in fleet.columns:
        return {lbl: float("nan") for lbl in _SECTOR_LABELS}

    wd = fleet["windDirection"].dropna().values.astype(float)
    wd = wd % 360.0
    total = len(wd)

    sector_freq = {}
    for i, label in enumerate(_SECTOR_LABELS):
        lo = i * 30.0
        hi = lo + 30.0
        count = int(np.sum((wd >= lo) & (wd < hi)))
        sector_freq[label] = round(count / total * 100.0, 3) if total > 0 else float("nan")

    return sector_freq


def compute_ti_by_bin(fleet: pd.DataFrame) -> Dict[int, float]:
    """
    Approximate turbulence intensity per 1 m/s wind speed bin (1-20 m/s).
    TI proxy = std(windSpeedAvg) / mean(windSpeedAvg) within each bin.
    """
    ws = fleet["windSpeedAvg"].dropna().values.astype(float)
    ws = ws[ws > 0.0]

    ti_by_bin = {}
    for bin_center in range(1, 21):
        lo = bin_center - 0.5
        hi = bin_center + 0.5
        mask = (ws >= lo) & (ws < hi)
        bin_ws = ws[mask]
        if len(bin_ws) >= 5:
            mean_v = float(np.mean(bin_ws))
            std_v = float(np.std(bin_ws))
            ti = std_v / mean_v if mean_v > 0 else float("nan")
        else:
            ti = float("nan")
        ti_by_bin[bin_center] = round(ti, 5) if not np.isnan(ti) else float("nan")

    return ti_by_bin


def compute_power_curve(fleet: pd.DataFrame) -> Dict[float, float]:
    """
    Fleet power curve: mean powerAvg per 0.5 m/s wind speed bin (0-25 m/s).
    """
    if "powerAvg" not in fleet.columns:
        return {}

    ws = fleet["windSpeedAvg"].values.astype(float)
    pw = fleet["powerAvg"].values.astype(float)
    valid = np.isfinite(ws) & np.isfinite(pw) & (ws >= 0.0)
    ws = ws[valid]
    pw = pw[valid]

    bins = np.arange(0.0, 25.5, 0.5)
    power_curve = {}
    for i in range(len(bins) - 1):
        lo = bins[i]
        hi = bins[i + 1]
        bin_center = round(float(lo + 0.25), 2)
        mask = (ws >= lo) & (ws < hi)
        if mask.sum() >= 3:
            power_curve[bin_center] = round(float(np.mean(pw[mask])), 2)
        else:
            power_curve[bin_center] = float("nan")

    return power_curve


def compute_del_ratios(
    fleet_k: float,
    fleet_A: float,
    ti_by_bin: Dict[int, float],
    config: dict,
) -> Dict[str, Dict[str, float]]:
    """
    Generic IEC DEL ratio calculation for each component in wohler_exponents.

    Design basis: IEC IIA, k=2.0, vave=8.5 m/s
      A_design = vave / Gamma(1 + 1/k) = 8.5 / Gamma(1.5) = 8.5 / 0.8862 ≈ 9.59

    TI correction: uses P90 TI from the 8 m/s wind speed bin as site_ti_P90,
    compared against reference_ti=0.16 from the type certificate.
    """
    tc_cfg = config.get("type_certificate", {})
    design_lifetime = float(config.get("design_lifetime_years", 20.0))
    cert_vave = float(tc_cfg.get("vave_ms", 8.5))
    cert_k = float(tc_cfg.get("design_weibull_k", 2.0))
    reference_ti = float(tc_cfg.get("reference_ti", 0.16))
    wohler_exponents = config.get("wohler_exponents", {})

    # Site P90 TI at the 8 m/s bin (bin_center = 8)
    site_ti_p90 = ti_by_bin.get(8, reference_ti)
    if not np.isfinite(site_ti_p90):
        site_ti_p90 = reference_ti

    del_ratios = {}
    for component, m in wohler_exponents.items():
        m = int(m)

        # DEL ratio from wind speed distribution
        del_ratio = _del_ratio(
            site_k=fleet_k,
            site_A=fleet_A,
            cert_vave=cert_vave,
            cert_k=cert_k,
            wohler_m=m,
        )

        # TI correction factor (simplified DNVGL-ST-0262 approach)
        m_f = float(m)
        site_factor = (1.0 + 2.0 * site_ti_p90) ** (m_f / 2.0)
        cert_factor = (1.0 + 2.0 * reference_ti) ** (m_f / 2.0)
        ti_factor = float(np.clip(site_factor / cert_factor, 0.1, 10.0)) if cert_factor > 0 else 1.0

        combined_del = del_ratio * ti_factor
        annual_consumption_pct = combined_del / design_lifetime * 100.0

        # years_operated is computed later from config — use a placeholder;
        # the caller will fill in consumed_pct and remaining_years.
        del_ratios[component] = {
            "del_ratio": round(combined_del, 6),
            "annual_consumption_pct": round(annual_consumption_pct, 4),
            "_ti_factor": round(ti_factor, 6),
            "_wind_del_ratio": round(del_ratio, 6),
        }

    return del_ratios


def compute_reference_lifetime(config: dict, years_operated: float) -> Dict[str, Dict[str, float]]:
    """
    Build reference_lifetime dict from config['lifetime_results_reference'].
    Adds remaining_years and consumed_pct derived from years_operated.
    """
    ref_source = config.get("lifetime_results_reference", {})
    reference_lifetime = {}

    for component, data in ref_source.items():
        if component.startswith("_"):
            continue
        total_years = float(data.get("total_years", 20.0))
        end_year = float(data.get("end_year", 2030.0))
        consumed_pct = round(years_operated / total_years * 100.0, 2)
        remaining_years = round(total_years - years_operated, 2)

        reference_lifetime[component] = {
            "total_years": total_years,
            "remaining_years": remaining_years,
            "consumed_pct": consumed_pct,
            "end_year": end_year,
        }

    return reference_lifetime


# ---------------------------------------------------------------------------
# Main public function
# ---------------------------------------------------------------------------

def build_analysis(config_path: Path = None) -> dict:
    """
    Load SCADA data and compute all statistics for the Ger lifetime assessment
    report.

    Parameters
    ----------
    config_path : Path, optional
        Path to site_config.json. Defaults to
        ``<this_file_dir>/input_data/site_config.json``.

    Returns
    -------
    dict
        Full analysis dictionary (see module docstring for structure).
    """
    # ------------------------------------------------------------------ config
    if config_path is None:
        config_path = Path(__file__).parent / "input_data" / "site_config.json"

    config_path = Path(config_path)
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    with open(config_path, "r", encoding="utf-8") as fh:
        config = json.load(fh)

    print("=" * 60)
    print(f"  Site  : {config.get('site_name', 'Unknown')}")
    print(f"  Config: {config_path}")
    print("=" * 60)

    # -------------------------------------------------- years_operated
    commissioning_year = int(config.get("commissioning_year", 2010))
    commissioning_month = int(config.get("commissioning_month", 12))
    assessment_year = int(config.get("assessment_year", 2025))
    # mid-year assessment (assume mid-2025 = June = month 6)
    assessment_month = 6
    years_operated = float(
        (assessment_year - commissioning_year)
        + (assessment_month - commissioning_month) / 12.0
    )
    print(f"  Years operated: {years_operated:.2f}")

    # ------------------------------------------- locate SCADA directory
    scada_dir = config_path.parent / "site_wind_data" / "4. 4 years SCADA 10min"
    if not scada_dir.exists():
        raise FileNotFoundError(f"SCADA directory not found: {scada_dir}")

    # -------------------------------------------------- load fleet data
    print("\nLoading SCADA files …")
    fleet = load_fleet_data(scada_dir)

    # ------------------------------------------- fleet Weibull + stats
    print("\nComputing statistics …")
    fleet_k, fleet_A, fleet_mean_ws, p10, p50, p90 = compute_fleet_weibull(fleet)

    # ------------------------------------------------- annual statistics
    n_turbines = int(config.get("n_turbines", 4))
    rated_power_kw = float(config.get("rated_power_kw", _RATED_POWER_KW))
    annual_stats = compute_annual_stats(fleet, rated_power_kw, n_turbines)

    # ---------------------------------------------- per-turbine stats
    per_turbine_stats = compute_per_turbine_stats(fleet, rated_power_kw)

    # ----------------------------------------- wind direction sectors
    sector_frequency = compute_sector_frequency(fleet)

    # ----------------------------------------------- turbulence proxy
    ti_by_bin = compute_ti_by_bin(fleet)

    # --------------------------------------------------- power curve
    power_curve = compute_power_curve(fleet)

    # ---------------------------------------------- DEL ratio calculation
    del_ratios_raw = compute_del_ratios(fleet_k, fleet_A, ti_by_bin, config)

    # Fill in consumed_pct and remaining_years now that years_operated is known
    del_ratios: Dict[str, Any] = {}
    for component, data in del_ratios_raw.items():
        annual_consumption_pct = data["annual_consumption_pct"]
        consumed_pct = round(annual_consumption_pct * years_operated, 2)
        remaining_years = (
            round((100.0 - consumed_pct) / annual_consumption_pct, 2)
            if annual_consumption_pct > 0
            else float("nan")
        )
        del_ratios[component] = {
            "del_ratio": data["del_ratio"],
            "annual_consumption_pct": annual_consumption_pct,
            "consumed_pct": consumed_pct,
            "remaining_years": remaining_years,
        }

    # ------------------------------------------ reference lifetime
    reference_lifetime = compute_reference_lifetime(config, years_operated)

    # ------------------------------------------------- assemble result
    analysis: Dict[str, Any] = {
        "config": config,
        "years_operated": round(years_operated, 3),
        "fleet_weibull_k": round(fleet_k, 4),
        "fleet_weibull_A": round(fleet_A, 4),
        "fleet_mean_ws": round(fleet_mean_ws, 4),
        "ws_percentiles": {
            "P10": round(p10, 3),
            "P50": round(p50, 3),
            "P90": round(p90, 3),
        },
        "annual": annual_stats,
        "per_turbine": per_turbine_stats,
        "sector_frequency": sector_frequency,
        "ti_by_bin": ti_by_bin,
        "power_curve": power_curve,
        "del_ratios": del_ratios,
        "reference_lifetime": reference_lifetime,
        "energy_availability": config.get("energy_availability_pct"),
        "annual_production_mwh": config.get("annual_production_mwh"),
        "extension_scenarios": config.get("extension_scenarios"),
        "period_start": "January 2021",
        "period_end": "December 2024",
    }

    # --------------------------------------------------- quick summary
    print("\n--- Fleet summary ---")
    print(f"  Weibull k = {fleet_k:.3f}, A = {fleet_A:.3f} m/s")
    print(f"  Mean wind speed = {fleet_mean_ws:.2f} m/s")
    print(f"  P10/P50/P90 = {p10:.2f} / {p50:.2f} / {p90:.2f} m/s")
    print("\n--- Annual energy (fleet MWh) ---")
    for yr, st in annual_stats.items():
        print(f"  {yr}: {st['energy_mwh']:.1f} MWh  CF={st['cf_pct']:.1f}%  "
              f"mean_ws={st['mean_ws']:.2f} m/s")
    print("\n--- Per-turbine totals (2021-2024) ---")
    for tid, st in per_turbine_stats.items():
        print(f"  {tid}: {st['energy_mwh']:.1f} MWh  CF={st['cf_pct']:.1f}%  "
              f"mean_ws={st['mean_ws']:.2f} m/s")
    print("\n--- DEL ratios ---")
    for comp, dr in del_ratios.items():
        print(f"  {comp:<30} DEL={dr['del_ratio']:.4f}  "
              f"ann={dr['annual_consumption_pct']:.3f}%  "
              f"consumed={dr['consumed_pct']:.1f}%  "
              f"rem={dr['remaining_years']:.1f} yr")
    print("\n--- Reference lifetime (from aeroelastic assessment) ---")
    for comp, rl in reference_lifetime.items():
        print(f"  {comp:<30} total={rl['total_years']:.1f} yr  "
              f"rem={rl['remaining_years']:.1f} yr  "
              f"consumed={rl['consumed_pct']:.1f}%  "
              f"end={rl['end_year']:.1f}")
    print("=" * 60)

    return analysis


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    result = build_analysis()
    print("\nAnalysis complete. Keys returned:")
    for k in result:
        v = result[k]
        if isinstance(v, dict):
            print(f"  {k!r}: dict with {len(v)} entries")
        else:
            print(f"  {k!r}: {v!r}")
