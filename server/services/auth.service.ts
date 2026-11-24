import bcrypt from "bcryptjs";
import jwt, { type SignOptions } from "jsonwebtoken";
import { getEnvConfig, isJwtConfigured, normalizeJwtExpiresIn } from "../config/env.ts";
import { UserModel, type IUser } from "../models/User.ts";

export interface PublicUserDto {
  id: string;
  fullName: string;
  email: string;
  avatarUrl: string;
  workspaceName: string;
  defaultFps: 24 | 30 | 60;
  defaultResolution: "720p" | "1080p" | "4K";
  createdAt: Date;
  updatedAt: Date;
}

export function toPublicUser(user: IUser): PublicUserDto {
  return {
    id: user._id.toString(),
    fullName: user.fullName,
    email: user.email,
    avatarUrl: user.avatarUrl || "",
    workspaceName: user.workspaceName,
    defaultFps: user.defaultFps,
    defaultResolution: user.defaultResolution,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export function signAuthToken(user: IUser): string {
  if (!isJwtConfigured()) {
    throw Object.assign(new Error("JWT_SECRET must be configured (minimum 16 characters)."), {
      statusCode: 500,
    });
  }
  const { jwtSecret, jwtExpiresIn } = getEnvConfig();
  const options: SignOptions = {
    algorithm: "HS256",
    expiresIn: normalizeJwtExpiresIn(jwtExpiresIn) as SignOptions["expiresIn"],
  };
  return jwt.sign({ sub: user._id.toString(), email: user.email }, jwtSecret, options);
}

export async function registerUser(input: {
  fullName: string;
  email: string;
  password: string;
}): Promise<{ user: PublicUserDto; token: string }> {
  const normalizedEmail = input.email.toLowerCase();
  const existing = await UserModel.findOne({ email: normalizedEmail });
  if (existing) {
    throw Object.assign(new Error("An account with this email already exists."), { statusCode: 409 });
  }

  const passwordHash = await bcrypt.hash(input.password, 12);
  let created: IUser;
  try {
    created = await UserModel.create({
      fullName: input.fullName,
      email: normalizedEmail,
      passwordHash,
      workspaceName: `${input.fullName.split(" ")[0]}'s Studio`,
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      throw Object.assign(new Error("An account with this email already exists."), {
        statusCode: 409,
      });
    }
    throw err;
  }

  const token = signAuthToken(created);
  return { user: toPublicUser(created), token };
}

export async function authenticateUser(input: {
  email: string;
  password: string;
}): Promise<{ user: PublicUserDto; token: string }> {
  const user = await UserModel.findOne({ email: input.email.toLowerCase() }).select("+passwordHash");
  if (!user) {
    throw Object.assign(new Error("Invalid email or password."), { statusCode: 401 });
  }

  const valid = await bcrypt.compare(input.password, user.passwordHash);
  if (!valid) {
    throw Object.assign(new Error("Invalid email or password."), { statusCode: 401 });
  }

  const token = signAuthToken(user);
  return { user: toPublicUser(user), token };
}

export async function updateUserProfile(
  userId: string,
  updates: {
    fullName?: string;
    workspaceName?: string;
    avatarUrl?: string;
    defaultFps?: 24 | 30 | 60;
    defaultResolution?: "720p" | "1080p" | "4K";
  }
): Promise<PublicUserDto | null> {
  const updated = await UserModel.findByIdAndUpdate(
    userId,
    { $set: updates },
    { new: true, runValidators: true }
  );
  return updated ? toPublicUser(updated) : null;
}
