import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserRecord } from "@/lib/server/auth";
import { postJsonToPythonService } from "@/lib/server/python-service";
import { mapSite } from "@/lib/server/site-mapper";
import {
  compute,
  solveAssetValueForTargetEquityIrr,
  type FinancialParams,
  type SiteFinancialInput,
} from "@/lib/financialModel";
import type { Site } from "@/types/site";

export const runtime = "nodejs";

type RevenueMode = "guaranteed" | "merchant" | "hybrid";
type RevenueYieldBasis = "p50" | "p90";

interface FinancialFormValues {
  acquisitionDate: string;
  revenueMode: RevenueMode;
  electricityPrice: number;
  electricityEscalation: number;
  contractPriceEscalation: number;
  guaranteedPhaseYears: number;
  revenueYieldBasis: RevenueYieldBasis;
  negativePriceBonusFactorPct: number;
  bessSpreadPrice: number;
  pvProdP50: number;
  pvProdP90: number;
  curtailmentRate: number;
  pvDegradation: number;
  pvLifetime: number;
  bessCyclesPerDay: number;
  bessMinSoH: number;
  bessDegradation: number;
  bessEffDCAC: number;
  capexPvPerKwc: number;
  capexBessPerKwh: number;
  omPv: number;
  insPv: number;
  amPv: number;
  rmPv: number;
  decomPv: number;
  omBess: number;
  insBess: number;
  amBess: number;
  rmBess: number;
  rentEuros: number;
  leaseDepositEuros: number;
  debtPercent: number;
  seniorRate: number;
  debtDuration: number;
  dsraMonths: number;
  dscrTarget: number;
  inflation: number;
  opexInflation: number;
  insuranceInflation: number;
  rentInflation: number;
  equityDividendRate: number;
  costOfEquity: number;
  tax: number;
  targetEquityIrr: number;
}

function parseUiDateToIso(value?: string | null): string | null {
  if (!value) return null;
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}

function buildDefaults(site: Site): FinancialFormValues {
  const currentYear = new Date().getFullYear();
  const defaultAcquisitionDate = parseUiDateToIso(site.cod) ?? `${currentYear}-01-01`;
  return {
    acquisitionDate: defaultAcquisitionDate,
    revenueMode: site.tariff_eur_mwh != null ? "guaranteed" : "merchant",
    electricityPrice: 85,
    electricityEscalation: 1.5,
    contractPriceEscalation: 0,
    guaranteedPhaseYears: site.contract_duration_years ?? 20,
    revenueYieldBasis: "p90",
    negativePriceBonusFactorPct: 50,
    bessSpreadPrice: 30,
    pvProdP50: site.specific_yield_p50_target_kwh_kwp ?? 1350,
    pvProdP90: site.specific_yield_p90_target_kwh_kwp ?? 1250,
    curtailmentRate: 0,
    pvDegradation: 0.5,
    pvLifetime: 25,
    bessCyclesPerDay: 1,
    bessMinSoH: 70,
    bessDegradation: 2.0,
    bessEffDCAC: site.bess_roundtrip_efficiency_pct ?? 88,
    capexPvPerKwc: 600,
    capexBessPerKwh: 300,
    omPv: 6,
    insPv: 3,
    amPv: 3,
    rmPv: 2,
    decomPv: 1,
    omBess: 8,
    insBess: 2,
    amBess: 1,
    rmBess: 2,
    rentEuros: 0,
    leaseDepositEuros: 0,
    debtPercent: 80,
    seniorRate: 5,
    debtDuration: 12,
    dsraMonths: 6,
    dscrTarget: 1.15,
    inflation: 2.0,
    opexInflation: 2.0,
    insuranceInflation: 2.0,
    rentInflation: 2.0,
    equityDividendRate: 10,
    costOfEquity: 10,
    tax: 25,
    targetEquityIrr: 10,
  };
}

