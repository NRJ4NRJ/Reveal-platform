"""
Wind Farm Lifetime Assessment Model
====================================
Calculates remaining structural lifetime of a wind turbine/wind farm
based on IEC 61400-1 Ed.4 site assessment methodology.

Methodology
-----------
1. Fit Weibull distribution to site wind speed measurements per wind sector
2. Compute site turbulence intensity characteristics (P90 representative TI)
3. Derive shear exponent alpha from multi-height measurements
4. Calculate Damage Equivalent Load (DEL) ratio: site / type certificate design basis
5. Apply component-specific Wohler slopes (m) to scale fatigue damage
6. Compute annual lifetime consumption rate and remaining lifetime

Key standards referenced:
  IEC 61400-1 Ed.4 (2019) - Design requirements
  DNVGL-ST-0262 (2016)    - Lifetime extension
  GL/DNV Site Assessment  - Load extrapolation
"""
from __future__ import annotations

import json
import math
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
from scipy import stats
from scipy.optimize import curve_fit
from scipy.special import gamma as gamma_func


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class TypeCertificate:
    """Stores the design basis parameters from the turbine type certificate."""

    iec_wind_class: str
    vref_ms: float
    vave_ms: float
    reference_ti: float
    design_shear_exponent: float
    design_inflow_angle_deg: float
    design_air_density_kgm3: float
    design_lifetime_years: float
    wohler_exponents: dict  # {"blades": 10, "tower": 4, ...}

    @classmethod
    def from_config(cls, config: dict) -> "TypeCertificate":
        """Construct from the nested config dict."""
        tc = config["type_certificate"]
        return cls(
            iec_wind_class=tc.get("iec_wind_class", "IIA"),
            vref_ms=float(tc.get("vref_ms", 42.5)),
            vave_ms=float(tc.get("vave_ms", 8.5)),
            reference_ti=float(tc.get("reference_ti", 0.16)),
            design_shear_exponent=float(tc.get("design_shear_exponent", 0.20)),
            design_inflow_angle_deg=float(tc.get("design_inflow_angle_deg", 8.0)),
            design_air_density_kgm3=float(tc.get("design_air_density_kgm3", 1.225)),
            design_lifetime_years=float(config.get("design_lifetime_years", 20.0)),
            wohler_exponents=dict(config.get("wohler_exponents", {"blades": 10, "tower": 4})),
        )


@dataclass
class SiteConditions:
    """
    Holds all computed site characterisation metrics.

    Weibull parameters are stored as dicts keyed by sector label
    (e.g. '0-30', '30-60', ..., 'overall') so callers can use per-sector
    or overall statistics as appropriate.
    """

    weibull_k: dict        # {sector_label: k}
    weibull_A: dict        # {sector_label: A  [m/s]}
    mean_wind_speed_ms: float
    P90_ti: dict           # {speed_bin_label: P90_TI value}
    representative_shear: float
    mean_air_density: float  # kg/m^3
    inflow_angle_deg: float
    years_in_operation: float
    sector_frequencies: dict  # {sector_label: fraction 0-1}


@dataclass
class LifetimeResult:
    """Per-component lifetime assessment result."""

    component: str
    design_del_ratio: float        # combined damage ratio site/design
    annual_consumption_pct: float  # % of design lifetime consumed per year
    consumed_pct: float            # % consumed so far
    remaining_years: float
    remaining_pct: float
    status: str                    # "OK" | "WARNING" | "CRITICAL"
    notes: list


@dataclass
class AssessmentResult:
    """Top-level result container for the full site/farm assessment."""

    site_name: str
    turbine_model: str
    assessment_date: str
    years_in_operation: float
    design_lifetime_years: float
    components: list              # list[LifetimeResult]
    governing_component: str
    remaining_lifetime_years: float   # min across all components
    summary_status: str
    weibull_params: dict          # overall Weibull k and A
    site_vs_design: dict          # key metric comparison


# ---------------------------------------------------------------------------
# Core statistical / engineering functions
# ---------------------------------------------------------------------------

