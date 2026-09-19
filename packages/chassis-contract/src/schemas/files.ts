import { z } from 'zod';
import { plainText } from './common.js';

export const fileSchema = z.object({
  id: z.string(),
  sha256: z.string(),
  sizeBytes: z.number(),
  contentType: z.string(),
  originalName: z.string(),
  /** Null once the uploader's account was deleted (files are workspace data). */
  createdBy: z.string().nullable(),
  createdAt: z.string()
});
export type FileInfo = z.infer<typeof fileSchema>;

export const filesListSchema = z.object({
  files: z.array(fileSchema),
  nextCursor: z.string().nullable()
});

export const fileUploadedSchema = z.object({
  file: fileSchema,
  /** True when identical bytes already existed for this workspace. */
  deduplicated: z.boolean()
});

export const fileUploadQuerySchema = z.object({
  /** Original filename (the body is the raw bytes). */
  name: plainText(1, 255)
});
