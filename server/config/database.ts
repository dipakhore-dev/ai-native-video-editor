import mongoose from "mongoose";
import { getEnvConfig } from "./env.ts";

let connectionAttempted = false;
let lastConnectionError: string | null = null;

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

export function getDatabaseStatus(): {
  configured: boolean;
  connected: boolean;
  readyState: number;
  lastError: string | null;
} {
  const { mongodbUri } = getEnvConfig();
  return {
    configured: Boolean(mongodbUri),
    connected: isDatabaseConnected(),
    readyState: mongoose.connection.readyState,
    lastError: lastConnectionError,
  };
}

export async function connectDatabase(): Promise<boolean> {
  const { mongodbUri } = getEnvConfig();
  if (!mongodbUri) {
    lastConnectionError = "MONGODB_URI is not set; running in browser-session mode.";
    return false;
  }

  if (isDatabaseConnected()) {
    return true;
  }

  if (connectionAttempted && mongoose.connection.readyState === 2) {
    return false;
  }

  connectionAttempted = true;
  try {
    await mongoose.connect(mongodbUri, {
      serverSelectionTimeoutMS: 5000,
    });
    lastConnectionError = null;
    console.log("MongoDB connected via Mongoose.");
    return true;
  } catch (err) {
    lastConnectionError = err instanceof Error ? err.message : "Failed to connect to MongoDB.";
    console.warn("MongoDB connection unavailable:", lastConnectionError);
    return false;
  }
}

export async function disconnectDatabase(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}