function buildSiteInput(site: Site, f: FinancialFormValues): SiteFinancialInput {
  const pvCap = site.cap_dc_kwp || 0;
  const bessCap = site.bess_energy_kwh || 0;
  const bessPow = site.bess_power_kw || 0;
  return {
    hasPV: true,
    pvCapacity: pvCap,
    acCapacity: site.cap_ac_kw || 0,
    revenueYieldBasis: f.revenueYieldBasis,
    pvProdP50: f.pvProdP50,
    pvProdP90: f.pvProdP90,
    pvDegradation: f.pvDegradation,
    pvLifetime: f.pvLifetime,
    capexPv: f.capexPvPerKwc * pvCap,
    omPv: f.omPv,
    insPv: f.insPv,
    amPv: f.amPv,
    rmPv: f.rmPv,
    decomPv: f.decomPv,
    hasBESS: !!site.has_bess,
    bessPower: bessPow,
    bessCapacity: bessCap,
    bessDegradation: f.bessDegradation,
    bessMinSoH: f.bessMinSoH,
    bessCyclesPerDay: f.bessCyclesPerDay,
    bessEffDCAC: f.bessEffDCAC,
    capexBess: f.capexBessPerKwh * bessCap,
    omBess: f.omBess,
    insBess: f.insBess,
    amBess: f.amBess,
    rmBess: f.rmBess,
    rentEuros: f.rentEuros,
    leaseDepositEuros: f.leaseDepositEuros,
  };
}

function buildProjectParams(site: Site, f: FinancialFormValues): Partial<FinancialParams> {
  const debtShare = f.debtPercent / 100;
  const equityShare = 1 - debtShare;
  const guaranteedPhaseYears = Math.max(0, Math.min(f.guaranteedPhaseYears, f.pvLifetime));
  const contractDurationYears =
    f.revenueMode === "merchant" ? 0 : f.revenueMode === "guaranteed" ? f.pvLifetime : guaranteedPhaseYears;
  const autoWacc = equityShare * f.costOfEquity + debtShare * f.seniorRate * (1 - f.tax / 100);
  return {
    acquisitionDate: f.acquisitionDate,
    electricityPrice: f.electricityPrice,
    electricityEscalation: f.electricityEscalation,
    contractPrice: site.tariff_eur_mwh ?? 85,
    contractPriceEscalation: f.contractPriceEscalation,
    contractDurationYears,
    curtailmentRate: f.curtailmentRate,
    bessSpreadPrice: f.bessSpreadPrice,
    inflation: f.inflation,
    opexInflation: f.opexInflation,
    insuranceInflation: f.insuranceInflation,
    rentInflation: f.rentInflation,
    equityDividendRate: f.equityDividendRate,
    tax: f.tax,
    wacc: autoWacc,
    debtPercent: f.debtPercent,
    seniorRate: f.seniorRate,
    debtDuration: f.debtDuration,
    dsraMonths: f.dsraMonths,
    dscrTarget: f.dscrTarget,
    negativePriceBonusFactorPct: /france/i.test(site.country) ? f.negativePriceBonusFactorPct : 0,
  };
}

async function getAccessibleSite(id: string, userId?: string, organizationId?: string | null) {
  const accessFilters = [];
  if (userId) accessFilters.push({ users: { some: { id: userId } } });
  if (organizationId) accessFilters.push({ organizationId });

  return prisma.site.findFirst({
    where: {
      id,
      ...(accessFilters.length ? { OR: accessFilters } : {}),
    },
    include: { solar_module_types: true, solar_inverter_units: true, financials: true },
  });
}

