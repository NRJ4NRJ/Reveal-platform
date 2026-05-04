"""Report builder for REVEAL."""

from __future__ import annotations

import asyncio
import importlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import traceback
from datetime import date, datetime
from html import escape
from pathlib import Path
from typing import Any

import pandas as pd

# Keep the embedded solar engine available for any legacy imports that still
# resolve through the REVEAL analysis-service bundle.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../..", "solar_engine"))


async def generate_report_file(
    data_files: list[str],
    site_config: dict[str, Any],
    column_mappings: dict[str, Any],
    report_type: str,
    lang: str,
    report_date: str | None,
    logo_variant: str,
    output_dir: str,
    output_format: str = "pdf",
) -> tuple[str, str]:
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None,
        _run_pipeline_sync,
        data_files,
        site_config,
        column_mappings,
        report_type,
        lang,
        report_date,
        logo_variant,
        output_dir,
        output_format,
    )
    return result


async def generate_pdf(
    data_files: list[str],
    site_config: dict[str, Any],
    column_mappings: dict[str, Any],
    report_type: str,
    lang: str,
    report_date: str | None,
    logo_variant: str,
    output_dir: str,
) -> str:
    report_path, _media_type = await generate_report_file(
        data_files=data_files,
        site_config=site_config,
        column_mappings=column_mappings,
        report_type=report_type,
        lang=lang,
        report_date=report_date,
        logo_variant=logo_variant,
        output_dir=output_dir,
        output_format="pdf",
    )
    return report_path


def _run_pipeline_sync(
    data_files: list[str],
    site_config: dict[str, Any],
    column_mappings: dict[str, Any],
    report_type: str,
    lang: str,
    report_date: str | None,
    logo_variant: str,
    output_dir: str,
    output_format: str,
) -> tuple[str, str]:
    try:
        legacy_result = _try_generate_legacy_report(
            data_files=data_files,
            site_config=site_config,
            column_mappings=column_mappings,
            report_type=report_type,
            report_date=report_date,
            output_dir=output_dir,
            output_format=output_format,
        )
        if legacy_result is not None:
            return legacy_result
    except Exception as exc:
        if output_format == "html":
            raise RuntimeError(
                "HTML report generation failed before a report could be produced. "
                "REVEAL has been configured not to show the legacy HTML fallback."
            )
        raise

    if output_format == "html":
        raise RuntimeError(
            "HTML report generation did not produce an output file. "
            "REVEAL has been configured not to show the legacy HTML fallback."
        )

    return _generate_fallback_report_pdf(
        data_files=data_files,
        site_config=site_config,
        column_mappings=column_mappings,
        report_type=report_type,
        lang=lang,
        report_date=report_date,
        output_dir=output_dir,
    )


def _load_reveal_pipeline_result(
    *,
    data_files: list[str],
    site_config: dict[str, Any],
    column_mappings: dict[str, Any],
) -> dict[str, Any]:
    pipeline_module = importlib.import_module("app.services.pipeline")
    run_pipeline = getattr(pipeline_module, "run_pipeline")
    result = run_pipeline(data_files, site_config, column_mappings)
    if not isinstance(result, dict):
        raise RuntimeError("REVEAL pipeline returned an invalid report payload.")
    return result


def _try_generate_legacy_report(
    data_files: list[str],
    site_config: dict[str, Any],
    column_mappings: dict[str, Any],
    report_type: str,
    report_date: str | None,
    output_dir: str,
    output_format: str,
) -> tuple[str, str] | None:
    try:
        debug_context: dict[str, Any] = {}
        if report_type not in {"daily", "comprehensive"}:
            return None

        legacy_root = _find_legacy_solar_root()
        if not legacy_root.exists():
            return None

        legacy_root_str = str(legacy_root)
        if legacy_root_str not in sys.path:
            sys.path.insert(0, legacy_root_str)

        if str(site_config.get("site_type", "solar")).lower() == "wind":
            return _try_generate_wind_report(
                data_files=data_files,
                site_config=site_config,
                report_type=report_type,
                output_dir=output_dir,
                shared_report_root=legacy_root,
                output_format=output_format,
            )

        site_cfg = _normalise_site_config(site_config)
        data_dir = Path(data_files[0]).resolve().parent if data_files else Path(output_dir)
        legacy_input_dir = data_dir
        out_dir = Path(output_dir)
        out_dir.mkdir(parents=True, exist_ok=True)

        if site_cfg.get("site_type", "solar") == "solar":
            legacy_input_dir, site_cfg = _prepare_legacy_solar_inputs(
                data_files=data_files,
                column_mappings=column_mappings,
                site_cfg=site_cfg,
                output_dir=out_dir,
            )
            debug_context = {
                "legacy_input_dir": str(legacy_input_dir),
                "effective_n_inverters": site_cfg.get("n_inverters"),
                "column_mappings": column_mappings,
                "input_files": [str(Path(p).name) for p in data_files],
            }

        if report_type == "daily":
            module = importlib.import_module("report.build_daily_report_data")
            build_daily_report = getattr(module, "build_daily_report")
            report_day = _resolve_report_date(report_date, data_files=data_files, column_mappings=column_mappings)
            _pdf_path, html_path = build_daily_report(
                site_cfg=site_cfg,
                report_date=report_day,
                data_dir=legacy_input_dir,
                out_dir=out_dir,
                skip_pdf=True,
            )
            if output_format == "html":
                return str(html_path), "text/html; charset=utf-8"
            return _render_pdf_from_html(
                html_path=Path(html_path),
                pdf_path=out_dir / f"{Path(html_path).stem}.pdf",
            )

        if report_type == "comprehensive":
            # Use the SCADA analysis HTML/PDF template pipeline for both formats so
            # the export matches the established report structure instead of
            # producing a PDF-only legacy file plus a placeholder HTML wrapper.
            pass

        # Run the pipeline to get the full analysis result for report sections A-F
        _pipeline_result = None
        try:
            import importlib as _il
            _pipe_mod = _il.import_module("app.services.pipeline")
            _pipeline_result = _pipe_mod.run_pipeline(data_files, site_config, column_mappings)
        except Exception:
            pass

        module = importlib.import_module("report.build_scada_analysis_html")
        build_scada_analysis_html = getattr(module, "build_scada_analysis_html")
        html_path = out_dir / "REVEAL_SCADA_Analysis_Report.html"
        result = build_scada_analysis_html(
            site_cfg=site_cfg,
            data_dir=legacy_input_dir,
            out_path=html_path,
            skip_pdf=output_format == "html",
            analysis_result=_pipeline_result,
        )
        if not isinstance(result, tuple) or not result:
            raise RuntimeError("Legacy comprehensive report template returned an invalid result.")
        if output_format == "html":
            html_result_path = result[1] if len(result) > 1 else None
            if html_result_path is None:
                raise RuntimeError("Legacy comprehensive report template returned no HTML output.")
            return str(html_result_path), "text/html; charset=utf-8"
        pdf_path = result[0]
        if pdf_path is None:
            errors = result[2] if len(result) > 2 else []
            raise RuntimeError(
                "Legacy comprehensive report template returned no PDF output."
                + (f" Errors: {errors}" if errors else "")
            )
        return str(pdf_path), "application/pdf"
    except Exception as exc:
        debug_suffix = f" Debug: {debug_context}" if 'debug_context' in locals() and debug_context else ""
        raise RuntimeError(f"Legacy {report_type} report generation failed ({type(exc).__name__}): {exc}{debug_suffix}") from exc


def _find_legacy_solar_root() -> Path:
    env_path = os.getenv("LEGACY_SCADA_PV_ROOT")
    if env_path:
        candidate = Path(env_path)
        if candidate.exists():
            return candidate

    direct_candidates = [
        Path("/app/legacy_scada_pv"),
        Path("/app/SCADA PV Analysis"),
    ]
    for candidate in direct_candidates:
        if candidate.exists():
            return candidate

    # The analysis-service ships solar_engine/ alongside app/ in the container
    # (Dockerfile: COPY solar_engine/ ./solar_engine/).  From report_builder.py
    # at <root>/app/services/report_builder.py that's three levels up + solar_engine.
    embedded = Path(__file__).resolve().parent.parent.parent / "solar_engine"
    if embedded.exists() and (embedded / "report" / "build_scada_analysis_html.py").exists():
        return embedded

    current = Path(__file__).resolve()
    for parent in current.parents:
        for child_name in ("SCADA PV Analysis", "legacy_scada_pv"):
            candidate = parent / child_name
            if candidate.exists():
                return candidate
        repat_candidate = parent / "REVEAL" / "SCADA PV Analysis"
        if repat_candidate.exists():
            return repat_candidate

    return Path("/app/legacy_scada_pv")


