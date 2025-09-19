import type { Post, User } from '@prisma/client';
import type { AcceleratedPrismaClient } from '../db';
import type { CreatePostRequest, UpdatePostRequest } from '../schemas/postSchema';

export type PostWithAuthor = Post & { author: Pick<User, 'authId'> };

export class PostRepository {
  constructor(private readonly prisma: AcceleratedPrismaClient) {}

  async listByAuthorId(authorId: string): Promise<PostWithAuthor[]> {
    return this.prisma.post.findMany({
      where: {
        authorId,
        deletedAt: null,
      },
      include: {
        author: {
          select: { authId: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(authorId: string, data: CreatePostRequest): Promise<PostWithAuthor> {
    return this.prisma.post.create({
      data: {
        authorId,
        title: data.title,
        content: data.content ?? null,
      },
      include: {
        author: {
          select: { authId: true },
        },
      },
    });
  }

  async findByIdForAuthor(id: string, authorId: string): Promise<PostWithAuthor | null> {
    return this.prisma.post.findFirst({
      where: {
        id,
        authorId,
        deletedAt: null,
      },
      include: {
        author: {
          select: { authId: true },
        },
      },
    });
  }

  async update(id: string, data: UpdatePostRequest): Promise<PostWithAuthor> {
    return this.prisma.post.update({
      where: { id },
      data: {
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.content !== undefined ? { content: data.content ?? null } : {}),
      },
      include: {
        author: {
          select: { authId: true },
        },
      },
    });
  }

  async softDelete(id: string): Promise<void> {
    await this.prisma.post.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