function parseSiteDate(value: string): Date | null {
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  const parsed = new Date(`${year}-${month}-${day}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatLongDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "long", year: "numeric" }).format(date);
}

function formatFileDate(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}_${mm}_${dd}`;
}

function formatDecimal(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "0.00";
}

function formatThousands(value: number): string {
  return Math.round(value).toLocaleString("en-GB");
}

function formatMoneyM(value: number): string {
  return `€ ${formatDecimal(value / 1_000_000, 2)}M`;
}

function formatMoneyK(value: number): string {
  return `€ ${formatDecimal(value / 1_000, 0)}k`;
}

function formatPerKwp(value: number): string {
  return `€ ${formatDecimal(value, 1)}/kWp`;
}

function formatPerKwpYear(value: number): string {
  return `€ ${formatDecimal(value, 1)}/kWp/yr + CPI`;
}

function inferStatus(site: Site): string {
  const cod = parseSiteDate(site.cod);
  if (!cod) return site.status;
  return cod.getTime() > Date.now() ? "pre-COD" : "operational";
}

function buildRevenueModelText(site: Site, f: FinancialFormValues): string {
  const tariff = site.tariff_eur_mwh ?? 0;
  if (f.revenueMode === "guaranteed") {
    return `Guaranteed tariff at € ${formatDecimal(tariff, 2)}/MWh over ${f.pvLifetime} years`;
  }
  if (f.revenueMode === "merchant") {
    return `Full merchant exposure starting at € ${formatDecimal(f.electricityPrice, 2)}/MWh`;
  }
  return `Guaranteed tariff at € ${formatDecimal(tariff, 2)}/MWh for ${f.guaranteedPhaseYears} years, then merchant`;
}

export async function GET(_req: Request, context: { params: { id: string } }) {
  try {
    const { user } = await getCurrentUserRecord();
    const dbSite = await getAccessibleSite(context.params.id, user?.id, user?.organizationId);
    if (!dbSite) return NextResponse.json({ error: "Site not found" }, { status: 404 });

    const site = mapSite(dbSite);
    const saved = (dbSite.financials?.params as Partial<FinancialFormValues> | null) ?? null;
    const formValues: FinancialFormValues = { ...buildDefaults(site), ...(saved ?? {}) };

    const siteInput = buildSiteInput(site, formValues);
    const projectParams = buildProjectParams(site, formValues);
    const result = compute(siteInput, projectParams);
    const valuation = solveAssetValueForTargetEquityIrr(siteInput, projectParams, formValues.targetEquityIrr);
    if (!valuation) {
      return NextResponse.json({ error: "Unable to solve valuation from current assumptions" }, { status: 400 });
    }

    const today = new Date();
    const validityDate = new Date(today);
    validityDate.setDate(validityDate.getDate() + 14);

    const location = `${site.region}, ${site.country}`;
    const mwp = site.cap_dc_kwp / 1000;
    const status = inferStatus(site);
    const codDate = parseSiteDate(site.cod);
    const projectName = site.display_name;
    const targetCompany = site.display_name;
    const spv = site.display_name;
    const seller = "To be confirmed";
    const contactName = "To be confirmed";
    const contactTitle = "To be confirmed";
    const leadOfferor = "Dolfines";
    const advisor = "Dolfines";
    const governingLaw = site.country.toLowerCase() === "france" ? "French law" : `the laws of ${site.country}`;
    const contractor = "To be confirmed";
    const investmentAmountPerKwp = site.cap_dc_kwp > 0 ? result.kpis.totalCapex / site.cap_dc_kwp : 0;
    const impliedPricePerWp = valuation.pricePerWp ?? 0;
    const impliedPricePerKwp = impliedPricePerWp * 1000;
    const revenueModelText = buildRevenueModelText(site, formValues);

    const replacements: Record<string, string> = {
      "[DATE]": formatLongDate(today),
      "[SELLER / DEVELOPER]": seller,
      "[NAME]": contactName,
      "[TITLE]": contactTitle,
      "[PROJECT NAME]": projectName,
      "[XX MWp]": formatDecimal(mwp, 2),
      "[LOCATION, COUNTRY]": location,
      "[LEAD OFFEROR]": leadOfferor,
      "[SUBSIDIARY / ADVISOR]": advisor,
      "[TARGET COMPANY]": targetCompany,
      "[SPV]": spv,
      "[STATUS]": status,
      "[EPC / O&M CONTRACTOR]": contractor,
      "[REVENUE MODEL]": revenueModelText,
      "[GOVERNING LAW]": governingLaw,
      "[VALIDITY DATE]": formatLongDate(validityDate),
      "[COUNTRY/MARKET]": site.country,
      "[OFFEROR]": leadOfferor,
      "[TRACKER BRAND]": "No tracker-specific adjustment applied",
      "[X,XXX kWh/kWp]": formatThousands(formValues.revenueYieldBasis === "p50" ? formValues.pvProdP50 : formValues.pvProdP90),
      "[€ XX/MWh]": `€ ${formatDecimal(site.tariff_eur_mwh ?? formValues.electricityPrice, 2)}/MWh`,
      "[€ XX.XM]": formatMoneyM(result.kpis.totalCapex),
      "[€ XXM]": formatMoneyM(result.kpis.van),
      "[X years]": String(Math.max(3, Math.min(5, formValues.pvLifetime))),
      "[€ X.XM]": formatMoneyM(valuation.equity),
      "[€ XXXk/yr]": formatMoneyK(formValues.rentEuros),
      "[€ XXX/kWp]": formatPerKwp(investmentAmountPerKwp),
      "[€ X.X/kWp/yr + CPI]": formatPerKwpYear(formValues.omPv),
    };

    const paragraph_updates = [
      {
        index: 10,
        text: `${leadOfferor} (the “Offeror”) is pleased to submit this non-binding indicative offer (“NBO”) for the acquisition of ${targetCompany} (the “Target Company”), holding company of ${spv}, in connection with the PV project located in ${location} (the “Project”).`,
      },
      {
        index: 11,
        text: `This offer covers the PV asset only (${formatDecimal(mwp, 2)} MWp, ${status}${codDate ? `, COD ${formatLongDate(codDate)}` : ""}). The Offeror has based its pricing on the current site setup and financial model assumptions, including the offtake structure, lease profile, and operating-cost framework currently loaded in the platform.`,
      },
      {
        index: 12,
        text: `This offer is based on our independent assessment, incorporating the active financial simulation for ${projectName} and adjusted for the project-specific risk factors identified below.`,
      },
      {
        index: 19,
        text: `Investment amount and annual operating costs are based on the current financial simulation for the selected site. These amounts should be aligned with the final SPA perimeter and any remaining technical, legal, or commercial clarifications.`,
      },
      {
        index: 22,
        text: `Our indicative asset value offer for the ${projectName} site, on a cash and debt-free basis, is as follows:`,
      },
      {
        index: 24,
        segments: [
          {
            text: `Non binding asset value: ${formatMoneyM(valuation.assetValue)} on a cash free / debt free basis for 100% of the SPV. The asset value amount of ${formatMoneyM(valuation.assetValue)} will be funded separately by the buyer via project finance and equity.`,
            bold: false,
          },
        ],
      },
      {
        index: 25,
        segments: [{ text: "", bold: false }],
      },
      { index: 36, text: "6. Conditions & Next Steps" },
      { index: 47, text: "Richard MUSI" },
      { index: 48, text: "Head of Renewables – Dolfines" },
      { index: 50, text: "Adrien BOURDON-FENIOU" },
      { index: 51, text: "CEO – Dolfines" },
    ];

    const table_updates = [
      { table: 0, row: 0, col: 1, text: "PV" },
      { table: 0, row: 1, col: 1, text: `${formatDecimal(mwp, 2)} MWp` },
      { table: 0, row: 1, col: 2, text: "" },
      { table: 0, row: 2, col: 1, text: location },
      { table: 0, row: 2, col: 2, text: "" },
      { table: 0, row: 3, col: 1, text: `${status}${codDate ? ` (COD ${formatLongDate(codDate)})` : ""}` },
      { table: 0, row: 3, col: 2, text: "" },
      { table: 0, row: 4, col: 1, text: `${formatThousands(formValues.pvProdP50)} kWh/kWp` },
      { table: 0, row: 4, col: 2, text: "" },
      { table: 0, row: 5, col: 1, text: revenueModelText },
      { table: 0, row: 5, col: 2, text: "" },
      { table: 0, row: 6, col: 0, text: "Investment amount" },
      { table: 0, row: 6, col: 1, text: formatPerKwp(investmentAmountPerKwp) },
      { table: 0, row: 6, col: 2, text: "" },
      { table: 0, row: 7, col: 0, text: "Grid connection" },
      { table: 0, row: 7, col: 1, text: "Included in investment amount" },
      { table: 0, row: 7, col: 2, text: "" },
      { table: 0, row: 8, col: 0, text: "O&M" },
      { table: 0, row: 8, col: 1, text: formatPerKwpYear(formValues.omPv) },
      { table: 0, row: 8, col: 2, text: "" },
      { table: 0, row: 9, col: 1, text: `${formatMoneyK(formValues.rentEuros)}/yr + CPI` },
      { table: 0, row: 9, col: 2, text: "" },
      { table: 1, row: 1, col: 0, text: "Curtailment" },
      { table: 1, row: 1, col: 1, text: `${formatDecimal(formValues.curtailmentRate, 1)}% on production` },
      { table: 1, row: 1, col: 2, text: "Applied explicitly in the energy model as a reduction from gross to net production." },
      { table: 1, row: 2, col: 0, text: "Adjusted yield" },
      { table: 1, row: 2, col: 1, text: `${formatThousands(formValues.revenueYieldBasis === "p50" ? formValues.pvProdP50 : formValues.pvProdP90)} kWh/kWp` },
      { table: 1, row: 2, col: 2, text: `${formValues.revenueYieldBasis.toUpperCase()} case used for the live revenue model and negative-hours bonus basis, versus ${formValues.revenueYieldBasis === "p50" ? `a reference P90 of ${formatThousands(formValues.pvProdP90)}` : `a reference P50 of ${formatThousands(formValues.pvProdP50)}`} kWh/kWp.` },
      { table: 1, row: 3, col: 0, text: "Revenue structure" },
      { table: 1, row: 3, col: 1, text: formValues.revenueMode === "hybrid" ? "Guaranteed + Merchant" : formValues.revenueMode === "guaranteed" ? "Guaranteed" : "Merchant" },
      { table: 1, row: 3, col: 2, text: revenueModelText },
      { table: 1, row: 4, col: 0, text: "Price basis" },
      { table: 1, row: 4, col: 1, text: `Guaranteed: € ${formatDecimal(site.tariff_eur_mwh ?? 0, 2)}/MWh` },
      { table: 1, row: 4, col: 2, text: formValues.revenueMode === "merchant" ? `Merchant start price € ${formatDecimal(formValues.electricityPrice, 2)}/MWh.` : `Merchant tail, where applicable, starts at € ${formatDecimal(formValues.electricityPrice, 2)}/MWh.` },
      { table: 1, row: 5, col: 0, text: "Project IRR" },
      { table: 1, row: 5, col: 1, text: `${formatDecimal(result.kpis.projectIRR, 2)}%` },
      { table: 1, row: 5, col: 2, text: `Based on the active operating assumptions and an asset life of ${formValues.pvLifetime} years.` },
      { table: 1, row: 6, col: 0, text: "Project NPV" },
      { table: 1, row: 6, col: 1, text: formatMoneyM(result.kpis.van) },
      { table: 1, row: 6, col: 2, text: `Net present value at a WACC of ${formatDecimal(projectParams.wacc ?? 0, 2)}% on the current simulation.` },
      { table: 2, row: 1, col: 0, text: "PV — Development / DD" },
      { table: 2, row: 1, col: 1, text: "Included / to be confirmed" },
      { table: 2, row: 1, col: 2, text: "—" },
      { table: 2, row: 2, col: 0, text: "PV — Investment amount" },
      { table: 2, row: 2, col: 1, text: formatPerKwp(investmentAmountPerKwp) },
      { table: 2, row: 2, col: 2, text: formatMoneyM(result.kpis.totalCapex) },
      { table: 2, row: 3, col: 0, text: "PV — Grid connection" },
      { table: 2, row: 3, col: 1, text: "Included in investment amount" },
      { table: 2, row: 3, col: 2, text: "—" },
      { table: 2, row: 4, col: 0, text: "TOTAL INVESTMENT AMOUNT" },
      { table: 2, row: 4, col: 2, text: formatMoneyM(result.kpis.totalCapex) },
      { table: 2, row: 5, col: 1, text: `€ ${formatDecimal(formValues.omPv, 1)}/kWp/yr` },
      { table: 2, row: 5, col: 2, text: formatMoneyK(result.annual[0]?.pvOmCost ?? 0) + "/yr" },
      { table: 2, row: 6, col: 1, text: "—" },
      { table: 2, row: 6, col: 2, text: `${formatMoneyK(formValues.rentEuros)}/yr` },
      { table: 2, row: 7, col: 2, text: `${formatMoneyK((result.annual[0]?.totalOpex ?? 0))}/yr` },
      { table: 3, row: 0, col: 1, text: "Asset value" },
      { table: 3, row: 1, col: 0, text: `${projectName} (${formatDecimal(mwp, 2)} MWp)` },
      { table: 3, row: 1, col: 1, text: formatMoneyM(valuation.assetValue) },
      { table: 3, row: 2, col: 1, text: formatMoneyM(valuation.assetValue) },
    ];

    const paragraph_deletions = [27, 28, 29, 30, 31, 32, 33, 34, 35];
    const table_column_removals = [
      { table: 0, col: 2 },
      { table: 3, col: 3 },
      { table: 3, col: 2 },
    ];
    const outputDate = formatFileDate(today);
    const safeSiteName = site.display_name.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

    const pythonResponse = await postJsonToPythonService("/offers/nbo", {
      template_name: "NBO_PV_Template.docx",
      filename: `NBO_${safeSiteName}_Dolfines_${outputDate}.docx`,
      replacements,
      paragraph_updates,
      table_updates,
      paragraph_deletions,
      table_column_removals,
    });

    const blob = await pythonResponse.arrayBuffer();
    return new NextResponse(blob, {
      status: 200,
      headers: {
        "Content-Type":
          pythonResponse.headers.get("content-type") ??
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition":
          pythonResponse.headers.get("content-disposition") ??
          `attachment; filename="NBO_${site.display_name.replace(/\s+/g, "_")}.docx"`,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const message = error instanceof Error ? error.message : "Failed to generate NBO";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
