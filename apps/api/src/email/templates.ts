import { EMAIL_ART } from "./art.js";

/**
 * Transactional email in email-safe HTML: tables, inline styles, a plain-text part, and inline (cid:) images so the
 * dithered artwork shows even when the website is unreachable. Headings use Cabinet Grotesk where the client loads web
 * fonts (Apple Mail, iOS); others fall back to Plus Jakarta Sans, then Helvetica/Arial.
 */
export type EmailAttachment = { filename: string; content: string; content_id: string };
export type RenderedEmail = { subject: string; html: string; text: string; attachments: EmailAttachment[] };

const HEADING = "'Cabinet Grotesk','Plus Jakarta Sans',Helvetica,Arial,sans-serif";
const BODY = "'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const C = { page: "#f3f6f2", card: "#ffffff", ink: "#14211a", ink2: "#4a5a50", muted: "#78877d", line: "#e3e9e1", chip: "#eef6f0", chipInk: "#165c33", hero: "#0f3d24", green: "#177a3d", mint: "#a7f3c4" };

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
const art = (): EmailAttachment[] => [
  { filename: "hero.png", content: EMAIL_ART.hero, content_id: "vso-hero" },
  { filename: "button.png", content: EMAIL_ART.button, content_id: "vso-button" },
  { filename: "logo.png", content: EMAIL_ART.logo, content_id: "vso-logo" },
];

/** A fully rounded, centred button over the dithered texture (solid green where background images are blocked). */
function button(label: string, url: string) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:26px auto 4px;border-collapse:separate;">
  <tr><td align="center" bgcolor="${C.green}" background="cid:vso-button" style="border-radius:999px;background-color:${C.green};background-image:url('cid:vso-button');background-size:cover;background-position:center;box-shadow:0 8px 18px -8px rgba(15,118,110,0.6);">
    <a href="${escape(url)}" target="_blank" style="display:inline-block;padding:15px 34px;border-radius:999px;font-family:${BODY};font-size:16px;font-weight:700;line-height:20px;color:#ffffff;text-decoration:none;letter-spacing:0.01em;">${escape(label)}&nbsp;&rarr;</a>
  </td></tr></table>`;
}

/** The brand lockup under the card: the logo, "Venture Studio" with a lighter "OS", the site link, and why this was sent. */
function brandFooter(origin: string, legal: string) {
  const host = origin.replace(/^https?:\/\//, "");
  return `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;margin-top:22px;">
    <tr>
      <td class="vso-col" valign="middle" style="padding:0 10px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td valign="middle" style="width:38px;"><img src="cid:vso-logo" width="38" height="38" alt="Venture Studio OS" style="display:block;border:0;border-radius:10px;"></td>
          <td valign="middle" style="padding-left:10px;font-family:${HEADING};font-size:21px;line-height:24px;font-weight:800;letter-spacing:-0.02em;color:${C.hero};white-space:nowrap;">Venture Studio<span style="padding-left:6px;font-family:${BODY};font-size:16px;font-weight:500;letter-spacing:0.04em;color:#2f6b4c;">OS</span></td>
        </tr></table>
      </td>
      <td class="vso-col vso-start" align="right" valign="middle" style="padding:0 10px;font-family:${BODY};font-size:12.5px;line-height:18px;"><a href="${escape(origin)}" target="_blank" style="color:${C.chipInk};font-weight:700;text-decoration:none;">${escape(host)}</a></td>
    </tr>
    <tr><td colspan="2" style="padding:14px 10px 0;font-family:${BODY};font-size:11.5px;line-height:18px;color:${C.muted};">${legal}<br>Venture Studio OS, the operating system for your ventures.</td></tr>
  </table>`;
}

/** The shared shell: dithered hero (kicker + headline), white card body, card footer, and the brand footer below. */
function shell({ title, preheader, kicker, headline, heroHeight, body, footer, legal, origin }: { title: string; preheader: string; kicker: string; headline: string; heroHeight: number; body: string; footer: string; legal: string; origin: string }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only">
<title>${escape(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
<link href="https://api.fontshare.com/v2/css?f[]=cabinet-grotesk@700,800&display=swap" rel="stylesheet">
<style>
  body { margin:0; padding:0; background:${C.page}; }
  a { color:${C.chipInk}; }
  @media (max-width:620px) { .vso-pad { padding-left:22px !important; padding-right:22px !important; } .vso-h1 { font-size:26px !important; line-height:30px !important; } .vso-col { display:block !important; width:100% !important; } .vso-start { text-align:left !important; padding-top:10px !important; } }
</style></head>
<body style="margin:0;padding:0;background:${C.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escape(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background:${C.page};">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${C.card};border:1px solid ${C.line};border-radius:20px;border-collapse:separate;overflow:hidden;">
    <tr><td bgcolor="${C.hero}" background="cid:vso-hero" valign="bottom" height="${heroHeight}" style="background-color:${C.hero};background-image:url('cid:vso-hero');background-size:cover;background-position:center;height:${heroHeight}px;border-radius:20px 20px 0 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td class="vso-pad" style="padding:22px 32px 0;"><img src="cid:vso-logo" width="30" height="30" alt="" style="display:inline-block;vertical-align:middle;border:0;border-radius:8px;"><span style="font-family:${HEADING};font-size:16px;font-weight:800;letter-spacing:-0.01em;color:#ffffff;vertical-align:middle;padding-left:9px;">Venture Studio<span style="padding-left:4px;font-family:${BODY};font-size:13px;font-weight:500;letter-spacing:0.04em;color:${C.mint};">OS</span></span></td></tr>
        <tr><td class="vso-pad" style="padding:${Math.max(20, heroHeight - 150)}px 32px 24px;">
          <div style="font-family:${BODY};font-size:12px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;color:${C.mint};">${escape(kicker)}</div>
          <h1 class="vso-h1" style="margin:6px 0 0;font-family:${HEADING};font-size:32px;line-height:36px;font-weight:800;letter-spacing:-0.02em;color:#ffffff;">${headline}</h1>
        </td></tr>
      </table>
    </td></tr>
    <tr><td class="vso-pad" style="padding:28px 32px 30px;font-family:${BODY};font-size:15px;line-height:24px;color:${C.ink2};">${body}</td></tr>
    <tr><td class="vso-pad" style="padding:18px 32px 24px;border-top:1px solid ${C.line};font-family:${BODY};font-size:12.5px;line-height:20px;color:${C.muted};">${footer}</td></tr>
  </table>
  ${brandFooter(origin, legal)}
</td></tr></table>
</body></html>`;
}

