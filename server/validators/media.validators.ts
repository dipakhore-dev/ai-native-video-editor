import { z } from "zod";

export const CreateMediaMetadataSchema = z.object({
  projectId: z.string().trim().optional().nullable(),
  name: z.string().trim().min(1, "Filename is required.").max(255),
  kind: z.enum(["video", "image", "audio"]),
  mimeType: z.string().trim().min(1),
  sizeBytes: z.number().min(0),
  duration: z.number().min(0),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  storageProvider: z.enum(["local_browser", "s3", "gcs"]).default("local_browser"),
  storageKey: z.string().trim().max(500).optional().default(""),
});

export const UpdateMediaMetadataSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    projectId: z.string().trim().nullable().optional(),
    storageProvider: z.enum(["local_browser", "s3", "gcs"]).optional(),
    storageKey: z.string().trim().max(500).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "Provide at least one media metadata field to update.",
  });