def fit_weibull(wind_speeds: np.ndarray) -> tuple:
    """
    Fit a 2-parameter Weibull distribution to wind speed data using MLE.

    Parameters
    ----------
    wind_speeds : np.ndarray
        1-D array of wind speed samples (m/s). Values <= 0 are dropped.

    Returns
    -------
    (k, A) : tuple[float, float]
        Weibull shape (k) and scale (A) parameters.
        Falls back to a moment-matching estimate if scipy MLE fails.
    """
    ws = np.asarray(wind_speeds, dtype=float)
    ws = ws[np.isfinite(ws) & (ws > 0.0)]

    if len(ws) < 10:
        warnings.warn(
            f"Only {len(ws)} valid wind speed samples — Weibull fit unreliable.",
            RuntimeWarning,
        )
        # Return trivial estimate to avoid crash
        mean_v = float(np.mean(ws)) if len(ws) > 0 else 6.0
        return 2.0, mean_v / gamma_func(1.5)

    try:
        # scipy.stats.weibull_min parameterisation: shape=c, scale=scale (loc fixed at 0)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            c, loc, scale = stats.weibull_min.fit(ws, floc=0)
        k = float(c)
        A = float(scale)
        # Sanity bounds
        k = max(0.5, min(k, 10.0))
        A = max(0.1, min(A, 50.0))
        return k, A
    except Exception:
        # Moment-matching fallback (Justus 1978 approximation)
        sigma = float(np.std(ws))
        mean_v = float(np.mean(ws))
        k_est = (sigma / mean_v) ** (-1.086) if mean_v > 0 else 2.0
        k_est = max(0.5, min(k_est, 10.0))
        A_est = mean_v / gamma_func(1.0 + 1.0 / k_est)
        A_est = max(0.1, A_est)
        return k_est, A_est


def weibull_mean(k: float, A: float) -> float:
    """
    Compute the mean of a Weibull distribution.

    E[V] = A * Gamma(1 + 1/k)

    Parameters
    ----------
    k : float
        Weibull shape parameter.
    A : float
        Weibull scale parameter (m/s).

    Returns
    -------
    float
        Mean wind speed (m/s).
    """
    return float(A * gamma_func(1.0 + 1.0 / k))


def compute_del_ratio(
    site_k: float,
    site_A: float,
    cert_vave: float,
    cert_k: float = 2.0,
    wohler_m: int = 10,
) -> float:
    """
    Compute the fatigue damage ratio between site conditions and the type
    certificate design basis.

    The fatigue integral is proportional to the m-th moment of the wind speed
    distribution:
        E[V^m] = A^m * Gamma(1 + m/k)

    For the design basis a Rayleigh distribution (k=2) is assumed with the
    scale parameter derived from the design annual mean wind speed vave:
        A_design = vave / Gamma(1.5) * sqrt(pi/2)

    Damage ratio = site_E_Vm / cert_E_Vm

    Parameters
    ----------
    site_k, site_A : float
        Weibull parameters fitted to site measurements.
    cert_vave : float
        Design annual mean wind speed from the type certificate (m/s).
    cert_k : float
        Design Weibull shape (default 2.0 = Rayleigh, per IEC 61400-1).
    wohler_m : int
        Wohler/S-N curve slope exponent for the component.

    Returns
    -------
    float
        Dimensionless damage ratio (>1 means site is more severe than design).
    """
    m = float(wohler_m)

    # Site m-th moment
    site_E_Vm = (site_A ** m) * gamma_func(1.0 + m / site_k)

    # Design scale parameter from Rayleigh (k=2): A = vave / Gamma(1.5)
    cert_A = cert_vave / gamma_func(1.0 + 1.0 / cert_k)
    cert_E_Vm = (cert_A ** m) * gamma_func(1.0 + m / cert_k)

    if cert_E_Vm <= 0.0:
        warnings.warn("cert_E_Vm is zero — cannot compute DEL ratio.", RuntimeWarning)
        return 1.0

    ratio = site_E_Vm / cert_E_Vm
    # Cap to physically reasonable range
    return float(np.clip(ratio, 0.01, 20.0))


def ti_correction_factor(
    site_P90_ti: float,
    cert_ref_ti: float,
    wohler_m: int = 10,
) -> float:
    """
    Simplified turbulence intensity damage correction factor.

    Turbulence increases fatigue loads approximately as (1 + 2*TI)^(m/2)
    following the simplified approach in DNVGL-ST-0262 Appendix A.

    Factor = site_factor / cert_factor
           = (1 + 2*TI_site)^(m/2) / (1 + 2*TI_cert)^(m/2)

    Parameters
    ----------
    site_P90_ti : float
        Site P90 representative turbulence intensity (dimensionless).
    cert_ref_ti : float
        Reference turbulence intensity from the type certificate.
    wohler_m : int
        Wohler slope exponent.

    Returns
    -------
    float
        Correction factor (>1 means site TI is more damaging than design).
    """
    m = float(wohler_m)
    site_factor = (1.0 + 2.0 * site_P90_ti) ** (m / 2.0)
    cert_factor = (1.0 + 2.0 * cert_ref_ti) ** (m / 2.0)
    if cert_factor <= 0.0:
        return 1.0
    return float(np.clip(site_factor / cert_factor, 0.1, 10.0))


