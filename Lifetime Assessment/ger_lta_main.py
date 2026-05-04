"""
Ger (Les Herbreux) Wind Farm — Lifetime Assessment Report Generator
===================================================================
Loads SCADA data, runs analysis, generates charts, and renders the
full PDF lifetime assessment report.

Usage
-----
    python ger_lta_main.py
    python ger_lta_main.py --output-dir output/ --keep-html

Options
-------
--output-dir PATH   Directory for generated report files. Defaults to
                    <script_dir>/output/.
--keep-html         Retain the intermediate HTML file alongside the PDF.
--pdf-engine ENGINE PDF renderer: "playwright" | "weasyprint" | "auto".
                    Defaults to "auto" (playwright on Windows, weasyprint
                    on Linux/macOS).
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Path injection — must happen before any relative imports
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).parent
SHARED_REPORT_DIR = SCRIPT_DIR.parent / "SCADA Analysis" / "report"

# Insert the parent of the shared report package so that
# ``from report.xxx import yyy`` works.
if str(SHARED_REPORT_DIR.parent) not in sys.path:
    sys.path.insert(0, str(SHARED_REPORT_DIR.parent))

# ---------------------------------------------------------------------------
# Project imports (after path injection)
# ---------------------------------------------------------------------------

from ger_analysis import build_analysis  # noqa: E402
from ger_charts import GerChartFactory  # noqa: E402
from ger_report import build_lta_report_data  # noqa: E402

try:
    from report.render_report import render_report_html, render_report_outputs, build_output_paths
    _HAS_RENDER = True
except ImportError as exc:
    print(f"[WARNING] Could not import render_report: {exc}")
    _HAS_RENDER = False

try:
    from report.build_report_data import _paginate_section_like_page  # noqa: F401
except ImportError as exc:
    print(f"[WARNING] Could not import build_report_data: {exc}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate the Ger (Les Herbreux) Lifetime Assessment PDF report.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=SCRIPT_DIR / "output",
        metavar="PATH",
        help="Directory for generated report files (default: output/).",
    )
    parser.add_argument(
        "--keep-html",
        action="store_true",
        default=False,
        help="Retain the intermediate HTML file alongside the PDF.",
    )
    parser.add_argument(
        "--pdf-engine",
        choices=["playwright", "weasyprint", "auto"],
        default="auto",
        metavar="ENGINE",
        help='PDF renderer: "playwright" | "weasyprint" | "auto" (default: auto).',
    )
    parser.add_argument(
        "--html-only",
        action="store_true",
        default=False,
        help="Render HTML only; skip PDF generation.",
    )
    return parser.parse_args()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    args = _parse_args()

    output_dir: Path = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    report_name = "Ger_LTA_Report"
    assets_dir = output_dir / f"{report_name}_assets"

    output_format = "html" if args.html_only else "pdf"

    # ------------------------------------------------------------------
    # Step 1 — Load SCADA data and run analysis
    # ------------------------------------------------------------------
    print()
    print("=" * 60)
    print("  Ger (Les Herbreux) — Lifetime Assessment Report Generator")
    print("=" * 60)
    t0 = time.perf_counter()

    print("\n[1/4] Loading SCADA data and running analysis ...")
    analysis = build_analysis()
    config = analysis["config"]
    t1 = time.perf_counter()
    print(f"      Done in {t1 - t0:.1f}s")

    # ------------------------------------------------------------------
    # Step 2 — Generate charts
    # ------------------------------------------------------------------
    print(f"\n[2/4] Building charts (assets -> {assets_dir}) ...")
    factory = GerChartFactory(analysis=analysis, assets_dir=assets_dir)
    charts = factory.build_all()
    t2 = time.perf_counter()
    print(f"      {len(charts)} chart(s) generated in {t2 - t1:.1f}s")
    for chart_id, meta in sorted(charts.items()):
        print(f"      - {chart_id:35s}  {Path(meta['path']).name}")

    # ------------------------------------------------------------------
    # Step 3 — Build report data
    # ------------------------------------------------------------------
    print("\n[3/4] Building report structure ...")
    outputs = {
        "output_format": output_format,
        "pdf_path": str(output_dir / f"{report_name}.pdf"),
    }
    report_data = build_lta_report_data(
        config=config,
        analysis=analysis,
        charts=charts,
        outputs=outputs,
    )
    n_pages = len(report_data.get("pages", []))
    t3 = time.perf_counter()
    print(f"      {n_pages} page(s) assembled in {t3 - t2:.1f}s")

    # ------------------------------------------------------------------
    # Step 4 — Render report
    # ------------------------------------------------------------------
    if not _HAS_RENDER:
        print("\n[4/4] ERROR: render_report module not available. Cannot render output.")
        sys.exit(1)

    print(f"\n[4/4] Rendering report to {output_format.upper()} ...")

    output_paths = build_output_paths(
        output_dir=output_dir,
        assets_dir=assets_dir,
        report_name=report_name,
        output_format=output_format,
        keep_html=args.keep_html,
        pdf_engine=args.pdf_engine,
    )

    rendered = render_report_outputs(
        report_data=report_data,
        output_paths=output_paths,
        template_dir=SHARED_REPORT_DIR / "templates",
        static_dir=SHARED_REPORT_DIR / "static",
    )

    t4 = time.perf_counter()

    # ------------------------------------------------------------------
    # Summary
    # ------------------------------------------------------------------
    print()
    print("=" * 60)
    print("  Report generation complete")
    print("=" * 60)
    if rendered.get("html_path"):
        print(f"  HTML : {rendered['html_path']}")
    if rendered.get("pdf_path"):
        print(f"  PDF  : {rendered['pdf_path']}")
    if rendered.get("pdf_engine_used"):
        print(f"  Engine used : {rendered['pdf_engine_used']}")
    print(f"  Assets dir  : {rendered.get('assets_dir', assets_dir)}")
    print(f"  Total time  : {t4 - t0:.1f}s")
    print("=" * 60)
    print()


if __name__ == "__main__":
    main()
