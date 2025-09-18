import type { AppEnv } from '../config/env';
import type { UserService } from '../services/userService';

export type AppContext = {
  Bindings: {
    STYTCH_PROJECT_ID: string;
    STYTCH_SECRET: string;
    STYTCH_ENV?: 'test' | 'live';
    STYTCH_BASE_URL?: string;
  };
  Variables: {
    config: AppEnv;
    userService: UserService;
  };
};
