export function cleanUrl(value: string): string {
  return value.trim().replace(/[)\]}.,]+$/, "");
}

export function extractTikTokUrls(value: string): string[] {
  const matches = value.match(/https?:\/\/[\w.-]*tiktok\.com\/[^\s"'<>;,]*/gi) ?? [];
  return [...new Set(matches.map(cleanUrl).filter((url) => {
    try { const host = new URL(url).hostname; return host === "tiktok.com" || host.endsWith(".tiktok.com"); }
    catch { return false; }
  }))];
}

export function linksFromSheets(sheets: Array<{ data: unknown[][] }>): string[] {
  return extractTikTokUrls(sheets.flatMap((sheet) => sheet.data.flatMap((row) => row.map((cell) => String(cell ?? "")))).join("\n"));
}
