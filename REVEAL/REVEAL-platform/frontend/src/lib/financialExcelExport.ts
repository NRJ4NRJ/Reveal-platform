import type {
  AnnualRow,
  FinancialKPIs,
  FinancialParams,
  SiteFinancialInput,
  ValuationResult,
} from "@/lib/financialModel";

type CellFormat = "text" | "number" | "currency" | "percent" | "date" | "ratio";

interface FinancialExcelExportOptions {
  siteName: string;
  location: string;
  capacitySummary: string;
  cod: string;
  siteInput: SiteFinancialInput;
  projectParams: FinancialParams;
  kpis: FinancialKPIs;
  annual: AnnualRow[];
  valuation: ValuationResult | null;
  targetEquityIrr: number;
  costOfEquity: number;
  logoUrl: string;
}

interface InputRow {
  section: string;
  key: string;
  label: string;
  value: string | number | Date;
  unit?: string;
  format: CellFormat;
}

function colLetter(index: number): string {
  let n = index;
  let result = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

function cellRef(col: number, row: number): string {
  return `${colLetter(col)}${row}`;
}

async function fetchImageAsBase64(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function applyValueFormat(cell: { numFmt?: string }, format: CellFormat) {
  if (format === "currency") cell.numFmt = '#,##0.0 "€"';
  if (format === "percent") cell.numFmt = '0.0';
  if (format === "number") cell.numFmt = '#,##0.0';
  if (format === "ratio") cell.numFmt = '0.00';
  if (format === "date") cell.numFmt = "dd/mm/yyyy";
}

function asExcelDate(value: string): Date {
  return new Date(`${value}T00:00:00`);
}

function formatOutputDate(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}_${mm}_${dd}`;
}

export async function exportFinancialWorkbook(options: FinancialExcelExportOptions) {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "OpenAI Codex";
  workbook.company = "Dolfines";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  const sheet = workbook.addWorksheet("P&L Summary", {
    properties: { defaultRowHeight: 20 },
  });

  const logoBase64 = await fetchImageAsBase64(options.logoUrl);
  if (logoBase64) {
    const imageId = workbook.addImage({ base64: logoBase64, extension: "png" });
    sheet.addImage(imageId, {
      tl: { col: 0.15, row: 0.1 },
      ext: { width: 180, height: 55 },
    });
  }

  sheet.mergeCells("D1:J1");
  sheet.getCell("D1").value = "REVEAL Financial Model Export";
  sheet.getCell("D1").font = { name: "Aptos Display", size: 18, bold: true, color: { argb: "FF0F2C46" } };
  sheet.getCell("D1").alignment = { vertical: "middle" };

  sheet.mergeCells("D2:J2");
  sheet.getCell("D2").value = options.siteName;
  sheet.getCell("D2").font = { name: "Aptos", size: 14, bold: true, color: { argb: "FF1F3D5A" } };

  sheet.getCell("D3").value = "Location";
  sheet.getCell("E3").value = options.location;
  sheet.getCell("G3").value = "Capacity";
  sheet.getCell("H3").value = options.capacitySummary;
  sheet.getCell("J3").value = "COD";
  sheet.getCell("K3").value = options.cod;

  const headingFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F2C46" } } as const;
  const sectionFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F6FA" } } as const;
  const accentFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F1F8" } } as const;

  ["D3", "G3", "J3"].forEach((ref) => {
    sheet.getCell(ref).font = { bold: true, color: { argb: "FF4B6075" } };
  });

  const inputs: InputRow[] = [
    { section: "Site setup", key: "has_pv", label: "Has PV", value: options.siteInput.hasPV ? 1 : 0, unit: "1=yes", format: "number" },
    { section: "Site setup", key: "pv_capacity_kwp", label: "PV capacity", value: options.siteInput.pvCapacity, unit: "kWp", format: "number" },
    { section: "Site setup", key: "ac_capacity_kw", label: "AC capacity", value: options.siteInput.acCapacity, unit: "kW", format: "number" },
    { section: "Site setup", key: "has_bess", label: "Has BESS", value: options.siteInput.hasBESS ? 1 : 0, unit: "1=yes", format: "number" },
    { section: "Site setup", key: "bess_power_kw", label: "BESS power", value: options.siteInput.bessPower, unit: "kW", format: "number" },
    { section: "Site setup", key: "bess_capacity_kwh", label: "BESS energy", value: options.siteInput.bessCapacity, unit: "kWh", format: "number" },
    { section: "Revenue", key: "acquisition_date", label: "Acquisition date", value: asExcelDate(options.projectParams.acquisitionDate), format: "date" },
    { section: "Revenue", key: "project_lifetime", label: "Project lifetime", value: options.siteInput.pvLifetime, unit: "years", format: "number" },
    { section: "Revenue", key: "yield_basis", label: "Yield basis", value: options.siteInput.revenueYieldBasis.toUpperCase(), format: "text" },
    { section: "Revenue", key: "p50_yield", label: "P50 specific yield", value: options.siteInput.pvProdP50, unit: "kWh/kWp", format: "number" },
    { section: "Revenue", key: "p90_yield", label: "P90 specific yield", value: options.siteInput.pvProdP90, unit: "kWh/kWp", format: "number" },
    { section: "Revenue", key: "curtailment_rate", label: "Curtailment rate", value: options.projectParams.curtailmentRate, unit: "%", format: "percent" },
    { section: "Revenue", key: "pv_degradation", label: "PV degradation", value: options.siteInput.pvDegradation, unit: "%/yr", format: "percent" },
    { section: "Revenue", key: "contract_price", label: "Tariff / contracted price", value: options.projectParams.contractPrice, unit: "€/MWh", format: "currency" },
    { section: "Revenue", key: "contract_price_escalation", label: "Contract price escalation", value: options.projectParams.contractPriceEscalation, unit: "%/yr", format: "percent" },
    { section: "Revenue", key: "contract_duration_years", label: "Contract duration", value: options.projectParams.contractDurationYears, unit: "years", format: "number" },
    { section: "Revenue", key: "merchant_price", label: "Merchant price", value: options.projectParams.electricityPrice, unit: "€/MWh", format: "currency" },
    { section: "Revenue", key: "merchant_escalation", label: "Merchant escalation", value: options.projectParams.electricityEscalation, unit: "%/yr", format: "percent" },
    { section: "Revenue", key: "negative_bonus_factor", label: "Negative-hours bonus factor", value: options.projectParams.negativePriceBonusFactorPct, unit: "%", format: "percent" },
    { section: "Revenue", key: "bess_spread_price", label: "BESS spread price", value: options.projectParams.bessSpreadPrice, unit: "€/MWh", format: "currency" },
    { section: "OPEX / CAPEX", key: "capex_pv_total", label: "PV capex total", value: options.siteInput.capexPv, unit: "€", format: "currency" },
    { section: "OPEX / CAPEX", key: "capex_bess_total", label: "BESS capex total", value: options.siteInput.capexBess, unit: "€", format: "currency" },
    { section: "OPEX / CAPEX", key: "om_pv", label: "PV O&M", value: options.siteInput.omPv, unit: "€/kWp/yr", format: "currency" },
    { section: "OPEX / CAPEX", key: "ins_pv", label: "PV insurance", value: options.siteInput.insPv, unit: "€/kWp/yr", format: "currency" },
    { section: "OPEX / CAPEX", key: "am_pv", label: "PV asset management", value: options.siteInput.amPv, unit: "€/kWp/yr", format: "currency" },
    { section: "OPEX / CAPEX", key: "rm_pv", label: "PV maintenance reserve", value: options.siteInput.rmPv, unit: "€/kWp/yr", format: "currency" },
    { section: "OPEX / CAPEX", key: "decom_pv", label: "PV decommissioning", value: options.siteInput.decomPv, unit: "€/kWp/yr", format: "currency" },
    { section: "OPEX / CAPEX", key: "om_bess", label: "BESS O&M", value: options.siteInput.omBess, unit: "€/kW/yr", format: "currency" },
    { section: "OPEX / CAPEX", key: "ins_bess", label: "BESS insurance", value: options.siteInput.insBess, unit: "€/kW/yr", format: "currency" },
    { section: "OPEX / CAPEX", key: "am_bess", label: "BESS asset management", value: options.siteInput.amBess, unit: "€/kW/yr", format: "currency" },
    { section: "OPEX / CAPEX", key: "rm_bess", label: "BESS maintenance reserve", value: options.siteInput.rmBess, unit: "€/kW/yr", format: "currency" },
    { section: "OPEX / CAPEX", key: "bess_degradation", label: "BESS degradation", value: options.siteInput.bessDegradation, unit: "%/yr", format: "percent" },
    { section: "OPEX / CAPEX", key: "bess_min_soh", label: "BESS minimum SoH", value: options.siteInput.bessMinSoH, unit: "%", format: "percent" },
    { section: "OPEX / CAPEX", key: "bess_cycles_day", label: "BESS cycles per day", value: options.siteInput.bessCyclesPerDay, unit: "cyc/day", format: "number" },
    { section: "OPEX / CAPEX", key: "bess_efficiency", label: "BESS round-trip efficiency", value: options.siteInput.bessEffDCAC, unit: "%", format: "percent" },
    { section: "OPEX / CAPEX", key: "rent", label: "Rent", value: options.siteInput.rentEuros, unit: "€/yr", format: "currency" },
    { section: "OPEX / CAPEX", key: "lease_deposit", label: "Lease deposit", value: options.siteInput.leaseDepositEuros, unit: "€", format: "currency" },
    { section: "Financing", key: "opex_inflation", label: "OPEX inflation", value: options.projectParams.opexInflation, unit: "%/yr", format: "percent" },
    { section: "Financing", key: "insurance_inflation", label: "Insurance inflation", value: options.projectParams.insuranceInflation, unit: "%/yr", format: "percent" },
    { section: "Financing", key: "rent_inflation", label: "Rent inflation", value: options.projectParams.rentInflation, unit: "%/yr", format: "percent" },
    { section: "Financing", key: "debt_percent", label: "Debt share", value: options.projectParams.debtPercent, unit: "%", format: "percent" },
    { section: "Financing", key: "senior_rate", label: "Senior rate", value: options.projectParams.seniorRate, unit: "%/yr", format: "percent" },
    { section: "Financing", key: "debt_duration", label: "Debt duration", value: options.projectParams.debtDuration, unit: "years", format: "number" },
    { section: "Financing", key: "dsra_months", label: "DSRA months", value: options.projectParams.dsraMonths, unit: "months", format: "number" },
    { section: "Financing", key: "dscr_target", label: "DSCR covenant", value: options.projectParams.dscrTarget, unit: "x", format: "ratio" },
    { section: "Financing", key: "equity_dividend_rate", label: "Equity dividend rate", value: options.projectParams.equityDividendRate, unit: "%", format: "percent" },
    { section: "Financing", key: "cost_of_equity", label: "Cost of equity", value: options.costOfEquity, unit: "%/yr", format: "percent" },
    { section: "Financing", key: "tax_rate", label: "Corporate tax", value: options.projectParams.tax, unit: "%", format: "percent" },
    { section: "Financing", key: "wacc", label: "WACC", value: options.projectParams.wacc, unit: "%/yr", format: "percent" },
    { section: "Financing", key: "target_equity_irr", label: "Target equity IRR", value: options.targetEquityIrr, unit: "%", format: "percent" },
  ];

  const inputMap = new Map<string, string>();
  let inputRow = 6;
  sheet.getCell(`A${inputRow}`).value = "Inputs";
  sheet.getCell(`A${inputRow}`).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getCell(`A${inputRow}`).fill = headingFill;
  sheet.getCell(`B${inputRow}`).fill = headingFill;
  sheet.getCell(`C${inputRow}`).fill = headingFill;
  sheet.getCell(`D${inputRow}`).fill = headingFill;
  inputRow += 1;
  sheet.getRow(inputRow).values = ["Section", "Input", "Value", "Unit"];
  sheet.getRow(inputRow).font = { bold: true, color: { argb: "FF4B6075" } };
  sheet.getRow(inputRow).fill = sectionFill;
  inputRow += 1;

  let lastSection = "";
  for (const item of inputs) {
    const row = inputRow;
    if (item.section !== lastSection) {
      sheet.getCell(`A${row}`).value = item.section;
      sheet.getCell(`A${row}`).font = { bold: true, color: { argb: "FF0F2C46" } };
      sheet.getCell(`A${row}`).fill = accentFill;
      sheet.getCell(`B${row}`).fill = accentFill;
      sheet.getCell(`C${row}`).fill = accentFill;
      sheet.getCell(`D${row}`).fill = accentFill;
      inputRow += 1;
    }
    lastSection = item.section;
    sheet.getCell(`B${inputRow}`).value = item.label;
    sheet.getCell(`C${inputRow}`).value = item.value;
    sheet.getCell(`D${inputRow}`).value = item.unit ?? "";
    inputMap.set(item.key, `C${inputRow}`);
    applyValueFormat(sheet.getCell(`C${inputRow}`), item.format);
    inputRow += 1;
  }

  const debtPercentInputRef = inputMap.get("debt_percent")!;
  const seniorRateInputRef = inputMap.get("senior_rate")!;
  const costOfEquityInputRef = inputMap.get("cost_of_equity")!;
  const taxRateInputRef = inputMap.get("tax_rate")!;
  const waccInputRef = inputMap.get("wacc")!;
  sheet.getCell(waccInputRef).value = {
    formula: `((100-${debtPercentInputRef})/100)*${costOfEquityInputRef}+(${debtPercentInputRef}/100)*${seniorRateInputRef}*(1-${taxRateInputRef}/100)`,
    result: options.projectParams.wacc,
  };
  applyValueFormat(sheet.getCell(waccInputRef), "percent");

  const summaryStart = 6;
  sheet.getCell(`F${summaryStart}`).value = "Summary";
  sheet.getCell(`F${summaryStart}`).font = { bold: true, color: { argb: "FFFFFFFF" } };
  for (const col of ["F", "G", "H", "I"]) {
    sheet.getCell(`${col}${summaryStart}`).fill = headingFill;
  }
  let summaryRow = summaryStart + 1;
  sheet.getRow(summaryRow).values = ["Group", "Metric", "Value", "Unit"];
  sheet.getRow(summaryRow).font = { bold: true, color: { argb: "FF4B6075" } };
  sheet.getRow(summaryRow).fill = sectionFill;
  summaryRow += 1;

  const addSummaryFormula = (group: string, label: string, formula: string, result: number | string | null, unit: string, format: CellFormat) => {
    sheet.getCell(`F${summaryRow}`).value = group;
    sheet.getCell(`G${summaryRow}`).value = label;
    sheet.getCell(`H${summaryRow}`).value = { formula, result: result ?? undefined };
    sheet.getCell(`I${summaryRow}`).value = unit;
    applyValueFormat(sheet.getCell(`H${summaryRow}`), format);
    summaryRow += 1;
  };

  const addSummaryValue = (group: string, label: string, value: number | string | null, unit: string, format: CellFormat) => {
    sheet.getCell(`F${summaryRow}`).value = group;
    sheet.getCell(`G${summaryRow}`).value = label;
    sheet.getCell(`H${summaryRow}`).value = value ?? "—";
    sheet.getCell(`I${summaryRow}`).value = unit;
    if (typeof value === "number") applyValueFormat(sheet.getCell(`H${summaryRow}`), format);
    summaryRow += 1;
  };

  const capexPvRef = inputMap.get("capex_pv_total")!;
  const capexBessRef = inputMap.get("capex_bess_total")!;
  const leaseDepositRef = inputMap.get("lease_deposit")!;
  const debtPctRef = debtPercentInputRef;
  const seniorRateRef = seniorRateInputRef;
  const debtDurationRef = inputMap.get("debt_duration")!;
  const waccRef = waccInputRef;
  const pvCapacityRef = inputMap.get("pv_capacity_kwp")!;

  addSummaryFormula("Core KPIs", "Total investment amount", `${capexPvRef}+${capexBessRef}`, options.kpis.totalCapex, "€", "currency");
  const totalCapexSummaryRef = `H${summaryRow - 1}`;
  addSummaryFormula("Core KPIs", "Senior debt", `${totalCapexSummaryRef}*${debtPctRef}/100`, options.kpis.debt, "€", "currency");
  const debtSummaryRef = `H${summaryRow - 1}`;
  addSummaryFormula("Core KPIs", "Equity", `${totalCapexSummaryRef}-${debtSummaryRef}`, options.kpis.equity, "€", "currency");
  const equitySummaryRef = `H${summaryRow - 1}`;
  addSummaryFormula("Core KPIs", "Annual debt service (full year)", `IF(${debtSummaryRef}>0,-PMT(${seniorRateRef}/1200,${debtDurationRef}*12,${debtSummaryRef})*12,0)`, options.annual[1]?.debtService ?? options.annual[0]?.debtService ?? 0, "€", "currency");
  const annualDebtServiceRef = `H${summaryRow - 1}`;

  const annualStartRow = Math.max(inputRow + 3, summaryRow + 3);
  const helperStartRow = annualStartRow;

  addSummaryFormula("Core KPIs", "Project IRR", `IFERROR(IRR($AU$${helperStartRow + 1}:$AU$${helperStartRow + 1 + options.annual.length})*100,"")`, options.kpis.projectIRR, "%", "percent");
  addSummaryFormula("Core KPIs", "Equity IRR", `IFERROR(IRR($AV$${helperStartRow + 1}:$AV$${helperStartRow + 1 + options.annual.length})*100,"")`, options.kpis.equityIRR, "%", "percent");
  addSummaryFormula("Core KPIs", "NPV (WACC)", `-(${totalCapexSummaryRef}+${leaseDepositRef})+NPV(${waccRef}/100,$AH$${annualStartRow + 1}:$AH$${annualStartRow + options.annual.length})`, options.kpis.van, "€", "currency");
  addSummaryFormula("Core KPIs", "DSCR min", `IFERROR(MINIFS($AL$${annualStartRow + 1}:$AL$${annualStartRow + options.annual.length},$AK$${annualStartRow + 1}:$AK$${annualStartRow + options.annual.length},\">0\"),"")`, options.kpis.dscrMin, "x", "ratio");
  addSummaryFormula("Core KPIs", "DSCR avg", `IFERROR(AVERAGEIFS($AL$${annualStartRow + 1}:$AL$${annualStartRow + options.annual.length},$AK$${annualStartRow + 1}:$AK$${annualStartRow + options.annual.length},\">0\"),"")`, options.kpis.dscrAvg, "x", "ratio");
  addSummaryFormula("Core KPIs", "CFADS Y1", `$AH$${annualStartRow + 1}`, options.annual[0]?.cfads ?? 0, "€", "currency");

  addSummaryValue("Valuation", "Target equity IRR", options.targetEquityIrr, "%", "percent");
  addSummaryValue("Valuation", "Implied asset value", options.valuation?.assetValue ?? null, "€", "currency");
  addSummaryFormula("Valuation", "Implied price per kWp", `IFERROR(H${summaryRow - 1}/${pvCapacityRef},"")`, options.valuation?.pricePerWp ?? null, "€/kWp", "currency");
  addSummaryValue("Valuation", "Debt at solved value", options.valuation?.debt ?? null, "€", "currency");
  addSummaryValue("Valuation", "Equity at solved value", options.valuation?.equity ?? null, "€", "currency");
  addSummaryValue("Valuation", "Valuation note", "Solved in app against target equity IRR", "", "text");

  const columns = [
    "Year",
    "Year frac",
    "Degrad F",
    "Gross prod (kWh)",
    "Curt. loss (kWh)",
    "Net prod (kWh)",
    "Contr. share",
    "Contr. price (€/MWh)",
    "Merchant price (€/MWh)",
    "PV revenue (€)",
    "Neg. bonus (€)",
    "BESS revenue (€)",
    "Total revenue (€)",
    "PV O&M (€)",
    "PV AM (€)",
    "MRA (€)",
    "Decom. (€)",
    "Insurance (€)",
    "BESS O&M (€)",
    "BESS AM (€)",
    "BESS MRA (€)",
    "BESS Ins. (€)",
    "Rent (€)",
    "Total OPEX (€)",
    "EBITDA (€)",
    "Depreciation (€)",
    "EBIT (€)",
    "Debt opening (€)",
    "Interest (€)",
    "EBT (€)",
    "Tax (€)",
    "Net income (€)",
    "Lease dep. rec. (€)",
    "CFADS (€)",
    "Principal (€)",
    "Debt svc (€)",
    "DSCR",
    "FCF Equity (€)",
    "Eq. div. (€)",
    "Retained (€)",
  ];

  sheet.getCell(`A${annualStartRow - 1}`).value = "Annual P&L Summary";
  sheet.getCell(`A${annualStartRow - 1}`).font = { bold: true, color: { argb: "FFFFFFFF" } };
  for (let c = 1; c <= columns.length; c++) {
    sheet.getCell(`${colLetter(c)}${annualStartRow - 1}`).fill = headingFill;
  }
  columns.forEach((header, index) => {
    const cell = sheet.getCell(cellRef(index + 1, annualStartRow));
    cell.value = header;
    cell.font = { bold: true, color: { argb: "FF4B6075" } };
    cell.fill = sectionFill;
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });

  const makeFormula = (row: number, formula: string, result: number | null) => ({ formula, result: result ?? undefined });
  const acqRef = inputMap.get("acquisition_date")!;
  const lifetimeRef = inputMap.get("project_lifetime")!;
  const yieldBasisRef = inputMap.get("yield_basis")!;
  const p50Ref = inputMap.get("p50_yield")!;
  const p90Ref = inputMap.get("p90_yield")!;
  const curtailmentRef = inputMap.get("curtailment_rate")!;
  const pvDegradationRef = inputMap.get("pv_degradation")!;
  const contractPriceRef = inputMap.get("contract_price")!;
  const contractPriceEscRef = inputMap.get("contract_price_escalation")!;
  const contractDurationRef = inputMap.get("contract_duration_years")!;
  const merchantPriceRef = inputMap.get("merchant_price")!;
  const merchantEscRef = inputMap.get("merchant_escalation")!;
  const negativeBonusRef = inputMap.get("negative_bonus_factor")!;
  const hasPvRef = inputMap.get("has_pv")!;
  const hasBessRef = inputMap.get("has_bess")!;
  const bessCapRef = inputMap.get("bess_capacity_kwh")!;
  const bessPowRef = inputMap.get("bess_power_kw")!;
  const bessDegRef = inputMap.get("bess_degradation")!;
  const bessMinSohRef = inputMap.get("bess_min_soh")!;
  const bessCyclesRef = inputMap.get("bess_cycles_day")!;
  const bessEffRef = inputMap.get("bess_efficiency")!;
  const bessSpreadRef = inputMap.get("bess_spread_price")!;
  const omPvRef = inputMap.get("om_pv")!;
  const amPvRef = inputMap.get("am_pv")!;
  const rmPvRef = inputMap.get("rm_pv")!;
  const decomPvRef = inputMap.get("decom_pv")!;
  const insPvRef = inputMap.get("ins_pv")!;
  const omBessRef = inputMap.get("om_bess")!;
  const amBessRef = inputMap.get("am_bess")!;
  const rmBessRef = inputMap.get("rm_bess")!;
  const insBessRef = inputMap.get("ins_bess")!;
  const rentRef = inputMap.get("rent")!;
  const opexInflRef = inputMap.get("opex_inflation")!;
  const insInflRef = inputMap.get("insurance_inflation")!;
  const rentInflRef = inputMap.get("rent_inflation")!;
  const taxRef = taxRateInputRef;
  const debtDurationInputRef = inputMap.get("debt_duration")!;
  const equityDividendRateRef = inputMap.get("equity_dividend_rate")!;

  for (let i = 0; i < options.annual.length; i++) {
    const rowIndex = annualStartRow + 1 + i;
    const previousRow = rowIndex - 1;
    const annual = options.annual[i];

    sheet.getCell(`A${rowIndex}`).value = annual.year;
    sheet.getCell(`B${rowIndex}`).value = makeFormula(rowIndex, `IF(A${rowIndex}=1,MAX(0,MIN(1,(DATE(YEAR(${acqRef}),12,31)-${acqRef}+1)/(DATE(YEAR(${acqRef}),12,31)-DATE(YEAR(${acqRef}),1,1)+1))),1)`, annual.year === 1 ? annual.grossProduction / (options.siteInput.pvCapacity * (options.siteInput.revenueYieldBasis === "p50" ? options.siteInput.pvProdP50 : options.siteInput.pvProdP90)) : 1);
    sheet.getCell(`C${rowIndex}`).value = makeFormula(rowIndex, `POWER(1-${pvDegradationRef}/100,A${rowIndex}-1)`, Math.pow(1 - options.siteInput.pvDegradation / 100, annual.year - 1));
    sheet.getCell(`D${rowIndex}`).value = makeFormula(rowIndex, `${pvCapacityRef}*IF(${yieldBasisRef}="P50",${p50Ref},${p90Ref})*C${rowIndex}*B${rowIndex}`, annual.grossProduction);
    sheet.getCell(`E${rowIndex}`).value = makeFormula(rowIndex, `D${rowIndex}*${curtailmentRef}/100`, annual.curtailmentLoss);
    sheet.getCell(`F${rowIndex}`).value = makeFormula(rowIndex, `MAX(0,D${rowIndex}-E${rowIndex})`, annual.production);
    sheet.getCell(`G${rowIndex}`).value = makeFormula(rowIndex, `IF(A${rowIndex}<=MAX(0,INT(${contractDurationRef})),1,0)`, annual.contractedShare);
    sheet.getCell(`H${rowIndex}`).value = makeFormula(rowIndex, `${contractPriceRef}*POWER(1+${contractPriceEscRef}/100,A${rowIndex}-1)`, annual.contractedPrice);
    sheet.getCell(`I${rowIndex}`).value = makeFormula(rowIndex, `${merchantPriceRef}*POWER(1+${merchantEscRef}/100,A${rowIndex}-1)`, annual.merchantPrice);
    sheet.getCell(`J${rowIndex}`).value = makeFormula(rowIndex, `IF(${hasPvRef}=1,F${rowIndex}*IF(G${rowIndex}=1,H${rowIndex},I${rowIndex})/1000,0)`, annual.pvRevenue);
    sheet.getCell(`K${rowIndex}`).value = makeFormula(rowIndex, `IF(${hasPvRef}=1,MAX(0,${negativeBonusRef})/100*H${rowIndex}*E${rowIndex}/1000,0)`, annual.negativePriceBonusRevenue);
    sheet.getCell(`L${rowIndex}`).value = makeFormula(rowIndex, `IF(${hasBessRef}=1,${bessCapRef}*MAX(${bessMinSohRef}/100,POWER(1-${bessDegRef}/100,A${rowIndex}-1))*(${bessEffRef}/100)*${bessCyclesRef}*365*B${rowIndex}*${bessSpreadRef}*POWER(1+${merchantEscRef}/100,A${rowIndex}-1)/1000,0)`, annual.bessRevenue);
    sheet.getCell(`M${rowIndex}`).value = makeFormula(rowIndex, `J${rowIndex}+K${rowIndex}+L${rowIndex}`, annual.totalRevenue);
    sheet.getCell(`N${rowIndex}`).value = makeFormula(rowIndex, `${omPvRef}*${pvCapacityRef}*POWER(1+${opexInflRef}/100,A${rowIndex}-1)*B${rowIndex}`, annual.pvOmCost);
    sheet.getCell(`O${rowIndex}`).value = makeFormula(rowIndex, `${amPvRef}*${pvCapacityRef}*POWER(1+${opexInflRef}/100,A${rowIndex}-1)*B${rowIndex}`, annual.pvAmCost);
    sheet.getCell(`P${rowIndex}`).value = makeFormula(rowIndex, `((${rmPvRef}*${pvCapacityRef})+(${rmBessRef}*${bessPowRef}))*POWER(1+${opexInflRef}/100,A${rowIndex}-1)*B${rowIndex}`, annual.mraExpense);
    sheet.getCell(`Q${rowIndex}`).value = makeFormula(rowIndex, `${decomPvRef}*${pvCapacityRef}*POWER(1+${opexInflRef}/100,A${rowIndex}-1)*B${rowIndex}`, annual.decomExpense);
    sheet.getCell(`R${rowIndex}`).value = makeFormula(rowIndex, `((${insPvRef}*${pvCapacityRef})+(${insBessRef}*${bessPowRef}))*POWER(1+${insInflRef}/100,A${rowIndex}-1)*B${rowIndex}`, annual.pvInsurance + annual.bessInsurance);
    sheet.getCell(`S${rowIndex}`).value = makeFormula(rowIndex, `${omBessRef}*${bessPowRef}*POWER(1+${opexInflRef}/100,A${rowIndex}-1)*B${rowIndex}`, annual.bessOmCost);
    sheet.getCell(`T${rowIndex}`).value = makeFormula(rowIndex, `${amBessRef}*${bessPowRef}*POWER(1+${opexInflRef}/100,A${rowIndex}-1)*B${rowIndex}`, annual.bessAmCost);
    sheet.getCell(`U${rowIndex}`).value = makeFormula(rowIndex, `${rmBessRef}*${bessPowRef}*POWER(1+${opexInflRef}/100,A${rowIndex}-1)*B${rowIndex}`, annual.bessMraExpense);
    sheet.getCell(`V${rowIndex}`).value = makeFormula(rowIndex, `${insBessRef}*${bessPowRef}*POWER(1+${insInflRef}/100,A${rowIndex}-1)*B${rowIndex}`, annual.bessInsurance);
    sheet.getCell(`W${rowIndex}`).value = makeFormula(rowIndex, `${rentRef}*POWER(1+${rentInflRef}/100,A${rowIndex}-1)*B${rowIndex}`, annual.rent);
    sheet.getCell(`X${rowIndex}`).value = makeFormula(rowIndex, `N${rowIndex}+O${rowIndex}+R${rowIndex}+S${rowIndex}+T${rowIndex}+V${rowIndex}+W${rowIndex}`, annual.totalOpex);
    sheet.getCell(`Y${rowIndex}`).value = makeFormula(rowIndex, `M${rowIndex}-X${rowIndex}`, annual.ebitda);
    sheet.getCell(`Z${rowIndex}`).value = makeFormula(rowIndex, `IF(${lifetimeRef}<=1,${totalCapexSummaryRef},IF(A${rowIndex}=1,${totalCapexSummaryRef}/${lifetimeRef}*B${rowIndex},IF(A${rowIndex}=${lifetimeRef},${totalCapexSummaryRef}/${lifetimeRef}*(2-B${annualStartRow + 1}),${totalCapexSummaryRef}/${lifetimeRef})))`, annual.depreciation);
    sheet.getCell(`AA${rowIndex}`).value = makeFormula(rowIndex, `Y${rowIndex}-Z${rowIndex}-P${rowIndex}-Q${rowIndex}`, annual.ebit);
    sheet.getCell(`AB${rowIndex}`).value = makeFormula(rowIndex, `IF(A${rowIndex}=1,${debtSummaryRef},AB${previousRow}-AI${previousRow})`, annual.debtRemaining);
    sheet.getCell(`AC${rowIndex}`).value = makeFormula(rowIndex, `IF(A${rowIndex}<=${debtDurationInputRef},AB${rowIndex}*${seniorRateRef}/100*B${rowIndex},0)`, annual.financialCharge);
    sheet.getCell(`AD${rowIndex}`).value = makeFormula(rowIndex, `AA${rowIndex}-AC${rowIndex}`, annual.ebt);
    sheet.getCell(`AE${rowIndex}`).value = makeFormula(rowIndex, `MAX(0,AD${rowIndex})*${taxRef}/100`, annual.taxAmount);
    sheet.getCell(`AF${rowIndex}`).value = makeFormula(rowIndex, `AD${rowIndex}-AE${rowIndex}`, annual.netIncome);
    sheet.getCell(`AG${rowIndex}`).value = makeFormula(rowIndex, `IF(A${rowIndex}=${lifetimeRef},${leaseDepositRef},0)`, annual.year === options.siteInput.pvLifetime ? options.siteInput.leaseDepositEuros : 0);
    sheet.getCell(`AH${rowIndex}`).value = makeFormula(rowIndex, `Y${rowIndex}-AE${rowIndex}+AG${rowIndex}`, annual.cfads);
    sheet.getCell(`AI${rowIndex}`).value = makeFormula(rowIndex, `IF(A${rowIndex}<=${debtDurationInputRef},MIN(MAX(${annualDebtServiceRef}*B${rowIndex}-AC${rowIndex},0),AB${rowIndex}),0)`, annual.principalRepayment);
    sheet.getCell(`AJ${rowIndex}`).value = makeFormula(rowIndex, `IF(A${rowIndex}<=${debtDurationInputRef},${annualDebtServiceRef}*B${rowIndex},0)`, annual.debtService);
    sheet.getCell(`AK${rowIndex}`).value = makeFormula(rowIndex, `IF(AND(A${rowIndex}<=${debtDurationInputRef},AJ${rowIndex}>0),AH${rowIndex}/AJ${rowIndex},"")`, annual.dscr);
    sheet.getCell(`AL${rowIndex}`).value = makeFormula(rowIndex, `AH${rowIndex}-AJ${rowIndex}`, annual.fcfEquity);
    sheet.getCell(`AM${rowIndex}`).value = makeFormula(rowIndex, `MAX(0,AL${rowIndex})*${equityDividendRateRef}/100`, annual.equityDividends);
    sheet.getCell(`AN${rowIndex}`).value = makeFormula(rowIndex, `AL${rowIndex}-AM${rowIndex}`, annual.retainedCash);

    for (const col of ["B", "C", "G", "K"]) applyValueFormat(sheet.getCell(`${col}${rowIndex}`), col === "G" ? "number" : col === "K" ? "currency" : "number");
    for (const col of ["D", "E", "F", "J", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "AA", "AB", "AC", "AD", "AE", "AF", "AG", "AH", "AI", "AJ", "AL", "AM", "AN"]) {
      applyValueFormat(sheet.getCell(`${col}${rowIndex}`), "currency");
    }
    applyValueFormat(sheet.getCell(`H${rowIndex}`), "currency");
    applyValueFormat(sheet.getCell(`I${rowIndex}`), "currency");
    applyValueFormat(sheet.getCell(`AK${rowIndex}`), "ratio");
  }

  const totalRow = annualStartRow + 1 + options.annual.length;
  sheet.getCell(`A${totalRow}`).value = "Total";
  sheet.getCell(`A${totalRow}`).font = { bold: true, color: { argb: "FF0F2C46" } };
  for (let c = 1; c <= columns.length; c++) {
    const cell = sheet.getCell(cellRef(c, totalRow));
    cell.fill = accentFill;
    if ([4, 5, 6, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 29, 31, 32, 33, 34, 35, 36, 38, 39, 40].includes(c)) {
      cell.value = { formula: `SUM(${cellRef(c, annualStartRow + 1)}:${cellRef(c, totalRow - 1)})` };
    }
  }
  sheet.getCell(`B${totalRow}`).value = { formula: `SUM(B${annualStartRow + 1}:B${totalRow - 1})` };
  sheet.getCell(`AK${totalRow}`).value = { formula: `IFERROR(AVERAGEIFS(AK${annualStartRow + 1}:AK${totalRow - 1},AJ${annualStartRow + 1}:AJ${totalRow - 1},\">0\"),"")`, result: options.kpis.dscrAvg ?? undefined };
  applyValueFormat(sheet.getCell(`B${totalRow}`), "number");
  for (const col of ["D", "E", "F", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "AC", "AE", "AF", "AG", "AH", "AI", "AJ", "AL", "AM", "AN"]) {
    applyValueFormat(sheet.getCell(`${col}${totalRow}`), "currency");
  }
  applyValueFormat(sheet.getCell(`AK${totalRow}`), "ratio");

  sheet.getCell(`AU${helperStartRow}`).value = "Project CF";
  sheet.getCell(`AV${helperStartRow}`).value = "Equity CF";
  sheet.getCell(`AU${helperStartRow + 1}`).value = { formula: `-(${totalCapexSummaryRef}+${leaseDepositRef})`, result: -(options.kpis.totalCapex + options.siteInput.leaseDepositEuros) };
  sheet.getCell(`AV${helperStartRow + 1}`).value = { formula: `-(${equitySummaryRef}+${leaseDepositRef})`, result: -(options.kpis.equity + options.siteInput.leaseDepositEuros) };
  for (let i = 0; i < options.annual.length; i++) {
    const rowIndex = annualStartRow + 1 + i;
    const helperRow = helperStartRow + 2 + i;
    sheet.getCell(`AU${helperRow}`).value = { formula: `AH${rowIndex}`, result: options.annual[i]?.cfads ?? undefined };
    sheet.getCell(`AV${helperRow}`).value = { formula: `AL${rowIndex}`, result: options.annual[i]?.fcfEquity ?? undefined };
  }
  sheet.getColumn("AU").hidden = true;
  sheet.getColumn("AV").hidden = true;

  for (let col = 1; col <= 40; col++) {
    sheet.getColumn(col).width = col === 2 || col === 7 ? 26 : 14;
  }
  sheet.getColumn("A").width = 16;
  sheet.getColumn("D").width = 12;

  for (let row = annualStartRow + 1; row <= totalRow; row++) {
    for (let col = 1; col <= columns.length; col++) {
      const cell = sheet.getCell(cellRef(col, row));
      cell.border = {
        top: { style: "thin", color: { argb: "FFD8E2EC" } },
        bottom: { style: "thin", color: { argb: "FFD8E2EC" } },
      };
      if (row < totalRow && (row - annualStartRow) % 2 === 0) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFAFCFE" } };
      }
    }
  }

  sheet.autoFilter = {
    from: `A${annualStartRow}`,
    to: `${cellRef(columns.length, totalRow - 1)}`,
  };

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${options.siteName.replace(/\s+/g, "_")}_financial_model_${formatOutputDate(new Date())}.xlsx`;
  anchor.click();
  URL.revokeObjectURL(url);
}
