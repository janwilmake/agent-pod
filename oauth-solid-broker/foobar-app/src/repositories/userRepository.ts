import type { CreateUserRequest, UserRecord } from '../schemas/userSchema';

export class UserRepository {
  async createUser(input: CreateUserRequest & { stytchUserId: string }): Promise<UserRecord> {
    const now = new Date().toISOString();
    const record: UserRecord = {
      id: crypto.randomUUID(),
      email: input.email,
      name: input.name,
      stytchUserId: input.stytchUserId,
      createdAt: now,
    };

    // TODO: Persist user record in Postgres

    return record;
  }
}
