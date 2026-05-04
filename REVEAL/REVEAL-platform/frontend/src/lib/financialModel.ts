/**
 * Financial model engine
 * 25-year annual P&L, monthly cashflows, IRR / NPV / DSCR KPIs,
 * plus a target-equity-IRR valuation helper.
 */

export interface FinancialParams {
  acquisitionDate: string; // YYYY-MM-DD
  electricityPrice: number; // merchant / post-contract price in €/MWh
  electricityEscalation: number; // merchant price escalation %/yr
  contractPrice: number; // contracted / offtake price in €/MWh
  contractPriceEscalation: number; // %/yr
  contractDurationYears: number; // years
  curtailmentRate: number; // % of gross production
  bessSpreadPrice: number; // €/MWh
  inflation: number; // %/yr
  opexInflation: number; // %/yr
  insuranceInflation: number; // %/yr
  rentInflation: number; // %/yr
  equityDividendRate: number; // % of distributable cash
  tax: number; // %
  wacc: number; // %
  debtPercent: number; // % of asset value financed by debt
  seniorRate: number; // %/yr
  debtDuration: number; // years
  dsraMonths: number; // months
  dscrTarget: number; // minimum DSCR covenant
  negativePriceBonusFactorPct: number; // user-defined factor applied instead of the default 0.5
}

export const FINANCIAL_DEFAULTS: FinancialParams = {
  acquisitionDate: "2026-01-01",
  electricityPrice: 85,
  electricityEscalation: 1.5,
  contractPrice: 85,
  contractPriceEscalation: 0,
  contractDurationYears: 20,
  curtailmentRate: 0,
  bessSpreadPrice: 30,
  inflation: 2.0,
  opexInflation: 2.0,
  insuranceInflation: 2.0,
  rentInflation: 2.0,
  equityDividendRate: 100,
  tax: 25.0,
  wacc: 8.0,
  debtPercent: 70,
  seniorRate: 4.5,
  debtDuration: 18,
  dsraMonths: 6,
  dscrTarget: 1.15,
  negativePriceBonusFactorPct: 50,
};

const MONTHLY_FACTORS = [
  0.67, 0.8, 1.04, 1.11, 1.19, 1.26,
  1.28, 1.24, 1.14, 0.92, 0.71, 0.64,
];

export interface SiteFinancialInput {
  hasPV: boolean;
  pvCapacity: number; // kWc
  acCapacity: number; // kW AC / Pmax basis
  revenueYieldBasis: "p50" | "p90";
  pvProdP50: number; // kWh/kWc/yr
  pvProdP90: number; // kWh/kWc/yr
  pvDegradation: number; // %/yr
  pvLifetime: number; // years
  capexPv: number; // € total
  omPv: number; // €/kWc/yr
  insPv: number; // €/kWc/yr
  amPv: number; // €/kWc/yr
  rmPv: number; // €/kWc/yr
  decomPv: number; // €/kWc/yr
  hasBESS: boolean;
  bessPower: number; // kW
  bessCapacity: number; // kWh
  bessDegradation: number; // %/yr
  bessMinSoH: number; // %
  bessCyclesPerDay: number;
  bessEffDCAC: number; // %
  capexBess: number; // € total
  omBess: number; // €/kW/yr
  insBess: number; // €/kW/yr
  amBess: number; // €/kW/yr
  rmBess: number; // €/kW/yr
  rentEuros: number; // €/yr
  leaseDepositEuros: number; // upfront recoverable lease deposit
}

export interface AnnualRow {
  year: number;
  grossProduction: number;
  curtailmentLoss: number;
  production: number;
  contractedShare: number;
  contractedPrice: number;
  merchantPrice: number;
  pvRevenue: number;
  negativePriceBonusRevenue: number;
  bessRevenue: number;
  totalRevenue: number;
  pvOmCost: number;
  pvAmCost: number;
  mraExpense: number;
  decomExpense: number;
  pvInsurance: number;
  bessOmCost: number;
  bessAmCost: number;
  bessMraExpense: number;
  bessInsurance: number;
  rent: number;
  totalOpex: number;
  ebitda: number;
  depreciation: number;
  ebit: number;
  financialCharge: number;
  ebt: number;
  taxAmount: number;
  netIncome: number;
  cfads: number;
  principalRepayment: number;
  debtService: number;
  dscr: number | null;
  fcfProject: number;
  equityDividends: number;
  retainedCash: number;
  fcfEquity: number;
  debtRemaining: number;
}

