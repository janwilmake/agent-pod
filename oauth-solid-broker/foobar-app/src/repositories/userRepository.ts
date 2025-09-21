import { userRecordSchema } from '../schemas/userSchema';
import type { CreateUserRequest, UserRecord } from '../schemas/userSchema';
import {type PrismaClient} from "@prisma/client/edge";

export class UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createUser(input: CreateUserRequest & { authId: string }): Promise<UserRecord> {
    const user = await this.prisma.user.create({
      data: {
        email: input.email.toLowerCase(),
        name: input.name || null,
        authId: input.authId,
      },
    });

    return this.toRecord(user);
  }

  async findByAuthId(authId: string): Promise<UserRecord | null> {
    const user = await this.prisma.user.findFirst({
      where: {
        authId,
        deletedAt: null,
      },
    });

    return user ? this.toRecord(user) : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const user = await this.prisma.user.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });

    return user ? this.toRecord(user) : null;
  }

  async softDelete(id: string): Promise<void> {
    await this.prisma.user.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  private toRecord(user: { id: string; email: string; name: string | null; authId: string; createdAt: Date }): UserRecord {
    return userRecordSchema.parse({
      id: user.id,
      email: user.email,
      name: user.name,
      authId: user.authId,
      createdAt: user.createdAt.toISOString(),
    });
  }
}
