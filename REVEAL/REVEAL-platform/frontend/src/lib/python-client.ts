/**
 * Browser-side caller for the Railway Python analysis service.
 *
 * Large SCADA files (often 10–50 MB) exceed Vercel's 4.5 MB serverless-function
 * body limit, so the browser must post them directly to Railway rather than
 * proxying through the Next.js API routes.
 *
 * Set NEXT_PUBLIC_PYTHON_SERVICE_URL in Vercel to the public Railway service URL.
 * If the variable is absent, helpers fall back to the Vercel proxy routes so
 * local development continues to work without Railway access.
 */

import type { AnalysisResult, ColumnDetectionResult } from "@/types/analysis";
import type { ChartingDateRangeResult, ChartingReferenceIrradianceResult, ChartingResult, ChartingSeriesConfig } from "@/types/charting";
import type { Site } from "@/types/site";

const DIRECT_URL = (process.env.NEXT_PUBLIC_PYTHON_SERVICE_URL ?? "").replace(/\/$/, "");

export function canCallDirectly(): boolean {
  return Boolean(DIRECT_URL);
}

// Temporary diagnostic — remove once direct upload is confirmed working
if (typeof window !== "undefined") {
  console.log("[python-client] DIRECT_URL:", DIRECT_URL || "(empty — using Vercel proxy)");
}

async function directPost<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`${DIRECT_URL}${path}`, {
    method: "POST",
    body: form,
    // No Content-Type — browser sets multipart boundary automatically
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Python service ${path} → ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function parseDownloadFilename(contentDisposition: string | null, fallback: string): string {
  if (!contentDisposition) return fallback;
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const basicMatch = contentDisposition.match(/filename="?([^\";]+)"?/i);
  return basicMatch?.[1] ?? fallback;
}

function buildAnalysisSiteConfig(site: Site, siteConfigOverrides: Record<string, unknown>) {
  return {
    ...site,
    solar_module_types: site.solar_module_types?.map((moduleType) => ({ ...moduleType })),
    ...siteConfigOverrides,
  };
}

function shouldFallbackToProxy(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && /failed to fetch/i.test(error.message));
}

async function proxyPost<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    body: form,
    credentials: "same-origin",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export type DirectReportExport = {
  blob: Blob;
  filename: string;
  mediaType: string;
};

/**
 * Detect columns in a SCADA file.
 * - Direct path (large files): browser → Railway /detect-columns
 * - Proxy path (fallback):     browser → Vercel /api/analysis/detect-columns → Railway
 */
export async function detectColumns(
  file: File,
  siteType: string,
  worksheet?: string,
): Promise<ColumnDetectionResult> {
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("site_type", siteType);
  if (worksheet) form.append("worksheet", worksheet);

  if (canCallDirectly()) {
    try {
      return await directPost<ColumnDetectionResult>("/detect-columns", form);
    } catch (error) {
      if (!shouldFallbackToProxy(error)) throw error;
    }
  }

  // Proxy path uses slightly different field names
  const proxyForm = new FormData();
  proxyForm.append("file", file, file.name);
  proxyForm.append("siteType", siteType);
  if (worksheet) proxyForm.append("worksheet", worksheet);
  return proxyPost<ColumnDetectionResult>("/api/analysis/detect-columns", proxyForm);
}

/**
 * Run the full analysis pipeline.
 * - Direct path (large files): browser → Railway /analyse
 * - Proxy path (fallback):     browser → Vercel /api/analysis/run → Railway
 */
