"use client";

import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Clock3, Film, Flame, MessageCircle, Play, RefreshCw, Share2, Sparkles, ThumbsUp } from "lucide-react";
import { Line, LineChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { toast } from "sonner";

import { AssessmentCard, ComputedFeaturesCard, ScriptTimeline } from "@/components/content-lab/analysis-panels";
import { RelativeTime } from "@/components/content-lab/relative-time";
import { useLocale } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { compactNumber, tagLabel, tagDimensionLabel, tagConfidenceLabel, type PostDetailData } from "@/lib/content-lab";


export default function PostDetailPage() {
  const { t, pick, lang } = useLocale();
  const chartConfig = { views: { label: t("累计 VV", "Total views"), color: "var(--chart-2)" } } satisfies ChartConfig;
  const params = useParams<{ id: string }>();
  const [data, setData] = useState<PostDetailData | null>(null);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const [showEmbed, setShowEmbed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  useLayoutEffect(() => {
    // Reset on entry, before async content replaces the skeleton. Polling must
    // not move the reader, and explicit fragment links keep their own target.
    if (!window.location.hash) window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [params.id]);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => fetch(`/api/posts/${encodeURIComponent(params.id)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? t("这条帖子不存在。", "This post does not exist.") : t("暂时无法读取帖子，请稍后重试。", "Could not load the post; try again shortly."));
        return response.json() as Promise<PostDetailData>;
      })
      .then(setData)
      .catch((error) => { if (!controller.signal.aborted) setLoadError(error.message); })
      .finally(() => setLoading(false));
    void refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [params.id]);

  const engagement = useMemo(() => {
    if (!data?.post.views) return 0;
    return ((data.post.likes + data.post.comments + data.post.shares) / data.post.views) * 100;
  }, [data]);

  async function retryAnalysis() {
    if (!data) return;
    setRetrying(true);
    try {
      const response = await fetch(`/api/posts/${encodeURIComponent(data.post.id)}`, { method: "POST" });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(result.error ?? t("重新排队失败", "Could not requeue"));
      }
      toast.success(t("已重新加入分析队列", "Queued for a new analysis"));
      setData((current) => current ? { ...current, post: { ...current.post, analysisState: "queued" } } : current);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("重新排队失败", "Could not requeue"));
    } finally { setRetrying(false); }
  }

  if (loading) return <DetailSkeleton />;
  if (!data) return <Empty className="min-h-[60vh] border-white/8"><EmptyHeader><EmptyMedia variant="icon"><Film /></EmptyMedia><EmptyTitle>{t("找不到这条帖子", "Post not found")}</EmptyTitle><EmptyDescription>{loadError ?? t("它可能尚未同步，或链接已失效。", "It may not be synced yet, or the link is invalid.")}</EmptyDescription></EmptyHeader><Button asChild variant="outline"><Link href="/posts">{t("返回帖子列表", "Back to posts")}</Link></Button></Empty>;

  const post = data.post;
  const frames = data.keyframes ?? data.features?.keyframes ?? [];
  const videoId = post.url.match(/\/(?:video|photo)\/(\d+)/)?.[1];
  const prediction = data.predictions[0];
  const tagEntries = Object.entries(data.features?.tags ?? {});

  return (
    <>
      <div className="mb-6 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
        <div className="min-w-0">
          <Link className="font-mono text-[11px] uppercase tracking-[0.15em] text-primary hover:underline" href="/posts">Posts / {post.market}</Link>
          <h1 className="mt-3 truncate text-3xl font-semibold tracking-[-0.045em] sm:text-[38px]">{post.creatorHandle ?? t("等待创作者资料", "Waiting for creator data")}</h1>
          <p className="mt-2 max-w-3xl truncate text-sm text-muted-foreground sm:text-base">{post.caption ?? post.url}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge className="border-white/10 bg-white/[0.03] text-muted-foreground" variant="outline">{post.market}</Badge>
            {post.projectTag ? <Badge className="border-white/10 bg-white/[0.03] text-muted-foreground" variant="outline">{post.projectTag}</Badge> : null}
            <Badge className={post.analysisState === "complete" ? "border-primary/20 bg-primary/8 text-primary" : "border-amber-300/20 bg-amber-300/8 text-amber-200"} variant="outline">{post.analysisState === "complete" ? t("分析完成", "Analyzed") : post.analysisState === "failed" ? t("分析失败，可重试", "Analysis failed; retry") : t("等待分析结果", "Analysis pending")}</Badge>
            <span className="flex items-center gap-1 text-xs text-muted-foreground"><Clock3 className="size-3.5" /><RelativeTime value={post.lastCapturedAt} /></span>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button asChild variant="outline"><a href={post.url} rel="noreferrer" target="_blank"><Play />{t("在 TikTok 查看", "Open on TikTok")}</a></Button>
          <Button disabled={retrying} onClick={retryAnalysis} variant="outline"><RefreshCw className={retrying ? "animate-spin" : ""} />{t("重试分析", "Re-analyze")}</Button>
        </div>
      </div>

      <Card className="mb-4 border-white/8 bg-card/80 shadow-none">
        <CardHeader><CardTitle className="text-lg">{t("原始内容", "Original post")}</CardTitle><CardDescription>{t("来自 TikTok 的真实帖子；平台限制播放时可打开原始链接。", "The real TikTok post; open the original link if playback is blocked.")}</CardDescription></CardHeader>
        <CardContent>{post.postType === "video" && post.mediaUrl && !playbackFailed ? <video className="mx-auto max-h-[650px] w-full max-w-[430px] rounded-lg bg-black" controls playsInline preload="metadata" poster={post.thumbnailUrl ?? undefined} src={post.mediaUrl} onError={() => setPlaybackFailed(true)} aria-label={t("原始视频", "Original video")} /> : videoId ? (showEmbed
          ? <iframe className="mx-auto h-[650px] w-full max-w-[370px] rounded-lg border-0 bg-black" src={`https://www.tiktok.com/player/v1/${videoId}`} title={t("TikTok 原始内容", "Original TikTok post")} allow="fullscreen; encrypted-media" allowFullScreen />
          // The TikTok embed grabs focus and scrolls the page when it loads, so it only loads on request.
          : <button className="relative mx-auto grid h-[420px] w-full max-w-[260px] place-items-center overflow-hidden rounded-lg border border-white/10 bg-black" onClick={() => setShowEmbed(true)} type="button">{post.thumbnailUrl ? <img alt="" className="absolute inset-0 h-full w-full object-cover opacity-70" src={post.thumbnailUrl} /> : null}<span className="relative flex items-center gap-2 rounded-full bg-black/70 px-4 py-2 text-sm"><Play className="size-4" />{t("加载 TikTok 播放器", "Load the TikTok player")}</span></button>) : <a className="text-primary underline" href={post.url} target="_blank" rel="noreferrer">{t("在 TikTok 打开原始内容", "Open the original on TikTok")}</a>}</CardContent>
      </Card>
      <section aria-label={t("帖子指标", "Post metrics")} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MiniMetric icon={Play} label={t("累计 VV", "Views")} value={compactNumber(post.lastCapturedAt ? post.views : null)} />
        <MiniMetric icon={ThumbsUp} label={t("点赞", "Likes")} value={compactNumber(post.lastCapturedAt ? post.likes : null)} />
        <MiniMetric icon={MessageCircle} label={t("评论", "Comments")} value={compactNumber(post.lastCapturedAt ? post.comments : null)} />
        <MiniMetric icon={Share2} label={t("分享", "Shares")} value={compactNumber(post.lastCapturedAt ? post.shares : null)} />
        <MiniMetric icon={Sparkles} label={t("互动率", "Engagement")} value={post.lastCapturedAt ? `${engagement.toFixed(2)}%` : "—"} />
      </section>

      <section className="mt-4 grid items-start gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(300px,.55fr)]">
        <Card className="border-white/8 bg-card/80 shadow-none">
          <CardHeader className="border-b border-white/8 pb-5">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle className="text-lg">{t("小时播放曲线", "Hourly views")}</CardTitle><CardDescription className="mt-1">{t("断点代表缺失，跨缺口的增量标为 interpolated", "Gaps are missing hours; deltas across a gap are marked interpolated")}</CardDescription></div><Badge className="border-cyan-300/15 bg-cyan-300/8 text-cyan-200" variant="outline">24h +{compactNumber(post.delta24h)}</Badge></div>
          </CardHeader>
          <CardContent className="px-3 pb-2 pt-6 sm:px-6">
            {data.snapshots.length ? (
              <ChartContainer className="h-[340px] w-full aspect-auto" config={chartConfig}>
                <LineChart data={data.snapshots} margin={{ left: 0, right: 12, top: 12, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="4 6" vertical={false} />
                  <XAxis axisLine={false} dataKey="capturedAt" minTickGap={46} tickFormatter={(value) => new Date(value).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US", { month: "numeric", day: "numeric", hour: "numeric" })} tickLine={false} />
                  <YAxis axisLine={false} tickFormatter={(value) => compactNumber(Number(value))} tickLine={false} width={50} />
                  <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, payload) => payload?.[0]?.payload?.capturedAt ? new Date(payload[0].payload.capturedAt).toLocaleString(lang === "zh" ? "zh-CN" : "en-US") : ""} />} />
                  <Line connectNulls={false} dataKey="views" dot={false} stroke="var(--color-views)" strokeWidth={2.25} type="monotone" />
                </LineChart>
              </ChartContainer>
            ) : <Empty className="h-[340px] border-0"><EmptyHeader><EmptyMedia variant="icon"><Film /></EmptyMedia><EmptyTitle>{t("等待第一笔快照", "Waiting for the first snapshot")}</EmptyTitle><EmptyDescription>{t("本机 worker 接走任务后，曲线会从这里开始。", "The curve starts once the local worker picks up the job.")}</EmptyDescription></EmptyHeader></Empty>}
          </CardContent>
        </Card>

        <ComputedFeaturesCard computed={data.features?.computed ?? {}} />
      </section>

      <div className="mt-4"><AssessmentCard market={post.market} prediction={prediction} /></div>

      <section className="mt-4 grid items-start gap-4 xl:grid-cols-[minmax(0,.8fr)_minmax(0,1.2fr)]">
        <Card className="border-white/8 bg-card/80 shadow-none">
          <CardHeader className="border-b border-white/8 pb-5"><CardTitle className="text-lg">{t("Agent 标签", "Agent tags")}</CardTitle><CardDescription>{t("分类词表", "Taxonomy")} {data.features?.taxonomyVersion ?? "v3"} · {t("固定分类", "closed set")}</CardDescription></CardHeader>
          <CardContent className="pt-6">
            {tagEntries.length ? <div className="grid gap-3 sm:grid-cols-2">{tagEntries.map(([key, raw]) => { const value = tagValue(raw); return <div className="rounded-lg border border-white/8 bg-white/[0.025] p-3" key={key}><p className="text-sm text-muted-foreground">{tagDimensionLabel(key, lang)}</p><div className="mt-2 flex items-start justify-between gap-3"><p className="min-w-0 text-sm font-medium">{tagLabel(value.value, key, lang)}</p>{value.confidence ? <span className="shrink-0 text-xs text-muted-foreground">{tagConfidenceLabel(value.confidence, lang)}</span> : null}</div></div>; })}</div> : <div className="py-12 text-center text-sm text-muted-foreground">{t("Agent 还在分析内容。", "The Agent is still analyzing.")}</div>}
          </CardContent>
        </Card>

        <Card className="border-white/8 bg-card/80 shadow-none">
          <CardHeader className="border-b border-white/8 pb-5"><CardTitle className="text-lg">{t("脚本拆解", "Script breakdown")}</CardTitle><CardDescription>{t("数字由程序计算，Agent 只负责解读", "Numbers come from the program; the Agent interprets")}</CardDescription></CardHeader>
          <CardContent className="space-y-6 pt-6">
            <div><p className="font-mono text-[10px] uppercase tracking-[0.13em] text-primary">{t("开场钩子", "Hook")}</p><blockquote className="mt-2 border-l-2 border-primary/60 pl-4 text-base leading-7">{pick(data.features?.texts, "hook_translation") || data.features?.hookTranslationZh || t("等待分析", "Pending")}</blockquote>{data.features?.hookText ? <p className="mt-2 pl-[18px] text-sm text-muted-foreground">{data.features.hookText}</p> : null}</div>
            <div><p className="font-mono text-[10px] uppercase tracking-[0.13em] text-cyan-200">{t("一句话公式", "Formula")}</p><p className="mt-2 text-sm leading-7 text-foreground/90">{pick(data.features?.texts, "formula") || data.features?.formulaZh || t("等待 Agent 生成公式", "Waiting for the Agent")}</p></div>
            <div><p className="font-mono text-[10px] uppercase tracking-[0.13em] text-muted-foreground">{t("摘要", "Summary")}</p><p className="mt-2 text-sm leading-7 text-muted-foreground">{pick(data.features?.texts, "summary") || data.features?.summaryZh || t("等待 Agent 生成摘要", "Waiting for the Agent")}</p></div>
          </CardContent>
        </Card>
      </section>

        <Card className="mt-4 border-white/8 bg-card/80 shadow-none">
          <CardHeader className="border-b border-white/8 pb-5"><CardTitle className="text-lg">{t("分段脚本", "Timed script")}</CardTitle><CardDescription>{post.postType === "photo" ? t("按图集顺序逐张拆解", "One beat per carousel image") : t("按时间拆解画面、字幕与台词；台词由本机 Whisper 转写", "Visuals, on-screen text and speech by time; speech transcribed locally by Whisper")}</CardDescription></CardHeader>
          <CardContent className="pt-6"><ScriptTimeline frames={frames} script={data.features?.script ?? []} /></CardContent>
        </Card>


      <Card className="mt-4 border-white/8 bg-card/80 shadow-none">
        <CardHeader className="border-b border-white/8 pb-5"><CardTitle className="text-lg">{t("关键帧", "Keyframes")}</CardTitle><CardDescription>{post.postType === "photo" ? t("图集的全部图片，交给 Claude 分析", "Every carousel image, analyzed by Claude") : t("本机 ffmpeg 按画面切换抽帧，交给 Claude 分析", "Extracted at scene changes by local ffmpeg, analyzed by Claude")}</CardDescription></CardHeader>
        <CardContent className="pt-6">
          {frames.length ? <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">{frames.map((frame, index) => <figure className="overflow-hidden rounded-lg border border-white/8 bg-black" key={frame}><img alt={t(`关键帧 ${index + 1}`, `Keyframe ${index + 1}`)} className="aspect-[9/16] h-full w-full object-cover" loading="lazy" src={frame} /><figcaption className="sr-only">{t(`关键帧 ${index + 1}`, `Keyframe ${index + 1}`)}</figcaption></figure>)}</div> : <Empty className="border-dashed border-white/8 py-12"><EmptyHeader><EmptyMedia variant="icon"><Film /></EmptyMedia><EmptyTitle>{data.mediaError ?? t("尚无关键帧", "No keyframes yet")}</EmptyTitle><EmptyDescription>{post.analysisState === "failed" ? t("媒体获取或分析失败，请查看处理队列并重试。", "Media download or analysis failed; check the queue and retry.") : t("本机获取媒体并抽帧后，图片会同步显示在这里。", "Frames appear here once the local worker downloads the media.")}</EmptyDescription></EmptyHeader></Empty>}
        </CardContent>
      </Card>

      {data.alerts.length ? <section className="mt-4 rounded-xl border border-[#ff715b]/18 bg-[#ff715b]/[0.055] p-5 sm:p-6"><div className="flex items-start gap-4"><div className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-[#ff715b]/12 text-[#ff8a76]"><Flame className="size-5" /></div><div><p className="font-medium">{t(`这条帖子已触发 ${data.alerts.length} 次信号`, `${data.alerts.length} signal${data.alerts.length === 1 ? "" : "s"} for this post`)}</p><p className="mt-1 text-sm text-muted-foreground">{t("最近：", "Latest: ")}{data.alerts[0].rule.replaceAll("_", " ")} · <RelativeTime value={data.alerts[0].firedAt} /></p></div></div></section> : null}
    </>
  );
}

function MiniMetric({ icon: Icon, label, value }: { icon: typeof Play; label: string; value: string }) {
  return <Card className="gap-3 border-white/8 bg-card/80 py-4 shadow-none"><CardHeader className="flex-row items-center gap-2 px-4"><Icon className="size-4 text-muted-foreground" /><CardDescription className="font-mono text-[10px] uppercase tracking-[0.1em]">{label}</CardDescription></CardHeader><CardContent className="px-4"><p className="text-2xl font-semibold tracking-[-0.04em]">{value}</p></CardContent></Card>;
}

function DetailSkeleton() {
  return <div className="space-y-4"><Skeleton className="h-24 w-full max-w-2xl" /><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{Array.from({ length: 5 }, (_, index) => <Skeleton className="h-24" key={index} />)}</div><Skeleton className="h-[430px] w-full" /></div>;
}

function tagValue(raw: unknown): { value: string | string[]; confidence: string | null } {
  if (typeof raw === "string") return { value: raw, confidence: null };
  if (raw && typeof raw === "object") {
    const value = (raw as Record<string, unknown>).value;
    const confidence = (raw as Record<string, unknown>).confidence;
    if (Array.isArray(value)) return { value: value.filter((item): item is string => typeof item === "string"), confidence: typeof confidence === "string" ? confidence : null };
    return { value: typeof value === "string" ? value : "—", confidence: typeof confidence === "string" ? confidence : null };
  }
  return { value: "—", confidence: null };
}
