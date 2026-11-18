import { getD1, jsonError } from "@/lib/server/content-db";

export const dynamic = "force-dynamic";

/** One regular ad creative, with the countries that have a guide. */
export async function GET(_request: Request, context: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await context.params;
  try {
    const row = await getD1().prepare("SELECT model_json FROM creatives WHERE video_id = ? LIMIT 1").bind(videoId).first<{ model_json: string }>();
    if (!row) return jsonError("找不到这支素材 · Creative not found", 404);
    const guides = await getD1().prepare("SELECT DISTINCT country FROM creative_guides").all();
    return Response.json({ creative: JSON.parse(row.model_json) as unknown, guides: guides.results }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("creative read failed", error);
    return jsonError("暂时无法读取素材 · Could not load the creative", 503);
  }
}