export interface MonthlyRow {
  year: number;
  month: number;
  period: number;
  production: number;
  pvRevenue: number;
  negativePriceBonusRevenue: number;
  bessRevenue: number;
  revenue: number;
  opex: number;
  ebitda: number;
  interest: number;
  tax: number;
  cfads: number;
  debtSvc: number;
  dscr: number | null;
  fcf: number;
}

export interface FinancialKPIs {
  totalCapex: number;
  debt: number;
  equity: number;
  debtPercent: number;
  lifetime: number;
  projectIRR: number;
  equityIRR: number;
  van: number;
  dscrMin: number | null;
  dscrAvg: number | null;
  annualRevY1: number;
  annualOpexY1: number;
  ebitdaY1: number;
}

export interface FinancialResult {
  monthly: MonthlyRow[];
  annual: AnnualRow[];
  kpis: FinancialKPIs;
  _params: FinancialParams;
}

export interface ValuationResult {
  assetValue: number;
  pricePerWp: number | null;
  debt: number;
  equity: number;
  projectIRR: number;
  equityIRR: number;
}

function npvCalc(rate: number, cfs: number[]): number {
  let result = 0;
  for (let i = 0; i < cfs.length; i++) result += cfs[i] / Math.pow(1 + rate, i + 1);
  return result;
}

function _npvFull(cfs: number[], r: number): number {
  let val = 0;
  for (let i = 0; i < cfs.length; i++) val += cfs[i] / Math.pow(1 + r, i);
  return val;
}

function _dnpvFull(cfs: number[], r: number): number {
  let val = 0;
  for (let i = 1; i < cfs.length; i++) val -= i * cfs[i] / Math.pow(1 + r, i + 1);
  return val;
}