export async function runAnalysis(
  files: File[],
  site: Site,
  columnMappings: Record<string, unknown>,
  siteConfigOverrides: Record<string, unknown>,
  lang = "en",
): Promise<AnalysisResult> {
  if (canCallDirectly()) {
    const form = new FormData();
    files.forEach((f) => form.append("files", f, f.name));
    form.append("site_config", JSON.stringify({ ...site, ...siteConfigOverrides }));
    form.append("column_mappings", JSON.stringify(columnMappings));
    form.append("lang", lang);
    try {
      return await directPost<AnalysisResult>("/analyse", form);
    } catch (error) {
      if (!shouldFallbackToProxy(error)) throw error;
    }
  }

  // Proxy path: Vercel route reads site from DB using siteId
  const form = new FormData();
  form.append("siteId", site.id);
  form.append("columnMappings", JSON.stringify(columnMappings));
  form.append("siteConfigOverrides", JSON.stringify(siteConfigOverrides));
  files.forEach((f) => form.append("files", f));
  return proxyPost<AnalysisResult>("/api/analysis/run", form);
}

export async function getChartingDateRange(
  file: File,
  timeColumn: string,
  worksheet?: string,
): Promise<ChartingDateRangeResult> {
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("time_column", timeColumn);
  if (worksheet) form.append("worksheet", worksheet);

  if (canCallDirectly()) {
    try {
      return await directPost<ChartingDateRangeResult>("/charting/date-range", form);
    } catch (error) {
      if (!shouldFallbackToProxy(error)) throw error;
    }
  }

  return proxyPost<ChartingDateRangeResult>("/api/charting/date-range", form);
}

export async function runCharting(
  file: File,
  args: {
    timeColumn: string;
    worksheet?: string;
    series: ChartingSeriesConfig[];
    startDate: string;
    endDate: string;
    aggregation: string;
    siteTimezone: string;
  },
): Promise<ChartingResult> {
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("time_column", args.timeColumn);
  form.append("series", JSON.stringify(args.series));
  form.append("start_date", args.startDate);
  form.append("end_date", args.endDate);
  form.append("aggregation", args.aggregation);
  form.append("site_timezone", args.siteTimezone);
  if (args.worksheet) form.append("worksheet", args.worksheet);

  if (canCallDirectly()) {
    try {
      return await directPost<ChartingResult>("/charting", form);
    } catch (error) {
      if (!shouldFallbackToProxy(error)) throw error;
    }
  }

  return proxyPost<ChartingResult>("/api/charting/run", form);
}

export async function fetchChartingReferenceIrradiance(form: FormData): Promise<ChartingReferenceIrradianceResult> {
  if (canCallDirectly()) {
    try {
      return await directPost<ChartingReferenceIrradianceResult>("/charting/reference-irradiance", form);
    } catch (error) {
      if (!shouldFallbackToProxy(error)) throw error;
    }
  }

  return proxyPost<ChartingReferenceIrradianceResult>("/api/charting/reference-irradiance", form);
}

export async function generateReportExport(args: {
  files: File[];
  site: Site;
  columnMappings: Record<string, unknown>;
  siteConfigOverrides: Record<string, unknown>;
  reportType: string;
  lang: string;
  reportDate?: string;
  outputFormat: "pdf" | "html";
}): Promise<DirectReportExport> {
  if (!canCallDirectly()) {
    throw new Error("Direct report export is unavailable because NEXT_PUBLIC_PYTHON_SERVICE_URL is not configured.");
  }

  const form = new FormData();
  args.files.forEach((file) => form.append("files", file, file.name));
  form.append("site_config", JSON.stringify(buildAnalysisSiteConfig(args.site, args.siteConfigOverrides)));
  form.append("column_mappings", JSON.stringify(args.columnMappings));
  form.append("report_type", args.reportType);
  form.append("lang", args.lang);
  if (args.reportDate) {
    form.append("report_date", args.reportDate);
  }
  form.append("output_format", args.outputFormat);

  const response = await fetch(`${DIRECT_URL}/report/generate`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Python service /report/generate → ${response.status}`);
  }

  const blob = await response.blob();
  const fallbackName = `REVEAL_${args.reportType}_${args.site.display_name.replace(/\s+/g, "_")}.${args.outputFormat}`;
  return {
    blob,
    filename: parseDownloadFilename(response.headers.get("content-disposition"), fallbackName),
    mediaType: response.headers.get("content-type") || blob.type || (args.outputFormat === "html" ? "text/html" : "application/pdf"),
  };
}