const chip = (label: string, role = false) => `<span style="display:inline-block;margin:0 6px 6px 0;padding:3px 11px;border-radius:999px;font-size:12.5px;font-weight:700;line-height:18px;${role ? "background:#d6f3e9;color:#085041;border:1px solid #a9e2cf;" : `background:${C.chip};color:${C.chipInk};`}">${escape(label)}</span>`;
const row = (label: string, value: string) => `<tr><td valign="top" style="width:96px;padding:6px 0;font-size:13px;font-weight:600;color:${C.muted};">${label}</td><td style="padding:6px 0;font-size:14px;color:${C.ink};">${value}</td></tr>`;
const feature = (glyph: string, color: string, title: string, text: string) => `<td class="vso-col" valign="top" width="50%" style="padding:8px 8px 8px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
  <td valign="top" style="width:30px;"><div style="width:30px;height:30px;border-radius:9px;background:${color};color:#ffffff;font-size:14px;font-weight:800;line-height:30px;text-align:center;">${glyph}</div></td>
  <td valign="top" style="padding-left:10px;font-family:${BODY};font-size:13.5px;line-height:19px;color:${C.ink2};"><b style="display:block;color:${C.ink};">${title}</b>${text}</td></tr></table></td>`;

const longDate = (value: Date) => new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(value);
const joinNames = (names: string[]) => names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} & ${names.at(-1)}`;

export type InviteEmailInput = { inviterName: string; workspaceName: string; role: string; ventures: string[]; groups: string[]; url: string; expiresAt: Date };

export function renderInviteEmail(input: InviteEmailInput): RenderedEmail {
  const firstName = input.inviterName.split(/\s+/)[0] || input.inviterName;
  const role = input.role.replaceAll("_", " ");
  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
  const where = input.ventures.length ? joinNames(input.ventures) : input.workspaceName;
  const expires = longDate(input.expiresAt);
  const subject = `${firstName} invited you to ${input.workspaceName}`;
  const body = `<p style="margin:0 0 4px;"><b style="color:${C.ink};">${escape(input.inviterName)}</b> added you to the ${escape(input.workspaceName)} workspace as a <b style="color:${C.ink};">${escape(role)}</b>.</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 4px;border:1px solid ${C.line};border-radius:14px;border-collapse:separate;"><tr><td style="padding:10px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:${BODY};">
    ${row("Role", chip(roleLabel, true))}
    ${input.ventures.length ? row("Ventures", input.ventures.map((name) => chip(name)).join("")) : ""}
    ${input.groups.length ? row("Groups", escape(input.groups.join(", "))) : ""}
  </table></td></tr></table>
  ${button(`Join ${input.workspaceName}`, input.url)}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;"><tr>
    ${feature("&#10003;", "#10b981", "Tasks &amp; reviews", "Your assignments, evidence and reviews in one place.")}
    ${feature("#", "#4f46e5", "Group channels", "Talk with your team and hand off work with /assign.")}
  </tr><tr>
    ${feature("&#10022;", "#7c3aed", "Knowledge", "Approved notes, decisions and files for each venture.")}
    ${feature("&#8984;", "#ea580c", "Claude, connected", "Ask Claude Code what's on your plate, once you've joined.")}
  </tr></table>`;
  const footer = `Button not working? Paste this link into your browser:<br><a href="${escape(input.url)}" style="color:${C.chipInk};word-break:break-all;">${escape(input.url)}</a><br><br>This invitation expires on <b style="color:${C.ink2};">${expires}</b>. If it has expired, ask ${escape(firstName)} to send a new one.<br><br>Not expecting this, or wrong address? You can ignore this email. Nothing happens unless you accept.`;
  const html = shell({ title: `You're invited to ${where}`, preheader: `${input.inviterName} invited you to join ${where} as a ${role}.`, kicker: "Invitation", headline: `You're invited to<br>${escape(where)}`, heroHeight: 200, body, footer, legal: `Sent by ${escape(input.workspaceName)} because ${escape(input.inviterName)} invited this address.`, origin: new URL(input.url).origin });
  const text = [
    `${input.inviterName} invited you to ${input.workspaceName}`,
    "",
    `You're invited to ${where} as a ${role}.`,
    "",
    `Role: ${roleLabel}`,
    ...(input.ventures.length ? [`Ventures: ${input.ventures.join(", ")}`] : []),
    ...(input.groups.length ? [`Groups: ${input.groups.join(", ")}`] : []),
    "",
    `Join ${input.workspaceName}: ${input.url}`,
    "",
    `This invitation expires on ${expires}. If it has expired, ask ${firstName} to send a new one.`,
    "Not expecting this, or wrong address? You can ignore this email. Nothing happens unless you accept.",
  ].join("\n");
  return { subject, html, text, attachments: art() };
}

