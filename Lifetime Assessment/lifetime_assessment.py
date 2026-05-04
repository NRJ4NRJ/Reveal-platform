"""
Wind Farm Lifetime Assessment -- main runner
============================================
Usage
-----
    python lifetime_assessment.py
    python lifetime_assessment.py --config path/to/site_config.json
    python lifetime_assessment.py --config path/to/site_config.json --output-dir results/

Arguments
---------
--config      Path to site_config.json (default: input_data/site_config.json)
--output-dir  Directory where CSV and JSON results are written (default: output/)
--data-dir    Directory containing wind measurement CSV files.
              Defaults to <config_dir>/site_wind_data/

Exit codes
----------
0  Assessment completed successfully (status OK or WARNING).
1  Assessment completed but status is CRITICAL.
2  Runtime error (missing files, bad data, etc.).
"""
from __future__ import annotations

import argparse
import sys
import traceback
from pathlib import Path

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lifetime_assessment",
        description="Wind Farm Lifetime Assessment based on IEC 61400-1 Ed.4 methodology.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=Path("input_data") / "site_config.json",
        metavar="PATH",
        help="Path to site_config.json (default: input_data/site_config.json)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("output"),
        metavar="DIR",
        help="Output directory for CSV and JSON results (default: output/)",
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=None,
        metavar="DIR",
        help=(
            "Directory containing wind measurement CSV files. "
            "Defaults to <config_dir>/site_wind_data/"
        ),
    )
    return parser


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv=None) -> int:
    """
    Run the lifetime assessment and write outputs.

    Returns
    -------
    int
        Exit code: 0 = OK/WARNING, 1 = CRITICAL, 2 = error.
    """
    parser = _build_parser()
    args = parser.parse_args(argv)

    # Resolve paths relative to the script location if they are not absolute
    script_dir = Path(__file__).parent

    config_path: Path = args.config
    if not config_path.is_absolute():
        config_path = script_dir / config_path

    output_dir: Path = args.output_dir
    if not output_dir.is_absolute():
        output_dir = script_dir / output_dir

    data_dir: Path | None = args.data_dir
    if data_dir is not None and not data_dir.is_absolute():
        data_dir = script_dir / data_dir

    # --- Import model (kept here so import errors are handled cleanly) -------
    try:
        from lifetime_model import (
            AssessmentResult,
            export_to_csv,
            export_to_json,
            print_report,
            run_assessment,
        )
    except ImportError as exc:
        print(
            f"ERROR: Could not import lifetime_model.py.\n"
            f"Make sure lifetime_model.py is in the same directory as this script.\n"
            f"Details: {exc}",
            file=sys.stderr,
        )
        return 2

    # --- Check config exists --------------------------------------------------
    if not config_path.exists():
        print(
            f"ERROR: Configuration file not found: {config_path}\n"
            f"Edit input_data/site_config.json with your site parameters.",
            file=sys.stderr,
        )
        return 2

    # --- Run assessment -------------------------------------------------------
    print(f"Loading config  : {config_path}")
    if data_dir:
        print(f"Wind data dir   : {data_dir}")
    else:
        print(f"Wind data dir   : {config_path.parent / 'site_wind_data'} (default)")
    print(f"Output dir      : {output_dir}")
    print()

    try:
        result: AssessmentResult = run_assessment(
            config_path=config_path,
            data_dir=data_dir,
        )
    except FileNotFoundError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        print(
            "\nHint: Place wind measurement CSV files in the site_wind_data/ directory.\n"
            "Use input_data/wind_data_template.csv as a column format reference.",
            file=sys.stderr,
        )
        return 2
    except ValueError as exc:
        print(f"DATA ERROR: {exc}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"UNEXPECTED ERROR: {exc}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return 2

    # --- Print console report -------------------------------------------------
    print_report(result)

    # --- Write outputs --------------------------------------------------------
    output_dir.mkdir(parents=True, exist_ok=True)

    # Sanitise site name for file naming
    safe_name = (
        result.site_name.lower()
        .replace(" ", "_")
        .replace("/", "-")
        .replace("\\", "-")
    )
    date_str = result.assessment_date.replace("-", "")

    csv_path = output_dir / f"lifetime_assessment_{safe_name}_{date_str}.csv"
    json_path = output_dir / f"lifetime_assessment_{safe_name}_{date_str}.json"

    export_to_csv(result, csv_path)
    export_to_json(result, json_path)

    # --- Exit code ------------------------------------------------------------
    if result.summary_status == "CRITICAL":
        print(
            "\n*** ASSESSMENT STATUS: CRITICAL ***\n"
            "One or more components have less than 2 years of remaining lifetime.",
            file=sys.stderr,
        )
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
