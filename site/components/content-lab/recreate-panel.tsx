"use client";

import { Clapperboard, Download, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { PostSummary, Recreation } from "@/lib/content-lab";
import { useLocale } from "@/lib/i18n";

const CAP = 2;
const ACTIVE = new Set<Recreation["status"]>(["queued", "preparing", "designing", "rendering"]);

export const recreationsUsed = (recreations: Recreation[]): number => recreations.reduce((sum, item) => sum + item.counts, 0);

/** Header action: starts an Agent recreation while the post has attempts left. */
export function RecreateButton({ post, recreations, onStarted }: { post: PostSummary; recreations: Recreation[]; onStarted: (recreation: Recreation) => void }) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const used = recreationsUsed(recreations);
  const disabledReason = post.postType === "photo" ? t("图集暂不支持重制", "Carousels can't be recreated")
    : post.analysisState !== "complete" ? t("分析完成后可重制", "Recreate after analysis")
    : recreations.some((item) => ACTIVE.has(item.status)) ? t("重制进行中", "Recreating…")
    : used >= CAP ? t("重制次数已用完", "No recreations left") : null;

  async function start() {
    setBusy(true);
    try {
      const response = await fetch(`/api/posts/${encodeURIComponent(post.id)}/recreate`, { method: "POST" });
      const result = await response.json().catch(() => ({})) as { error?: string; recreationId?: string };
      if (!response.ok || !result.recreationId) throw new Error(result.error ?? t("暂时无法开始重制", "Could not start the recreation"));
      const now = new Date().toISOString();
      onStarted({ id: result.recreationId, status: "queued", notes: null, videoUrl: null, coverUrl: null, error: null, counts: 1, createdAt: now, updatedAt: now });
      toast.success(t("已排队，Agent 完成后会显示在下方", "Queued; the result appears below when the Agent finishes"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("暂时无法开始重制", "Could not start the recreation"));
    } finally { setBusy(false); }
  }

  return (
    <Button disabled={busy || disabledReason !== null} onClick={start}>
      {busy || recreations.some((item) => ACTIVE.has(item.status)) ? <Loader2 className="animate-spin" /> : <Clapperboard />}
      {disabledReason ?? t("Agent 重制", "Recreate by Agent")}
      <span className="font-mono text-xs opacity-70">{Math.max(0, CAP - used)}/{CAP}</span>
    </Button>
  );
}

const STAGES: Record<Recreation["status"], [string, string]> = {
  queued: ["排队中", "Queued"],
  preparing: ["准备素材", "Preparing material"],
  designing: ["Agent 设计动效中", "Agent is designing the motion"],
  rendering: ["渲染中", "Rendering"],
  complete: ["已完成", "Done"],
  failed: ["失败", "Failed"],
};

/** Worker error categories (never raw output, which can contain local paths). */
const ERRORS: Record<string, [string, string]> = {
  source_unavailable: ["原片无法下载（可能已删除或设为私密）。", "The source video could not be downloaded (it may be deleted or private)."],
  prepare_failed: ["准备素材失败。", "Preparing the material failed."],
  agent_failed: ["Agent 没能完成设计。", "The Agent could not finish the design."],
  render_failed: ["渲染失败。", "Rendering failed."],
  verify_failed: ["成片没有通过检查（尺寸、声音或时长）。", "The result failed its checks (size, audio or length)."],
  upload_failed: ["成片上传失败。", "Uploading the result failed."],
  post_not_tracked: ["本机没有追踪这条帖子。", "The local worker does not track this post."],
  worker_stopped: ["本机 worker 在制作中停止了。", "The local worker stopped during the recreation."],
  unknown: ["重制失败。", "The recreation failed."],
};

/** Every recreation of the post: progress, the rendered video and the Agent's notes. */
export function RecreatePanel({ recreations }: { recreations: Recreation[] }) {
  const { t, lang } = useLocale();
  if (!recreations.length) return null;
  return (
    <Card className="border-white/8 bg-card/60">
      <CardHeader>
        <CardTitle>{t("Agent 重制版本", "Agent recreations")}</CardTitle>
        <CardDescription>{t("按修改建议重新剪辑并加入动态图形；每条帖子最多 2 次。", "Re-edited with motion graphics from the suggestions; up to 2 per post.")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-8 md:grid-cols-2">
        {recreations.map((item) => (
          <div className="min-w-0 space-y-3" key={item.id}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {ACTIVE.has(item.status) ? <Loader2 className="size-4 animate-spin text-primary" /> : null}
              <span className={item.status === "failed" ? "text-red-300" : item.status === "complete" ? "text-primary" : ""}>{t(...STAGES[item.status])}</span>
              <span className="text-muted-foreground">{new Date(item.updatedAt).toLocaleString(lang === "en" ? "en" : "zh-CN")}</span>
            </div>
            {item.videoUrl ? (
              <div className="space-y-2">
                <video className="aspect-[9/16] w-full max-w-[320px] rounded-lg border border-white/8 bg-black" controls playsInline poster={item.coverUrl ?? undefined} preload="metadata" src={item.videoUrl} />
                <a className="inline-flex items-center gap-1 text-sm text-primary hover:underline" download href={item.videoUrl}><Download className="size-4" />{t("下载 MP4", "Download MP4")}</a>
              </div>
            ) : null}
            {item.notes ? (
              <div className="space-y-2 text-sm">
                <p>{lang === "en" ? item.notes.summary_en : item.notes.summary_zh}</p>
                {item.notes.changes.length ? <ul className="list-disc space-y-1 pl-5 text-muted-foreground">{item.notes.changes.map((change, index) => <li key={index}>{lang === "en" ? change.en : change.zh}</li>)}</ul> : null}
                {item.notes.skipped?.length ? (
                  <div className="pt-1">
                    <p className="text-xs text-muted-foreground">{t("需要重拍、这次没有采用的建议", "Suggestions that need a reshoot (not applied)")}</p>
                    <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground/80">{item.notes.skipped.map((skip, index) => <li key={index}>{lang === "en" ? skip.en : skip.zh}</li>)}</ul>
                  </div>
                ) : null}
              </div>
            ) : null}
            {item.status === "failed" ? <p className="text-sm text-red-300/80">{t(...(ERRORS[item.error ?? ""] ?? ERRORS.unknown!))}{item.counts === 0 ? t("这次不计次数。", " This attempt is not counted.") : ""}</p>
              : item.error === "paused_for_quota" ? <p className="text-sm text-amber-200/80">{t("Claude 额度暂时用完，恢复后会自动继续。", "Claude quota is used up for now; it resumes automatically.")}</p> : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