export function calcIrr(cfs: number[], guess = 0.1): number {
  if (!cfs || cfs.length < 2) return NaN;
  let hasPos = false;
  let hasNeg = false;
  for (const c of cfs) {
    if (c > 0) hasPos = true;
    if (c < 0) hasNeg = true;
  }
  if (!hasPos || !hasNeg) return NaN;

  const maxIter = 200;
  const tol = 1e-9;
  let r = isFinite(guess) ? guess : 0.1;
  for (let i = 0; i < maxIter; i++) {
    const f = _npvFull(cfs, r);
    const df = _dnpvFull(cfs, r);
    if (Math.abs(df) < 1e-15) break;
    const next = r - f / df;
    if (next < -0.9999) {
      r = (r - 0.9999) / 2;
      continue;
    }
    if (Math.abs(next - r) < tol) return next;
    r = next;
  }

  let lo = -0.9999;
  let hi = 10;
  if (_npvFull(cfs, lo) * _npvFull(cfs, hi) > 0) {
    let prev = _npvFull(cfs, 0);
    for (let rx = 0.01; rx <= 5; rx += 0.01) {
      const cur = _npvFull(cfs, rx);
      if (prev * cur <= 0) {
        lo = rx - 0.01;
        hi = rx;
        break;
      }
      prev = cur;
    }
    if (_npvFull(cfs, lo) * _npvFull(cfs, hi) > 0) return NaN;
  }

  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const fMid = _npvFull(cfs, mid);
    if (Math.abs(fMid) < tol || (hi - lo) / 2 < tol) return mid;
    if (_npvFull(cfs, lo) * fMid < 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

function pmtCalc(rate: number, nper: number, pv: number): number {
  if (rate === 0) return pv / nper;
  return (pv * rate * Math.pow(1 + rate, nper)) / (Math.pow(1 + rate, nper) - 1);
}

function getFirstYearFraction(acquisitionDate: string | undefined): number {
  if (!acquisitionDate) return 1;
  const parsed = new Date(`${acquisitionDate}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return 1;
  const year = parsed.getFullYear();
  const startOfYear = new Date(year, 0, 1);
  const startOfNextYear = new Date(year + 1, 0, 1);
  const totalMs = startOfNextYear.getTime() - startOfYear.getTime();
  const remainingMs = startOfNextYear.getTime() - parsed.getTime();
  if (totalMs <= 0) return 1;
  return Math.min(1, Math.max(0, remainingMs / totalMs));
}

export function formatEur(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !isFinite(amount)) return "—";
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "−" : "";
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + " Md€";
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + " M€";
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + " k€";
  return sign + abs.toFixed(0) + " €";
}

export function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !isFinite(value)) return "—";
  return value.toFixed(2) + " %";
}

function computeInternal(
  site: SiteFinancialInput,
  projectParams: Partial<FinancialParams> = {},
  assetValueOverride?: number,
): FinancialResult {
  const p: FinancialParams = { ...FINANCIAL_DEFAULTS, ...projectParams };

  const pvCap = site.hasPV ? site.pvCapacity || 0 : 0;
  const pvProd = site.hasPV ? (site.revenueYieldBasis === "p50" ? site.pvProdP50 || 0 : site.pvProdP90 || 0) : 0;
  const pvDeg = site.hasPV ? site.pvDegradation || 0 : 0;
  const lifetime = site.pvLifetime || 25;

  const bessPow = site.hasBESS ? site.bessPower || 0 : 0;
  const bessCap = site.hasBESS ? site.bessCapacity || 0 : 0;
  const bessDeg = site.hasBESS ? site.bessDegradation || 0 : 0;
  const bessMinSoH = site.hasBESS ? site.bessMinSoH || 70 : 70;
  const bessCpD = site.hasBESS ? site.bessCyclesPerDay || 1 : 1;
  const bessEff = site.hasBESS ? site.bessEffDCAC || 95 : 95;

  const capexPv = site.hasPV ? site.capexPv || 0 : 0;
  const capexBess = site.hasBESS ? site.capexBess || 0 : 0;
  const baseAssetValue = capexPv + capexBess;
  const totalCapex = assetValueOverride ?? baseAssetValue;
  const leaseDeposit = Math.max(0, site.leaseDepositEuros || 0);

  const debtFrac = p.debtPercent / 100;
  const debt = totalCapex * debtFrac;
  const equity = totalCapex * (1 - debtFrac);

  const monthlyRate = p.seniorRate / 100 / 12;
  const nMonths = p.debtDuration * 12;
  const monthlyPmt = debt > 0 ? pmtCalc(monthlyRate, nMonths, debt) : 0;
  const annualPmt = monthlyPmt * 12;
  const depreciation = lifetime > 0 ? totalCapex / lifetime : 0;
  const firstYearFraction = getFirstYearFraction(p.acquisitionDate);
  const negativePriceBonusFactor = Math.max(0, p.negativePriceBonusFactorPct || 0) / 100;

  const annual: AnnualRow[] = [];
  const monthly: MonthlyRow[] = [];
  let debtRemaining = debt;

  for (let y = 1; y <= lifetime; y++) {
    const yearFraction = y === 1 ? firstYearFraction : 1;
    const degradF = Math.pow(1 - pvDeg / 100, y - 1);
    const grossProduction = pvCap * pvProd * degradF * yearFraction;
    const curtailmentLoss = grossProduction * (p.curtailmentRate / 100);
    const annualProd = Math.max(0, grossProduction - curtailmentLoss);

    const sohFactor = Math.max(bessMinSoH / 100, Math.pow(1 - bessDeg / 100, y - 1));
    const bessDischarge = site.hasBESS
      ? bessCap * sohFactor * (bessEff / 100) * bessCpD * 365 * yearFraction
      : 0;

    const contractEscF = Math.pow(1 + p.contractPriceEscalation / 100, y - 1);
    const merchantEscF = Math.pow(1 + p.electricityEscalation / 100, y - 1);
    const contractedPrice = p.contractPrice * contractEscF;
    const merchantPrice = p.electricityPrice * merchantEscF;
    const contractedShare = y <= Math.max(0, Math.floor(p.contractDurationYears)) ? 1 : 0;
    const pvRevenue = site.hasPV
      ? annualProd * ((contractedShare ? contractedPrice : merchantPrice) / 1000)
      : 0;
    const negativePriceBonusRevenue = site.hasPV
      ? negativePriceBonusFactor * contractedPrice * (curtailmentLoss / 1000)
      : 0;
    const bessRevenue = site.hasBESS
      ? (bessDischarge * p.bessSpreadPrice * merchantEscF) / 1000
      : 0;
    const totalRevenue = pvRevenue + negativePriceBonusRevenue + bessRevenue;

    const opexInflF = Math.pow(1 + p.opexInflation / 100, y - 1);
    const insuranceInflF = Math.pow(1 + p.insuranceInflation / 100, y - 1);
    const rentInflF = Math.pow(1 + p.rentInflation / 100, y - 1);

    const pvOmCost = (site.omPv * pvCap) * opexInflF * yearFraction;
    const pvAmCost = (site.amPv * pvCap) * opexInflF * yearFraction;
    const pvReserveCost = (site.rmPv * pvCap) * opexInflF * yearFraction;
    const pvDecomCost = (site.decomPv * pvCap) * opexInflF * yearFraction;
    const pvInsurance = (site.insPv * pvCap) * insuranceInflF * yearFraction;
    const bessOmCost = (site.omBess * bessPow) * opexInflF * yearFraction;
    const bessAmCost = (site.amBess * bessPow) * opexInflF * yearFraction;
    const bessReserveCost = (site.rmBess * bessPow) * opexInflF * yearFraction;
    const bessInsurance = (site.insBess * bessPow) * insuranceInflF * yearFraction;
    const rent = site.rentEuros * rentInflF * yearFraction;
    const totalOpex =
      pvOmCost +
      pvAmCost +
      pvInsurance +
      bessOmCost +
      bessAmCost +
      bessInsurance +
      rent;
    const totalNonCashProjectCharges = pvReserveCost + pvDecomCost + bessReserveCost;

    const ebitda = totalRevenue - totalOpex;
    const depreciationY =
      lifetime <= 1
        ? totalCapex
        : y === 1
          ? depreciation * firstYearFraction
          : y === lifetime
            ? depreciation * (2 - firstYearFraction)
            : depreciation;
    const ebit = ebitda - depreciationY - totalNonCashProjectCharges;

    const inDebt = y <= p.debtDuration && debt > 0;
    const interest = inDebt ? debtRemaining * (p.seniorRate / 100) * yearFraction : 0;
    const debtServiceY = inDebt ? annualPmt * yearFraction : 0;
    const principal = inDebt ? Math.min(Math.max(debtServiceY - interest, 0), debtRemaining) : 0;

    const ebt = ebit - interest;
    const taxAmount = Math.max(0, ebt) * (p.tax / 100);
    const cfadsBase = ebitda - taxAmount;
    const leaseDepositRecovery = y === lifetime ? leaseDeposit : 0;
    const cfads = cfadsBase + leaseDepositRecovery;
    const dscr = inDebt && debtServiceY > 0 ? cfads / debtServiceY : null;
    const fcfBeforeDividend = cfads - debtServiceY;
    const equityDividends = Math.max(0, fcfBeforeDividend) * (p.equityDividendRate / 100);
    const retainedCash = fcfBeforeDividend - equityDividends;

    const snap = debtRemaining;
    debtRemaining = Math.max(0, debtRemaining - principal);

    annual.push({
      year: y,
      grossProduction,
      curtailmentLoss,
      production: annualProd,
      contractedShare,
      contractedPrice,
      merchantPrice,
      pvRevenue,
      negativePriceBonusRevenue,
      bessRevenue,
      totalRevenue,
      pvOmCost,
      pvAmCost,
      mraExpense: pvReserveCost + bessReserveCost,
      decomExpense: pvDecomCost,
      pvInsurance,
      bessOmCost,
      bessAmCost,
      bessMraExpense: bessReserveCost,
      bessInsurance,
      rent,
      totalOpex,
      ebitda,
      depreciation: depreciationY,
      ebit,
      financialCharge: interest,
      ebt,
      taxAmount,
      netIncome: ebt - taxAmount,
      cfads,
      principalRepayment: principal,
      debtService: debtServiceY,
      dscr,
      fcfProject: cfads,
      equityDividends,
      retainedCash,
      fcfEquity: fcfBeforeDividend,
      debtRemaining: snap,
    });

    for (let m = 0; m < 12; m++) {
      const mf = MONTHLY_FACTORS[m];
      const mRevenue = (pvRevenue * mf) / 12 + (negativePriceBonusRevenue / 12) + bessRevenue / 12;
      const mOpex = totalOpex / 12;
      const mEbitda = mRevenue - mOpex;
      const mTax = taxAmount / 12;
      const mCfads = mEbitda - mTax + (y === lifetime && m === 11 ? leaseDepositRecovery : 0);
      const mDebt = inDebt ? monthlyPmt : 0;
      monthly.push({
        year: y,
        month: m + 1,
        period: (y - 1) * 12 + m + 1,
        production: (annualProd * mf) / 12,
        pvRevenue: (pvRevenue * mf) / 12,
        negativePriceBonusRevenue: negativePriceBonusRevenue / 12,
        bessRevenue: bessRevenue / 12,
        revenue: mRevenue,
        opex: mOpex,
        ebitda: mEbitda,
        interest: interest / 12,
        tax: mTax,
        cfads: mCfads,
        debtSvc: mDebt,
        dscr: mDebt > 0 ? mCfads / mDebt : null,
        fcf: mCfads - mDebt,
      });
    }
  }

  const projectCFs = [-(totalCapex + leaseDeposit), ...annual.map((a) => a.fcfProject)];
  const equityCFs = [-(equity + leaseDeposit), ...annual.map((a) => a.fcfEquity)];
  const projectIrr = calcIrr(projectCFs, 0.08);
  const equityIrr = calcIrr(equityCFs, 0.1);
  const van = -(totalCapex + leaseDeposit) + npvCalc(p.wacc / 100, annual.map((a) => a.fcfProject));

  const dscrVals = annual.filter((a) => a.dscr !== null).map((a) => a.dscr as number);
  const dscrMin = dscrVals.length ? Math.min(...dscrVals) : null;
  const dscrAvg = dscrVals.length ? dscrVals.reduce((s, v) => s + v, 0) / dscrVals.length : null;

  return {
    monthly,
    annual,
    kpis: {
      totalCapex,
      debt,
      equity,
      debtPercent: p.debtPercent,
      lifetime,
      projectIRR: isFinite(projectIrr) ? projectIrr * 100 : NaN,
      equityIRR: isFinite(equityIrr) ? equityIrr * 100 : NaN,
      van,
      dscrMin,
      dscrAvg,
      annualRevY1: annual[0]?.totalRevenue ?? 0,
      annualOpexY1: annual[0]?.totalOpex ?? 0,
      ebitdaY1: annual[0]?.ebitda ?? 0,
    },
    _params: p,
  };
}

export function compute(
  site: SiteFinancialInput,
  projectParams: Partial<FinancialParams> = {},
): FinancialResult {
  return computeInternal(site, projectParams);
}

export function solveAssetValueForTargetEquityIrr(
  site: SiteFinancialInput,
  projectParams: Partial<FinancialParams>,
  targetEquityIrrPct: number,
): ValuationResult | null {
  const baseAssetValue = (site.capexPv || 0) + (site.capexBess || 0);
  if (!(baseAssetValue > 0) || !(targetEquityIrrPct > -99)) return null;

  const target = targetEquityIrrPct;
  const lowResult = computeInternal(site, projectParams, Math.max(1, baseAssetValue * 0.05));
  if (!isFinite(lowResult.kpis.equityIRR)) return null;

  let low = Math.max(1, baseAssetValue * 0.05);
  let high = Math.max(baseAssetValue * 2, low * 2);
  let highResult = computeInternal(site, projectParams, high);

  let guard = 0;
  while (guard < 30 && isFinite(highResult.kpis.equityIRR) && highResult.kpis.equityIRR > target) {
    low = high;
    high *= 1.5;
    highResult = computeInternal(site, projectParams, high);
    guard += 1;
  }

  if (!isFinite(highResult.kpis.equityIRR)) return null;
  if (lowResult.kpis.equityIRR < target) {
    const pricePerWp = site.pvCapacity > 0 ? low / site.pvCapacity : null;
    return {
      assetValue: low,
      pricePerWp,
      debt: lowResult.kpis.debt,
      equity: lowResult.kpis.equity,
      projectIRR: lowResult.kpis.projectIRR,
      equityIRR: lowResult.kpis.equityIRR,
    };
  }

  let best = highResult;
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    const midResult = computeInternal(site, projectParams, mid);
    if (!isFinite(midResult.kpis.equityIRR)) return null;
    best = midResult;
    if (Math.abs(midResult.kpis.equityIRR - target) < 0.01) {
      low = high = mid;
      break;
    }
    if (midResult.kpis.equityIRR > target) low = mid;
    else high = mid;
  }

  const assetValue = (low + high) / 2;
  return {
    assetValue,
    pricePerWp: site.pvCapacity > 0 ? assetValue / site.pvCapacity : null,
    debt: best.kpis.debt,
    equity: best.kpis.equity,
    projectIRR: best.kpis.projectIRR,
    equityIRR: best.kpis.equityIRR,
  };
}
