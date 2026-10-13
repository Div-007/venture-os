import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.string().optional(),
  APP_MODE: z.enum(["local", "production"]).default("local"),
  MONGODB_URI: z.string().min(1).default("mongodb://127.0.0.1:27017/venture_studio"),
  MONGODB_DB: z.string().min(1).default("venture_studio"),
  WORKER_ID: z.string().default(`worker-${process.pid}`),
  POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Venture Studio <noreply@example.invalid>"),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:admin@example.invalid"),
});
export type WorkerConfig = z.infer<typeof schema>;
export function loadConfig(source: NodeJS.ProcessEnv = process.env): WorkerConfig {
  // Blank values in an env file mean "not set"; a blank APP_MODE still fails rather than silently meaning local.
  const value = schema.parse(Object.fromEntries(Object.entries(source).filter(([key, entry]) => entry !== undefined && (key === "APP_MODE" || entry.trim() !== ""))));
  if (value.NODE_ENV === "production" && value.APP_MODE !== "production") throw new Error("NODE_ENV=production requires APP_MODE=production so the production safety checks run");
  if (value.APP_MODE === "production" && (!value.RESEND_API_KEY || !value.VAPID_PUBLIC_KEY || !value.VAPID_PRIVATE_KEY)) throw new Error("Production notification credentials are required");
  return value;
}
