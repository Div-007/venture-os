import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  APP_MODE: z.enum(["local", "production"]).default("local"),
  APP_ORIGIN: z.url().default("http://localhost:3000"),
  API_ORIGIN: z.url().default("http://localhost:4000"),
  MONGODB_URI: z.string().min(1).default("mongodb://127.0.0.1:27017/venture_studio"),
  MONGODB_DB: z.string().min(1).default("venture_studio"),
  BETTER_AUTH_SECRET: z.string().min(32).default("local-only-change-me-32-characters-minimum"),
  RESEND_API_KEY: z.string().optional(),
  BOOTSTRAP_ADMIN_EMAIL: z.email().optional(),
  VAPID_PUBLIC_KEY: z.string().optional(),
  EMAIL_FROM: z.string().refine((value) => {
    const named = /^[^\r\n<>]+ <([^<>\r\n]+)>$/.exec(value);
    return (named !== null || !/[<>\r\n]/.test(value)) && z.email().safeParse(named?.[1] ?? value).success;
  }, "EMAIL_FROM must be an email address or Name <address@example.com>").default("Venture Studio <noreply@example.invalid>"),
  ALLOW_DEV_AUTH: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  // Hosted MCP (`/mcp`) and its write tools can be switched off without a code change.
  MCP_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  MCP_WRITES_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  // Company search for the Dealflow Sales connector (search_companies). Blank means off: the tool then says search is not set up.
  TINYFISH_API_KEY: z.string().trim().min(1).optional(),
  EXA_API_KEY: z.string().trim().min(1).optional(),
  // The built-in lead finder (sales/finder): works queued find-leads and enrich runs in this API process. It waits while a workspace has no search key.
  SALES_FINDER: z.enum(["on", "off"]).default("on"),
  FILE_STORAGE: z.enum(["local", "r2"]).default("local"),
  R2_ENDPOINT: z.url().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().min(1).optional(),
  LOCAL_UPLOAD_DIR: z.string().default(".data/uploads"),
  // The leaderboard's weeks start at Saturday midnight here, and the weekly edition appears then for everyone.
  LEADERBOARD_TIME_ZONE: z.string().default("Asia/Kolkata").refine((value) => { try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; } }, "LEADERBOARD_TIME_ZONE must be an IANA time zone"),
  // Express "trust proxy" (e.g. "loopback" behind nginx/Caddy on the same host). Unset trusts no forwarding headers.
  TRUST_PROXY: z.string().trim().min(1).optional(),
  // A header that the edge always overwrites with the visitor's address (Cloudflare: cf-connecting-ip). Only set it when
  // every request reaches the API through that edge; it then keys per-IP rate limits for both the API and sign-in.
  CLIENT_IP_HEADER: z.string().trim().toLowerCase().regex(/^[a-z0-9-]+$/, "CLIENT_IP_HEADER must be a header name").optional(),
});

export type AppConfig = z.infer<typeof schema>;

/** Express accepts true/false, a hop count, or proxy names/CIDRs such as "loopback". */
export function trustProxySetting(value: string): boolean | number | string {
  if (value === "true") return true;
  if (value === "false") return false;
  return /^\d+$/.test(value) ? Number(value) : value;
}

/** Blank values (e.g. `RESEND_API_KEY=` in an env file) mean "not set". The mode switches stay strict: a blank one fails. */
const strictWhenBlank = new Set(["APP_MODE", "NODE_ENV"]);
export const withoutBlankValues = (source: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && (strictWhenBlank.has(key) || value.trim() !== "")));

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = schema.parse(withoutBlankValues(source));
  if (config.FILE_STORAGE === "r2" && (!config.R2_ENDPOINT || !config.R2_ACCESS_KEY_ID || !config.R2_SECRET_ACCESS_KEY || !config.R2_BUCKET)) throw new Error("FILE_STORAGE=r2 requires R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET");
  if (config.FILE_STORAGE === "local" && (config.R2_ENDPOINT || config.R2_ACCESS_KEY_ID || config.R2_SECRET_ACCESS_KEY || config.R2_BUCKET)) throw new Error("R2 settings require FILE_STORAGE=r2; storage will not fall back silently");
  if (config.RESEND_API_KEY && config.EMAIL_FROM.includes("example.invalid")) throw new Error("EMAIL_FROM must be a verified Resend sender when RESEND_API_KEY is set");
  if (config.BOOTSTRAP_ADMIN_EMAIL && config.BOOTSTRAP_ADMIN_EMAIL.endsWith("@example.invalid")) throw new Error("BOOTSTRAP_ADMIN_EMAIL must be a real email address");
  if (config.NODE_ENV === "production" && config.APP_MODE !== "production") throw new Error("NODE_ENV=production requires APP_MODE=production so the production safety checks run");
  if (config.APP_MODE === "production") {
    if (config.ALLOW_DEV_AUTH) throw new Error("ALLOW_DEV_AUTH is forbidden in production");
    if (config.BETTER_AUTH_SECRET.startsWith("local-only")) throw new Error("BETTER_AUTH_SECRET must be configured in production");
    const appOrigin = new URL(config.APP_ORIGIN);
    const apiOrigin = new URL(config.API_ORIGIN);
    if ([appOrigin, apiOrigin].some((origin) => origin.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw new Error("APP_ORIGIN and API_ORIGIN must use public HTTPS hosts in production");
    if (!config.RESEND_API_KEY) throw new Error("RESEND_API_KEY is required in production");
    if (!config.VAPID_PUBLIC_KEY) throw new Error("VAPID_PUBLIC_KEY is required in production");
    if (config.FILE_STORAGE !== "r2") throw new Error("FILE_STORAGE=r2 is required in production");
    if (config.TRUST_PROXY === "true") throw new Error("TRUST_PROXY=true trusts client-supplied X-Forwarded-For; use loopback, a hop count, or the proxy address in production");
  }
  return config;
}
