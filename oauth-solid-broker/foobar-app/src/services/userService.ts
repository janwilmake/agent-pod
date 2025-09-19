import type { AcceleratedPrismaClient } from '../db';
import { UserRepository } from '../repositories/userRepository';
import type { CreateUserRequest, UserRecord } from '../schemas/userSchema';
import { AppError } from '../utils/errors';
import { StytchService } from './stytchService';

export class UserService {
  constructor(
    private readonly stytchService: StytchService,
    private readonly repository: UserRepository,
  ) {}

  async createUser(input: CreateUserRequest): Promise<UserRecord> {
    const stytchUser = await this.stytchService.createUser(input);

    const record = await this.repository.createUser({
      ...input,
      authId: stytchUser.user_id,
    });

    // TODO: Provision additional resources for the user (e.g. Solid pod, OAuth clients)

    return record;
  }

  async getUserByAuthId(authId: string): Promise<UserRecord> {
    const user = await this.repository.findByAuthId(authId);
    if (!user) {
      throw new AppError('User not found', 404);
    }

    return user;
  }
}

export function buildUserService(
  prisma: AcceleratedPrismaClient,
  stytchService: StytchService,
): { userService: UserService; userRepository: UserRepository } {
  const repository = new UserRepository(prisma);
  return {
    userService: new UserService(stytchService, repository),
    userRepository: repository,
  };
}
