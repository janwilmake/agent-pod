import { PrismaClient } from '@prisma/client/edge';
import { withAccelerate } from '@prisma/extension-accelerate';

// This type matches the extended Prisma client correctly
type ExtendedPrismaClient = ReturnType<
    PrismaClient['$extends']
>;

let client: ExtendedPrismaClient | null = null;

export function getPrismaClient(databaseUrl: string): ExtendedPrismaClient {
    if (!client) {
        client = new PrismaClient({ datasourceUrl: databaseUrl }).$extends(withAccelerate());
    }
    return client;
}
