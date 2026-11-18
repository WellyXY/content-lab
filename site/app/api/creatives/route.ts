import { getD1, jsonError } from "@/lib/server/content-db";

export const dynamic = "force-dynamic";

/** Every regular ad creative the worker has synced, with spend by window and country; the page filters and sorts. */
export async function GET() {
  try {
    const result = await getD1().prepare("SELECT model_json FROM creatives ORDER BY spend_30 DESC LIMIT 5000").all();
    const creatives = (result.results as Array<{ model_json: string }>).map((row) => { try { return JSON.parse(row.model_json) as unknown; } catch { return null; } }).filter(Boolean);
    const guides = await getD1().prepare("SELECT country, MAX(version) AS version FROM creative_guides GROUP BY country ORDER BY country").all();
    return Response.json({ creatives, guides: guides.results }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("creatives read failed", error);
    return jsonError("暂时无法读取常规素材 · Could not load creatives", 503);
  }
}
