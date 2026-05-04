import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserRecord } from "@/lib/server/auth";

export const runtime = "nodejs";

async function getSiteAccess(siteId: string, userId?: string, orgId?: string | null) {
  const filters = [];
  if (userId) filters.push({ users: { some: { id: userId } } });
  if (orgId) filters.push({ organizationId: orgId });
  return prisma.site.findFirst({
    where: { id: siteId, ...(filters.length ? { OR: filters } : {}) },
    select: { id: true },
  });
}

export async function GET(_req: Request, context: { params: { id: string } }) {
  try {
    const { user } = await getCurrentUserRecord();
    const site = await getSiteAccess(context.params.id, user?.id, user?.organizationId);
    if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

    const record = await prisma.siteFinancials.findUnique({
      where: { siteId: context.params.id },
    });

    if (!record) return NextResponse.json(null, { status: 200 });
    return NextResponse.json(record.params);
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to load financial parameters" }, { status: 500 });
  }
}

export async function PUT(req: Request, context: { params: { id: string } }) {
  try {
    const { user } = await getCurrentUserRecord();
    const site = await getSiteAccess(context.params.id, user?.id, user?.organizationId);
    if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

    const params = await req.json();

    await prisma.siteFinancials.upsert({
      where: { siteId: context.params.id },
      create: { siteId: context.params.id, params },
      update: { params, updatedAt: new Date() },
    });

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to save financial parameters" }, { status: 500 });
  }
}
