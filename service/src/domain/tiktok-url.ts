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
  if (url.username || url.password || (url.port && url.port !== "443")) throw new Error("TikTok URLs cannot contain credentials or a custom port");
  url.search = "";
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (!SHORT_HOSTS.has(url.hostname) && url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

export function isShortTikTokUrl(input: string): boolean {
  const url = new URL(normalizeTikTokUrl(input));
  return SHORT_HOSTS.has(url.hostname) || /^\/t\/[A-Za-z0-9]+\/?$/.test(url.pathname);
}

export function extractVideoId(input: string): string | null {
  const { pathname } = new URL(normalizeTikTokUrl(input));
  return pathname.match(/\/(?:video|photo)\/(\d{8,})/)?.[1] ?? null;
}

/** Normalize a link that must point at one video or photo post (or a short link to one); profile and other pages are refused. */
export function normalizeTikTokPostUrl(input: string): string {
  const url = normalizeTikTokUrl(input);
  if (extractVideoId(url) || isShortTikTokUrl(url)) return url;
  throw new Error(/^\/@[^/]+$/.test(new URL(url).pathname)
    ? "这是 TikTok 账号主页，不是帖子链接；请打开具体视频后复制链接"
    : "不是 TikTok 帖子链接（需要 /video/ 或 /photo/ 链接，或 vt.tiktok.com 短链）");
}

export async function expandTikTokUrl(input: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const normalized = normalizeTikTokUrl(input);
  if (!isShortTikTokUrl(normalized)) return normalized;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    let current = normalized;
    for (let redirect = 0; redirect < 5; redirect += 1) {
      const response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "ContentLab/0.1" },
      });
      const location = response.headers.get("location");
      if (!location || response.status < 300 || response.status >= 400) throw new Error(`TikTok short URL returned ${response.status} without a redirect`);
      current = normalizeTikTokUrl(new URL(location, current).toString());
      if (extractVideoId(current)) return current;
    }
    throw new Error("TikTok short URL exceeded the redirect limit");
  } finally {
    clearTimeout(timer);
  }
}
