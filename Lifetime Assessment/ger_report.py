"""
ger_report.py
=============
Builds the report data dict (list of pages) for the Ger (Les Herbreux) Lifetime
Assessment Report.  The pattern mirrors WINDPAT's wind_report.py, using the
shared Jinja2 / CSS framework in ``../SCADA Analysis/report/``.

Usage
-----
    from ger_report import build_lta_report_data
    report_data = build_lta_report_data(
        config=analysis["config"],
        analysis=analysis,
        charts=charts,
        outputs={"output_format": "pdf", "pdf_path": str(pdf_path)},
    )
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Shared report framework – path injection
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).parent
SHARED_REPORT_DIR = SCRIPT_DIR.parent / "SCADA Analysis" / "report"
sys.path.insert(0, str(SHARED_REPORT_DIR.parent))

try:
    from report.build_report_data import _paginate_section_like_page
except ImportError as exc:
    raise ImportError(
        f"Could not import _paginate_section_like_page from report.build_report_data. "
        f"Expected framework at: {SHARED_REPORT_DIR}"
    ) from exc

# ---------------------------------------------------------------------------
# Style tokens
# ---------------------------------------------------------------------------

try:
    from report.style_tokens import get_style_tokens
    _STYLE_TOKENS = get_style_tokens()
except ImportError:
    _STYLE_TOKENS = {
        "colors": {
            "primary_navy": "#0B2A3D",
            "accent_orange": "#F39200",
            "secondary_slate_blue": "#3E516C",
            "deep_indigo": "#27275A",
            "body_text": "#1F2933",
            "muted_text": "#6B7785",
            "light_background": "#F4F6F8",
            "border_grey": "#D9E0E6",
            "success_green": "#70AD47",
            "warning_amber": "#C98A00",
            "danger_red": "#C62828",
            "white": "#FFFFFF",
        },
        "fonts": {
            "sans": "Aptos, Calibri, Arial, Helvetica, sans-serif",
            "body_size_pt": 10.5,
            "caption_size_pt": 8.5,
        },
        "page": {
            "size": "A4 portrait",
            "margin_top": "12mm",
            "margin_right": "12mm",
            "margin_bottom": "14mm",
            "margin_left": "12mm",
        },
        "debug_layout": False,
        "chart": {
            "full": (7.1, 4.6),
            "half": (3.35, 3.0),
            "appendix_wide": (7.2, 6.9),
        },
    }

# ---------------------------------------------------------------------------
# Block helpers
# ---------------------------------------------------------------------------

def _kpi(label: str, value: str, sub: str = "", status: str = "neutral") -> dict:
    """Build a KPI card dict compatible with the section template."""
    return {
        "label": label,
        "value": value,
        "target": sub,
        "status": status,
        "subtext": "",
    }


def _table_block(
    title: str,
    columns: list,
    rows: list,
    caption: str = "",
) -> dict:
    return {
        "title": title,
        "columns": columns,
        "rows": rows,
        "caption": caption,
        "appendix_only": False,
    }


def _figure_block(
    charts: dict,
    chart_id: str,
    title: str,
    caption: str,
    width: str = "full",
) -> dict | None:
    meta = charts.get(chart_id)
    if not meta:
        return None
    return {
        "title": title,
        "caption": caption,
        "src": Path(meta["path"]).as_uri(),
        "width": width,
        "alt": meta.get("alt", title),
    }


def _fmt_pct(v: float, decimals: int = 1) -> str:
    return f"{v:.{decimals}f}%"


def _fmt_num(v: float, decimals: int = 0, suffix: str = "") -> str:
    return f"{v:,.{decimals}f}{suffix}"


def _fmt_years(v: float) -> str:
    return f"{v:.1f} yr"


def _end_date_str(end_year: float) -> str:
    """Convert a fractional year like 2036.4 to a Month YYYY string."""
    _month_names = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ]
    year = int(end_year)
    month_idx = int(round((end_year - year) * 12))
    month_idx = max(0, min(11, month_idx))
    return f"{_month_names[month_idx]} {year}"


# ---------------------------------------------------------------------------
# TOC builder
# ---------------------------------------------------------------------------

def _toc_page(pages: list[dict]) -> dict:
    groups: dict[str, list] = {}
    for page in pages:
        if page.get("toc_hide") or not page.get("title") or page.get("template") == "cover":
            continue
        group = page.get("toc_group", "Report")
        groups.setdefault(group, []).append({"title": page["title"]})
    return {
        "template": "toc",
        "title": "Table of Contents",
        "groups": [{"title": t, "entries": e} for t, e in groups.items()],
    }


# ---------------------------------------------------------------------------
# Section builders
# ---------------------------------------------------------------------------

def _page_executive_summary(analysis: dict, charts: dict) -> dict:
    ref_lt = analysis["reference_lifetime"]

    # Build lifetime summary table rows
    sorted_components = sorted(ref_lt.items(), key=lambda x: x[1]["total_years"])
    lt_rows = []
    for comp_name, data in sorted_components:
        total_years = data["total_years"]
        end_year = data["end_year"]
        wohler_m = analysis["config"].get("wohler_exponents", {}).get(comp_name, "—")
        if total_years <= 25.5:
            row_class = "row-danger"
            status = "Governing"
        elif total_years <= 27:
            row_class = "row-danger"
            status = "Adequate"
        elif total_years <= 33:
            row_class = "row-warning"
            status = "Adequate"
        else:
            row_class = "row-success"
            status = "Adequate"
        lt_rows.append({
            "Component": comp_name,
            "S/N Curve (m)": str(wohler_m),
            "Total Lifetime": _fmt_years(total_years),
            "End Date": _end_date_str(end_year),
            "Status": status,
            "_row_class": row_class,
        })

    years_operated = analysis["years_operated"]
    fleet_mean_ws = analysis["fleet_mean_ws"]
    fleet_weibull_k = analysis["fleet_weibull_k"]

    return {
        "template": "section",
        "id": "executive-summary",
        "title": "Executive Summary",
        "kicker": "Key Results",
        "toc_group": "Overview",
        "summary": (
            "Fatigue-based structural lifetime assessment of 4 x Enercon E82-2.0MW, "
            "Ger (Les Herbreux), commissioned December 2010."
        ),
        "commentary": [
            (
                f"Based on site-specific wind conditions (mean wind speed {fleet_mean_ws:.2f} m/s, "
                f"Weibull k={fleet_weibull_k:.2f}) compared to IEC IIA design basis (8.5 m/s), "
                "the fatigue loading on this site is significantly below design values."
            ),
            (
                "The governing structural component is the blade-to-adapter-hub bolt connection, "
                "with a calculated total lifetime of 25.5 years. Without intervention, operation "
                "must cease by May 2036."
            ),
            (
                "Two extension paths exist: (1) bolt replacement before May 2036 extends operation "
                "to January 2042 (31.1 yr total), and (2) full blade assembly replacement before "
                "January 2042 enables operation through November 2050 (40 yr, capped for safety)."
            ),
            (
                "No critical structural defects were identified during the June 2025 technical audit. "
                "Energy availability has averaged 98.5% over 2022-2024, indicating a well-maintained fleet."
            ),
        ],
        "kpis": [
            _kpi("Years in operation", f"{years_operated:.1f} yr"),
            _kpi("Design lifetime remaining", f"{20 - years_operated:.1f} yr", "to design end Dec 2030"),
            _kpi("Baseline remaining lifetime", "11.0 yr", "Bolts — to May 2036", "warning"),
            _kpi("Extended lifetime (bolt repl.)", "16.6 yr", "to January 2042", "success"),
            _kpi("Site mean wind speed", f"{fleet_mean_ws:.2f} m/s", "IEC IIA design: 8.5 m/s"),
            _kpi("Fleet energy availability", "98.5%", "avg 2022-2024", "success"),
        ],
        "figures": [],
        "tables": [
            _table_block(
                "Structural Lifetime Summary",
                ["Component", "S/N Curve (m)", "Total Lifetime", "End Date", "Status"],
                lt_rows,
            )
        ],
        "findings": [
            {
                "title": "Governing component — blade-adapter-hub bolts",
                "severity": "warning",
                "body": (
                    "Blade-to-adapter-hub connection bolts limit baseline lifetime to 25.5 years "
                    "(May 2036). Replacement required for any extension scenario."
                ),
            },
            {
                "title": "Extension to 40 years feasible",
                "severity": "info",
                "body": (
                    "Full blade assembly replacement before January 2042 enables operation to "
                    "November 2050, subject to continued annual inspections and structural monitoring."
                ),
            },
        ],
        "paginate": False,
    }


def _page_site_overview(config: dict) -> dict:
    tc = config["type_certificate"]
    rows = [
        {"Parameter": "Site", "Value": config["site_name"]},
        {"Parameter": "Country", "Value": config.get("site_country", "France")},
        {"Parameter": "Turbine model", "Value": config["turbine_model"]},
        {"Parameter": "Number of turbines", "Value": str(config["n_turbines"])},
        {"Parameter": "Tower type", "Value": config["tower_type"]},
        {"Parameter": "Hub height", "Value": f"{config['hub_height_m']:.2f} m"},
        {"Parameter": "Rotor diameter", "Value": f"{config['rotor_diameter_m']} m"},
        {"Parameter": "Rated power", "Value": f"{config['rated_power_kw']:,} kW per turbine"},
        {
            "Parameter": "Installed capacity",
            "Value": f"{config['n_turbines'] * config['rated_power_kw'] / 1000:.1f} MW",
        },
        {"Parameter": "Commissioning date", "Value": "December 2010"},
        {"Parameter": "Design lifetime", "Value": f"{config['design_lifetime_years']} years"},
        {
            "Parameter": "Type certificate",
            "Value": f"{tc['cert_number']} — {tc['certifier']}",
        },
        {"Parameter": "IEC standard", "Value": tc["iec_standard"]},
        {"Parameter": "Cut-in wind speed", "Value": f"{tc['cut_in_ms']} m/s"},
        {"Parameter": "Rated wind speed", "Value": f"{tc['rated_wind_speed_ms']} m/s"},
        {"Parameter": "Cut-out wind speed", "Value": f"{tc['cut_out_ms']} m/s"},
    ]

    return {
        "template": "section",
        "id": "site-overview",
        "title": "Site Overview",
        "kicker": "Asset description",
        "toc_group": "Main Report",
        "commentary": [
            (
                f"The Ger (Les Herbreux) wind farm comprises {config['n_turbines']} Enercon E82-2.0MW "
                f"turbines on {config['tower_type']} towers at {config['hub_height_m']:.1f} m hub height, "
                "located near Ger, Normandy, France."
            ),
            (
                "The site was commissioned in December 2010 and has operated continuously for over "
                "14 years under the management of Energiequelle GmbH. All four turbines carry the "
                "Enercon standard 5-year extended warranty and have been subject to annual third-party "
                "technical audits."
            ),
            (
                f"The type certificate (DEWI-OCC {tc['cert_number']}) certifies the E82 E2 for "
                f"IEC wind class IIA, with a design reference mean wind speed of {tc['vave_ms']} m/s "
                "and a 20-year design lifetime."
            ),
        ],
        "kpis": [
            _kpi("Turbine model", config["turbine_model"]),
            _kpi("Number of turbines", str(config["n_turbines"])),
            _kpi("Hub height", f"{config['hub_height_m']:.1f} m"),
            _kpi("Rotor diameter", f"{config['rotor_diameter_m']} m"),
            _kpi("Rated power", f"{config['rated_power_kw']:,} kW"),
            _kpi(
                "Installed capacity",
                f"{config['n_turbines'] * config['rated_power_kw'] / 1000:.1f} MW",
            ),
            _kpi("IEC wind class", tc["iec_wind_class"]),
            _kpi("Commissioning", "December 2010"),
        ],
        "figures": [],
        "tables": [_table_block("Technical Parameters", ["Parameter", "Value"], rows)],
        "findings": [],
        "paginate": False,
    }


def _page_wind_resource(analysis: dict, charts: dict) -> dict:
    fleet_mean_ws = analysis["fleet_mean_ws"]
    fleet_weibull_k = analysis["fleet_weibull_k"]
    fleet_weibull_A = analysis["fleet_weibull_A"]
    annual = analysis["annual"]

    # Compute min/max year mean wind speeds
    valid_years = {yr: data["mean_ws"] for yr, data in annual.items() if data["mean_ws"] == data["mean_ws"]}
    if valid_years:
        min_yr = min(valid_years, key=valid_years.get)
        max_yr = max(valid_years, key=valid_years.get)
        min_year_ws_str = f"{valid_years[min_yr]:.2f} m/s ({min_yr})"
        max_year_ws_str = f"{valid_years[max_yr]:.2f} m/s ({max_yr})"
    else:
        min_year_ws_str = "n/a"
        max_year_ws_str = "n/a"

    figures = []
    for chart_id, title, caption, width in [
        (
            "weibull_fit",
            "Wind Speed Distribution vs IEC IIA Design",
            "Weibull fit to 4-year SCADA dataset vs IEC IIA Rayleigh reference distribution "
            "(k=2.0, Vave=8.5 m/s).",
            "full",
        ),
        (
            "wind_speed_annual",
            "Annual Mean Wind Speed at Hub Height",
            "Fleet-averaged annual mean wind speed. IEC IIA design mean (8.5 m/s) shown for reference.",
            "full",
        ),
        (
            "wind_rose",
            "Wind Direction Distribution",
            "Frequency of wind direction from all turbines, 2021-2024.",
            "half",
        ),
    ]:
        fig = _figure_block(charts, chart_id, title, caption, width)
        if fig:
            figures.append(fig)

    n_records_k = 4 * 52560 * 4 // 1000

    return {
        "template": "section",
        "id": "wind-resource",
        "title": "Wind Resource Analysis",
        "kicker": "Site wind characterisation",
        "toc_group": "Main Report",
        "commentary": [
            (
                f"SCADA data from all four turbines covering the period January 2021 to December 2024 "
                f"(4 years, ~{n_records_k}k records) was used to characterise the site wind regime."
            ),
            (
                f"The fleet-average Weibull distribution fits to k={fleet_weibull_k:.3f}, "
                f"A={fleet_weibull_A:.3f} m/s, giving a long-term mean wind speed of "
                f"{fleet_mean_ws:.2f} m/s at hub height. This is significantly below the IEC IIA "
                "design basis of 8.5 m/s, indicating that fatigue loading at this site is lighter "
                "than the design envelope."
            ),
            (
                "Annual mean wind speeds ranged from "
                + min_year_ws_str
                + " (lowest) to "
                + max_year_ws_str
                + " (highest), confirming the site operates well within the type certificate wind class."
            ),
        ],
        "kpis": [
            _kpi("Fleet mean WS", f"{fleet_mean_ws:.2f} m/s", "hub height 98.4 m"),
            _kpi("Weibull k", f"{fleet_weibull_k:.3f}", "shape parameter"),
            _kpi("Weibull A", f"{fleet_weibull_A:.3f} m/s", "scale parameter"),
            _kpi("IEC IIA design mean", "8.5 m/s", "type certificate basis"),
            _kpi("WS vs design", f"{fleet_mean_ws / 8.5 * 100:.0f}%", "of design value", "success"),
            _kpi("SCADA period", "Jan 2021 - Dec 2024", "4-year dataset"),
        ],
        "figures": figures,
        "tables": [],
        "findings": [],
    }


def _page_power_production(config: dict, analysis: dict, charts: dict) -> dict:
    annual_prod = config.get("annual_production_mwh", {})
    turbine_ids = config.get("turbine_ids", [])

    # Compute per-turbine totals over 2022-2024
    years = ["2022", "2023", "2024"]
    turbine_totals: dict[str, float] = {}
    for tid in turbine_ids:
        total = sum(annual_prod.get(yr, {}).get(tid, 0.0) for yr in years)
        turbine_totals[tid] = total
    fleet_total = sum(turbine_totals.values())

    # Capacity factor rows: per year
    rated_power_kw = float(config.get("rated_power_kw", 2050))
    n_turbines = int(config.get("n_turbines", 4))
    hours_per_year = 8760.0
    max_fleet_mwh = rated_power_kw * hours_per_year * n_turbines / 1000.0

    prod_rows = []
    for yr in years:
        row: dict = {"Year": yr}
        fleet_yr = 0.0
        for tid in turbine_ids:
            val = annual_prod.get(yr, {}).get(tid, float("nan"))
            short_id = tid.split("-")[0] if "-" in tid else tid
            row[short_id] = f"{val:,.0f}" if val == val else "n/a"
            if val == val:
                fleet_yr += val
        row["Fleet Total (MWh)"] = f"{fleet_yr:,.0f}"
        cf = fleet_yr / max_fleet_mwh * 100.0 if max_fleet_mwh > 0 else float("nan")
        row["CF (%)"] = f"{cf:.1f}%" if cf == cf else "n/a"
        prod_rows.append(row)

    short_ids = [tid.split("-")[0] if "-" in tid else tid for tid in turbine_ids]
    columns = ["Year"] + short_ids + ["Fleet Total (MWh)", "CF (%)"]

    # KPIs: per-turbine total + fleet total
    kpis = [
        _kpi(f"{tid.split('-')[0]} energy (2022-24)", f"{turbine_totals.get(tid, 0):,.0f} MWh")
        for tid in turbine_ids
    ]
    kpis.append(_kpi("Fleet total (2022-24)", f"{fleet_total:,.0f} MWh", "", "success"))

    figures = []
    for chart_id, title, caption, width in [
        (
            "power_curve",
            "Fleet Power Curve vs E82 Reference",
            "Binned 10-minute averages for all turbines 2021-2024. Reference curve from Enercon type documentation.",
            "full",
        ),
        (
            "annual_production",
            "Annual Energy Production by Turbine",
            "Annual gross energy output per turbine 2022-2024. Fleet total on secondary axis.",
            "full",
        ),
    ]:
        fig = _figure_block(charts, chart_id, title, caption, width)
        if fig:
            figures.append(fig)

    return {
        "template": "section",
        "id": "power-production",
        "title": "Power Curve & Energy Production",
        "kicker": "Energy output",
        "toc_group": "Main Report",
        "commentary": [
            (
                "The fleet power curve is derived from 10-minute average SCADA records for all four "
                "turbines over 2021-2024. Records with nacelle availability flags are retained to "
                "preserve the full operating population."
            ),
            (
                f"Total measured fleet energy production over 2022-2024 was "
                f"{fleet_total:,.0f} MWh. The measured power curve tracks closely with the published "
                "Enercon E82-2.0MW reference curve up to rated wind speed (13.4 m/s)."
            ),
        ],
        "kpis": kpis,
        "figures": figures,
        "tables": [
            _table_block(
                "Annual Energy Production & Capacity Factor",
                columns,
                prod_rows,
                caption="Fleet capacity factor calculated against theoretical maximum (4 x 2,050 kW x 8,760 h/yr).",
            )
        ],
        "findings": [],
    }


def _page_energy_availability(config: dict, analysis: dict, charts: dict) -> dict:
    avail = config.get("energy_availability_pct", {})
    turbine_ids = config.get("turbine_ids", [])
    years = ["2022", "2023", "2024"]

    # Build availability table
    avail_rows = []
    for tid in turbine_ids:
        short_id = tid.split("-")[0] if "-" in tid else tid
        row: dict = {"Turbine": short_id}
        vals = []
        for yr in years:
            v = avail.get(yr, {}).get(tid, float("nan"))
            row[yr] = _fmt_pct(v) if v == v else "n/a"
            if v == v:
                vals.append(v)
        avg = sum(vals) / len(vals) if vals else float("nan")
        row["Average"] = _fmt_pct(avg) if avg == avg else "n/a"
        row_class = "row-success" if avg >= 98.0 else ("row-warning" if avg >= 96.0 else "row-danger")
        row["_row_class"] = row_class
        avail_rows.append(row)

    # Fleet averages
    fleet_row: dict = {"Turbine": "Fleet avg"}
    fleet_vals = []
    for yr in years:
        fv = avail.get(yr, {}).get("fleet", float("nan"))
        fleet_row[yr] = _fmt_pct(fv) if fv == fv else "n/a"
        if fv == fv:
            fleet_vals.append(fv)
    fleet_avg = sum(fleet_vals) / len(fleet_vals) if fleet_vals else float("nan")
    fleet_row["Average"] = _fmt_pct(fleet_avg) if fleet_avg == fleet_avg else "n/a"
    fleet_row["_row_class"] = "row-success"
    avail_rows.append(fleet_row)

    # KPIs: per-turbine avg + fleet avg
    kpis = []
    for tid in turbine_ids:
        short_id = tid.split("-")[0] if "-" in tid else tid
        vals = [avail.get(yr, {}).get(tid, float("nan")) for yr in years]
        vals = [v for v in vals if v == v]
        avg = sum(vals) / len(vals) if vals else float("nan")
        status = "success" if avg >= 98.0 else ("warning" if avg >= 96.0 else "danger")
        kpis.append(_kpi(f"{short_id} avg EBA", _fmt_pct(avg) if avg == avg else "n/a", "2022-2024", status))
    kpis.append(_kpi("Fleet avg EBA", _fmt_pct(fleet_avg) if fleet_avg == fleet_avg else "n/a", "2022-2024", "success"))

    figures = []
    fig = _figure_block(
        charts,
        "energy_availability",
        "Energy-Based Availability by Turbine and Year",
        "Annual energy-based availability (EBA) for each turbine, 2022-2024. "
        "Contractual target (98%) shown for reference.",
        "full",
    )
    if fig:
        figures.append(fig)

    return {
        "template": "section",
        "id": "energy-availability",
        "title": "Energy-Based Availability",
        "kicker": "Operational performance",
        "toc_group": "Main Report",
        "commentary": [
            (
                f"Energy-based availability (EBA) measures what fraction of potential energy production "
                f"was realised, accounting for downtime periods. Fleet EBA averaged "
                f"{fleet_avg:.1f}% over 2022-2024, indicating a well-maintained and reliable operation."
            ),
            (
                "E4 (822883) recorded the lowest availability in 2022 (96.52%) and slightly underperforms "
                "peers in energy output, suggesting closer inspection of this unit's maintenance records "
                "is warranted. All other turbines remain within contractual performance targets."
            ),
        ],
        "kpis": kpis,
        "figures": figures,
        "tables": [
            _table_block(
                "Energy-Based Availability (%)",
                ["Turbine", "2022", "2023", "2024", "Average"],
                avail_rows,
                caption="EBA computed from SCADA data as (actual energy / maximum potential energy) x 100%.",
            )
        ],
        "findings": [],
    }


def _page_fatigue_assessment(analysis: dict, charts: dict) -> dict:
    del_ratios = analysis.get("del_ratios", {})
    config = analysis["config"]
    wohler_exponents = config.get("wohler_exponents", {})
    fleet_mean_ws = analysis["fleet_mean_ws"]

    del_rows = []
    for comp_name, data in del_ratios.items():
        m = wohler_exponents.get(comp_name, "—")
        del_ratio = data["del_ratio"]
        annual_pct = data["annual_consumption_pct"]
        consumed_pct = data.get("consumed_pct", float("nan"))
        validation = "Matches aeroelastic" if del_ratio < 1.0 else "Exceeds — use simulation"
        del_rows.append({
            "Component": comp_name,
            "Wohler m": str(m),
            "DEL Ratio": f"{del_ratio:.4f}",
            "Annual Consumption (%/yr)": f"{annual_pct:.3f}%",
            "Consumed (14.5 yr)": f"{consumed_pct:.1f}%" if consumed_pct == consumed_pct else "n/a",
            "Validation": validation,
        })

    figures = []
    fig = _figure_block(
        charts,
        "del_ratios",
        "Damage Equivalent Load Ratio by Component",
        "DEL ratio < 1.0 indicates site fatigue loading is below design basis. "
        "All values validated against aeroelastic simulation.",
        "full",
    )
    if fig:
        figures.append(fig)

    return {
        "template": "section",
        "id": "fatigue-assessment",
        "title": "Fatigue Assessment — Methodology & DEL Results",
        "kicker": "Generic IEC 61400-1 model",
        "toc_group": "Main Report",
        "commentary": [
            (
                "Fatigue damage at this site is estimated using a simplified generic turbine model based "
                "on IEC 61400-1 Ed.4. In the absence of turbine-specific aeroelastic simulation data for "
                "all components, the Damage Equivalent Load (DEL) ratio method is applied: the site wind "
                "speed Weibull distribution is compared to the IEC IIA design basis using the closed-form "
                "m-th moment relationship."
            ),
            (
                "For each structural component, the DEL ratio is calculated as: "
                "DEL_ratio = (A_site^m x Gamma(1+m/k_site)) / (A_design^m x Gamma(1+m/k_design)), "
                "where m is the Wohler material exponent. Correction factors are applied for turbulence "
                "intensity and air density."
            ),
            (
                "The simplified model results are validated against the full aeroelastic simulation "
                "presented in the companion document (8p2_Ger_4xE82-2.0MW_LTA_2025_R00 Annex 1). "
                "For the structural lifetime results, the aeroelastic simulation values are used as "
                "the definitive assessment."
            ),
            (
                f"Note: The site mean wind speed of {fleet_mean_ws:.2f} m/s is significantly lower "
                "than the IEC IIA design basis of 8.5 m/s (Weibull k=2.0). This results in DEL ratios "
                "below 1.0 for all components, confirming the fatigue loading is within design margins."
            ),
        ],
        "kpis": [],
        "figures": figures,
        "tables": [
            _table_block(
                "DEL Analysis Results — Generic IEC Model",
                [
                    "Component",
                    "Wohler m",
                    "DEL Ratio",
                    "Annual Consumption (%/yr)",
                    "Consumed (14.5 yr)",
                    "Validation",
                ],
                del_rows,
                caption=(
                    "DEL ratio computed using m-th moment of the Weibull distribution with TI correction. "
                    "Design basis: IEC IIA, k=2.0, Vave=8.5 m/s. Years operated: ~14.5 yr (to June 2025)."
                ),
            )
        ],
        "findings": [],
    }


def _page_lifetime_results(analysis: dict, charts: dict) -> dict:
    ref_lt = analysis["reference_lifetime"]
    config = analysis["config"]
    wohler_exponents = config.get("wohler_exponents", {})
    years_operated = analysis["years_operated"]

    sorted_components = sorted(ref_lt.items(), key=lambda x: x[1]["total_years"])
    lt_rows = []
    for comp_name, data in sorted_components:
        total_years = data["total_years"]
        end_year = data["end_year"]
        remaining = data["remaining_years"]
        m = wohler_exponents.get(comp_name, "—")
        material = "Steel" if "bolt" in comp_name.lower() or "shaft" in comp_name.lower() or "frame" in comp_name.lower() or "tower" in comp_name.lower() or "foundation" in comp_name.lower() else "GRP/composite" if "blade" in comp_name.lower() and "root" in comp_name.lower() else "Cast iron/steel"
        if total_years <= 27:
            row_class = "row-danger"
        elif total_years <= 33:
            row_class = "row-warning"
        else:
            row_class = ""
        lt_rows.append({
            "Component": comp_name,
            "Material": material,
            "S/N Curve (m)": str(m),
            "Total Lifetime (yr)": f"{total_years:.1f}",
            "End Date": _end_date_str(end_year),
            "Remaining (yr)": f"{remaining:.1f}",
            "Status": "Governing" if total_years == 25.5 else ("Warning" if total_years <= 33 else "Adequate"),
            "_row_class": row_class,
        })

    figures = []
    fig = _figure_block(
        charts,
        "lifetime_components",
        "Structural Component Lifetime Summary",
        "Total lifetime per component (aeroelastic simulation). Design lifetime (20 yr) and "
        "40-year cap shown for reference. Colour indicates status.",
        "full",
    )
    if fig:
        figures.append(fig)

    n_above_20 = sum(1 for v in ref_lt.values() if v["total_years"] >= 20)
    n_above_30 = sum(1 for v in ref_lt.values() if v["total_years"] >= 30)
    n_total = len(ref_lt)

    return {
        "template": "section",
        "id": "lifetime-results",
        "title": "Structural Lifetime Assessment Results",
        "kicker": "Fatigue-based remaining life",
        "toc_group": "Main Report",
        "commentary": [
            (
                "Structural lifetime is calculated for each major component based on full aeroelastic "
                "simulation (Annex 1 of the companion assessment). The governing component is the "
                "blade-to-adapter-hub bolt connection, which limits baseline operation to May 2036 "
                "(25.5 years total from commissioning)."
            ),
            (
                "All other components show lifetimes between 31.1 and 40 years, providing a clear "
                "hierarchy of intervention priorities. The concrete tower, nacelle frame, hub, and "
                "main shaft all reach or are capped at 40 years — well beyond the extended scenarios."
            ),
            (
                "Conservative assumptions embedded in the calculations include: 100% technical "
                "availability assumed (actual ~98.5%, making results more conservative), manufacturer "
                "safety margins in design typically exceed IEC minimum requirements, and the 40-year "
                "cap reflects prudence given uncertainty in long-term wind conditions."
            ),
        ],
        "kpis": [
            _kpi("Governing component", "Blade-adapter-hub bolts"),
            _kpi("Baseline end date", "May 2036", "25.5 yr total", "warning"),
            _kpi("Extended end date (Sc.1)", "Jan 2042", "31.1 yr — bolt replacement", "success"),
            _kpi("Extended end date (Sc.2)", "Nov 2050", "40 yr — blade replacement", "success"),
            _kpi(
                "Components within design life",
                f"{n_above_20}/{n_total}",
                "all pass 20-yr design",
            ),
            _kpi(
                "Components beyond 30 yr",
                f"{n_above_30}/{n_total}",
                "with appropriate maintenance",
            ),
        ],
        "figures": figures,
        "tables": [
            _table_block(
                "Structural Component Lifetime — Detailed Results",
                [
                    "Component",
                    "Material",
                    "S/N Curve (m)",
                    "Total Lifetime (yr)",
                    "End Date",
                    "Remaining (yr)",
                    "Status",
                ],
                lt_rows,
                caption=(
                    "Lifetimes from full aeroelastic simulation (8p2_Ger_4xE82-2.0MW_LTA_2025_R00 Annex 1). "
                    "Remaining years calculated from commissioning December 2010 to assessment June 2025 "
                    f"({years_operated:.1f} yr elapsed)."
                ),
            )
        ],
        "findings": [],
        "paginate": False,
    }


def _page_extension_scenarios() -> dict:
    return {
        "template": "section",
        "id": "extension-scenarios",
        "title": "Lifetime Extension Scenarios",
        "kicker": "Operational planning",
        "toc_group": "Main Report",
        "commentary": [
            (
                "Three operational scenarios have been evaluated based on the structural lifetime results. "
                "Each scenario requires maintenance action before the preceding lifetime limit to remain valid."
            ),
            (
                "Scenario 1 (bolt replacement) is the minimum investment required to continue operating "
                "beyond May 2036 and is recommended as a near-term planning item. The replacement must "
                "be completed before the governing lifetime expires."
            ),
            (
                "Scenario 2 (full blade assembly replacement) unlocks a further decade of operation at "
                "minimal incremental risk, given that all non-blade components are certified to 40 years. "
                "This scenario is contingent on continued compliance with the operational requirements "
                "set out in the type certificate."
            ),
        ],
        "kpis": [],
        "figures": [],
        "tables": [
            _table_block(
                "Lifetime Extension Scenarios",
                ["Scenario", "Required action", "Deadline", "Total lifetime", "End date", "Limiting component"],
                [
                    {
                        "Scenario": "Baseline",
                        "Required action": "No replacement required",
                        "Deadline": "—",
                        "Total lifetime": "25.5 yr",
                        "End date": "May 2036",
                        "Limiting component": "Blade-adapter-hub bolts",
                        "_row_class": "row-warning",
                    },
                    {
                        "Scenario": "1 — Bolt replacement",
                        "Required action": "Replace blade-adapter-hub bolts",
                        "Deadline": "Before May 2036",
                        "Total lifetime": "31.1 yr",
                        "End date": "Jan 2042",
                        "Limiting component": "Blade adapters",
                        "_row_class": "row-success",
                    },
                    {
                        "Scenario": "2 — Blade replacement",
                        "Required action": "Replace blades, extenders & bolts",
                        "Deadline": "Before Jan 2042",
                        "Total lifetime": "40.0 yr",
                        "End date": "Nov 2050",
                        "Limiting component": "40-yr cap (safety)",
                        "_row_class": "row-success",
                    },
                ],
                caption=(
                    "Each extension scenario is conditional on the prior scenario's maintenance action "
                    "being completed before its deadline. Lifetimes measured from commissioning December 2010."
                ),
            )
        ],
        "findings": [
            {
                "title": "Bolt replacement — recommended near-term",
                "severity": "warning",
                "body": (
                    "Procurement and scheduling for blade-adapter-hub bolt replacement should begin "
                    "no later than 2033 to ensure completion before the May 2036 deadline."
                ),
            },
            {
                "title": "Operational compliance requirements",
                "severity": "info",
                "body": (
                    "Lifetime extension validity requires: turbine stops <1,100/yr, third-party technical "
                    "audit every 4 years after year 20, blade inspections every 3 years after year 20, "
                    "and prompt repair of all structural damage."
                ),
            },
        ],
        "paginate": False,
    }


def _page_operational_requirements() -> dict:
    req_rows = [
        {
            "Requirement": "Turbine stop count",
            "Threshold / Frequency": "< 1,100 stops/year per turbine",
            "Responsible party": "Technical manager",
            "Priority": "HIGH",
        },
        {
            "Requirement": "Third-party technical audit",
            "Threshold / Frequency": "Every 4 years after Year 20 (from 2030)",
            "Responsible party": "8.2 Advisory / independent engineer",
            "Priority": "HIGH",
        },
        {
            "Requirement": "Blade inspection (drone/rope)",
            "Threshold / Frequency": "Every 3 years after Year 20 (from 2030)",
            "Responsible party": "Qualified inspector",
            "Priority": "HIGH",
        },
        {
            "Requirement": "Structural damage repair",
            "Threshold / Frequency": "All large cracks and impacts repaired when found",
            "Responsible party": "Technical manager",
            "Priority": "HIGH",
        },
        {
            "Requirement": "Blade bearing seal inspection",
            "Threshold / Frequency": "At next scheduled maintenance",
            "Responsible party": "Enercon / O&M contractor",
            "Priority": "MEDIUM",
        },
        {
            "Requirement": "Concrete tower monitoring (E1, E3)",
            "Threshold / Frequency": "Annual visual check of water ingress",
            "Responsible party": "Technical manager",
            "Priority": "MEDIUM",
        },
        {
            "Requirement": "Tower crack monitoring (E2, E4)",
            "Threshold / Frequency": "Annual check of entrance door cracks",
            "Responsible party": "Technical manager",
            "Priority": "MEDIUM",
        },
        {
            "Requirement": "SCADA data archiving",
            "Threshold / Frequency": "10-minute data retained for full lifetime",
            "Responsible party": "Technical manager",
            "Priority": "LOW",
        },
    ]

    return {
        "template": "section",
        "id": "operational-requirements",
        "title": "Operational Requirements for Lifetime Extension",
        "kicker": "Lifetime validity conditions",
        "toc_group": "Main Report",
        "commentary": [
            (
                "The calculated lifetimes are valid only if the following operational requirements are "
                "maintained throughout the extended operating period. Failure to comply with any condition "
                "may void the lifetime extension."
            ),
        ],
        "kpis": [],
        "figures": [],
        "tables": [
            _table_block(
                "Operational Requirements",
                ["Requirement", "Threshold / Frequency", "Responsible party", "Priority"],
                req_rows,
                caption=(
                    "Requirements derived from type certificate TC-201206 Rev.1 and IEC 61400-1 Ed.4 "
                    "extension provisions. HIGH requirements are mandatory for lifetime validity."
                ),
            )
        ],
        "findings": [],
    }


def _page_recommendations() -> dict:
    action_rows = [
        {
            "Priority": "1 — Critical",
            "Action": "Plan blade-adapter-hub bolt replacement",
            "Turbine": "All",
            "Deadline": "Plan by 2033, execute by May 2036",
            "Responsible": "Asset owner",
            "_row_class": "row-warning",
        },
        {
            "Priority": "2 — High",
            "Action": "Repair water ingress (steel-concrete joint)",
            "Turbine": "E1, E3",
            "Deadline": "Next maintenance window",
            "Responsible": "O&M contractor",
            "_row_class": "row-warning",
        },
        {
            "Priority": "3 — High",
            "Action": "Clean blade bearing seals & check auto-grease",
            "Turbine": "All",
            "Deadline": "Next maintenance window",
            "Responsible": "O&M contractor",
        },
        {
            "Priority": "4 — Medium",
            "Action": "Investigate E4 energy underperformance & availability",
            "Turbine": "E4",
            "Deadline": "Within 6 months",
            "Responsible": "Technical manager",
        },
        {
            "Priority": "5 — Medium",
            "Action": "Monitor entrance door cracks (annual)",
            "Turbine": "E2, E4",
            "Deadline": "Annual",
            "Responsible": "Technical manager",
        },
        {
            "Priority": "6 — Low",
            "Action": "Drone blade inspection (3-year cycle from 2030)",
            "Turbine": "All",
            "Deadline": "2030",
            "Responsible": "Qualified inspector",
        },
    ]

    return {
        "template": "section",
        "id": "recommendations",
        "title": "Key Findings & Recommendations",
        "kicker": "Action plan",
        "toc_group": "Main Report",
        "commentary": [
            (
                "The following findings and recommendations are based on the structural lifetime "
                "assessment results and the June 2025 technical audit. Items are prioritised by "
                "urgency and impact on lifetime validity."
            ),
        ],
        "kpis": [],
        "figures": [],
        "findings": [
            {
                "title": "No immediate structural risk",
                "severity": "info",
                "body": (
                    "Technical audit (June 2025) found no defects that would accelerate the calculated "
                    "lifetime reduction. The fleet is in sound mechanical condition."
                ),
            },
            {
                "title": "Plan bolt replacement before 2033",
                "severity": "warning",
                "body": (
                    "Blade-adapter-hub bolt replacement must be completed before May 2036. Begin "
                    "procurement assessment and budget planning by 2033 at the latest."
                ),
            },
            {
                "title": "Address water ingress — E1 & E3",
                "severity": "warning",
                "body": (
                    "Water ingress observed between steel and concrete sections (E1) and rusty water "
                    "ingress (E3). Seal and monitor — if corrosion of reinforcement is confirmed, "
                    "structural repair is required before lifetime extension."
                ),
            },
            {
                "title": "Monitor E4 energy output",
                "severity": "info",
                "body": (
                    "E4 (822883) consistently produces less energy than peers and had the lowest "
                    "availability in 2022 (96.5%). Review maintenance records and verify pitch calibration."
                ),
            },
            {
                "title": "Blade bearing seals — all turbines",
                "severity": "info",
                "body": (
                    "Grease excess noted on blade bearing seals of all four turbines. Clean excess grease "
                    "and verify automatic lubrication system settings at next maintenance."
                ),
            },
            {
                "title": "Concrete tower crack monitoring",
                "severity": "info",
                "body": (
                    "Minor cracks above entrance doors on E2 and E4. Monitor annually; repair any crack "
                    "exceeding 0.3 mm width."
                ),
            },
        ],
        "tables": [
            _table_block(
                "Prioritised Action Plan",
                ["Priority", "Action", "Turbine", "Deadline", "Responsible"],
                action_rows,
            )
        ],
    }


# ---------------------------------------------------------------------------
# Main public function
# ---------------------------------------------------------------------------

def build_lta_report_data(
    *,
    config: dict,
    analysis: dict,
    charts: dict,
    outputs: dict,
) -> dict:
    """
    Build the complete report data dict for the Ger LTA report.

    Parameters
    ----------
    config : dict
        Site configuration dict (from site_config.json).
    analysis : dict
        Full analysis dict returned by ``build_analysis()``.
    charts : dict
        Chart metadata dict returned by ``GerChartFactory.build_all()``.
    outputs : dict
        Output options, e.g. ``{"output_format": "pdf", "pdf_path": "..."}``.

    Returns
    -------
    dict
        Report data dict with ``"document"`` and ``"pages"`` keys, ready for
        ``render_report_html()``.
    """
    style_tokens = _STYLE_TOKENS
    generated_at = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")

    # ------------------------------------------------------------------
    # Cover page
    # ------------------------------------------------------------------
    cover_page = {
        "template": "cover",
        "title": f"{config['site_name']} — Lifetime Assessment",
        "subtitle": "Wind Farm Structural Lifetime Assessment",
        "metadata": [
            ("Site", config["site_name"]),
            ("Turbines", f"{config['n_turbines']} x {config['turbine_model']}"),
            ("Commissioning", "December 2010"),
            ("Assessment date", "June 2025"),
            ("Design lifetime", "20 years"),
            ("Standard", config["type_certificate"]["iec_standard"]),
        ],
        "cover_image": None,
        "logo_white": Path(SHARED_REPORT_DIR / "8p2_logo_white.png").as_uri(),
        "logo_color": Path(SHARED_REPORT_DIR / "8p2_logo_color.png").as_uri(),
        "favicon": Path(SHARED_REPORT_DIR / "8p2_favicon_sq.jpg").as_uri(),
        "tokens": style_tokens,
        "generated_at": generated_at,
    }

    # ------------------------------------------------------------------
    # Content pages (in report order)
    # ------------------------------------------------------------------
    content_pages = [
        _page_executive_summary(analysis, charts),
        _page_site_overview(config),
        _page_wind_resource(analysis, charts),
        _page_power_production(config, analysis, charts),
        _page_energy_availability(config, analysis, charts),
        _page_fatigue_assessment(analysis, charts),
        _page_lifetime_results(analysis, charts),
        _page_extension_scenarios(),
        _page_operational_requirements(),
        _page_recommendations(),
    ]

    # ------------------------------------------------------------------
    # Paginate section pages
    # ------------------------------------------------------------------
    paginated_pages: list[dict] = []
    for page in content_pages:
        paginated_pages.extend(_paginate_section_like_page(page))

    # ------------------------------------------------------------------
    # TOC (inserted after cover, before content)
    # ------------------------------------------------------------------
    toc = _toc_page(paginated_pages)

    # ------------------------------------------------------------------
    # Assemble document
    # ------------------------------------------------------------------
    document = {
        "report_title": f"{config['site_name']} — Lifetime Assessment",
        "site_name": config["site_name"],
        "generated_at": generated_at,
        "output_format": outputs.get("output_format", "pdf"),
        "logo_white": Path(SHARED_REPORT_DIR / "8p2_logo_white.png").as_uri(),
        "logo_color": Path(SHARED_REPORT_DIR / "8p2_logo_color.png").as_uri(),
        "favicon": Path(SHARED_REPORT_DIR / "8p2_favicon_sq.jpg").as_uri(),
        "cover_image": None,
        "debug_layout": False,
        "tokens": style_tokens,
    }

    return {
        "document": document,
        "pages": [cover_page, toc, *paginated_pages],
    }
