import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

export let isConnectedToMongo = false;

/**
 * In-Memory Mock Database Store (Fallback when MongoDB instance is not connected)
 */
export const inMemoryStore = {
  users: new Map<string, any>(),
  tickets: new Map<string, any>(),
  events: new Map<string, any>(),
  webhookLogs: new Map<string, any>(),
};

export function getMongoTargetIdentifier(mongoUri: string | undefined): string {
  if (!mongoUri) return 'configured MongoDB target';
  try {
    const parsedUri = new URL(mongoUri);
    if (!parsedUri.hostname) return 'configured MongoDB target';
    const host = `${parsedUri.hostname}${parsedUri.port ? `:${parsedUri.port}` : ''}`;
    const database = parsedUri.pathname.replace(/^\/+/, '');
    return database ? `${host}/${database}` : host;
  } catch {
    return 'configured MongoDB target';
  }
}

export async function connectDatabase(): Promise<boolean> {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    isConnectedToMongo = false;
    if (process.env.NODE_ENV === 'production') {
      throw new Error('MONGODB_URI is required in production.');
    }
    console.log('ℹ️ MONGODB_URI not specified. Operating in hybrid mode with In-Memory Persistent Store.');
    return false;
  }

  try {
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
    isConnectedToMongo = true;
    console.log('✅ Connected to MongoDB at:', getMongoTargetIdentifier(mongoUri));
    return true;
  } catch {
    isConnectedToMongo = false;
    if (process.env.NODE_ENV === 'production') {
      throw new Error('MongoDB connection failed; refusing to start in production.');
    }
    console.warn(
      '⚠️ MongoDB connection warning. Falling back to In-Memory database store for:',
      getMongoTargetIdentifier(mongoUri),
    );
    return false;
  }
}
