import { redirect } from "next/navigation";
import { auth } from "@/auth";

export async function getCurrentUser() {
  const session = await auth();
  return session?.user ?? null;
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if ((user as { role?: string }).role !== "admin") redirect("/projects");
  return user;
}

function jsonResponse(error: string, status: number) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function adminGuard() {
  const session = await auth();
  if (!session?.user) return { response: jsonResponse("Unauthorized", 401) };
  if ((session.user as { role?: string }).role !== "admin") return { response: jsonResponse("Forbidden", 403) };
  return { user: session.user };
}

export async function authGuard() {
  const session = await auth();
  if (!session?.user) return { response: jsonResponse("Unauthorized", 401) };
  return { user: session.user };
}
