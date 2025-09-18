import type { AppEnv } from '../config/env';
import { UserRepository } from '../repositories/userRepository';
import type { CreateUserRequest, UserRecord } from '../schemas/userSchema';
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
      stytchUserId: stytchUser.user_id,
    });

    // TODO: Provision additional resources for the user (e.g. Solid pod, OAuth clients)

    return record;
  }
}

export function buildUserService(config: AppEnv): UserService {
  const stytchService = new StytchService(config);
  const repository = new UserRepository();
  return new UserService(stytchService, repository);
}
