import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import type { Db } from "mongodb";
import type { AppConfig } from "./config.js";
import { renderInviteEmail, renderSignInEmail, type InviteEmailInput, type RenderedEmail } from "./email/templates.js";

/** How long a sign-in link works; the email states the same number. */
export const MAGIC_LINK_MINUTES = 5;

/** Resend payload for a rendered email: HTML and plain-text parts plus the inline (cid:) artwork. */
const resendBody = (config: AppConfig, to: string, email: RenderedEmail) => JSON.stringify({ from: config.EMAIL_FROM, to, subject: email.subject, html: email.html, text: email.text, attachments: email.attachments });

async function sendMagicLink(config: AppConfig, email: string, url: string): Promise<void> {
  if (!config.RESEND_API_KEY) {
    console.info(JSON.stringify({ level: "info", adapter: "local", event: "magic_link", email, url }));
    return;
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: resendBody(config, email, renderSignInEmail({ url, email, minutes: MAGIC_LINK_MINUTES })),
  });
  if (!response.ok) throw new Error(`Resend rejected magic link: ${response.status}`);
}

export async function sendInvitationEmail(config: AppConfig, email: string, invitationId: string, details: InviteEmailInput): Promise<string> {
  if (!config.RESEND_API_KEY) throw new Error("Resend is not configured");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `invitation/${invitationId}` },
    body: resendBody(config, email, renderInviteEmail(details)),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Resend rejected invitation: ${response.status}`);
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || !("id" in result) || typeof result.id !== "string") throw new Error("Resend did not confirm an email ID");
  return result.id;
}

export function createAuth(db: Db, config: AppConfig) {
  return betterAuth({
    // Magic-link verification must be served through the web origin so its
    // session cookie belongs to the same host used by subsequent /v1 calls.
    baseURL: config.APP_ORIGIN,
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.APP_ORIGIN],
    // Sign-in rate limits use the edge's client-address header when one is configured (see CLIENT_IP_HEADER).
    ...(config.CLIENT_IP_HEADER ? { advanced: { ipAddress: { ipAddressHeaders: [config.CLIENT_IP_HEADER] } } } : {}),
    database: mongodbAdapter(db),
    plugins: [magicLink({ expiresIn: MAGIC_LINK_MINUTES * 60, sendMagicLink: ({ email, url }) => sendMagicLink(config, email, url) })],
  });
}

export type Auth = ReturnType<typeof createAuth>;
