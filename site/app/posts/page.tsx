"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Clock3, ListFilter, Play, Search } from "lucide-react";

import { PostAdsCells, PostAdsHeadCells } from "@/components/content-lab/ads-panels";
import { RelativeTime } from "@/components/content-lab/relative-time";
import { adsSortValue } from "@/lib/ads";
import { useLocale } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MARKETS, compactNumber, tagLabel, type PostSummary } from "@/lib/content-lab";
import { comparePublishedNewest, formatPublishedTime } from "@/lib/published-time";

const POTENTIAL_RANK = { high: 0, medium: 1, low: 2 } as const;
const POTENTIAL_BADGE = {
  high: { label: ["爆款可能性高", "High potential"], className: "border-primary/20 bg-primary/8 text-primary" },
  medium: { label: ["爆款可能性中", "Medium potential"], className: "border-amber-300/20 bg-amber-300/8 text-amber-200" },
  low: { label: ["爆款可能性低", "Low potential"], className: "border-[#ff715b]/20 bg-[#ff715b]/8 text-[#ff9c8d]" },
} as const;

export default function PostsPage() {
  const { t, lang } = useLocale();
  const [posts, setPosts] = useState<PostSummary[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [market, setMarket] = useState("all");
  const [state, setState] = useState("all");
  const [kind, setKind] = useState("all");
  const [sort, setSort] = useState("publishedAt");

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => fetch(`/api/posts?sort=${encodeURIComponent(sort)}&limit=5000`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("posts unavailable");
        return response.json() as Promise<{ mode: "live"; posts: PostSummary[] }>;
      })
      .then((result) => { if (!controller.signal.aborted) { setPosts(result.posts); setError(false); } })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    void refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [sort]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const result = posts.filter((post) => {
      if (market !== "all" && post.market !== market) return false;
      if (state !== "all" && post.trackingState !== state) return false;
      if (kind !== "all" && post.postType !== kind) return false;
      if (!normalized) return true;
      return [post.creatorHandle, post.caption, post.projectTag].some((value) => value?.toLowerCase().includes(normalized));
    });
    return result.sort((a, b) => {
      if (sort === "publishedAt") return comparePublishedNewest(a, b);
      if (sort === "views") return b.views - a.views;
      if (sort === "newest") return new Date(b.boundAt).getTime() - new Date(a.boundAt).getTime();
      if (sort === "spend" || sort === "registrations" || sort === "cpr") return adsSortValue(b, sort) - adsSortValue(a, sort) || b.views - a.views;
      if (sort === "registrationPotential") return (b.registrationPotential ?? -1) - (a.registrationPotential ?? -1) || (b.creativeScore ?? -1) - (a.creativeScore ?? -1) || b.views - a.views;
      if (sort === "potential") return (a.potential ? POTENTIAL_RANK[a.potential] : 3) - (b.potential ? POTENTIAL_RANK[b.potential] : 3) || b.views - a.views;
      return b.delta24h - a.delta24h;
    });
  }, [kind, market, posts, query, sort, state]);

  return (
    <>
      <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.15em] text-primary"><span className="inline-block h-px w-7 bg-primary" />Tracked content</div>
          <h1 className="text-3xl font-semibold tracking-[-0.045em] sm:text-[38px]">{t("帖子雷达", "Post radar")}</h1>
          <p className="mt-2 text-sm text-muted-foreground sm:text-base">{t("按增速、累计播放与爆款可能性找到值得跟进的内容。", "Find posts worth following by growth, total views and viral potential.")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge className="border-white/10 bg-white/[0.03] text-muted-foreground" variant="outline">{t(`${filtered.length} 条`, `${filtered.length} posts`)}</Badge>
        </div>
      </div>

      <Card className="gap-0 overflow-hidden border-white/8 bg-card/80 py-0 shadow-none">
        <div className="grid gap-3 border-b border-white/8 p-4 md:grid-cols-[minmax(220px,1fr)_150px_130px_150px_220px]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label={t("搜索创作者、文案或项目", "Search creators, captions or projects")} className="h-10 border-white/10 bg-white/[0.025] pl-9" onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索创作者、文案、项目", "Search creators, captions, projects")} value={query} />
          </div>
          <Select onValueChange={setMarket} value={market}>
            <SelectTrigger className="h-10 w-full border-white/10 bg-white/[0.025]"><SelectValue placeholder={t("全部市场", "All markets")} /></SelectTrigger>
            <SelectContent><SelectItem value="all">{t("全部市场", "All markets")}</SelectItem>{MARKETS.map((item) => <SelectItem key={item.code} value={item.code}>{item.code} {t(item.label, item.labelEn)}</SelectItem>)}</SelectContent>
          </Select>
          <Select onValueChange={setKind} value={kind}>
            <SelectTrigger aria-label={t("内容类型", "Post type")} className="h-10 w-full border-white/10 bg-white/[0.025]"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">{t("全部类型", "All types")}</SelectItem><SelectItem value="video">{t("视频", "Video")}</SelectItem><SelectItem value="photo">{t("图文", "Photo")}</SelectItem></SelectContent>
          </Select>
          <Select onValueChange={setState} value={state}>
            <SelectTrigger className="h-10 w-full border-white/10 bg-white/[0.025]"><SelectValue placeholder={t("全部状态", "All states")} /></SelectTrigger>
            <SelectContent><SelectItem value="all">{t("全部状态", "All states")}</SelectItem><SelectItem value="active">{t("每小时", "Hourly")}</SelectItem><SelectItem value="slow">{t("每 3 小时", "Every 3h")}</SelectItem><SelectItem value="daily">{t("每日", "Daily")}</SelectItem><SelectItem value="stopped">{t("已停止", "Stopped")}</SelectItem></SelectContent>
          </Select>
          <Select onValueChange={setSort} value={sort}>
            <SelectTrigger aria-label={t("排序", "Sort posts")} className="h-10 w-full border-white/10 bg-white/[0.025]"><ListFilter /><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="publishedAt">{t("发布时间（由新到旧）", "Published (newest first)")}</SelectItem><SelectItem value="delta24h">{t("24h 增量", "24h growth")}</SelectItem><SelectItem value="views">{t("累计播放", "Total views")}</SelectItem><SelectItem value="registrationPotential">{t("注册潜力（高到低）", "Registration potential (high first)")}</SelectItem><SelectItem value="potential">{t("爆款可能性（旧版）", "Viral potential (legacy)")}</SelectItem><SelectItem value="spend">{t("投放花费", "Ad spend")}</SelectItem><SelectItem value="registrations">{t("注册数", "Registrations")}</SelectItem><SelectItem value="cpr">{t("注册成本（低到高）", "Cost/reg (low to high)")}</SelectItem><SelectItem value="newest">{t("最新绑定", "Recently bound")}</SelectItem></SelectContent>
          </Select>
        </div>

        <CardContent className="p-0">
          {loading ? <div className="space-y-2 p-5">{Array.from({ length: 6 }, (_, index) => <Skeleton className="h-16 w-full" key={index} />)}</div> : filtered.length ? (
            <Table>
              <TableHeader><TableRow className="border-white/8 hover:bg-transparent"><TableHead className="pl-5 text-xs text-muted-foreground">{t("内容", "Post")}</TableHead><TableHead className="text-xs text-muted-foreground">{t("市场 / 项目", "Market / project")}</TableHead><TableHead className="text-xs text-muted-foreground">{t("发布时间", "Published")}</TableHead><TableHead className="text-right text-xs text-muted-foreground">{t("累计 VV", "Views")}</TableHead><TableHead className="text-right text-xs text-muted-foreground">{t("24h 增量", "24h growth")}</TableHead><PostAdsHeadCells /><TableHead className="hidden text-right text-xs text-muted-foreground md:table-cell" title={t("知识库 v2 盲测分数（0–10），不看这条帖子的成效", "Knowledge base v2 blind scores (0–10), made without this post's results")}>{t("注册潜力 / 创意", "Reg. potential / creative")}</TableHead><TableHead className="hidden text-xs text-muted-foreground lg:table-cell">{t("Agent 标签", "Agent tags")}</TableHead><TableHead className="hidden pr-5 text-right text-xs text-muted-foreground sm:table-cell">{t("状态", "Status")}</TableHead></TableRow></TableHeader>
              <TableBody>{filtered.map((post) => <PostRow key={post.id} post={post} />)}</TableBody>
            </Table>
          ) : (
            <Empty className="border-0 py-24"><EmptyHeader><EmptyMedia variant="icon"><Search /></EmptyMedia><EmptyTitle>{error ? t("暂时无法读取帖子", "Could not load posts") : posts.length ? t("没有符合条件的帖子", "No posts match") : t("尚未加入真实帖子", "No posts yet")}</EmptyTitle><EmptyDescription>{error ? t("请刷新重试，系统不会用示范内容代替数据。", "Refresh to retry; the site never substitutes demo data.") : t("导入 Excel／CSV 或粘贴 TikTok 链接，开始采集真实数据。", "Import Excel/CSV or paste TikTok links to start collecting real data.")}</EmptyDescription></EmptyHeader></Empty>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function PostRow({ post }: { post: PostSummary }) {
  const { t, lang } = useLocale();
  const status = statusCopy(post);
  // The v1 views-only badge gives way to the v2 scores once a post has them.
  const scored = post.registrationPotential != null || post.creativeScore != null;
  const potential = post.potential && !scored ? POTENTIAL_BADGE[post.potential] : null;
  const published = formatPublishedTime(post.publishedAt, MARKETS.find((market) => market.code === post.market)?.timezone);
  return (
    <TableRow className="border-white/8 hover:bg-white/[0.025]">
      <TableCell className="max-w-[320px] py-3 pl-5">
        <div className="flex items-center gap-3">
          <Link aria-label={t(`查看 ${post.creatorHandle ?? "帖子"}`, `Open ${post.creatorHandle ?? "post"}`)} className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-lg border border-white/10 bg-gradient-to-br from-cyan-300/15 to-primary/10 text-cyan-200" href={`/posts/${post.id}`}>
            {post.thumbnailUrl ? <img alt="" className="h-full w-full object-cover" src={post.thumbnailUrl} /> : <Play className="size-4" />}
          </Link>
          <div className="min-w-0">
            <Link className="block truncate text-sm font-medium hover:text-primary" href={`/posts/${post.id}`}>{post.creatorHandle ?? t("等待创作者资料", "Waiting for creator data")}</Link>
            <p className="mt-1 truncate text-xs text-muted-foreground">{post.caption ?? post.url}</p>
          </div>
        </div>
      </TableCell>
      <TableCell><p className="font-mono text-xs font-semibold">{post.market}</p><p className="mt-1 max-w-32 truncate text-xs text-muted-foreground">{post.projectTag ?? t("未分类", "Unassigned")}</p></TableCell>
      <TableCell className="whitespace-nowrap">
        {published ? <time dateTime={post.publishedAt ?? undefined} title={`${published.date} ${published.time} ${published.timeZone}`}>
          <span className="block font-mono text-sm tabular-nums">{published.date}</span>
          <span className="mt-1 block font-mono text-xs text-muted-foreground">{published.time} {published.timeZone}</span>
        </time> : <span className="text-sm text-muted-foreground">{t("未知", "Unknown")}</span>}
      </TableCell>
      <TableCell className="text-right font-mono font-semibold">{compactNumber(post.lastCapturedAt ? post.views : null)}</TableCell>
      <TableCell className="text-right"><span className="font-mono font-semibold text-cyan-200">{post.lastCapturedAt ? `+${compactNumber(post.delta24h)}` : "—"}</span></TableCell>
      <PostAdsCells post={post} />
      <TableCell className="hidden text-right md:table-cell"><ScorePair creative={post.creativeScore ?? null} registration={post.registrationPotential ?? null} /></TableCell>
      <TableCell className="hidden lg:table-cell"><div className="flex max-w-56 flex-wrap gap-1.5">{post.hookType ? <Badge className="border-white/10 bg-white/[0.03] text-muted-foreground" variant="outline">{tagLabel(post.hookType, "hook_type", lang)}</Badge> : null}{post.topic ? <Badge className="border-white/10 bg-white/[0.03] text-muted-foreground" variant="outline">{tagLabel(post.topic, "topic", lang)}</Badge> : null}{potential ? <Badge className={potential.className} variant="outline">{t(potential.label[0], potential.label[1])}</Badge> : null}</div></TableCell>
      <TableCell className="hidden pr-5 text-right sm:table-cell"><Badge className={status.className} variant="outline">{t(status.label[0], status.label[1])}</Badge><div className="mt-1.5 flex items-center justify-end gap-1 text-[11px] text-muted-foreground"><Clock3 className="size-3" /><RelativeTime value={post.lastCapturedAt} /></div></TableCell>
    </TableRow>
  );
}

function statusCopy(post: PostSummary) {
  if (post.analysisState === "failed") return { label: ["分析失败", "Analysis failed"] as const, className: "border-[#ff715b]/20 bg-[#ff715b]/8 text-[#ff9c8d]" };
  if (post.analysisState !== "complete") return { label: ["分析中", "Analyzing"] as const, className: "border-amber-300/20 bg-amber-300/8 text-amber-200" };
  if (post.trackingState === "stopped") return { label: ["已停止", "Stopped"] as const, className: "border-white/10 bg-white/[0.03] text-muted-foreground" };
  return { label: ["追踪中", "Tracking"] as const, className: "border-primary/20 bg-primary/8 text-primary" };
}

function ScorePair({ registration, creative }: { registration: number | null; creative: number | null }) {
  const { t } = useLocale();
  if (registration === null && creative === null) return <span className="text-sm text-muted-foreground">—</span>;
  const tone = registration === null ? "text-muted-foreground" : registration >= 7 ? "text-primary" : registration >= 4 ? "text-amber-200" : "text-[#ff9c8d]";
  return <span className="whitespace-nowrap font-mono text-sm tabular-nums" title={t(`注册潜力 ${registration ?? "—"} · 创意 ${creative ?? "—"}`, `Registration potential ${registration ?? "—"} · creative ${creative ?? "—"}`)}><span className={`font-semibold ${tone}`}>{registration ?? "—"}</span><span className="text-muted-foreground"> / {creative ?? "—"}</span></span>;
}
