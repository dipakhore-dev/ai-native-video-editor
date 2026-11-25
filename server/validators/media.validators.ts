import { z } from "zod";

const NonBlobOptionalUrl = z
  .string()
  .trim()
  .max(1000)
  .refine((val) => val === "" || !/^blob:/i.test(val), {
    message: "Temporary blob URLs cannot be stored as permanent media metadata.",
  })
  .optional();

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
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  description: z.string().trim().max(400).optional(),
  sourceOrigin: z
    .enum(["uploaded", "existing_library", "stock", "generated_slide"])
    .optional()
    .default("uploaded"),
  providerName: z.string().trim().max(80).optional(),
  providerAssetId: z.string().trim().max(120).optional(),
  sourceUrl: NonBlobOptionalUrl,
  creatorName: z.string().trim().max(160).optional(),
  attributionUrl: NonBlobOptionalUrl,
  licenseInfo: z.string().trim().max(200).optional(),
});

export const UpdateMediaMetadataSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    projectId: z.string().trim().nullable().optional(),
    storageProvider: z.enum(["local_browser", "s3", "gcs"]).optional(),
    storageKey: z.string().trim().max(500).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    description: z.string().trim().max(400).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "Provide at least one media metadata field to update.",
  });
