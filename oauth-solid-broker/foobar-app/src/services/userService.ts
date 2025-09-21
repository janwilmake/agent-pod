import { UserRepository } from '../repositories/userRepository';
import type { CreateUserRequest, UserRecord } from '../schemas/userSchema';
import { AppError } from '../utils/errors';
import { StytchService } from './stytchService';
import {CssProvisioningService} from "./CSSProvisioningService";
import {PrismaClient} from "@prisma/client/edge";

export class UserService {
  constructor(
    private readonly stytchService: StytchService,
    private readonly repository: UserRepository,
    private readonly cssProvisioningService?: CssProvisioningService,
  ) {}

  async createUser(input: CreateUserRequest): Promise<UserRecord> {
    const stytchUser = await this.stytchService.createUser(input);

    const cssResult = await this.provisionSolidResources(input, stytchUser.user_id);

    const record = await this.repository.createUser({
      ...input,
      authId: stytchUser.user_id,
      cssPodBaseUrl: cssResult?.podBaseUrl ?? null,
      cssWebId: cssResult?.webId ?? null,
    });

    return record;
  }

  private async provisionSolidResources(input: CreateUserRequest, authId: string) {
    if (!this.cssProvisioningService) {
      return null;
    }
    const slug = derivePodSlug(input.email, authId);
    try {
      return await this.cssProvisioningService.provisionPod({
        slug,
        email: input.email,
        name: input.name,
        password: input.password,
      });
    } catch (error) {
      throw new AppError('Unable to provision Solid resources for the new user', 502, {
        cause: error instanceof Error ? error.message : String(error),
              slug,
            });
          }
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
  prisma: PrismaClient,
  stytchService: StytchService,
  cssProvisioningService?: CssProvisioningService,
): { userService: UserService; userRepository: UserRepository } {
  const repository = new UserRepository(prisma);
  return {
    userService: new UserService(stytchService, repository, cssProvisioningService),
    userRepository: repository,
  };
}

function derivePodSlug(email: string, fallback: string): string {
  const normalized = email.trim().toLowerCase();
  const slug = normalized
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  if (slug.length >= 3) {
    return slug;
  }

  const sanitizedFallback = fallback.replace(/[^a-z0-9]+/gi, '').toLowerCase();
  const suffix = sanitizedFallback.slice(0, 16) || 'pod';
  return `user-${suffix}`;
}
