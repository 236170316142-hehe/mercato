import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import bcrypt from "bcryptjs";

export async function GET() {
  const { response } = await adminGuard();
  if (response) return response;

  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, role: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ users });
}

export async function POST(req: NextRequest) {
  const { response } = await adminGuard();
  if (response) return response;

  const body = await req.json();
  const { name, email, password, role } = body;

  if (!email || !password) {
    return NextResponse.json({ error: "email and password required" }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return NextResponse.json({ error: "User already exists" }, { status: 409 });

  const hash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { name: name ?? null, email, password: hash, role: role ?? "user" },
    select: { id: true, name: true, email: true, role: true, createdAt: true },
  });

  return NextResponse.json(user);
}

export async function DELETE(req: NextRequest) {
  const { response } = await adminGuard();
  if (response) return response;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  await prisma.user.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest) {
  const { response } = await adminGuard();
  if (response) return response;

  const body = await req.json();
  const { id, role } = body;
  if (!id || !role) return NextResponse.json({ error: "id and role required" }, { status: 400 });

  const user = await prisma.user.update({
    where: { id },
    data: { role },
    select: { id: true, name: true, email: true, role: true, createdAt: true },
  });

  return NextResponse.json(user);
}
