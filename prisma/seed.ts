import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

dotenv.config();

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const name = process.env.ADMIN_NAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.log("ADMIN_EMAIL and ADMIN_PASSWORD required in .env to seed admin.");
    return;
  }

  const hash = await bcrypt.hash(password, 12);
  const admin = await prisma.user.upsert({
    where: { email },
    update: { role: "admin", password: hash },
    create: { email, name: name ?? "Admin", password: hash, role: "admin" },
  });

  console.log(`Admin seeded: ${admin.email}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
