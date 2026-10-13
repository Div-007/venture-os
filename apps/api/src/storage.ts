import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { copyFile, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { AppConfig } from "./config.js";

export type ObjectMetadata = { size: number; etag: string };
export interface ObjectStore {
  readonly kind: "local" | "r2";
  uploadUrl(key: string, contentType: string, size: number): Promise<string>;
  downloadUrl(key: string): Promise<string>;
  read(key: string, maxBytes: number): Promise<Buffer>;
  head(key: string): Promise<ObjectMetadata>;
  finalize(stagingKey: string, finalKey: string, expectedEtag?: string): Promise<ObjectMetadata>;
  discard(key: string): Promise<void>;
}

export class LocalObjectStore implements ObjectStore {
  readonly kind = "local" as const;
  private readonly directory: string;
  constructor(private readonly config: AppConfig) { this.directory = resolve(config.LOCAL_UPLOAD_DIR); }
  private token(op: "put" | "get", key: string, expires = Date.now() + 15 * 60_000): string {
    const body = Buffer.from(JSON.stringify({ op, key, expires })).toString("base64url");
    const signature = createHmac("sha256", this.config.BETTER_AUTH_SECRET).update(body).digest("base64url");
    return `${body}.${signature}`;
  }
  verify(token: string, op: "put" | "get"): string {
    const [body, signature] = token.split(".");
    if (!body || !signature) throw new Error("Invalid upload token");
    const expected = createHmac("sha256", this.config.BETTER_AUTH_SECRET).update(body).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid upload token");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { op: string; key: string; expires: number };
    if (payload.op !== op || payload.expires <= Date.now() || payload.key.includes("..")) throw new Error("Expired upload token");
    return payload.key;
  }
  path(key: string): string { return resolve(this.directory, key); }
  async uploadUrl(key: string): Promise<string> { return `${this.config.API_ORIGIN}/v1/local-objects/${this.token("put", key)}`; }
  async downloadUrl(key: string): Promise<string> { return `${this.config.API_ORIGIN}/v1/local-objects/${this.token("get", key)}`; }
  async write(key: string, body: Buffer): Promise<void> { const path = this.path(key); await mkdir(dirname(path), { recursive: true }); await writeFile(path, body); }
  async read(key: string, maxBytes: number): Promise<Buffer> {
    if ((await stat(this.path(key))).size > maxBytes) throw new Error("Stored object exceeds the read limit");
    const body = await readFile(this.path(key));
    if (body.length > maxBytes) throw new Error("Stored object exceeds the read limit");
    return body;
  }
  async head(key: string): Promise<ObjectMetadata> { const body = await readFile(this.path(key)); const info = await stat(this.path(key)); return { size: info.size, etag: createHash("sha256").update(body).digest("hex") }; }
  async finalize(stagingKey: string, finalKey: string): Promise<ObjectMetadata> { const path = this.path(finalKey); await mkdir(dirname(path), { recursive: true }); await copyFile(this.path(stagingKey), path); return this.head(finalKey); }
  async discard(key: string): Promise<void> { try { await unlink(this.path(key)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}

export class R2ObjectStore implements ObjectStore {
  readonly kind = "r2" as const;
  private readonly client: S3Client;
  constructor(private readonly config: AppConfig) {
    this.client = new S3Client({ region: "auto", endpoint: config.R2_ENDPOINT, credentials: { accessKeyId: config.R2_ACCESS_KEY_ID!, secretAccessKey: config.R2_SECRET_ACCESS_KEY! } });
  }
  uploadUrl(key: string, contentType: string, size: number): Promise<string> { return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.config.R2_BUCKET, Key: key, ContentType: contentType, ContentLength: size }), { expiresIn: 900 }); }
  downloadUrl(key: string): Promise<string> { return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.config.R2_BUCKET, Key: key }), { expiresIn: 300 }); }
  async read(key: string, maxBytes: number): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.R2_BUCKET, Key: key }));
    if (!result.Body) throw new Error("Stored object is empty");
    const closeBody = () => (result.Body as { destroy?: () => void }).destroy?.();
    if (result.ContentLength !== undefined && result.ContentLength > maxBytes) {
      closeBody();
      throw new Error("Stored object exceeds the read limit");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        closeBody();
        throw new Error("Stored object exceeds the read limit");
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, size);
  }
  async head(key: string): Promise<ObjectMetadata> { const result = await this.client.send(new HeadObjectCommand({ Bucket: this.config.R2_BUCKET, Key: key })); return { size: result.ContentLength ?? 0, etag: result.ETag?.replaceAll('"', "") ?? "" }; }
  async finalize(stagingKey: string, finalKey: string, expectedEtag?: string): Promise<ObjectMetadata> {
    await this.client.send(new CopyObjectCommand({ Bucket: this.config.R2_BUCKET, CopySource: `${this.config.R2_BUCKET}/${stagingKey}`, CopySourceIfMatch: expectedEtag ? `"${expectedEtag}"` : undefined, Key: finalKey }));
    return this.head(finalKey);
  }
  async discard(key: string): Promise<void> { await this.client.send(new DeleteObjectCommand({ Bucket: this.config.R2_BUCKET, Key: key })); }
}

export function createObjectStore(config: AppConfig): ObjectStore {
  return config.FILE_STORAGE === "r2" ? new R2ObjectStore(config) : new LocalObjectStore(config);
}