def _try_generate_wind_report(
    data_files: list[str],
    site_config: dict[str, Any],
    report_type: str,
    output_dir: str,
    shared_report_root: Path,
    output_format: str,
) -> tuple[str, str] | None:
    if report_type != "comprehensive":
        return None

    wind_root = shared_report_root.parent / "REVEAL" / "SCADA Wind Analysis"
    if not wind_root.exists():
        return None

    wind_root_str = str(wind_root)
    if wind_root_str not in sys.path:
        sys.path.insert(0, wind_root_str)

    wind_module = importlib.import_module("windpat_scada_analysis")
    wind_report_module = importlib.import_module("wind_report")
    render_report_module = importlib.import_module("report.render_report")
    style_tokens_module = importlib.import_module("report.style_tokens")

    data_dir = Path(data_files[0]).resolve().parent if data_files else Path(output_dir)
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    operation = wind_module.load_operation_data(data_dir)
    messages = wind_module.load_message_data(data_dir)
    derived_config, analysis = wind_module.build_analysis(operation, messages, float(site_config.get("tariff_eur_per_kwh") or 0.09))

    display_name = str(site_config.get("display_name") or site_config.get("site_name") or "REVEAL Wind Site")
    site_kmz_path = wind_module.detect_site_kmz_path(None)
    site_location = wind_module.extract_site_location_from_kmz(site_kmz_path)

    config = {
        **derived_config,
        "site_name": display_name,
        "report_title": display_name,
        "data_dir": data_dir,
        "output_dir": out_dir,
        "report_name": "WINDPAT_SCADA_Analysis_Report.pdf",
        "style_tokens": style_tokens_module.get_style_tokens(debug_layout=False),
        "logo_white": (shared_report_root / "reveal_logo_white.png"
                       if (shared_report_root / "reveal_logo_white.png").exists()
                       else shared_report_root / "8p2_logo_white.png"),
        "logo_color": (shared_report_root / "reveal_logo.png"
                       if (shared_report_root / "reveal_logo.png").exists()
                       else shared_report_root / "8p2_logo.png"),
        "favicon": shared_report_root / "8p2_favicon_sq.jpg",
        "company": "REVEAL | 8p2 Advisory",
        "cover_image_path": wind_root / "bg_wind.jpg",
        "site_kmz_path": site_kmz_path,
        "site_location": site_location,
        "country": site_config.get("country") or "",
        "region": site_config.get("region") or "",
    }

    output_paths = render_report_module.build_output_paths(
        output_dir=out_dir,
        assets_dir=None,
        report_name="WINDPAT_SCADA_Analysis_Report.pdf",
        output_format="pdf",
        keep_html=True,
        pdf_engine="auto",
    )
    charts = wind_report_module.build_wind_report_assets(config=config, analysis=analysis, assets_dir=output_paths["assets_dir"])
    report_data = wind_report_module.build_wind_report_data(config=config, analysis=analysis, charts=charts, outputs=output_paths)
    results = render_report_module.render_report_outputs(
        report_data=report_data,
        output_paths=output_paths,
        template_dir=shared_report_root / "report" / "templates",
        static_dir=shared_report_root / "report" / "static",
    )
    if output_format == "html":
        html_path = results.get("html_path")
        return (str(html_path), "text/html; charset=utf-8") if html_path else None
    pdf_path = results.get("pdf_path")
    return (str(pdf_path), "application/pdf") if pdf_path else None


def _normalise_site_config(site_config: dict[str, Any]) -> dict[str, Any]:
    display_name = str(site_config.get("display_name") or site_config.get("site_name") or "REVEAL Site")
    inverter_model = str(site_config.get("inverter_model") or site_config.get("inv_model") or "")
    operating_pr_target = float(
        site_config.get("operating_pr_target")
        or site_config.get("design_pr")
        or 0.79
    )

    return {
        **site_config,
        "display_name": display_name,
        "site_name": display_name,
        "technology": str(site_config.get("technology") or "Solar PV"),
        "site_type": str(site_config.get("site_type") or "solar"),
        "cap_ac_kw": float(site_config.get("cap_ac_kw") or 0),
        "cap_dc_kwp": float(site_config.get("cap_dc_kwp") or 0),
        "n_inverters": int(site_config.get("n_inverters") or 1),
        "inv_ac_kw": float(site_config.get("inv_ac_kw") or 0),
        "inverter_model": inverter_model,
        "inv_model": inverter_model,
        "module_brand": str(site_config.get("module_brand") or ""),
        "module_wp": float(site_config.get("module_wp") or 0),
        "n_modules": int(site_config.get("n_modules") or 0),
        "dc_ac_ratio": float(site_config.get("dc_ac_ratio") or 1.0),
        "design_pr": float(site_config.get("design_pr") or operating_pr_target),
        "operating_pr_target": operating_pr_target,
        "interval_min": int(site_config.get("interval_min") or 10),
        "irr_threshold": float(site_config.get("irr_threshold") or 50),
        "power_threshold": float(site_config.get("power_threshold") or 5),
        "country": str(site_config.get("country") or ""),
        "region": str(site_config.get("region") or ""),
        "cod": str(site_config.get("cod") or ""),
    }


def _prepare_legacy_solar_inputs(
    data_files: list[str],
    column_mappings: dict[str, Any],
    site_cfg: dict[str, Any],
    output_dir: Path,
) -> tuple[Path, dict[str, Any]]:
    if not data_files:
        return (Path(data_files[0]).resolve().parent if data_files else output_dir, site_cfg)

    frames: list[pd.DataFrame] = []
    irr_frames: list[pd.DataFrame] = []
    selected_power_labels: set[str] = set()
    power_by_year_ptr: dict[tuple[int, str], list[pd.DataFrame]] = {}
    irradiance_by_year: dict[int, list[pd.DataFrame]] = {}

    for file_path in data_files:
        source = Path(file_path)
        if not source.exists():
            continue

        mapping = _resolve_mapping_for_file(column_mappings, source)
        worksheet = _mapping_worksheet(mapping)
        power_columns = [str(col).strip() for col in (mapping.get("power") or []) if str(col).strip()]
        time_column = str(mapping.get("time") or "").strip()
        irradiance_column = str(mapping.get("irradiance") or "").strip()
        ambient_temperature_column = str(mapping.get("ambientTemperature") or mapping.get("temperature") or "").strip()
        module_temperature_column = str(mapping.get("moduleTemperature") or "").strip()

        if not time_column or not power_columns:
            continue

        if source.suffix.lower() in {".xlsx", ".xls"}:
            read_kwargs: dict[str, Any] = {}
            if worksheet:
                read_kwargs["sheet_name"] = worksheet
            df = pd.read_excel(source, **read_kwargs)
        else:
            df = pd.read_csv(source)

        df.columns = [str(col).strip() for col in df.columns]
        if time_column not in df.columns:
            continue

        df[time_column] = pd.to_datetime(df[time_column], dayfirst=True, errors="coerce")
        df = df.dropna(subset=[time_column]).copy()
        if df.empty:
            continue

        available_power_cols = [col for col in power_columns if col in df.columns]
        if available_power_cols:
            selected_power_labels.update(available_power_cols)
            inv_df = df[[time_column] + available_power_cols].copy()
            melted = inv_df.melt(id_vars=time_column, var_name="EQUIP", value_name="PAC")
            melted = melted.rename(columns={time_column: "Time_UDT"})
            melted["PAC"] = pd.to_numeric(melted["PAC"], errors="coerce").fillna(0.0)
            melted = melted[["Time_UDT", "EQUIP", "PAC"]]
            frames.append(melted)

            fallback_ptr_map = _build_fallback_ptr_map(available_power_cols)
            for year, year_frame in melted.groupby(melted["Time_UDT"].dt.year):
                for ptr_name, ptr_frame in year_frame.groupby(year_frame["EQUIP"].map(lambda label: _infer_ptr_name(str(label), fallback_ptr_map))):
                    if ptr_frame.empty:
                        continue
                    power_by_year_ptr.setdefault((int(year), ptr_name), []).append(ptr_frame)

        if irradiance_column and irradiance_column in df.columns:
            irr_cols = [time_column, irradiance_column]
            if ambient_temperature_column and ambient_temperature_column in df.columns:
                irr_cols.append(ambient_temperature_column)
            if module_temperature_column and module_temperature_column in df.columns:
                irr_cols.append(module_temperature_column)
            irr_df = df[irr_cols].copy()
            rename_map = {time_column: "Time_UDT", irradiance_column: "GHI"}
            if ambient_temperature_column and ambient_temperature_column in irr_df.columns:
                rename_map[ambient_temperature_column] = "T_amb"
            if module_temperature_column and module_temperature_column in irr_df.columns:
                rename_map[module_temperature_column] = "T_panel"
            irr_df = irr_df.rename(columns=rename_map)
            irr_df["GHI"] = pd.to_numeric(irr_df["GHI"], errors="coerce").fillna(0.0)
            irr_df["T_amb"] = pd.to_numeric(irr_df.get("T_amb"), errors="coerce")
            irr_df["T_panel"] = pd.to_numeric(irr_df.get("T_panel"), errors="coerce")
            irr_df = irr_df[["Time_UDT", "GHI", "T_amb", "T_panel"]]
            irr_frames.append(irr_df)
            for year, year_frame in irr_df.groupby(irr_df["Time_UDT"].dt.year):
                irradiance_by_year.setdefault(int(year), []).append(year_frame)

    if not frames:
        return (Path(data_files[0]).resolve().parent if data_files else output_dir, site_cfg)

    tmp_root = Path(tempfile.mkdtemp(prefix="reveal-legacy-solar-", dir=str(output_dir)))
    inverter_csv = tmp_root / "inverter_power.csv"
    pd.concat(frames, ignore_index=True).to_csv(inverter_csv, index=False, sep=";")

    if irr_frames:
        irradiance_csv = tmp_root / "irradiance.csv"
        pd.concat(irr_frames, ignore_index=True).to_csv(irradiance_csv, index=False, sep=";")

    for (year, ptr_name), ptr_frames in power_by_year_ptr.items():
        ptr_output = tmp_root / f"{ptr_name}_{year}.csv"
        ptr_df = pd.concat(ptr_frames, ignore_index=True).copy()
        ptr_df["Time_UDT"] = ptr_df["Time_UDT"].dt.strftime("%d/%m/%Y %H:%M")
        ptr_df = ptr_df[["Time_UDT", "EQUIP", "PAC"]]
        ptr_df.to_csv(ptr_output, index=False, sep=";", header=True)

    for year, year_frames in irradiance_by_year.items():
        irr_output = tmp_root / f"Irradiance_{year}.csv"
        irr_year_df = pd.concat(year_frames, ignore_index=True).copy()
        irr_year_df["Time_UTC"] = irr_year_df["Time_UDT"].dt.strftime("%d/%m/%Y %H:%M")
        irr_year_df = irr_year_df.rename(columns={"GHI": "WSIrradianceA", "T_amb": "WSTExt", "T_panel": "WSTPanneau"})
        irr_year_df = irr_year_df[["Time_UTC", "WSIrradianceA", "WSTExt", "WSTPanneau"]]
        irr_year_df.to_csv(irr_output, index=False, sep=";", header=True)

    _copy_legacy_solar_assets(tmp_root)

    adjusted_site_cfg = {
        **site_cfg,
        "n_inverters": max(len(selected_power_labels), 1),
    }
    return tmp_root, adjusted_site_cfg