def shear_correction_factor(
    site_shear: float,
    cert_shear: float,
    wohler_m: int = 10,
) -> float:
    """
    Wind shear damage correction factor.

    Higher shear increases the rotor-equivalent wind speed variance, leading
    to larger load cycles. Approximate factor per simplified GL methodology:
        factor = (1 + (site_shear/cert_shear - 1) * 0.3) ^ (m/2)

    The factor is capped between 0.5 and 2.5 to prevent extrapolation artefacts.

    Parameters
    ----------
    site_shear : float
        Site representative shear exponent alpha.
    cert_shear : float
        Design shear exponent from the type certificate.
    wohler_m : int
        Wohler slope exponent.

    Returns
    -------
    float
        Shear correction factor.
    """
    if cert_shear <= 0.0:
        return 1.0
    m = float(wohler_m)
    base = 1.0 + (site_shear / cert_shear - 1.0) * 0.3
    base = max(base, 0.01)  # avoid negative base before power
    factor = base ** (m / 2.0)
    return float(np.clip(factor, 0.5, 2.5))


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

_REQUIRED_COLUMNS = {"wind_speed_ms", "wind_direction_deg"}
_TIMESTAMP_COLUMN = "timestamp"
_TEMPLATE_FILENAME = "wind_data_template.csv"


def load_wind_data(data_dir: Path) -> pd.DataFrame:
    """
    Load all wind measurement CSV files from *data_dir*.

    Files matching ``*.csv`` are loaded and concatenated.  The template file
    (``wind_data_template.csv``) is skipped automatically.  Timestamps are
    parsed and the dataframe is sorted chronologically.

    Parameters
    ----------
    data_dir : Path
        Directory containing the wind measurement CSV files.

    Returns
    -------
    pd.DataFrame
        Combined dataframe with at minimum columns:
        ``wind_speed_ms``, ``wind_direction_deg``.
        Optional columns used when present:
        ``ti_10min``, ``shear_exponent``, ``temperature_c``, ``height_m``.

    Raises
    ------
    FileNotFoundError
        If *data_dir* does not exist.
    ValueError
        If no usable CSV files are found or required columns are missing.
    """
    data_dir = Path(data_dir)
    if not data_dir.exists():
        raise FileNotFoundError(f"Wind data directory not found: {data_dir}")

    csv_files = [
        p for p in data_dir.glob("*.csv")
        if p.name != _TEMPLATE_FILENAME
    ]

    if not csv_files:
        raise ValueError(
            f"No CSV wind data files found in {data_dir}. "
            "Place measurement files there (not the template)."
        )

    frames = []
    for csv_path in sorted(csv_files):
        try:
            df_part = pd.read_csv(csv_path)
            # Normalise column names
            df_part.columns = [c.strip().lower().replace(" ", "_") for c in df_part.columns]
            frames.append(df_part)
        except Exception as exc:
            warnings.warn(f"Could not read {csv_path}: {exc}", RuntimeWarning)

    if not frames:
        raise ValueError("All CSV files failed to load.")

    df = pd.concat(frames, ignore_index=True)

    # Check required columns
    missing = _REQUIRED_COLUMNS - set(df.columns)
    if missing:
        raise ValueError(
            f"Wind data is missing required columns: {missing}. "
            f"Available columns: {list(df.columns)}"
        )

    # Parse timestamps if present
    if _TIMESTAMP_COLUMN in df.columns:
        df[_TIMESTAMP_COLUMN] = pd.to_datetime(df[_TIMESTAMP_COLUMN], errors="coerce")
        df = df.sort_values(_TIMESTAMP_COLUMN).reset_index(drop=True)

    # Drop rows with NaN wind speed or direction
    df = df.dropna(subset=["wind_speed_ms", "wind_direction_deg"])
    df = df[df["wind_speed_ms"] >= 0.0].reset_index(drop=True)

    return df


# ---------------------------------------------------------------------------
# Site condition computation
# ---------------------------------------------------------------------------

