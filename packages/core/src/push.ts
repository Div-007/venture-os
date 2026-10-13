const trustedHosts = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com", "push.services.mozilla.com"]);

export function isTrustedPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && !url.username && !url.password
      && !url.hash
      && (!url.port || url.port === "443")
      && (trustedHosts.has(host) || host.endsWith(".push.apple.com") || host.endsWith(".notify.windows.com"));
  } catch {
    return false;
  }
}