def _build_fallback_ptr_map(power_columns: list[str]) -> dict[str, str]:
    ordered = sorted({str(col).strip() for col in power_columns if str(col).strip()})
    midpoint = max((len(ordered) + 1) // 2, 1)
    return {
        label: "PTR1" if index < midpoint else "PTR2"
        for index, label in enumerate(ordered)
    }


def _infer_ptr_name(label: str, fallback_map: dict[str, str]) -> str:
    lowered = label.lower()
    if lowered.startswith("ond1") or lowered.startswith("ptr1") or lowered.startswith("inv1"):
        return "PTR1"
    if lowered.startswith("ond2") or lowered.startswith("ptr2") or lowered.startswith("inv2"):
        return "PTR2"
    match = re.search(r"(\d+)", lowered)
    if match:
        leading_group = match.group(1)
        if leading_group.startswith("1"):
            return "PTR1"
        if leading_group.startswith("2"):
            return "PTR2"
    return fallback_map.get(label, "PTR1")


def _copy_legacy_solar_assets(target_dir: Path) -> None:
    legacy_root = _find_legacy_solar_root()
    asset_sources = [
        legacy_root / "00orig" / "8p2 advisory white.png",
        legacy_root / "00orig" / "solar_farm_2.jpg",
        legacy_root / "00orig" / "Test.csv",
        legacy_root / "00orig" / "SARAH_Nord.csv",
        legacy_root / "00orig" / "SARAH_Sud.csv",
    ]
    for source in asset_sources:
        if source.exists():
            shutil.copy2(source, target_dir / source.name)


def _run_true_comprehensive_solar_report(
    legacy_root: Path,
    data_dir: Path,
    out_dir: Path,
    output_format: str,
) -> tuple[str, str]:
    script_path = legacy_root / "pvpat_scada_analysis.py"
    if not script_path.exists():
        raise FileNotFoundError(f"Comprehensive PVPAT script not found at {script_path}")

    report_name = "PVPAT_SCADA_Analysis_Report.pdf"
    command = [
        sys.executable,
        str(script_path),
        "--data-dir",
        str(data_dir),
        "--out-dir",
        str(out_dir),
        "--report-name",
        report_name,
    ]
    result = subprocess.run(
        command,
        cwd=str(legacy_root),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "PVPAT comprehensive report generation failed: "
            f"{result.stderr.strip() or result.stdout.strip() or f'exit code {result.returncode}'}"
        )

    pdf_path = out_dir / report_name
    if not pdf_path.exists():
        raise FileNotFoundError(f"PVPAT comprehensive report did not produce {pdf_path}")

    if output_format == "html":
        html_path = out_dir / "PVPAT_SCADA_Analysis_Report.html"
        html_content = (
            "<!doctype html><html><body style=\"font-family:Arial,sans-serif;padding:24px;\">"
            "<h1>PVPAT Comprehensive Report Ready</h1>"
            "<p>The comprehensive report was generated as a PDF for this run.</p>"
            f"<p>PDF file: {escape(pdf_path.name)}</p>"
            "</body></html>"
        )
        html_path.write_text(html_content, encoding="utf-8")
        return str(html_path), "text/html; charset=utf-8"

    return str(pdf_path), "application/pdf"


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        if isinstance(value, str) and not value.strip():
            return default
        return float(value)
    except Exception:
        return default


def _month_label(month: str) -> str:
    try:
        return pd.Timestamp(f"{month}-01").strftime("%m/%y")
    except Exception:
        return month


def _priority_color(priority: str) -> str:
    priority = str(priority or "").upper()
    if priority == "HIGH":
        return "#dc2626"
    if priority == "MEDIUM":
        return "#ea7824"
    return "#64748b"


def _confidence_color(confidence: str) -> str:
    confidence = str(confidence or "").lower()
    if confidence == "high":
        return "#059669"
    if confidence == "medium":
        return "#ea7824"
    return "#64748b"


def _svg_polyline(points: list[tuple[float, float]], color: str, stroke_width: float = 3.0) -> str:
    if not points:
        return ""
    coords = " ".join(f"{x:.1f},{y:.1f}" for x, y in points)
    markers = "".join(
        f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3.5" fill="#ffffff" stroke="{color}" stroke-width="2" />'
        for x, y in points
    )
    return f'<polyline fill="none" stroke="{color}" stroke-width="{stroke_width}" points="{coords}" />{markers}'


def _render_dual_axis_chart_svg(
    *,
    labels: list[str],
    bar_series: list[dict[str, Any]],
    line_series: list[dict[str, Any]],
    left_label: str,
    right_label: str,
    left_max: float | None = None,
    right_max: float | None = None,
    left_min: float = 0.0,
    right_min: float = 0.0,
) -> str:
    if not labels:
        return '<div class="chart-empty">No chart data available for this section.</div>'

    width = 920.0
    height = 340.0
    pad_left = 62.0
    pad_right = 62.0
    pad_top = 20.0
    pad_bottom = 78.0
    plot_width = width - pad_left - pad_right
    plot_height = height - pad_top - pad_bottom

    bar_values = [max(_safe_float(item), 0.0) for series in bar_series for item in series.get("values", [])]
    line_values = [_safe_float(item) for series in line_series for item in series.get("values", [])]
    left_hi = left_max if left_max is not None else max(max(line_values or [0.0]), left_min + 1.0)
    right_hi = right_max if right_max is not None else max(max(bar_values or [0.0]), right_min + 1.0)
    if left_hi <= left_min:
        left_hi = left_min + 1.0
    if right_hi <= right_min:
        right_hi = right_min + 1.0

    def x_center(idx: int) -> float:
        if len(labels) == 1:
            return pad_left + plot_width / 2.0
        return pad_left + (idx / max(len(labels) - 1, 1)) * plot_width

    def left_y(value: float) -> float:
        ratio = (_safe_float(value) - left_min) / max(left_hi - left_min, 1e-9)
        return pad_top + (1.0 - ratio) * plot_height

    def right_y(value: float) -> float:
        ratio = (_safe_float(value) - right_min) / max(right_hi - right_min, 1e-9)
        return pad_top + (1.0 - ratio) * plot_height

    grid: list[str] = []
    for step in range(5):
        y = pad_top + step * plot_height / 4.0
        left_value = left_hi - step * (left_hi - left_min) / 4.0
        right_value = right_hi - step * (right_hi - right_min) / 4.0
        grid.append(
            f'<line x1="{pad_left:.1f}" y1="{y:.1f}" x2="{width - pad_right:.1f}" y2="{y:.1f}" stroke="#e8eef5" stroke-dasharray="2 5" />'
            f'<text x="{pad_left - 10:.1f}" y="{y + 4:.1f}" text-anchor="end" class="svg-axis">{left_value:.0f}</text>'
            f'<text x="{width - pad_right + 10:.1f}" y="{y + 4:.1f}" text-anchor="start" class="svg-axis">{right_value:.0f}</text>'
        )

    bars: list[str] = []
    if bar_series:
        group_width = plot_width / max(len(labels), 1)
        max_bar_band = min(42.0, group_width * 0.72)
        bar_width = max(10.0, max_bar_band / max(len(bar_series), 1))
        for series_index, series in enumerate(bar_series):
            color = str(series.get("color", "#ea7824"))
            values = series.get("values", [])
            for idx, raw_value in enumerate(values[: len(labels)]):
                value = max(_safe_float(raw_value), 0.0)
                cx = x_center(idx)
                x = cx - max_bar_band / 2.0 + series_index * bar_width
                y = right_y(value)
                bars.append(
                    f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_width - 2:.1f}" height="{pad_top + plot_height - y:.1f}" rx="4" fill="{color}" fill-opacity="0.86" />'
                )

    lines: list[str] = []
    for series in line_series:
        color = str(series.get("color", "#3b82f6"))
        values = series.get("values", [])
        points = [(x_center(idx), left_y(_safe_float(value))) for idx, value in enumerate(values[: len(labels)])]
        lines.append(_svg_polyline(points, color))

    x_labels = "".join(
        f'<text x="{x_center(idx):.1f}" y="{height - 36:.1f}" text-anchor="middle" class="svg-axis">{escape(label)}</text>'
        for idx, label in enumerate(labels)
    )
    legend_items = "".join(
        f'<span class="svg-legend-item"><span class="svg-legend-swatch" style="background:{escape(str(series.get("color", "#ea7824")))}"></span>{escape(str(series.get("label", "")))}</span>'
        for series in [*bar_series, *line_series]
    )
    right_axis_title = (
        f'<text x="{width - 18:.1f}" y="{pad_top + plot_height / 2:.1f}" transform="rotate(90 {width - 18:.1f} {pad_top + plot_height / 2:.1f})" class="svg-axis-title">{escape(right_label)}</text>'
        if right_label
        else ""
    )
    return (
        f'<div class="svg-wrap"><svg viewBox="0 0 {width} {height}" class="chart-svg" role="img" aria-label="{escape(left_label)} and {escape(right_label)} chart">'
        f'<line x1="{pad_left:.1f}" y1="{pad_top:.1f}" x2="{pad_left:.1f}" y2="{pad_top + plot_height:.1f}" stroke="#c9d5e4" />'
        f'<line x1="{width - pad_right:.1f}" y1="{pad_top:.1f}" x2="{width - pad_right:.1f}" y2="{pad_top + plot_height:.1f}" stroke="#c9d5e4" />'
        f'<line x1="{pad_left:.1f}" y1="{pad_top + plot_height:.1f}" x2="{width - pad_right:.1f}" y2="{pad_top + plot_height:.1f}" stroke="#c9d5e4" />'
        f'{"".join(grid)}{"".join(bars)}{"".join(lines)}{x_labels}'
        f'<text x="18" y="{pad_top + plot_height / 2:.1f}" transform="rotate(-90 18 {pad_top + plot_height / 2:.1f})" class="svg-axis-title">{escape(left_label)}</text>'
        f"{right_axis_title}</svg><div class=\"svg-legend\">{legend_items}</div></div>"
    )


def _render_line_chart_svg(
    *,
    labels: list[str],
    series: list[dict[str, Any]],
    y_label: str,
    y_min: float = 0.0,
    y_max: float | None = None,
) -> str:
    return _render_dual_axis_chart_svg(
        labels=labels,
        bar_series=[],
        line_series=series,
        left_label=y_label,
        right_label="",
        left_min=y_min,
        left_max=y_max,
        right_min=0.0,
        right_max=1.0,
    )