export function renderSignInEmail(input: { url: string; email: string; minutes: number }): RenderedEmail {
  const subject = "Your Venture Studio sign-in link";
  const body = `<p style="margin:0;">Use the button below to sign in to Venture Studio as <b style="color:${C.ink};">${escape(input.email)}</b>. It works once and expires in ${input.minutes} minutes.</p>
  ${button("Sign in to Venture Studio", input.url)}`;
  const footer = `Button not working? Paste this link into your browser:<br><a href="${escape(input.url)}" style="color:${C.chipInk};word-break:break-all;">${escape(input.url)}</a><br><br>Didn't ask to sign in? You can ignore this email. Nobody can sign in without this link.`;
  const html = shell({ title: "Your sign-in link", preheader: `Your one-time sign-in link. It expires in ${input.minutes} minutes.`, kicker: "Sign in", headline: "Your sign-in link", heroHeight: 150, body, footer, legal: "Sent by Venture Studio because someone asked to sign in with this address.", origin: new URL(input.url).origin });
  const text = [`Sign in to Venture Studio as ${input.email}:`, input.url, "", `The link works once and expires in ${input.minutes} minutes.`, "Didn't ask to sign in? You can ignore this email. Nobody can sign in without this link."].join("\n");
  return { subject, html, text, attachments: art() };
}
