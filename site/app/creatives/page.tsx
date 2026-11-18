"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { BookOpenText, ChevronLeft, ChevronRight, Clapperboard, Search } from "lucide-react";

import { formatMoney } from "@/lib/ads";
import { countriesBySpend, listCreatives, type Creative, type CreativeSort } from "@/lib/creatives";
import { compactNumber } from "@/lib/content-lab";
import { useLocale } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const PAGE_SIZE = 50;
const pct = (value: number | null): string => value === null ? "—" : `${(value * 100).toFixed(2)}%`;

export default function CreativesPage() {
  const { t } = useLocale();
  const [creatives, setCreatives] = useState<Creative[]>([]);
  const [guides, setGuides] = useState<Array<{ country: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [window, setWindow] = useState("7");
  const [country, setCountry] = useState("all");
  const [sort, setSort] = useState<CreativeSort>("spend");
  const [query, setQuery] = useState("");
  const router = useRouter();
  const [paging, setPaging] = useState({ key: "", page: 0 });

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/creatives", { cache: "no-store", signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error("creatives unavailable"); return response.json() as Promise<{ creatives: Creative[]; guides: Array<{ country: string }> }>; })
      .then((result) => { setCreatives(result.creatives); setGuides(result.guides); })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const days = Number(window);
  const selected = country === "all" ? null : country;
  const countries = useMemo(() => countriesBySpend(creatives, days), [creatives, days]);
  const rows = useMemo(() => listCreatives(creatives, days, selected, sort, query), [creatives, days, selected, sort, query]);
  const total = useMemo(() => rows.reduce((sum, row) => ({ spend: sum.spend + row.totals.spend, registrations: sum.registrations + row.totals.registrations }), { spend: 0, registrations: 0 }), [rows]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const filterKey = [window, country, sort, query].join("|");
  const current = Math.min(paging.key === filterKey ? paging.page : 0, pages - 1);
  const visible = rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const setPage = (page: number): void => { setPaging({ key: filterKey, page }); globalThis.scrollTo({ top: 0 }); };
  const hasGuide = (code: string) => guides.some((guide) => guide.country === code);

  return (
    <>
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.15em] text-primary"><span className="inline-block h-px w-7 bg-primary" />Regular ad creatives</div>
          <h1 className="text-3xl font-semibold tracking-[-0.045em] sm:text-[38px]">{t("常规素材", "Regular creatives")}</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground sm:text-base">{t("TikTok 上非 Spark Ads 的投放素材：所有有花费的视频，同一支视频跨广告、跨账户合并。数据每天更新一次。", "Non-Spark TikTok ad videos: every video with spend, merged across ads and accounts. Updated daily.")}</p>
        </div>
        <Button asChild variant="outline"><Link href={`/creatives/guide${selected ? `?country=${selected}` : ""}`}><BookOpenText />{t("分国家素材指南", "Guides by country")}</Link></Button>
      </div>

      <Card className="gap-0 overflow-hidden border-white/8 bg-card/80 py-0 shadow-none">
        <div className="grid gap-3 border-b border-white/8 p-4 md:grid-cols-[minmax(200px,1fr)_130px_170px_190px]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label={t("搜索文件名或广告系列", "Search file names or campaigns")} className="h-10 border-white/10 bg-white/[0.025] pl-9" onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索文件名、广告系列", "Search file names, campaigns")} value={query} />
          </div>
          <Select onValueChange={setWindow} value={window}>
            <SelectTrigger aria-label={t("时间范围", "Window")} className="h-10 w-full border-white/10 bg-white/[0.025]"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="7">{t("最近 7 天", "Last 7 days")}</SelectItem><SelectItem value="14">{t("最近 14 天", "Last 14 days")}</SelectItem><SelectItem value="30">{t("最近 30 天", "Last 30 days")}</SelectItem></SelectContent>
          </Select>
          <Select onValueChange={setCountry} value={country}>
            <SelectTrigger aria-label={t("国家", "Country")} className="h-10 w-full border-white/10 bg-white/[0.025]"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">{t("全部国家", "All countries")}</SelectItem>{countries.map((item) => <SelectItem key={item.country} value={item.country}>{item.country} · {formatMoney(item.spend)}</SelectItem>)}</SelectContent>
          </Select>
          <Select onValueChange={(value) => setSort(value as CreativeSort)} value={sort}>
            <SelectTrigger aria-label={t("排序", "Sort")} className="h-10 w-full border-white/10 bg-white/[0.025]"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="spend">{t("花费（高到低）", "Spend (high first)")}</SelectItem><SelectItem value="registrations">{t("注册数（高到低）", "Registrations (high first)")}</SelectItem><SelectItem value="cpr">{t("注册成本（低到高）", "Cost/reg (low first)")}</SelectItem></SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-white/8 px-5 py-3 text-sm text-muted-foreground">
          <span>{t(`${rows.length} 支素材`, `${rows.length} creatives`)}</span>
          <span>{t("花费", "Spend")} <span className="font-mono text-foreground">{formatMoney(total.spend)}</span></span>
          <span>{t("注册", "Registrations")} <span className="font-mono text-foreground">{compactNumber(total.registrations)}</span></span>
          <span>{t("注册成本", "Cost/reg")} <span className="font-mono text-foreground">{formatMoney(total.registrations > 0 ? total.spend / total.registrations : null)}</span></span>
          {selected && hasGuide(selected) ? <Link className="text-primary hover:underline" href={`/creatives/guide?country=${selected}`}>{t(`${selected} 素材指南 →`, `${selected} guide →`)}</Link> : null}
        </div>
        <CardContent className="p-0">
          {loading ? <div className="space-y-2 p-5">{Array.from({ length: 6 }, (_, index) => <Skeleton className="h-16 w-full" key={index} />)}</div> : visible.length ? (
            <Table>
              <TableHeader><TableRow className="border-white/8 hover:bg-transparent">
                <TableHead className="pl-5 text-xs text-muted-foreground">{t("素材", "Creative")}</TableHead>
                <TableHead className="text-right text-xs text-muted-foreground">{t("花费", "Spend")}</TableHead>
                <TableHead className="hidden text-right text-xs text-muted-foreground md:table-cell">{t("曝光", "Impr.")}</TableHead>
                <TableHead className="hidden text-right text-xs text-muted-foreground lg:table-cell">CTR</TableHead>
                <TableHead className="hidden text-right text-xs text-muted-foreground md:table-cell">{t("安装 / CPI", "Installs / CPI")}</TableHead>
                <TableHead className="text-right text-xs text-muted-foreground">{t("注册", "Regs")}</TableHead>
                <TableHead className="pr-5 text-right text-xs text-muted-foreground">{t("注册成本", "Cost/reg")}</TableHead>
              </TableRow></TableHeader>
              <TableBody>{visible.map(({ creative, totals }) => (
                  <TableRow className="cursor-pointer border-white/8 hover:bg-white/[0.025]" key={creative.videoId} onClick={() => router.push(`/creatives/${encodeURIComponent(creative.videoId)}?window=${days}`)}>
                    <TableCell className="max-w-[360px] py-3 pl-5">
                      <div className="flex items-center gap-3">
                        <div className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-lg border border-white/10 bg-black text-muted-foreground">{creative.coverUrl ? <img alt="" className="h-full w-full object-cover" loading="lazy" src={creative.coverUrl} /> : <Clapperboard className="size-4" />}</div>
                        <div className="min-w-0">
                          <Link className="block truncate text-sm font-medium hover:underline" href={`/creatives/${encodeURIComponent(creative.videoId)}?window=${days}`} onClick={(event) => event.stopPropagation()}>{creative.fileName ?? creative.videoId}</Link>
                          <p className="mt-1 flex items-center gap-1.5 truncate text-xs text-muted-foreground">{t(`${creative.ads} 条广告`, `${creative.ads} ads`)}{creative.analyzedAt ? <Badge className="border-primary/20 bg-primary/8 px-1.5 py-0 text-[10px] text-primary" variant="outline">{t("已分析", "Analyzed")}</Badge> : null}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono font-semibold">{formatMoney(totals.spend)}</TableCell>
                    <TableCell className="hidden text-right font-mono md:table-cell">{compactNumber(totals.impressions)}</TableCell>
                    <TableCell className="hidden text-right font-mono lg:table-cell">{pct(totals.ctr)}</TableCell>
                    <TableCell className="hidden text-right font-mono md:table-cell">{compactNumber(totals.installs)} <span className="text-muted-foreground">/ {formatMoney(totals.cpi)}</span></TableCell>
                    <TableCell className="text-right font-mono">{compactNumber(totals.registrations)}</TableCell>
                    <TableCell className="pr-5 text-right font-mono font-semibold text-cyan-200">{formatMoney(totals.cpr)}</TableCell>
                  </TableRow>
              ))}</TableBody>
            </Table>
          ) : (
            <Empty className="border-0 py-24"><EmptyHeader><EmptyMedia variant="icon"><Clapperboard /></EmptyMedia><EmptyTitle>{error ? t("暂时无法读取常规素材", "Could not load creatives") : t("这个范围没有花费的素材", "No creatives with spend here")}</EmptyTitle><EmptyDescription>{t("素材每天台北时间 12:00 从 TikTok 广告后台同步。", "Creatives sync from TikTok Ads daily at 12:00 Taipei.")}</EmptyDescription></EmptyHeader></Empty>
          )}
          {!loading && rows.length > PAGE_SIZE ? (
            <div className="flex items-center justify-between gap-3 border-t border-white/8 px-5 py-3 text-sm text-muted-foreground">
              <span>{t(`第 ${current * PAGE_SIZE + 1}–${current * PAGE_SIZE + visible.length} 支，共 ${rows.length} 支`, `${current * PAGE_SIZE + 1}–${current * PAGE_SIZE + visible.length} of ${rows.length}`)}</span>
              <div className="flex items-center gap-2">
                <Button disabled={current === 0} onClick={() => setPage(current - 1)} size="sm" variant="outline"><ChevronLeft />{t("上一页", "Previous")}</Button>
                <span className="font-mono text-xs">{current + 1} / {pages}</span>
                <Button disabled={current >= pages - 1} onClick={() => setPage(current + 1)} size="sm" variant="outline">{t("下一页", "Next")}<ChevronRight /></Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}