def _render_heatmap_html(
    *,
    rows: list[dict[str, Any]],
    row_key: str,
    col_key: str,
    value_key: str,
    title_formatter,
    value_formatter,
) -> str:
    if not rows:
        return '<div class="chart-empty">No heat-map data available for this section.</div>'
    row_labels = list(dict.fromkeys(str(item[row_key]) for item in rows))
    col_labels = list(dict.fromkeys(str(item[col_key]) for item in rows))
    lookup = {(str(item[row_key]), str(item[col_key])): _safe_float(item.get(value_key)) for item in rows}
    values = [lookup[key] for key in lookup]
    min_value = min(values) if values else 0.0
    max_value = max(values) if values else 1.0
    span = max(max_value - min_value, 1e-9)

    def heat_color(value: float) -> str:
        ratio = (_safe_float(value) - min_value) / span
        if ratio < 0.25:
            return "#dd5a3a"
        if ratio < 0.50:
            return "#f4bf4b"
        if ratio < 0.75:
            return "#9aa7c0"
        return "#3f5ecb"

    header_cells = "".join(f'<div class="heatmap-head">{escape(_month_label(label))}</div>' for label in col_labels)
    body_rows: list[str] = []
    for row_label in row_labels:
        cells = [f'<div class="heatmap-rowlabel">{escape(row_label)}</div>']
        for col_label in col_labels:
            value = lookup.get((row_label, col_label))
            if value is None:
                cells.append('<div class="heatmap-cell heatmap-empty"></div>')
                continue
            cells.append(
                f'<div class="heatmap-cell" style="background:{heat_color(value)}" title="{escape(title_formatter(row_label, col_label, value))}">{escape(value_formatter(value))}</div>'
            )
        body_rows.append(f'<div class="heatmap-row">{"".join(cells)}</div>')
    return f'<div class="heatmap-wrap"><div class="heatmap-row heatmap-header"><div class="heatmap-rowlabel"></div>{header_cells}</div>{"".join(body_rows)}</div>'


