import { z } from 'zod';

export const createPostRequestSchema = z.object({
  title: z.string().min(1, 'title is required').max(256),
  content: z.string().max(5000).optional().nullable(),
});

export type CreatePostRequest = z.infer<typeof createPostRequestSchema>;

export const updatePostRequestSchema = createPostRequestSchema.partial().refine(
  (value) => value.title !== undefined || value.content !== undefined,
  {
    message: 'At least one field must be provided to update a post',
  },
);

export type UpdatePostRequest = z.infer<typeof updatePostRequestSchema>;

export const postRecordSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string().nullable(),
  ownerId: z.string(),
  createdAt: z.string().datetime(),
});

export type PostRecord = z.infer<typeof postRecordSchema>;