_SECTOR_EDGES = list(range(0, 361, 30))          # 0, 30, 60, … 360
_SECTOR_LABELS = [f"{_SECTOR_EDGES[i]}-{_SECTOR_EDGES[i+1]}" for i in range(12)]
_SPEED_BIN_EDGES = list(range(0, 30, 2))         # 0-2, 2-4, … 24-26, …


def _sector_label(direction_deg: float) -> str:
    """Return the 30-degree sector label for a wind direction."""
    d = float(direction_deg) % 360.0
    idx = int(d // 30) % 12
    return _SECTOR_LABELS[idx]


def _air_density(temperature_c: float, elevation_m: float) -> float:
    """
    Compute dry air density from temperature and elevation using the
    ISA (International Standard Atmosphere) barometric formula.

    rho = P / (R_specific * T)
    P   = P0 * (1 - L*h/T0)^(g*M/(R*L))   [ISA troposphere]

    Parameters
    ----------
    temperature_c : float
        Mean air temperature (Celsius).
    elevation_m : float
        Site elevation above mean sea level (m).

    Returns
    -------
    float
        Air density (kg/m^3).
    """
    T_K = temperature_c + 273.15
    P0 = 101325.0      # Pa  — sea-level standard pressure
    L = 0.0065         # K/m — temperature lapse rate
    T0 = 288.15        # K   — sea-level standard temperature
    g = 9.80665        # m/s^2
    M = 0.0289644      # kg/mol — molar mass of dry air
    R = 8.31447        # J/(mol·K)
    exponent = g * M / (R * L)
    P = P0 * ((1.0 - L * elevation_m / T0) ** exponent)
    R_specific = 287.058  # J/(kg·K)
    rho = P / (R_specific * T_K)
    return float(rho)


def compute_site_conditions(df: pd.DataFrame, config: dict) -> SiteConditions:
    """
    Derive all site characterisation metrics from loaded wind data.

    Steps performed
    ---------------
    1. Weibull fit per 30-degree wind sector (12 sectors).
    2. Overall Weibull fit using all valid wind speeds.
    3. P90 turbulence intensity per 2 m/s wind speed bin.
    4. Representative shear exponent — median of the ``shear_exponent`` column
       if present; otherwise the design value from config is used.
    5. Mean air density from temperature column (or ISA elevation correction).
    6. Inflow angle from column if available.
    7. Sector frequency distribution.

    Parameters
    ----------
    df : pd.DataFrame
        Wind measurement data as returned by :func:`load_wind_data`.
    config : dict
        Full site configuration dictionary.

    Returns
    -------
    SiteConditions
    """
    tc_cfg = config.get("type_certificate", {})
    site_cfg = config.get("site_conditions", {})
    design_lifetime = float(config.get("design_lifetime_years", 20.0))
    commissioning_year = int(config.get("commissioning_year", 2018))
    assessment_year = int(config.get("assessment_year", 2025))
    years_in_operation = float(assessment_year - commissioning_year)

    ws = df["wind_speed_ms"].values.astype(float)
    wd = df["wind_direction_deg"].values.astype(float)

    # --- Per-sector Weibull ---------------------------------------------------
    weibull_k: dict = {}
    weibull_A: dict = {}
    sector_counts: dict = {}

    sector_labels_col = [_sector_label(d) for d in wd]
    df = df.copy()
    df["_sector"] = sector_labels_col

    for label in _SECTOR_LABELS:
        mask = df["_sector"] == label
        ws_sec = df.loc[mask, "wind_speed_ms"].values.astype(float)
        sector_counts[label] = int(mask.sum())
        if len(ws_sec) >= 10:
            k_s, A_s = fit_weibull(ws_sec)
        else:
            # Fall back to overall fit if sector is empty
            k_s, A_s = 2.0, float(np.mean(ws)) / gamma_func(1.5) if len(ws) > 0 else 2.0
        weibull_k[label] = k_s
        weibull_A[label] = A_s

    # --- Overall Weibull ------------------------------------------------------
    k_overall, A_overall = fit_weibull(ws)
    weibull_k["overall"] = k_overall
    weibull_A["overall"] = A_overall

    mean_ws = weibull_mean(k_overall, A_overall)

    # --- Sector frequencies ---------------------------------------------------
    total = max(len(df), 1)
    sector_frequencies = {lbl: sector_counts.get(lbl, 0) / total for lbl in _SECTOR_LABELS}

    # --- P90 TI per wind speed bin --------------------------------------------
    P90_ti: dict = {}
    ti_col = "ti_10min" if "ti_10min" in df.columns else None

    for i in range(len(_SPEED_BIN_EDGES) - 1):
        v_lo = _SPEED_BIN_EDGES[i]
        v_hi = _SPEED_BIN_EDGES[i + 1]
        label = f"{v_lo}-{v_hi}"
        mask = (df["wind_speed_ms"] >= v_lo) & (df["wind_speed_ms"] < v_hi)
        if ti_col is not None and mask.sum() >= 3:
            ti_vals = df.loc[mask, ti_col].dropna().values.astype(float)
            if len(ti_vals) >= 3:
                P90_ti[label] = float(np.percentile(ti_vals, 90))
            else:
                P90_ti[label] = float(tc_cfg.get("reference_ti", 0.16))
        else:
            P90_ti[label] = float(tc_cfg.get("reference_ti", 0.16))

    # If no TI data, add a representative overall entry
    if ti_col is not None and len(df) > 0:
        overall_ti_p90 = float(np.percentile(df[ti_col].dropna().values.astype(float), 90))
    else:
        overall_ti_p90 = float(tc_cfg.get("reference_ti", 0.16))
    P90_ti["overall"] = overall_ti_p90

    # --- Representative shear -------------------------------------------------
    if "shear_exponent" in df.columns:
        shear_vals = df["shear_exponent"].dropna().values.astype(float)
        shear_vals = shear_vals[shear_vals > 0.0]
        representative_shear = float(np.median(shear_vals)) if len(shear_vals) > 0 else float(tc_cfg.get("design_shear_exponent", 0.20))
    else:
        representative_shear = float(tc_cfg.get("design_shear_exponent", 0.20))

    # --- Air density ----------------------------------------------------------
    elevation_m = float(site_cfg.get("site_elevation_m", 0.0))
    if "temperature_c" in df.columns:
        temp_vals = df["temperature_c"].dropna().values.astype(float)
        mean_temp = float(np.mean(temp_vals)) if len(temp_vals) > 0 else 15.0
    else:
        # ISA standard temperature at elevation
        mean_temp = 15.0 - 0.0065 * elevation_m
    mean_air_density = _air_density(mean_temp, elevation_m)

    # --- Inflow angle ---------------------------------------------------------
    if "inflow_angle_deg" in df.columns:
        ia_vals = df["inflow_angle_deg"].dropna().values.astype(float)
        inflow_angle = float(np.median(ia_vals)) if len(ia_vals) > 0 else float(tc_cfg.get("design_inflow_angle_deg", 8.0))
    else:
        inflow_angle = float(tc_cfg.get("design_inflow_angle_deg", 8.0))

    return SiteConditions(
        weibull_k=weibull_k,
        weibull_A=weibull_A,
        mean_wind_speed_ms=mean_ws,
        P90_ti=P90_ti,
        representative_shear=representative_shear,
        mean_air_density=mean_air_density,
        inflow_angle_deg=inflow_angle,
        years_in_operation=years_in_operation,
        sector_frequencies=sector_frequencies,
    )


# ---------------------------------------------------------------------------
# Component assessment
# ---------------------------------------------------------------------------

# Components for which shear correction is physically relevant
_SHEAR_SENSITIVE_COMPONENTS = {"blades", "tower"}


def assess_component(
    component: str,
    site: SiteConditions,
    cert: TypeCertificate,
    years_operated: float,
) -> LifetimeResult:
    """
    Compute the lifetime assessment for a single structural component.

    Damage model
    ------------
    combined_damage_ratio = DEL_ratio * TI_factor * shear_factor

    where DEL_ratio accounts for wind speed distribution differences,
    TI_factor accounts for turbulence intensity differences, and
    shear_factor accounts for shear profile differences (blades & tower).

    annual_consumption_pct = combined_damage_ratio * (100 / design_lifetime)

    Parameters
    ----------
    component : str
        Component name, matching a key in cert.wohler_exponents.
    site : SiteConditions
        Computed site characterisation.
    cert : TypeCertificate
        Type certificate design basis.
    years_operated : float
        Number of years the turbine has been in operation.

    Returns
    -------
    LifetimeResult
    """
    notes = []
    m = cert.wohler_exponents.get(component, 4)  # fallback m=4

    # --- DEL ratio from wind speed distribution --------------------------------
    k_site = site.weibull_k["overall"]
    A_site = site.weibull_A["overall"]

    del_ratio = compute_del_ratio(
        site_k=k_site,
        site_A=A_site,
        cert_vave=cert.vave_ms,
        cert_k=2.0,
        wohler_m=m,
    )
    notes.append(
        f"Wind speed DEL ratio (m={m}): {del_ratio:.4f} "
        f"[site Weibull k={k_site:.2f}, A={A_site:.2f} m/s vs. design Vave={cert.vave_ms} m/s]"
    )

    # --- TI correction --------------------------------------------------------
    site_p90_ti = site.P90_ti.get("overall", cert.reference_ti)
    ti_factor = ti_correction_factor(
        site_P90_ti=site_p90_ti,
        cert_ref_ti=cert.reference_ti,
        wohler_m=m,
    )
    notes.append(
        f"TI correction factor: {ti_factor:.4f} "
        f"[site P90 TI={site_p90_ti:.4f} vs. cert ref TI={cert.reference_ti:.4f}]"
    )

    # --- Shear correction (blades and tower only) ----------------------------
    if component.lower() in _SHEAR_SENSITIVE_COMPONENTS:
        shear_factor = shear_correction_factor(
            site_shear=site.representative_shear,
            cert_shear=cert.design_shear_exponent,
            wohler_m=m,
        )
        notes.append(
            f"Shear correction factor: {shear_factor:.4f} "
            f"[site alpha={site.representative_shear:.3f} "
            f"vs. cert alpha={cert.design_shear_exponent:.3f}]"
        )
    else:
        shear_factor = 1.0
        notes.append("Shear correction not applied (not shear-sensitive component).")

    # --- Air density correction -----------------------------------------------
    # Aerodynamic loads scale with air density — apply a linear correction
    # since load ~ rho and fatigue damage ~ load^m.
    rho_ratio = site.mean_air_density / cert.design_air_density_kgm3
    density_factor = rho_ratio ** (m / 2.0)
    notes.append(
        f"Air density correction factor: {density_factor:.4f} "
        f"[site rho={site.mean_air_density:.4f} kg/m^3 "
        f"vs. cert rho={cert.design_air_density_kgm3:.4f} kg/m^3]"
    )

    # --- Combined damage ratio ------------------------------------------------
    combined_damage_ratio = del_ratio * ti_factor * shear_factor * density_factor
    notes.append(f"Combined damage ratio: {combined_damage_ratio:.4f}")

    # --- Annual consumption ---------------------------------------------------
    # Design basis: 100% lifetime in design_lifetime_years under design conditions.
    # Site annual consumption proportional to combined damage ratio.
    annual_consumption_pct = combined_damage_ratio * (100.0 / cert.design_lifetime_years)

    consumed_pct = annual_consumption_pct * years_operated
    remaining_pct = max(0.0, 100.0 - consumed_pct)

    if annual_consumption_pct > 0.0:
        remaining_years = remaining_pct / annual_consumption_pct
    else:
        remaining_years = float(cert.design_lifetime_years)
        notes.append("WARNING: annual consumption is zero — check inputs.")

    # --- Status -----------------------------------------------------------
    if remaining_years < 2.0:
        status = "CRITICAL"
        notes.append("CRITICAL: Remaining lifetime < 2 years. Immediate action required.")
    elif remaining_years < 5.0:
        status = "WARNING"
        notes.append("WARNING: Remaining lifetime < 5 years. Plan for inspection/extension.")
    else:
        status = "OK"

    return LifetimeResult(
        component=component,
        design_del_ratio=combined_damage_ratio,
        annual_consumption_pct=annual_consumption_pct,
        consumed_pct=consumed_pct,
        remaining_years=remaining_years,
        remaining_pct=remaining_pct,
        status=status,
        notes=notes,
    )


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run_assessment(
    config_path: Path,
    data_dir: Optional[Path] = None,
) -> AssessmentResult:
    """
    Run the full lifetime assessment pipeline.

    Steps
    -----
    1. Load and validate the site configuration JSON.
    2. Locate and load wind measurement CSV files.
    3. Build :class:`TypeCertificate` from config.
    4. Compute :class:`SiteConditions` from wind data.
    5. Assess each component listed in ``wohler_exponents``.
    6. Identify the governing component (minimum remaining lifetime).
    7. Build and return the :class:`AssessmentResult`.

    Parameters
    ----------
    config_path : Path
        Path to the ``site_config.json`` file.
    data_dir : Path, optional
        Directory containing wind measurement CSVs.  If *None*, defaults to
        ``config_path.parent / "site_wind_data"``.

    Returns
    -------
    AssessmentResult
    """
    config_path = Path(config_path)
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    with open(config_path, "r", encoding="utf-8") as fh:
        config = json.load(fh)

    # Strip comment key (not a real config field)
    config.pop("_comment", None)

    # Resolve wind data directory
    if data_dir is None:
        data_dir = config_path.parent / "site_wind_data"

    # --- Load wind data -------------------------------------------------------
    df = load_wind_data(data_dir)

    # --- Type certificate -----------------------------------------------------
    cert = TypeCertificate.from_config(config)

    # --- Site conditions ------------------------------------------------------
    site = compute_site_conditions(df, config)

    # --- Assess each component ------------------------------------------------
    component_results = []
    for comp_name in cert.wohler_exponents:
        result = assess_component(
            component=comp_name,
            site=site,
            cert=cert,
            years_operated=site.years_in_operation,
        )
        component_results.append(result)

    # --- Governing component --------------------------------------------------
    if not component_results:
        raise ValueError("No components to assess — check wohler_exponents in config.")

    governing = min(component_results, key=lambda r: r.remaining_years)

    # --- Summary status -------------------------------------------------------
    statuses = [r.status for r in component_results]
    if "CRITICAL" in statuses:
        summary_status = "CRITICAL"
    elif "WARNING" in statuses:
        summary_status = "WARNING"
    else:
        summary_status = "OK"

    # --- Site vs design comparison --------------------------------------------
    site_vs_design = {
        "mean_wind_speed_ms": {
            "site": round(site.mean_wind_speed_ms, 3),
            "design": round(cert.vave_ms, 3),
            "ratio": round(site.mean_wind_speed_ms / cert.vave_ms, 4) if cert.vave_ms > 0 else None,
        },
        "P90_turbulence_intensity": {
            "site": round(site.P90_ti.get("overall", float("nan")), 4),
            "design": round(cert.reference_ti, 4),
        },
        "shear_exponent": {
            "site": round(site.representative_shear, 4),
            "design": round(cert.design_shear_exponent, 4),
        },
        "air_density_kgm3": {
            "site": round(site.mean_air_density, 4),
            "design": round(cert.design_air_density_kgm3, 4),
        },
        "inflow_angle_deg": {
            "site": round(site.inflow_angle_deg, 2),
            "design": round(cert.design_inflow_angle_deg, 2),
        },
        "weibull_k_overall": round(site.weibull_k["overall"], 3),
        "weibull_A_overall_ms": round(site.weibull_A["overall"], 3),
        "n_wind_records": len(df),
    }

    import datetime
    assessment_date = datetime.date.today().isoformat()

    return AssessmentResult(
        site_name=config.get("site_name", "Unknown"),
        turbine_model=config.get("turbine_model", "Unknown"),
        assessment_date=assessment_date,
        years_in_operation=site.years_in_operation,
        design_lifetime_years=cert.design_lifetime_years,
        components=component_results,
        governing_component=governing.component,
        remaining_lifetime_years=round(governing.remaining_years, 2),
        summary_status=summary_status,
        weibull_params={
            "k": site.weibull_k["overall"],
            "A_ms": site.weibull_A["overall"],
        },
        site_vs_design=site_vs_design,
    )


# ---------------------------------------------------------------------------
# Reporting helpers
# ---------------------------------------------------------------------------

def print_report(result: AssessmentResult) -> None:
    """
    Print a formatted plain-text assessment summary to stdout.

    Parameters
    ----------
    result : AssessmentResult
        The result object returned by :func:`run_assessment`.
    """
    sep = "=" * 72
    thin = "-" * 72

    print(sep)
    print("  WIND FARM LIFETIME ASSESSMENT REPORT")
    print(sep)
    print(f"  Site       : {result.site_name}")
    print(f"  Turbine    : {result.turbine_model}")
    print(f"  Date       : {result.assessment_date}")
    print(f"  Operated   : {result.years_in_operation:.1f} years  "
          f"(design lifetime: {result.design_lifetime_years:.0f} years)")
    print(f"  Status     : {result.summary_status}")
    print(sep)

    print("\n  SITE vs DESIGN SUMMARY")
    print(thin)
    svd = result.site_vs_design
    mws = svd["mean_wind_speed_ms"]
    print(f"  Mean wind speed (m/s)   : site={mws['site']:.2f}  "
          f"design={mws['design']:.2f}  ratio={mws['ratio']:.3f}")
    ti = svd["P90_turbulence_intensity"]
    print(f"  P90 TI (–)              : site={ti['site']:.4f}  design={ti['design']:.4f}")
    sh = svd["shear_exponent"]
    print(f"  Shear exponent (–)      : site={sh['site']:.4f}  design={sh['design']:.4f}")
    rd = svd["air_density_kgm3"]
    print(f"  Air density (kg/m^3)    : site={rd['site']:.4f}  design={rd['design']:.4f}")
    ia = svd["inflow_angle_deg"]
    print(f"  Inflow angle (deg)      : site={ia['site']:.2f}   design={ia['design']:.2f}")
    print(f"  Weibull fit             : k={svd['weibull_k_overall']:.3f}  "
          f"A={svd['weibull_A_overall_ms']:.3f} m/s")
    print(f"  Wind records analysed   : {svd['n_wind_records']}")

    print("\n  COMPONENT RESULTS")
    print(thin)
    header = (
        f"  {'Component':<16} {'Dmg Ratio':>10} {'Ann.Cons%':>10} "
        f"{'Consumed%':>10} {'Rem.Yrs':>9} {'Rem.%':>8}  Status"
    )
    print(header)
    print(thin)
    for comp in result.components:
        flag = ""
        if comp.status == "CRITICAL":
            flag = " *** CRITICAL ***"
        elif comp.status == "WARNING":
            flag = " ** WARNING **"
        print(
            f"  {comp.component:<16} {comp.design_del_ratio:>10.4f} "
            f"{comp.annual_consumption_pct:>10.3f} "
            f"{comp.consumed_pct:>10.2f} "
            f"{comp.remaining_years:>9.2f} "
            f"{comp.remaining_pct:>8.2f}"
            f"  {comp.status}{flag}"
        )

    print(thin)
    print(f"\n  GOVERNING COMPONENT : {result.governing_component.upper()}")
    print(f"  REMAINING LIFETIME  : {result.remaining_lifetime_years:.2f} years")

    print("\n  COMPONENT DIAGNOSTIC NOTES")
    print(thin)
    for comp in result.components:
        print(f"\n  [{comp.component.upper()}]")
        for note in comp.notes:
            print(f"    - {note}")

    print()
    print(sep)


def export_to_csv(result: AssessmentResult, output_path: Path) -> None:
    """
    Export component lifetime results to a CSV file.

    Parameters
    ----------
    result : AssessmentResult
        Result object returned by :func:`run_assessment`.
    output_path : Path
        Destination CSV file path.
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    rows = []
    for comp in result.components:
        rows.append({
            "site_name": result.site_name,
            "turbine_model": result.turbine_model,
            "assessment_date": result.assessment_date,
            "years_in_operation": result.years_in_operation,
            "design_lifetime_years": result.design_lifetime_years,
            "component": comp.component,
            "combined_damage_ratio": round(comp.design_del_ratio, 6),
            "annual_consumption_pct": round(comp.annual_consumption_pct, 4),
            "consumed_pct": round(comp.consumed_pct, 3),
            "remaining_pct": round(comp.remaining_pct, 3),
            "remaining_years": round(comp.remaining_years, 3),
            "status": comp.status,
            "notes": " | ".join(comp.notes),
        })

    df_out = pd.DataFrame(rows)
    df_out.to_csv(output_path, index=False)
    print(f"Component results exported to: {output_path}")


def export_to_json(result: AssessmentResult, output_path: Path) -> None:
    """
    Serialise the full AssessmentResult to a JSON file.

    Parameters
    ----------
    result : AssessmentResult
        Result object.
    output_path : Path
        Destination JSON file path.
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    def _make_serialisable(obj):
        """Recursively convert dataclass instances and numpy types to dicts/lists."""
        if hasattr(obj, "__dataclass_fields__"):
            return {k: _make_serialisable(v) for k, v in obj.__dict__.items()}
        elif isinstance(obj, list):
            return [_make_serialisable(i) for i in obj]
        elif isinstance(obj, dict):
            return {k: _make_serialisable(v) for k, v in obj.items()}
        elif isinstance(obj, (np.integer,)):
            return int(obj)
        elif isinstance(obj, (np.floating,)):
            return float(obj)
        elif isinstance(obj, (np.ndarray,)):
            return obj.tolist()
        else:
            return obj

    data = _make_serialisable(result)
    with open(output_path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
    print(f"Full JSON report exported to: {output_path}")