def _render_rank_bars(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return '<div class="chart-empty">No ranking data available for this section.</div>'
    max_value = max(_safe_float(item.get("yield_kwh_kwp")) for item in rows) or 1.0
    cards: list[str] = []
    for idx, item in enumerate(rows):
        pct = _safe_float(item.get("yield_kwh_kwp")) / max_value * 100.0
        tone = "#16a34a" if idx < 2 else "#dc2626"
        cards.append(
            f"""
            <div class="rank-card">
              <div class="rank-row">
                <div class="rank-name">{escape(str(item.get('inv_id', '')))}</div>
                <div class="rank-value">{_safe_float(item.get('yield_kwh_kwp')):.1f} kWh/kWp</div>
              </div>
              <div class="rank-track"><div class="rank-fill" style="width:{pct:.1f}%;background:{tone};"></div></div>
              <div class="rank-subtitle">PR {_safe_float(item.get('pr_pct')):.1f}% · Rank {int(_safe_float(item.get('rank'), 0))}</div>
            </div>
            """
        )
    return "".join(cards)


def _render_weather_tiles(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return '<div class="chart-empty">No rainfall context available for this section.</div>'
    cards: list[str] = []
    for row in rows:
        rain = _safe_float(row.get("total_rain_mm"))
        intensity = str(row.get("intensity", "dry")).replace("_", " ").title()
        if rain >= 120:
            fill = "#c22b27"
        elif rain >= 60:
            fill = "#ec7067"
        elif rain >= 25:
            fill = "#f6c6c0"
        else:
            fill = "#fff4f3"
        text_color = "#ffffff" if rain >= 60 else "#8b2131"
        cards.append(
            f"""
            <div class="rain-card" style="background:{fill};color:{text_color};">
              <div class="rain-top">
                <div class="rain-month">{escape(_month_label(str(row.get('month', ''))))}</div>
                <div class="rain-badge">{escape(intensity)}</div>
              </div>
              <div class="rain-total">{rain:.1f} mm</div>
              <div class="rain-meta">{int(_safe_float(row.get('rainy_hours')))}h rain · peak {_safe_float(row.get('max_hourly_rain_mm')):.2f} mm/h</div>
            </div>
            """
        )
    return f'<div class="rain-grid">{"".join(cards)}</div>'


def _render_punchlist_cards(items: list[dict[str, Any]]) -> str:
    if not items:
        return '<div class="chart-empty">No punchlist findings were generated for this run.</div>'
    cards: list[str] = []
    for item in items:
        impact_mwh = item.get("impact_mwh")
        impact_eur = item.get("impact_eur")
        evidence = item.get("evidence") or []
        next_steps = item.get("next_steps") or []
        confidence = str(item.get("confidence", "medium"))
        cards.append(
            f"""
            <div class="punch-card">
              <div class="punch-head">
                <div class="punch-title-wrap">
                  <span class="pill" style="background:{_priority_color(str(item.get('priority', 'LOW')))};">{escape(str(item.get('priority', 'LOW')))}</span>
                  <span class="punch-category">{escape(str(item.get('category', 'Finding')))}</span>
                  <div class="punch-title">{escape(str(item.get('title') or item.get('finding') or 'Finding'))}</div>
                </div>
                <div class="punch-metrics">
                  {f'<span class="impact-chip">{_safe_float(impact_mwh):.1f} MWh</span>' if impact_mwh is not None else ''}
                  {f'<span class="impact-chip">{_safe_float(impact_eur):,.0f} EUR</span>' if impact_eur is not None else ''}
                  <span class="confidence-chip" style="border-color:{_confidence_color(confidence)};color:{_confidence_color(confidence)};">{escape(confidence.title())} confidence</span>
                </div>
              </div>
              <p class="punch-text">{escape(str(item.get('finding', '')))}</p>
              <p class="punch-reco">{escape(str(item.get('recommendation', '')))}</p>
              {f'<ul class="detail-list">{"".join(f"<li>{escape(str(line))}</li>" for line in evidence)}</ul>' if evidence else ''}
              {f'<div class="detail-subhead">Recommended actions</div><ul class="detail-list">{"".join(f"<li>{escape(str(line))}</li>" for line in next_steps)}</ul>' if next_steps else ''}
            </div>
            """
        )
    return "".join(cards)


def _render_root_cause_cards(items: list[dict[str, Any]]) -> str:
    if not items:
        return '<div class="chart-empty">No root-cause cards available for this section.</div>'
    cards: list[str] = []
    for item in items:
        impact = item.get("impact_mwh")
        impact_eur = item.get("impact_eur")
        confidence = str(item.get("confidence", "medium"))
        cards.append(
            f"""
            <div class="root-card">
              <div class="root-head">
                <div class="root-title">{escape(str(item.get('title', 'Root cause')))}</div>
                <div class="root-badges">
                  <span class="status-chip">{escape(str(item.get('recoverability', ''))).replace('_', ' ').title()}</span>
                  <span class="confidence-chip" style="border-color:{_confidence_color(confidence)};color:{_confidence_color(confidence)};">{escape(confidence.title())}</span>
                </div>
              </div>
              <p>{escape(str(item.get('cause', '')))}</p>
              <p class="punch-reco">{escape(str(item.get('action', '')))}</p>
              <div class="root-impact">
                {f'<span class="impact-chip">{_safe_float(impact):.1f} MWh</span>' if impact is not None else ''}
                {f'<span class="impact-chip">{_safe_float(impact_eur):,.0f} EUR</span>' if impact_eur is not None else ''}
              </div>
            </div>
            """
        )
    return "".join(cards)


def _commentary_block(items: list[str]) -> str:
    if not items:
        return ""
    return f'<div class="commentary-card"><div class="commentary-title">Commentary</div><ul class="detail-list">{"".join(f"<li>{escape(str(item))}</li>" for item in items)}</ul></div>'


def _resolve_mapping_for_file(
    column_mappings: dict[str, Any],
    source: Path,
) -> dict[str, Any]:
    if not isinstance(column_mappings, dict):
        return {}

    # Flat mapping shape.
    if any(key in column_mappings for key in ("time", "power", "irradiance", "temperature")):
        return column_mappings

    candidates = [
        source.name,
        source.name.lower(),
        source.stem,
        source.stem.lower(),
    ]
    for key in candidates:
        value = column_mappings.get(key)
        if isinstance(value, dict):
            return value

    for key, value in column_mappings.items():
        if isinstance(value, dict) and str(key).lower() == source.name.lower():
            return value

    return {}


def _mapping_worksheet(mapping: dict[str, Any]) -> str | None:
    worksheet = mapping.get("worksheet") if isinstance(mapping, dict) else None
    if worksheet is None:
        return None
    value = str(worksheet).strip()
    return value or None


def _resolve_report_date(
    report_date: str | None,
    data_files: list[str] | None = None,
    column_mappings: dict[str, Any] | None = None,
) -> date:
    if not report_date:
        inferred = _infer_single_report_date(data_files or [], column_mappings or {})
        return inferred or datetime.utcnow().date()

    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(report_date, fmt).date()
        except ValueError:
            continue
    inferred = _infer_single_report_date(data_files or [], column_mappings or {})
    return inferred or datetime.utcnow().date()


def _infer_single_report_date(data_files: list[str], column_mappings: dict[str, Any]) -> date | None:
    if not data_files:
        return None

    try:
        import pandas as pd
    except Exception:
        return None

    time_aliases = {
        "time_udt", "time_utc", "time_local", "time", "datetime",
        "timestamp", "date_time", "horodate", "date",
    }

    for file_path in data_files:
        path = Path(file_path)
        mapping = _resolve_mapping_for_file(column_mappings, path)
        worksheet = _mapping_worksheet(mapping)
        try:
            if path.suffix.lower() in {".xlsx", ".xls"}:
                read_kwargs: dict[str, Any] = {}
                if worksheet:
                    read_kwargs["sheet_name"] = worksheet
                df = pd.read_excel(path, **read_kwargs)
            else:
                df = pd.read_csv(path, sep=None, engine="python", encoding="utf-8-sig", low_memory=False)
        except Exception:
            continue

        if df.empty:
            continue

        df.columns = [str(c).strip() for c in df.columns]
        time_col = next((c for c in df.columns if c.lower() in time_aliases), None)
        if time_col is None:
            time_col = str(df.columns[0])

        series = pd.to_datetime(df[time_col], dayfirst=True, errors="coerce")
        unique_dates = sorted({ts.date() for ts in series.dropna()})
        if len(unique_dates) == 1:
            return unique_dates[0]

    return None


def _generate_fallback_report_pdf(
    data_files: list[str],
    site_config: dict[str, Any],
    column_mappings: dict[str, Any],
    report_type: str,
    lang: str,
    report_date: str | None,
    output_dir: str,
) -> tuple[str, str]:
    from playwright.sync_api import sync_playwright

    title = "REVEAL Reporting Summary" if lang == "en" else "Synthèse de rapport REVEAL"
    site_name = str(site_config.get("site_name") or site_config.get("display_name") or "REVEAL Site")
    technology = str(site_config.get("technology", site_config.get("site_type", "solar"))).strip() or "solar"
    cap_ac = site_config.get("cap_ac_kw", "—")
    cap_dc = site_config.get("cap_dc_kwp", "—")
    n_inverters = site_config.get("n_inverters", "—")
    report_date_label = report_date or ("Not specified" if lang == "en" else "Non précisée")

    file_sections: list[str] = []
    for file_path in data_files:
        file_name = os.path.basename(file_path)
        mapping = column_mappings.get(file_name, {})
        power_cols = mapping.get("power", [])
        worksheet = mapping.get("worksheet", "—")
        if isinstance(power_cols, str):
            power_cols = [power_cols]
        power_text = ", ".join(power_cols) if power_cols else "—"
        file_sections.append(
            f"""
            <div class="file-card">
              <h3>{escape(file_name)}</h3>
              <p><strong>{'Worksheet' if lang == 'en' else 'Feuille'}:</strong> {escape(str(worksheet))}</p>
              <p><strong>{'Timestamp' if lang == 'en' else 'Horodatage'}:</strong> {escape(str(mapping.get('time', '—')))}</p>
              <p><strong>{'Power columns' if lang == 'en' else 'Colonnes de puissance'}:</strong> {escape(power_text)}</p>
              <p><strong>{'Irradiance' if lang == 'en' else 'Irradiance'}:</strong> {escape(str(mapping.get('irradiance', '—')))}</p>
              <p><strong>{'Temperature' if lang == 'en' else 'Température'}:</strong> {escape(str(mapping.get('temperature', '—')))}</p>
            </div>
            """
        )

    html = f"""<!doctype html>
<html lang="{escape(lang)}">
  <head>
    <meta charset="utf-8" />
    <title>{escape(title)}</title>
    <style>
      body {{
        font-family: Arial, sans-serif;
        margin: 0;
        background: #051b2b;
        color: #f6f8fb;
      }}
      .page {{
        padding: 36px 42px 48px;
      }}
      .hero {{
        border-radius: 24px;
        padding: 28px 30px;
        background: linear-gradient(135deg, rgba(4,18,28,0.94), rgba(8,39,59,0.88));
        border: 1px solid rgba(255,255,255,0.12);
      }}
      .eyebrow {{
        text-transform: uppercase;
        letter-spacing: 0.3em;
        color: rgba(255,255,255,0.62);
        font-size: 11px;
        font-weight: 700;
      }}
      h1 {{
        margin: 12px 0 8px;
        font-size: 30px;
      }}
      .subtitle {{
        color: rgba(255,255,255,0.82);
        font-size: 14px;
        line-height: 1.6;
      }}
      .kpis {{
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 14px;
        margin: 22px 0 0;
      }}
      .kpi {{
        border-radius: 18px;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.1);
        padding: 16px;
      }}
      .kpi-label {{
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.16em;
        color: rgba(255,255,255,0.58);
        margin-bottom: 10px;
      }}
      .kpi-value {{
        font-size: 22px;
        font-weight: 700;
      }}
      .section {{
        margin-top: 22px;
        border-radius: 22px;
        background: rgba(4,18,28,0.84);
        border: 1px solid rgba(255,255,255,0.1);
        padding: 22px 24px;
      }}
      .section h2 {{
        margin: 0 0 14px;
        font-size: 18px;
      }}
      .files {{
        display: grid;
        gap: 12px;
      }}
      .file-card {{
        border-radius: 16px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        padding: 14px 16px;
      }}
      .file-card h3 {{
        margin: 0 0 10px;
        color: #ea7824;
        font-size: 15px;
      }}
      .file-card p {{
        margin: 6px 0;
        font-size: 13px;
        line-height: 1.5;
      }}
    </style>
  </head>
  <body>
    <div class="page">
      <section class="hero">
        <div class="eyebrow">REVEAL Renewable Energy Valuation, Evaluation and Analytics Lab</div>
        <h1>{escape(title)} · {escape(site_name)}</h1>
        <div class="subtitle">
          {'Fallback PDF generated from the active REVEAL job pipeline while the legacy template is unavailable.' if lang == 'en' else 'PDF de secours généré depuis le pipeline REVEAL actif pendant l’indisponibilité du modèle historique.'}
        </div>
        <div class="kpis">
          <div class="kpi"><div class="kpi-label">{'Report type' if lang == 'en' else 'Type de rapport'}</div><div class="kpi-value">{escape(report_type.title())}</div></div>
          <div class="kpi"><div class="kpi-label">{'Technology' if lang == 'en' else 'Technologie'}</div><div class="kpi-value">{escape(technology)}</div></div>
          <div class="kpi"><div class="kpi-label">AC</div><div class="kpi-value">{escape(str(cap_ac))}</div></div>
          <div class="kpi"><div class="kpi-label">{'Report date' if lang == 'en' else 'Date du rapport'}</div><div class="kpi-value">{escape(report_date_label)}</div></div>
        </div>
      </section>
      <section class="section">
        <h2>{'Asset context' if lang == 'en' else 'Contexte de l’actif'}</h2>
        <p><strong>{'DC capacity' if lang == 'en' else 'Puissance DC'}:</strong> {escape(str(cap_dc))}</p>
        <p><strong>{'Inverters' if lang == 'en' else 'Onduleurs'}:</strong> {escape(str(n_inverters))}</p>
      </section>
      <section class="section">
        <h2>{'Uploaded files and selected mappings' if lang == 'en' else 'Fichiers chargés et mappings sélectionnés'}</h2>
        <div class="files">
          {''.join(file_sections)}
        </div>
      </section>
    </div>
  </body>
</html>"""

    output_path = Path(output_dir)
    html_path = output_path / "reveal_report_fallback.html"
    pdf_path = output_path / "reveal_report_fallback.pdf"
    html_path.write_text(html, encoding="utf-8")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page()
        page.goto(html_path.as_uri(), wait_until="networkidle")
        page.pdf(
            path=str(pdf_path),
            format="A4",
            print_background=True,
            margin={"top": "18mm", "bottom": "18mm", "left": "14mm", "right": "14mm"},
        )
        browser.close()

    return str(pdf_path), "application/pdf"


def _generate_reveal_report_html(
    data_files: list[str],
    site_config: dict[str, Any],
    column_mappings: dict[str, Any],
    pipeline_result: dict[str, Any],
    report_type: str,
    lang: str,
    report_date: str | None,
    output_dir: str,
) -> tuple[str, str]:
    site_name = str(site_config.get("site_name") or site_config.get("display_name") or "REVEAL Site")
    summary = pipeline_result.get("summary") or {}
    pr = pipeline_result.get("pr") or {}
    availability = pipeline_result.get("availability") or {}
    data_quality = pipeline_result.get("data_quality") or {}
    mttf = pipeline_result.get("mttf") or {}
    clipping = pipeline_result.get("clipping") or {}
    diagnosis = pipeline_result.get("diagnosis") or {}
    weather = pipeline_result.get("weather") or {}
    section_commentary = diagnosis.get("section_commentary") or {}
    monthly_pr = pr.get("monthly") or []
    annual_pr = pr.get("annual") or []
    availability_monthly = availability.get("site_monthly") or []
    specific_yield = pipeline_result.get("specific_yield") or []
    specific_yield_monthly = pipeline_result.get("specific_yield_monthly") or []
    irradiance_check = diagnosis.get("irradiance_check") or {}
    waterfall = pipeline_result.get("waterfall") or []
    root_causes = diagnosis.get("root_causes") or []
    punchlist = pipeline_result.get("punchlist") or []
    start_stop = pipeline_result.get("start_stop") or []
    mttf_rows = mttf.get("by_inverter") or []

    monthly_labels = [_month_label(str(item.get("month", ""))) for item in monthly_pr]
    energy_vs_ref_chart = _render_dual_axis_chart_svg(
        labels=monthly_labels,
        bar_series=[
            {"label": "Measured energy", "values": [_safe_float(item.get("E_act_mwh")) for item in monthly_pr], "color": "#7fb7f4"},
            {"label": "Reference energy", "values": [_safe_float(item.get("E_ref_mwh")) for item in monthly_pr], "color": "#d8e6f7"},
        ],
        line_series=[],
        left_label="Energy (MWh)",
        right_label="Energy (MWh)",
    )
    pr_irr_chart = _render_dual_axis_chart_svg(
        labels=monthly_labels,
        bar_series=[{"label": "Irradiation", "values": [_safe_float(item.get("irrad_kwh_m2")) for item in monthly_pr], "color": "#f2b13a"}],
        line_series=[{"label": "PR (%)", "values": [_safe_float(item.get("PR_pct")) for item in monthly_pr], "color": "#5f98ff"}],
        left_label="PR (%)",
        right_label="Irradiation (kWh/m²)",
        left_max=100.0,
    )
    availability_chart = _render_line_chart_svg(
        labels=[_month_label(str(item.get("month", ""))) for item in availability_monthly],
        series=[{"label": "Availability", "values": [_safe_float(item.get("avail_pct")) for item in availability_monthly], "color": "#34d399"}],
        y_label="Availability (%)",
        y_max=100.0,
    )
    irr_monthly_rows = irradiance_check.get("monthly") or []
    irr_benchmark_chart = _render_dual_axis_chart_svg(
        labels=[_month_label(str(item.get("month", ""))) for item in irr_monthly_rows],
        bar_series=[
            {"label": "Measured irradiance", "values": [_safe_float(item.get("measured_kwh_m2")) for item in irr_monthly_rows], "color": "#9fd4ff"},
            {"label": "ERA irradiance", "values": [_safe_float(item.get("reference_kwh_m2")) for item in irr_monthly_rows], "color": "#d6e5f6"},
        ],
        line_series=[],
        left_label="Irradiation (kWh/m²)",
        right_label="Irradiation (kWh/m²)",
    )
    annual_pr_chart = _render_dual_axis_chart_svg(
        labels=[str(item.get("year", "")) for item in annual_pr],
        bar_series=[{"label": "Energy", "values": [_safe_float(item.get("E_act_mwh")) for item in annual_pr], "color": "#7ad28b"}],
        line_series=[{"label": "PR (%)", "values": [_safe_float(item.get("PR_pct")) for item in annual_pr], "color": "#4f86f7"}],
        left_label="PR (%)",
        right_label="Energy (MWh)",
        left_max=100.0,
    )

    mttf_lookup = {str(item.get("inv_id")): item for item in mttf_rows}
    start_lookup = {str(item.get("inv_id")): item for item in start_stop}
    inv_diag_rows: list[dict[str, Any]] = []
    ordered_inverters = list(dict.fromkeys([str(item.get("inv_id")) for item in mttf_rows] + [str(item.get("inv_id")) for item in start_stop]))
    for inv_id in ordered_inverters[:12]:
        inv_diag_rows.append(
            {
                "inv_id": inv_id,
                "mttf_hours": _safe_float(mttf_lookup.get(inv_id, {}).get("mttf_hours")),
                "start_dev": abs(_safe_float(start_lookup.get(inv_id, {}).get("start_dev"))),
            }
        )
    mttf_chart = _render_dual_axis_chart_svg(
        labels=[str(row["inv_id"]) for row in inv_diag_rows],
        bar_series=[{"label": "MTTF (h)", "values": [_safe_float(row["mttf_hours"]) for row in inv_diag_rows], "color": "#8b5cf6"}],
        line_series=[{"label": "Start deviation (min)", "values": [_safe_float(row["start_dev"]) for row in inv_diag_rows], "color": "#14b8a6"}],
        left_label="Start deviation (min)",
        right_label="MTTF (h)",
    )
    clipping_chart = _render_dual_axis_chart_svg(
        labels=[str(item.get("label", "")) for item in (clipping.get("by_irradiance_bin") or [])],
        bar_series=[{"label": "Near-clipping frequency", "values": [_safe_float(item.get("near_clip_pct")) for item in (clipping.get("by_irradiance_bin") or [])], "color": "#a855f7"}],
        line_series=[],
        left_label="Near clip (%)",
        right_label="Near clip (%)",
    )

    dq_monthly = data_quality.get("monthly") or []
    dq_by_month: dict[str, dict[str, float]] = {}
    for row in dq_monthly:
        month = str(row.get("month", ""))
        bucket = dq_by_month.setdefault(month, {"missing_pct": 0.0, "frozen_pct": 0.0, "count": 0.0})
        bucket["missing_pct"] += _safe_float(row.get("missing_pct"))
        bucket["frozen_pct"] += _safe_float(row.get("frozen_pct"))
        bucket["count"] += 1.0
    curtailment_lookup = {str(item.get("month")): _safe_float(item.get("loss_mwh")) for item in (diagnosis.get("curtailment_candidates") or [])}
    event_overlay_rows: list[dict[str, Any]] = []
    for item in monthly_pr:
        month = str(item.get("month", ""))
        dq_month_item = dq_by_month.get(month) or {}
        count = max(dq_month_item.get("count", 0.0), 1.0)
        avail_item = next((row for row in availability_monthly if str(row.get("month")) == month), {})
        event_overlay_rows.append(
            {
                "month": month,
                "pr_pct": _safe_float(item.get("PR_pct")),
                "avail_pct": _safe_float(avail_item.get("avail_pct")),
                "missing_pct": dq_month_item.get("missing_pct", 0.0) / count,
                "frozen_pct": dq_month_item.get("frozen_pct", 0.0) / count,
                "curtailment_mwh": curtailment_lookup.get(month, 0.0),
            }
        )
    event_overlay_chart = _render_dual_axis_chart_svg(
        labels=[_month_label(str(item["month"])) for item in event_overlay_rows],
        bar_series=[
            {"label": "Missing data", "values": [_safe_float(item["missing_pct"]) for item in event_overlay_rows], "color": "#f3b2dc"},
            {"label": "Frozen data", "values": [_safe_float(item["frozen_pct"]) for item in event_overlay_rows], "color": "#ef5b5b"},
            {"label": "Curtailment candidate", "values": [_safe_float(item["curtailment_mwh"]) for item in event_overlay_rows], "color": "#f6b63d"},
        ],
        line_series=[
            {"label": "PR", "values": [_safe_float(item["pr_pct"]) for item in event_overlay_rows], "color": "#5f98ff"},
            {"label": "Availability", "values": [_safe_float(item["avail_pct"]) for item in event_overlay_rows], "color": "#34d399"},
        ],
        left_label="Percent (%)",
        right_label="MWh / %",
        left_max=100.0,
    )
    specific_yield_heatmap = _render_heatmap_html(
        rows=specific_yield_monthly,
        row_key="inv_id",
        col_key="month",
        value_key="yield_kwh_kwp",
        title_formatter=lambda inv, month, value: f"{inv} · {_month_label(month)} · {value:.1f} kWh/kWp",
        value_formatter=lambda value: f"{value:.0f}",
    )
    max_waterfall = max((_safe_float(item.get("value_mwh")) for item in waterfall), default=1.0)
    waterfall_rows = []
    for item in waterfall:
        width_pct = _safe_float(item.get("value_mwh")) / max_waterfall * 100.0 if max_waterfall > 0 else 0.0
        waterfall_rows.append(
            f'<div class="wf-row"><div class="wf-label">{escape(str(item.get("label", "")))}</div><div class="wf-track"><div class="wf-fill" style="width:{width_pct:.1f}%;background:{escape(str(item.get("color") or "#94a3b8"))};"></div></div><div class="wf-value">{_safe_float(item.get("value_mwh")):.1f} MWh</div></div>'
        )

    site_location_parts = [str(site_config.get(key, "")).strip() for key in ("site_name", "city", "country") if str(site_config.get(key, "")).strip()]
    site_location = " · ".join(dict.fromkeys(site_location_parts))
    report_title = "REVEAL Performance Report" if lang == "en" else "Rapport de performance REVEAL"
    report_date_label = report_date or datetime.utcnow().strftime("%Y-%m-%d")
    report_period = " to ".join(str(item)[:10] for item in (summary.get("data_date_range") or [] if isinstance(summary.get("data_date_range"), list) else []))
    latest_annual_pr = _safe_float(annual_pr[-1].get("PR_pct")) if annual_pr else 0.0
    mean_availability = _safe_float(availability.get("mean_pct"))
    total_gap_mwh = _safe_float((diagnosis.get("summary") or {}).get("total_gap_mwh"))
    recoverable_mwh = _safe_float((diagnosis.get("summary") or {}).get("recoverable_mwh"))
    site_details_cards = (
        f'<div class="detail-card"><div class="detail-label">Technology</div><div class="detail-value">{escape(str(site_config.get("technology") or site_config.get("site_type") or "Solar"))}</div></div>'
        f'<div class="detail-card"><div class="detail-label">Inverters</div><div class="detail-value">{int(_safe_float(summary.get("n_inverters")))}</div></div>'
        f'<div class="detail-card"><div class="detail-label">AC capacity</div><div class="detail-value">{_safe_float(summary.get("cap_ac_kw")):.0f} kW</div></div>'
        f'<div class="detail-card"><div class="detail-label">DC capacity</div><div class="detail-value">{_safe_float(summary.get("cap_dc_kwp")):.0f} kWp</div></div>'
        f'<div class="detail-card"><div class="detail-label">Tariff</div><div class="detail-value">{escape(str(site_config.get("tariff_eur_mwh") or site_config.get("site_tariff") or "—"))}</div></div>'
        f'<div class="detail-card"><div class="detail-label">Period analysed</div><div class="detail-value">{escape(report_period or "—")}</div></div>'
    )
    performance_cards = (
        f'<div class="detail-card"><div class="detail-label">Latest annual PR</div><div class="detail-value">{latest_annual_pr:.1f}%</div></div>'
        f'<div class="detail-card"><div class="detail-label">Mean availability</div><div class="detail-value">{mean_availability:.1f}%</div></div>'
        f'<div class="detail-card"><div class="detail-label">Gross gap</div><div class="detail-value">{total_gap_mwh:.1f} MWh</div></div>'
        f'<div class="detail-card"><div class="detail-label">Recoverable gap</div><div class="detail-value">{recoverable_mwh:.1f} MWh</div></div>'
        f'<div class="detail-card"><div class="detail-label">Mapped power channels</div><div class="detail-value">{sum(len(value.get("power", [])) if isinstance(value.get("power"), list) else (1 if value.get("power") else 0) for value in column_mappings.values())}</div></div>'
        f'<div class="detail-card"><div class="detail-label">Irradiance benchmark</div><div class="detail-value">{escape(str(irradiance_check.get("median_ratio_pct") if irradiance_check.get("median_ratio_pct") is not None else "—"))}% median</div></div>'
    )
    html = f"""<!doctype html><html lang="{escape(lang)}"><head><meta charset="utf-8" /><title>{escape(report_title)} · {escape(site_name)}</title><style>:root{{--bg:#f5f8fc;--surface:#fff;--surface-2:#f9fbff;--line:#dbe4ef;--text:#18324a;--muted:#5f7187;--orange:#ea7824;--shadow:0 10px 30px rgba(23,44,71,.08);}}*{{box-sizing:border-box}}body{{margin:0;background:radial-gradient(circle at top right,#fff0e6,transparent 32%),var(--bg);color:var(--text);font-family:Arial,sans-serif}}.page{{max-width:1480px;margin:0 auto;padding:28px}}.hero{{background:linear-gradient(135deg,#fff 0%,#fff5ef 100%);border:1px solid #f0d6c4;border-radius:28px;padding:28px 30px;box-shadow:var(--shadow)}}.eyebrow{{text-transform:uppercase;letter-spacing:.28em;font-size:11px;color:#6a7d93;font-weight:700}}h1{{margin:12px 0 6px;font-size:34px;line-height:1.1}}.subtitle{{color:var(--muted);line-height:1.6;max-width:980px}}.kpis{{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:14px;margin-top:22px}}.kpi{{background:rgba(255,255,255,.78);border:1px solid #e6edf4;border-radius:18px;padding:16px}}.kpi-label{{font-size:11px;text-transform:uppercase;letter-spacing:.16em;color:#73859b;margin-bottom:8px}}.kpi-value{{font-size:24px;font-weight:700}}.meta-grid{{display:grid;grid-template-columns:1.4fr 1fr;gap:18px;margin-top:20px}}.panel{{background:var(--surface);border:1px solid var(--line);border-radius:24px;padding:22px;box-shadow:var(--shadow)}}.section{{margin-top:20px;background:var(--surface);border:1px solid var(--line);border-radius:28px;padding:22px;box-shadow:var(--shadow)}}.section-label{{text-transform:uppercase;letter-spacing:.26em;font-size:11px;color:#6f8296;font-weight:700}}h2{{margin:10px 0 8px;font-size:30px}}.section-copy{{margin:0 0 18px;color:var(--muted);line-height:1.6;max-width:1080px}}.grid-2{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}}.chart-card,.commentary-card,.punch-card,.root-card{{background:var(--surface-2);border:1px solid #e6edf4;border-radius:22px;padding:18px;box-shadow:inset 0 1px 0 rgba(255,255,255,.8)}}.chart-card h3,.commentary-title,.punch-title,.root-title{{margin:0;font-size:18px}}.chart-copy{{margin:8px 0 14px;color:var(--muted);line-height:1.55}}.chart-svg{{width:100%;height:auto;display:block}}.svg-wrap{{display:flex;flex-direction:column;gap:10px}}.svg-axis,.svg-axis-title{{fill:#90a1b5;font-size:12px}}.svg-legend{{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:center;color:#60738a;font-size:13px;padding-top:8px}}.svg-legend-item{{display:inline-flex;align-items:center;gap:6px}}.svg-legend-swatch{{width:12px;height:12px;border-radius:999px;display:inline-block}}.chart-empty{{min-height:180px;display:flex;align-items:center;justify-content:center;color:var(--muted);background:#fbfdff;border:1px dashed #cbd8e5;border-radius:18px}}.commentary-title{{font-size:15px;text-transform:uppercase;letter-spacing:.18em;color:#6c8096;margin-bottom:10px}}.detail-list{{margin:0;padding-left:18px;color:var(--text);line-height:1.6}}.detail-subhead{{margin-top:12px;margin-bottom:6px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.14em;color:#6e8095}}.rain-grid{{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}}.rain-card{{border-radius:18px;padding:14px;border:1px solid rgba(255,255,255,.4);min-height:108px}}.rain-top{{display:flex;justify-content:space-between;gap:10px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.12em}}.rain-badge{{font-size:10px;border:1px solid rgba(255,255,255,.75);padding:3px 8px;border-radius:999px}}.rain-total{{font-size:30px;font-weight:700;margin-top:8px}}.rain-meta{{margin-top:8px;font-size:12px;opacity:.9}}.heatmap-wrap{{overflow-x:auto}}.heatmap-row{{display:grid;grid-template-columns:88px repeat(21,minmax(40px,1fr));gap:4px;margin-bottom:4px;align-items:center}}.heatmap-header{{margin-bottom:8px}}.heatmap-rowlabel{{font-size:12px;color:#51657b;font-weight:700}}.heatmap-head{{text-align:center;font-size:11px;color:#7c8ea3;transform:rotate(-38deg);transform-origin:center;white-space:nowrap;padding-bottom:8px}}.heatmap-cell{{min-height:26px;border-radius:6px;color:rgba(255,255,255,0);font-size:10px;text-align:center;line-height:26px}}.heatmap-empty{{background:#f1f5f9}}.rank-card{{padding:14px 0;border-bottom:1px solid #e8eef5}}.rank-card:last-child{{border-bottom:0}}.rank-row{{display:flex;justify-content:space-between;gap:12px;align-items:center;font-weight:700}}.rank-track{{height:8px;background:#edf3f8;border-radius:999px;overflow:hidden;margin-top:10px}}.rank-fill{{height:100%;border-radius:999px}}.rank-subtitle{{margin-top:8px;color:var(--muted);font-size:12px}}.wf-row{{display:grid;grid-template-columns:180px 1fr 100px;gap:14px;align-items:center;margin-bottom:10px}}.wf-label{{font-weight:700;color:var(--text)}}.wf-track{{height:14px;background:#edf3f8;border-radius:999px;overflow:hidden}}.wf-fill{{height:100%;border-radius:999px}}.wf-value{{text-align:right;font-weight:700;color:var(--text)}}.punch-head,.root-head{{display:flex;justify-content:space-between;gap:14px;align-items:flex-start}}.punch-title-wrap{{display:flex;flex-wrap:wrap;gap:10px;align-items:center}}.punch-title{{flex-basis:100%;margin-top:6px}}.pill,.impact-chip,.confidence-chip,.status-chip{{display:inline-flex;align-items:center;justify-content:center;border-radius:999px;padding:6px 10px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}}.pill{{color:#fff}}.impact-chip{{background:#fff2e8;color:var(--orange);border:1px solid #ffd9be}}.confidence-chip,.status-chip{{background:#fff;border:1px solid #d8e4ef;color:#5c6f84}}.punch-category{{color:#6e8096;font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}}.punch-metrics,.root-badges,.root-impact{{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:flex-end}}.punch-text,.punch-reco,.root-card p{{margin:10px 0 0;color:var(--text);line-height:1.6}}.punch-reco{{color:#415870;font-weight:700}}.report-footer{{margin-top:18px;color:#7b8da2;font-size:12px;text-align:center}}</style></head><body><div class="page"><section class="hero"><div class="eyebrow">REVEAL Renewable Energy Valuation, Evaluation and Analytics Lab</div><h1>{escape(report_title)} · {escape(site_name)}</h1><p class="subtitle">Client-facing performance diagnosis built directly from the REVEAL platform analysis. This report uses the same section structure as the in-platform review so the evidence, commentary, charts, and actions stay aligned.</p><div class="kpis"><div class="kpi"><div class="kpi-label">Report type</div><div class="kpi-value">{escape(report_type.title())}</div></div><div class="kpi"><div class="kpi-label">Site</div><div class="kpi-value">{escape(site_name)}</div></div><div class="kpi"><div class="kpi-label">AC capacity</div><div class="kpi-value">{_safe_float(summary.get('cap_ac_kw')):.0f} kW</div></div><div class="kpi"><div class="kpi-label">DC capacity</div><div class="kpi-value">{_safe_float(summary.get('cap_dc_kwp')):.0f} kWp</div></div><div class="kpi"><div class="kpi-label">Report date</div><div class="kpi-value">{escape(report_date_label)}</div></div></div></section><section class="meta-grid"><div class="panel"><div class="section-label">Site context</div><h3 style="margin:10px 0 8px;font-size:22px;">{escape(site_location or site_name)}</h3><p class="section-copy">Technology: {escape(str(site_config.get('technology') or site_config.get('site_type') or 'Solar'))} · Inverters: {int(_safe_float(summary.get('n_inverters')))} · Tariff: {escape(str(site_config.get('tariff_eur_mwh') or site_config.get('site_tariff') or '—'))}</p><p class="section-copy">Date range analysed: {escape(" to ".join(str(item)[:10] for item in (summary.get("data_date_range") or [] if isinstance(summary.get("data_date_range"), list) else [])))}</p></div><div class="panel"><div class="section-label">Mapped inputs</div><p class="section-copy" style="margin-top:10px;">Files: {escape(", ".join(Path(path).name for path in data_files))}</p><p class="section-copy">Mapped power channels: {sum(len(value.get("power", [])) if isinstance(value.get("power"), list) else (1 if value.get("power") else 0) for value in column_mappings.values())}</p><p class="section-copy">Irradiance input: {escape(", ".join(str(value.get("irradiance", "—")) for value in column_mappings.values()))}</p></div></section><section class="section"><div class="section-label">Section A</div><h2>Weather context and irradiance benchmark</h2><p class="section-copy">Monthly rainfall and the measured-versus-ERA irradiance benchmark give the weather context used to distinguish genuine resource variation from sensor issues or operational underperformance.</p><div class="grid-2"><div class="chart-card"><h3>Measured irradiance versus ERA benchmark</h3><p class="chart-copy">The monthly ratio highlights whether the site irradiance channel is tracking the external reference consistently enough to support PR and specific-yield interpretation.</p>{irr_benchmark_chart}</div><div>{_commentary_block(section_commentary.get("weather") or [])}</div></div><div class="chart-card" style="margin-top:18px;"><h3>Rainfall heat map</h3><p class="chart-copy">ERA rainfall is included so any PR or specific-yield reset can be checked against heavy-rain periods before attributing the change to cleaning or operational recovery.</p>{_render_weather_tiles(weather.get("monthly") or [])}</div></section><section class="section"><div class="section-label">Section B</div><h2>Monthly performance story and inverter spread</h2><p class="section-copy">This section brings together the monthly energy story, PR performance, fleet availability, and inverter spread so the main underperformance pattern can be isolated before drilling into root causes.</p><div class="grid-2"><div class="chart-card"><h3>Monthly energy versus reference</h3><p class="chart-copy">Measured site energy is compared against the weather-implied reference each month.</p>{energy_vs_ref_chart}</div><div class="chart-card"><h3>Monthly PR and irradiation</h3><p class="chart-copy">PR is shown on its own 0–100% axis, while irradiation remains on the right axis.</p>{pr_irr_chart}</div></div><div class="grid-2" style="margin-top:18px;"><div class="chart-card"><h3>Site availability trend</h3><p class="chart-copy">Availability is plotted monthly so equipment-driven losses can be separated from weather-driven variation.</p>{availability_chart}</div><div class="chart-card"><h3>Inverter specific-yield ranking</h3><p class="chart-copy">The highest- and lowest-yield units are highlighted first so persistent underperformers stand out clearly.</p>{_render_rank_bars((specific_yield[:2] + specific_yield[-2:]) if len(specific_yield) > 4 else specific_yield)}</div></div><div style="margin-top:18px;">{_commentary_block(section_commentary.get("site") or [])}</div></section><section class="section"><div class="section-label">Section C</div><h2>Inverter diagnostics</h2><p class="section-copy">The inverter fleet is reviewed through specific-yield spread, reliability signatures, start-time deviation, and near-clipping exposure so persistent unit-level issues can be separated from fleet-wide behavior.</p><div class="chart-card"><h3>Per-inverter specific yield heat map</h3><p class="chart-copy">Lower-yield months stand out immediately, helping isolate persistent underperformers before drilling into faults or clipping.</p>{specific_yield_heatmap}</div><div class="grid-2" style="margin-top:18px;"><div class="chart-card"><h3>MTTF and start deviation</h3><p class="chart-copy">Lower mean time between failures and repeated late starts are practical indicators of units needing closer inspection.</p>{mttf_chart}</div><div class="chart-card"><h3>Near-clipping frequency by irradiance bin</h3><p class="chart-copy">This shows how often the site approaches AC saturation under stronger irradiance.</p>{clipping_chart}</div></div><div style="margin-top:18px;">{_commentary_block(section_commentary.get("inverter") or [])}</div></section><section class="section"><div class="section-label">Section D</div><h2>Loss deep-dive and action register</h2><p class="section-copy">The waterfall separates non-recoverable context from recoverable losses, then turns the main findings into quantified actions with evidence, confidence, and estimated commercial value.</p><div class="grid-2"><div class="chart-card"><h3>Yield waterfall and bridge</h3><p class="chart-copy">The buckets below follow the same REVEAL bridge logic used in the platform diagnosis.</p>{''.join(waterfall_rows)}</div><div>{_commentary_block(section_commentary.get("losses") or [])}</div></div><div class="grid-2" style="margin-top:18px;"><div class="chart-card"><h3>Root causes and actions</h3>{_render_root_cause_cards(root_causes)}</div><div class="chart-card"><h3>Detailed punchlist</h3>{_render_punchlist_cards(punchlist)}</div></div></section><section class="section"><div class="section-label">Section E</div><h2>Performance trend and event overlay annex</h2><p class="section-copy">These supporting views help test whether the monthly story is drifting structurally, reacting to event clusters, or aligning with data-quality exclusions and curtailment periods.</p><div class="grid-2"><div class="chart-card"><h3>Annual PR trend</h3><p class="chart-copy">Annual PR is shown against annual energy so longer-term drift can be checked without legacy chart assumptions.</p>{annual_pr_chart}</div><div class="chart-card"><h3>Monthly event overlay</h3><p class="chart-copy">PR and availability are read against missing-data, frozen-data, and curtailment candidate bars month by month.</p>{event_overlay_chart}</div></div><div style="margin-top:18px;">{_commentary_block(section_commentary.get("data_quality") or [])}</div></section><div class="report-footer">Generated from the REVEAL platform performance workflow · HTML export</div></div></body></html>"""
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    html_path = output_path / "REVEAL_Performance_Report.html"
    html_path.write_text(html, encoding="utf-8")
    return str(html_path), "text/html; charset=utf-8"


def _generate_fallback_report_html(
    data_files: list[str],
    site_config: dict[str, Any],
    column_mappings: dict[str, Any],
    report_type: str,
    lang: str,
    report_date: str | None,
    output_dir: str,
    legacy_error: str | None = None,
    legacy_traceback: str | None = None,
) -> tuple[str, str]:
    title = "REVEAL Reporting Summary" if lang == "en" else "Synthèse de rapport REVEAL"
    site_name = str(site_config.get("site_name") or site_config.get("display_name") or "REVEAL Site")
    technology = str(site_config.get("technology", site_config.get("site_type", "solar"))).strip() or "solar"
    cap_ac = site_config.get("cap_ac_kw", "—")
    cap_dc = site_config.get("cap_dc_kwp", "—")
    n_inverters = site_config.get("n_inverters", "—")
    report_date_label = report_date or ("Not specified" if lang == "en" else "Non précisée")

    file_sections: list[str] = []
    for file_path in data_files:
        file_name = os.path.basename(file_path)
        mapping = column_mappings.get(file_name, {})
        power_cols = mapping.get("power", [])
        if isinstance(power_cols, str):
            power_cols = [power_cols]
        power_text = ", ".join(power_cols) if power_cols else "—"
        file_sections.append(
            f"""
            <div class="file-card">
              <h3>{escape(file_name)}</h3>
              <p><strong>{'Timestamp' if lang == 'en' else 'Horodatage'}:</strong> {escape(str(mapping.get('time', '—')))}</p>
              <p><strong>{'Power columns' if lang == 'en' else 'Colonnes de puissance'}:</strong> {escape(power_text)}</p>
              <p><strong>{'Irradiance' if lang == 'en' else 'Irradiance'}:</strong> {escape(str(mapping.get('irradiance', '—')))}</p>
              <p><strong>{'Temperature' if lang == 'en' else 'Température'}:</strong> {escape(str(mapping.get('temperature', '—')))}</p>
            </div>
            """
        )

    legacy_note = ""
    if legacy_error:
        legacy_note = f"""
      <section class="section">
        <h2>{'Legacy template status' if lang == 'en' else 'Statut du modèle historique'}</h2>
        <p><strong>{'The legacy template failed and REVEAL generated this HTML fallback so the report can still be reviewed.' if lang == 'en' else 'Le modèle historique a échoué et REVEAL a généré ce HTML de secours afin que le rapport puisse quand même être consulté.'}</strong></p>
        <p><code>{escape(legacy_error)}</code></p>
        {'<details><summary>Traceback</summary><pre>' + escape(legacy_traceback or '') + '</pre></details>' if legacy_traceback else ''}
      </section>"""

    html = f"""<!doctype html>
<html lang="{escape(lang)}">
  <head>
    <meta charset="utf-8" />
    <title>{escape(title)}</title>
    <style>
      body {{
        font-family: Arial, sans-serif;
        margin: 0;
        background: #051b2b;
        color: #f6f8fb;
      }}
      .page {{
        padding: 36px 42px 48px;
      }}
      .hero {{
        border-radius: 24px;
        padding: 28px 30px;
        background: linear-gradient(135deg, rgba(4,18,28,0.94), rgba(8,39,59,0.88));
        border: 1px solid rgba(255,255,255,0.12);
      }}
      .eyebrow {{
        text-transform: uppercase;
        letter-spacing: 0.3em;
        color: rgba(255,255,255,0.62);
        font-size: 11px;
        font-weight: 700;
      }}
      h1 {{
        margin: 12px 0 8px;
        font-size: 30px;
      }}
      .subtitle {{
        color: rgba(255,255,255,0.82);
        font-size: 14px;
        line-height: 1.6;
      }}
      .kpis {{
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 14px;
        margin: 22px 0 0;
      }}
      .kpi {{
        border-radius: 18px;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.1);
        padding: 16px;
      }}
      .kpi-label {{
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.16em;
        color: rgba(255,255,255,0.58);
        margin-bottom: 10px;
      }}
      .kpi-value {{
        font-size: 22px;
        font-weight: 700;
      }}
      .section {{
        margin-top: 22px;
        border-radius: 22px;
        background: rgba(4,18,28,0.84);
        border: 1px solid rgba(255,255,255,0.1);
        padding: 22px 24px;
      }}
      .section h2 {{
        margin: 0 0 14px;
        font-size: 18px;
      }}
      .files {{
        display: grid;
        gap: 12px;
      }}
      .file-card {{
        border-radius: 16px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        padding: 14px 16px;
      }}
      .file-card h3 {{
        margin: 0 0 10px;
        color: #ea7824;
        font-size: 15px;
      }}
      .file-card p {{
        margin: 6px 0;
        font-size: 13px;
        line-height: 1.5;
      }}
    </style>
  </head>
  <body>
    <div class="page">
      <section class="hero">
        <div class="eyebrow">REVEAL Renewable Energy Valuation, Evaluation and Analytics Lab</div>
        <h1>{escape(title)} · {escape(site_name)}</h1>
        <div class="subtitle">
          {'HTML fallback generated from the active REVEAL job pipeline so the legacy report content can be inspected directly.' if lang == 'en' else 'HTML de secours généré depuis le pipeline REVEAL actif afin d’inspecter directement le contenu du rapport historique.'}
        </div>
        <div class="kpis">
          <div class="kpi"><div class="kpi-label">{'Report type' if lang == 'en' else 'Type de rapport'}</div><div class="kpi-value">{escape(report_type.title())}</div></div>
          <div class="kpi"><div class="kpi-label">{'Technology' if lang == 'en' else 'Technologie'}</div><div class="kpi-value">{escape(technology)}</div></div>
          <div class="kpi"><div class="kpi-label">AC</div><div class="kpi-value">{escape(str(cap_ac))}</div></div>
          <div class="kpi"><div class="kpi-label">{'Report date' if lang == 'en' else 'Date du rapport'}</div><div class="kpi-value">{escape(report_date_label)}</div></div>
        </div>
      </section>
      <section class="section">
        <h2>{'Asset context' if lang == 'en' else 'Contexte de l’actif'}</h2>
        <p><strong>{'DC capacity' if lang == 'en' else 'Puissance DC'}:</strong> {escape(str(cap_dc))}</p>
        <p><strong>{'Inverters' if lang == 'en' else 'Onduleurs'}:</strong> {escape(str(n_inverters))}</p>
      </section>
      <section class="section">
        <h2>{'Uploaded files and selected mappings' if lang == 'en' else 'Fichiers chargés et mappings sélectionnés'}</h2>
        <div class="files">
          {''.join(file_sections)}
        </div>
      </section>
      {legacy_note}
    </div>
  </body>
</html>"""

    output_path = Path(output_dir)
    html_path = output_path / "reveal_report_fallback.html"
    html_path.write_text(html, encoding="utf-8")
    return str(html_path), "text/html; charset=utf-8"


def _render_pdf_from_html(html_path: Path, pdf_path: Path) -> str:
    from playwright.sync_api import sync_playwright

    pdf_path.parent.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        page = browser.new_page()
        page.goto(html_path.resolve().as_uri(), wait_until="networkidle")
        page.pdf(
            path=str(pdf_path),
            format="A4",
            print_background=True,
            margin={"top": "8mm", "right": "8mm", "bottom": "8mm", "left": "8mm"},
        )
        browser.close()

    return str(pdf_path)
