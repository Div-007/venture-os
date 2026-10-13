import { MongoClient, type ClientSession, type Collection, type Db, type Document } from "mongodb";
import type { AppConfig } from "./config.js";

export type AppDocument = Document & { _id: string; [key: string]: any };
export class AppDb {
  constructor(readonly native: Db) {}
  collection(name: string): Collection<AppDocument> { return this.native.collection<AppDocument>(name); }
  command(command: Document) { return this.native.command(command); }
}
export type Database = { client: MongoClient; db: AppDb; native: Db; transactions: boolean };

export async function connectDatabase(config: AppConfig): Promise<Database> {
  const client = new MongoClient(config.MONGODB_URI);
  await client.connect();
  const native = client.db(config.MONGODB_DB);
  const hello = await native.admin().command({ hello: 1 });
  const transactions = typeof hello.setName === "string";
  if (config.APP_MODE === "production" && !transactions) {
    await client.close();
    throw new Error("Production requires a MongoDB replica set for atomic state, audit, and outbox writes");
  }
  return { client, db: new AppDb(native), native, transactions };
}

export async function atomic<T>(database: Database, work: (session?: ClientSession) => Promise<T>): Promise<T> {
  if (!database.transactions) return work();
  return database.client.withSession((session) => session.withTransaction(() => work(session)));
}
