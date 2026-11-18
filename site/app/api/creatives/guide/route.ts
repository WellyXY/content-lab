import { getD1, jsonError } from "@/lib/server/content-db";

export const dynamic = "force-dynamic";

/** A country's latest creative guide (or a given version) and the list of countries that have one. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const country = (url.searchParams.get("country") ?? "").toUpperCase();
  const version = Number(url.searchParams.get("version") ?? 0);
  try {
    const db = getD1();
    const countries = (await db.prepare("SELECT country, MAX(version) AS version, MAX(created_at) AS created_at FROM creative_guides GROUP BY country ORDER BY country").all()).results;
    const row = country ? await (version
      ? db.prepare("SELECT * FROM creative_guides WHERE country = ? AND version = ?").bind(country, version)
      : db.prepare("SELECT * FROM creative_guides WHERE country = ? ORDER BY version DESC LIMIT 1").bind(country)).first<Record<string, unknown>>() : null;
    const guide = row ? { id: row.id, country: row.country, version: row.version, createdAt: row.created_at, model: row.model, document: JSON.parse(String(row.document_json)), evidence: JSON.parse(String(row.evidence_json)) } : null;
    return Response.json({ countries, guide }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("creative guide read failed", error);
    return jsonError("暂时无法读取素材指南 · Could not load the creative guide", 503);
  }
}
