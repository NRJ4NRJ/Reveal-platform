#!/bin/sh
# Baselines the five migrations that already exist in the database before
# prisma migrate deploy runs. Safe to re-run — errors from migrations that
# are already tracked are suppressed.
set -e

echo "Baselining existing migrations..."
prisma migrate resolve --applied "0001_init"                             2>/dev/null || true
prisma migrate resolve --applied "0002_site_metadata_and_inverter_units" 2>/dev/null || true
prisma migrate resolve --applied "0003_inverter_module_count"            2>/dev/null || true
prisma migrate resolve --applied "0004_site_bess_metadata"               2>/dev/null || true
prisma migrate resolve --applied "0005_resource_database_expansion"      2>/dev/null || true
prisma migrate resolve --applied "0006_site_financials"                  2>/dev/null || true
prisma migrate resolve --applied "0007_site_specific_yield_targets"      2>/dev/null || true
prisma migrate resolve --applied "0008_site_contract_and_curtailment_fields" 2>/dev/null || true
echo "Baseline complete."
