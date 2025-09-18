export class AppError extends Error {
  constructor(message: string, public readonly status = 400, public readonly details?: unknown) {
    super(message);
    this.name = 'AppError';
  }
}
