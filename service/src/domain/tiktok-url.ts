const SHORT_HOSTS = new Set(["vt.tiktok.com", "vm.tiktok.com"]);

export function isTikTokHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "tiktok.com" || host.endsWith(".tiktok.com");
}

export function normalizeTikTokUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("A valid HTTPS TikTok URL is required");
  }
  if (url.protocol !== "https:") throw new Error("Only HTTPS TikTok URLs are accepted");
  if (!isTikTokHost(url.hostname)) throw new Error("Only TikTok URLs are accepted");
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (!SHORT_HOSTS.has(url.hostname) && url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

export function isShortTikTokUrl(input: string): boolean {
  return SHORT_HOSTS.has(new URL(normalizeTikTokUrl(input)).hostname);
}

export function extractVideoId(input: string): string | null {
  const { pathname } = new URL(normalizeTikTokUrl(input));
  return pathname.match(/\/(?:video|photo)\/(\d{8,})/)?.[1] ?? null;
}

export async function expandTikTokUrl(input: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const normalized = normalizeTikTokUrl(input);
  if (!isShortTikTokUrl(normalized)) return normalized;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(normalized, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { "user-agent": "ContentLab/0.1" },
    });
    const location = response.headers.get("location");
    if (!location) throw new Error(`TikTok short URL returned ${response.status} without a redirect`);
    return normalizeTikTokUrl(new URL(location, normalized).toString());
  } finally {
    clearTimeout(timer);
  }
}
