import { z } from "zod";

function isSafeAvatarUrl(raw: string): boolean {
  if (!raw) return true;
  if (raw.startsWith("/") && !raw.startsWith("//")) return true;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export const RegisterSchema = z.object({
  fullName: z.string().trim().min(2, "Full name must be at least 2 characters.").max(100),
  email: z.string().trim().email("Enter a valid email address.").max(254).toLowerCase(),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters.")
    .max(128, "Password must be at most 128 characters.")
    .regex(/[A-Za-z]/, "Password must include at least one letter.")
    .regex(/\d/, "Password must include at least one number."),
});

export const LoginSchema = z.object({
  email: z.string().trim().email("Enter a valid email address.").max(254).toLowerCase(),
  password: z.string().min(6, "Password must be at least 6 characters.").max(128),
});

export const UpdateProfileSchema = z
  .object({
    fullName: z.string().trim().min(2).max(100).optional(),
    workspaceName: z.string().trim().min(2).max(120).optional(),
    avatarUrl: z
      .string()
      .trim()
      .max(500)
      .refine(isSafeAvatarUrl, "Avatar URL must be a relative path or an https:// URL.")
      .optional(),
    defaultFps: z.union([z.literal(24), z.literal(30), z.literal(60)]).optional(),
    defaultResolution: z.enum(["720p", "1080p", "4K"]).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "Provide at least one profile field to update.",
  });
