import type { PostRepository, PostWithAuthor } from '../repositories/postRepository';
import type { UserRepository } from '../repositories/userRepository';
import {
  createPostRequestSchema,
  postRecordSchema,
  type PostRecord,
  updatePostRequestSchema,
} from '../schemas/postSchema';
import { AppError } from '../utils/errors';

export class PostService {
  constructor(
    private readonly postRepository: PostRepository,
    private readonly userRepository: UserRepository,
  ) {}

  async listForAuthUser(authId: string): Promise<PostRecord[]> {
    const user = await this.userRepository.findByAuthId(authId);
    if (!user) {
      throw new AppError('User not found', 404);
    }

    const posts = await this.postRepository.listByAuthorId(user.id);
    return posts.map((post) => this.toRecord(post));
  }

  async createForAuthUser(authId: string, payload: unknown): Promise<PostRecord> {
    const data = createPostRequestSchema.parse(payload);
    const user = await this.userRepository.findByAuthId(authId);
    if (!user) {
      throw new AppError('User not found', 404);
    }

    const post = await this.postRepository.create(user.id, data);
    return this.toRecord(post);
  }

  async getForAuthUser(authId: string, postId: string): Promise<PostRecord> {
    const user = await this.userRepository.findByAuthId(authId);
    if (!user) {
      throw new AppError('User not found', 404);
    }

    const post = await this.postRepository.findByIdForAuthor(postId, user.id);
    if (!post) {
      throw new AppError('Post not found', 404);
    }

    return this.toRecord(post);
  }

  async updateForAuthUser(authId: string, postId: string, payload: unknown): Promise<PostRecord> {
    const data = updatePostRequestSchema.parse(payload);
    const user = await this.userRepository.findByAuthId(authId);
    if (!user) {
      throw new AppError('User not found', 404);
    }

    const existing = await this.postRepository.findByIdForAuthor(postId, user.id);
    if (!existing) {
      throw new AppError('Post not found', 404);
    }

    const updated = await this.postRepository.update(postId, data);
    return this.toRecord(updated);
  }

  async deleteForAuthUser(authId: string, postId: string): Promise<void> {
    const user = await this.userRepository.findByAuthId(authId);
    if (!user) {
      throw new AppError('User not found', 404);
    }

    const existing = await this.postRepository.findByIdForAuthor(postId, user.id);
    if (!existing) {
      throw new AppError('Post not found', 404);
    }

    await this.postRepository.softDelete(postId);
  }

  private toRecord(post: PostWithAuthor): PostRecord {
    return postRecordSchema.parse({
      id: post.id,
      title: post.title,
      content: post.content ?? null,
      ownerId: post.author.authId,
      createdAt: post.createdAt.toISOString(),
    });
  }
}

export function buildPostService(
  postRepository: PostRepository,
  userRepository: UserRepository,
): PostService {
  return new PostService(postRepository, userRepository);
}
