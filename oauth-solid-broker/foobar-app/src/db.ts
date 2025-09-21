import { PrismaClient } from '@prisma/client/edge';
import { withAccelerate } from '@prisma/extension-accelerate';


let client: PrismaClient | null = null;


export function getPrismaClient(databaseUrl: string): PrismaClient {
    if (!client) {
        client = new PrismaClient({ datasourceUrl: databaseUrl }).$extends(withAccelerate()) as any;
    }
    return client as PrismaClient;
}
