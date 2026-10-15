import { computeCalibration, type CalibrationRow } from "@/lib/calibration";
import { getD1, jsonError } from "@/lib/server/content-db";

export const dynamic = "force-dynamic";

/** How the frozen blind scores line up with Spark Ads outcomes so far. */
export async function GET() {
  try {
    const db = getD1();
    const result = await db.prepare(`SELECT p.id, p.market, p.post_type, p.creator_handle,
        json_extract(p.ads_json, '$.lifetime.spend') AS spend, json_extract(p.ads_json, '$.lifetime.registrations') AS registrations,
        json_extract(ev.inputs_json, '$.registrationPotential') AS registration_potential, json_extract(ev.inputs_json, '$.creativeScore') AS creative_score
      FROM posts p JOIN predictions ev ON ev.id = (SELECT id FROM predictions WHERE post_id = p.id AND id LIKE 'eval-%' ORDER BY made_at DESC LIMIT 1)`).all();
    const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
    const rows: CalibrationRow[] = (result.results as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id), market: String(row.market), postType: String(row.post_type ?? "video"), creatorHandle: typeof row.creator_handle === "string" ? row.creator_handle : null,
      spend: number(row.spend), registrations: number(row.registrations), registrationPotential: number(row.registration_potential), creativeScore: number(row.creative_score),
    }));
    return Response.json({ evaluated: rows.length, ...computeCalibration(rows) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("calibration read failed", error);
    return jsonError("暂时无法读取校准数据 · Could not load calibration", 503);
  }
}
