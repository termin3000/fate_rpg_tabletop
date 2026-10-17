import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  prismaUrl: string | undefined
  prismaInitKey: string | undefined
}

const currentUrl = process.env.DATABASE_URL ?? ''

// Force-recreate the PrismaClient when this module is re-imported AND the
// singleton was created by an older version of this file (before we added the
// URL-tracking logic). We detect this by checking if `prismaInitKey` was set.
// On first load with the new code, the old singleton exists but without the
// init key — we tear it down and create a fresh one bound to the current URL.
if (
  globalForPrisma.prisma &&
  globalForPrisma.prismaInitKey !== 'v3-quiet-logs'
) {
  const oldClient = globalForPrisma.prisma
  globalForPrisma.prisma = undefined
  oldClient.$disconnect().catch(() => {})
}

// If the URL has changed since the singleton was created (e.g. .env reload),
// tear down and recreate.
if (
  globalForPrisma.prisma &&
  globalForPrisma.prismaUrl &&
  globalForPrisma.prismaUrl !== currentUrl
) {
  const oldClient = globalForPrisma.prisma
  globalForPrisma.prisma = undefined
  oldClient.$disconnect().catch(() => {})
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = db
  globalForPrisma.prismaUrl = currentUrl
  globalForPrisma.prismaInitKey = 'v3-quiet-logs'
}
