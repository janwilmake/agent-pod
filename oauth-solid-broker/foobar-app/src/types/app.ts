import type { AppEnv } from '../config/env';
import type { AcceleratedPrismaClient } from '../db';
import type { StytchService, StytchSession, StytchUserProfile } from '../services/stytchService';
import type { PostService } from '../services/postService';
import type { UserService } from '../services/userService';

export type AppContext = {
  Bindings: {
    STYTCH_PROJECT_ID: string;
    STYTCH_SECRET: string;
    STYTCH_ENV?: 'test' | 'live';
    STYTCH_BASE_URL?: string;
    DATABASE_URL: string;
  };
  Variables: {
    config: AppEnv;
    prisma: AcceleratedPrismaClient;
    stytchService: StytchService;
    userService: UserService;
    postService: PostService;
    stytchSession?: StytchSession;
    stytchUser?: StytchUserProfile;
  };
};
