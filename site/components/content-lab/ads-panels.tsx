"use client";

import Link from "next/link";
import { Megaphone } from "lucide-react";

import { RelativeTime } from "@/components/content-lab/relative-time";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney, formatPercentChange, type MarketAds } from "@/lib/ads";
import { compactNumber, type PostAds, type PostSummary } from "@/lib/content-lab";
import { useLocale } from "@/lib/i18n";

const count = (value: number | null | undefined): string => value === null || value === undefined ? "—" : value.toLocaleString("en-US");
const changeClass = (text: string | null, lowerIsBetter = false): string => {
  if (!text) return "text-muted-foreground";
  const up = text.startsWith("+");
  return (up !== lowerIsBetter) ? "text-primary" : "text-[#ff9c8d]";
};

/** Money: current value and percentage change only. */
function MoneyChange({ current, prior, lowerIsBetter = false }: { current: number | null; prior: number | null; lowerIsBetter?: boolean }) {
  const change = formatPercentChange(current, prior);
  return <><span className="font-mono">{formatMoney(current)}</span>{change ? <span className={`ml-1.5 font-mono text-[11px] ${changeClass(change, lowerIsBetter)}`}>{change}</span> : null}</>;
}

/** Counts: current, prior, absolute change and percentage. */
function CountChange({ current, prior }: { current: number; prior: number }) {
  const { t } = useLocale();
  const change = formatPercentChange(current, prior);
  const delta = current - prior;
  return (
    <>
      <span className="font-mono">{count(current)}</span>
      <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">{t("上期", "prior")} {count(prior)} · {delta >= 0 ? "+" : ""}{count(delta)}{change ? ` · ${change}` : ""}</span>
    </>
  );
}

/** Lifetime delivery cells for the posts table. */
export function PostAdsCells({ post }: { post: PostSummary }) {
  const { t } = useLocale();
  const lifetime = post.ads?.lifetime;
  if (!lifetime) {
    return <TableCell className="hidden text-right text-xs text-muted-foreground md:table-cell" colSpan={3}>{t("未投放", "Not promoted")}</TableCell>;
  }
  return (
    <>
      <TableCell className="hidden text-right md:table-cell">
        <span className="font-mono text-sm font-semibold">{formatMoney(lifetime.spend)}</span>
        {post.ads?.status === "active" ? <Badge className="ml-1.5 border-primary/20 bg-primary/8 px-1.5 py-0 text-[10px] text-primary" variant="outline">{t("投放中", "Live")}</Badge> : null}
      </TableCell>
      <TableCell className="hidden text-right md:table-cell">
        <span className="font-mono text-sm">{count(lifetime.registrations)}</span>
        <span className="mt-1 block font-mono text-[11px] text-muted-foreground">{t("注册成本", "Cost/reg")} {formatMoney(lifetime.cpr)}</span>
      </TableCell>
      <TableCell className="hidden text-right lg:table-cell">
        <span className="font-mono text-xs">CPI {formatMoney(lifetime.cpi)}</span>
        <span className="mt-1 block font-mono text-[11px] text-muted-foreground">CPM {formatMoney(lifetime.cpm)}</span>
      </TableCell>
    </>
  );
}

export function PostAdsHeadCells() {
  const { t } = useLocale();
  return (
    <>
      <TableHead className="hidden text-right text-xs text-muted-foreground md:table-cell">{t("花费", "Spend")}</TableHead>
      <TableHead className="hidden text-right text-xs text-muted-foreground md:table-cell">{t("注册", "Registrations")}</TableHead>
      <TableHead className="hidden text-right text-xs text-muted-foreground lg:table-cell">CPI / CPM</TableHead>
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-white/8 bg-white/[0.025] p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold">{value}</p>
      {sub ? <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

/** Delivery card on the post page. */
export function PostAdsCard({ ads }: { ads: PostAds | null | undefined }) {
  const { t } = useLocale();
  if (!ads) {
    return (
      <Card className="border-white/8 bg-card/80 shadow-none">
        <CardHeader><CardTitle className="text-lg">{t("投放成效", "Ad performance")}</CardTitle><CardDescription>{t("这条帖子还没有被投放成 Spark Ads，所以没有花费和注册数据。", "This post has not run as a Spark Ad, so it has no spend or registrations.")}</CardDescription></CardHeader>
      </Card>
    );
  }
  const maxSpend = Math.max(...ads.daily.map((day) => day.spend), 0);
  return (
    <Card className="border-white/8 bg-card/80 shadow-none">
      <CardHeader className="border-b border-white/8 pb-5">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-lg">{t("投放成效", "Ad performance")}</CardTitle>
          <Badge className={ads.status === "active" ? "border-primary/20 bg-primary/8 text-primary" : "border-white/10 bg-white/[0.03] text-muted-foreground"} variant="outline">{ads.status === "active" ? t("投放中", "Live") : t("已停投", "Paused")}</Badge>
        </div>
        <CardDescription>
          {t(`${ads.adCount} 条 Spark Ads · ${ads.accounts} 个广告账户 · 累计数据（USD）`, `${ads.adCount} Spark Ads · ${ads.accounts} ad accounts · lifetime (USD)`)}
          {ads.refreshedAt ? <> · {t("更新于", "updated")} <RelativeTime value={ads.refreshedAt} /></> : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pt-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label={t("花费", "Spend")} value={formatMoney(ads.lifetime.spend)} />
          <Stat label={t("注册", "Registrations")} value={count(ads.lifetime.registrations)} sub={`${t("注册成本", "Cost/reg")} ${formatMoney(ads.lifetime.cpr)}`} />
          <Stat label={t("安装", "Installs")} value={count(ads.lifetime.installs)} sub={`CPI ${formatMoney(ads.lifetime.cpi)}`} />
          <Stat label={t("曝光", "Impressions")} value={compactNumber(ads.lifetime.impressions)} sub={`CPM ${formatMoney(ads.lifetime.cpm)} · CTR ${ads.lifetime.ctr === null ? "—" : `${(ads.lifetime.ctr * 100).toFixed(2)}%`}`} />
        </div>
        <div className="grid gap-3 text-sm sm:grid-cols-3">
          <div className="rounded-lg border border-white/8 p-3"><p className="text-[11px] text-muted-foreground">{t("近 7 天花费", "Spend, last 7d")}</p><p className="mt-1"><MoneyChange current={ads.last7d.spend} prior={ads.prev7d.spend} /></p></div>
          <div className="rounded-lg border border-white/8 p-3"><p className="text-[11px] text-muted-foreground">{t("近 7 天注册", "Registrations, last 7d")}</p><p className="mt-1"><CountChange current={ads.last7d.registrations} prior={ads.prev7d.registrations} /></p></div>
          <div className="rounded-lg border border-white/8 p-3"><p className="text-[11px] text-muted-foreground">{t("近 7 天注册成本", "Cost/reg, last 7d")}</p><p className="mt-1"><MoneyChange current={ads.last7d.cpr} prior={ads.prev7d.cpr} lowerIsBetter /></p></div>
        </div>
        <div>
          <p className="mb-2 text-xs text-muted-foreground">{t("近 14 天每日花费与注册（按广告账户时区）", "Daily spend and registrations, last 14 days (ad account time zone)")}</p>
          <div className="flex h-24 items-end gap-1">
            {ads.daily.map((day) => (
              <div className="flex flex-1 flex-col items-center justify-end" key={day.date} title={`${day.date} · ${formatMoney(day.spend)} · ${count(day.registrations)}`}>
                <div className="w-full rounded-t bg-primary/60" style={{ height: `${maxSpend ? Math.max(2, (day.spend / maxSpend) * 88) : 2}px` }} />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground"><span>{ads.daily[0]?.date.slice(5)}</span><span>{ads.daily.at(-1)?.date.slice(5)}</span></div>
        </div>
        {ads.topAds.length ? (
          <Table>
            <TableHeader><TableRow className="border-white/8 hover:bg-transparent"><TableHead className="text-xs">{t("广告", "Ad")}</TableHead><TableHead className="hidden text-xs sm:table-cell">{t("账户", "Account")}</TableHead><TableHead className="text-right text-xs">{t("花费", "Spend")}</TableHead><TableHead className="text-right text-xs">{t("注册", "Reg.")}</TableHead><TableHead className="text-right text-xs">{t("注册成本", "Cost/reg")}</TableHead></TableRow></TableHeader>
            <TableBody>{ads.topAds.map((ad) => (
              <TableRow className="border-white/8" key={ad.adId}>
                <TableCell className="max-w-[220px] truncate text-xs" title={ad.campaignName ?? undefined}>{ad.adName ?? ad.adId}</TableCell>
                <TableCell className="hidden max-w-[160px] truncate text-xs text-muted-foreground sm:table-cell">{ad.advertiserName ?? "—"}</TableCell>
                <TableCell className="text-right font-mono text-xs">{formatMoney(ad.spend)}</TableCell>
                <TableCell className="text-right font-mono text-xs">{count(ad.registrations)}</TableCell>
                <TableCell className="text-right font-mono text-xs">{formatMoney(ad.cpr)}</TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        ) : null}
        {ads.currencyExcluded ? <p className="text-xs text-amber-200/80">{t(`有 ${ads.currencyExcluded} 条广告不是 USD 计价，没有计入合计。`, `${ads.currencyExcluded} ads are not in USD and are left out of the totals.`)}</p> : null}
      </CardContent>
    </Card>
  );
}

/** Per-market delivery on the overview. */
export function MarketAdsPanel({ markets, topPosts }: { markets: MarketAds[] | undefined; topPosts: PostSummary[] | undefined }) {
  const { t } = useLocale();
  if (!markets) return null;
  return (
    <Card className="mt-4 border-white/8 bg-card/80 shadow-none">
      <CardHeader className="border-b border-white/8 pb-5">
        <div className="flex items-center gap-2"><Megaphone className="size-4 text-primary" /><CardTitle className="text-lg">{t("投放成效", "Ad performance")}</CardTitle></div>
        <CardDescription>{t("已追踪帖子的 Spark Ads，近 7 天对比前 7 天（USD）", "Spark Ads of tracked posts, last 7 days vs the 7 before (USD)")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pt-4">
        {markets.length ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow className="border-white/8 hover:bg-transparent">
                <TableHead className="text-xs">{t("市场", "Market")}</TableHead>
                <TableHead className="text-right text-xs">{t("投放中 / 已投放", "Live / promoted")}</TableHead>
                <TableHead className="text-right text-xs">{t("花费", "Spend")}</TableHead>
                <TableHead className="text-right text-xs">{t("注册", "Registrations")}</TableHead>
                <TableHead className="text-right text-xs">{t("注册成本", "Cost/reg")}</TableHead>
                <TableHead className="text-right text-xs">CPI</TableHead>
                <TableHead className="text-right text-xs">CPM</TableHead>
              </TableRow></TableHeader>
              <TableBody>{markets.map((market) => (
                <TableRow className="border-white/8" key={market.market}>
                  <TableCell className="font-mono text-sm font-semibold">{market.market}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{market.activePosts} / {market.promotedPosts}</TableCell>
                  <TableCell className="text-right text-sm"><MoneyChange current={market.last7d.spend} prior={market.prev7d.spend} /></TableCell>
                  <TableCell className="text-right text-sm"><CountChange current={market.last7d.registrations} prior={market.prev7d.registrations} /></TableCell>
                  <TableCell className="text-right text-sm"><MoneyChange current={market.last7d.cpr} prior={market.prev7d.cpr} lowerIsBetter /></TableCell>
                  <TableCell className="text-right text-sm"><MoneyChange current={market.last7d.cpi} prior={market.prev7d.cpi} lowerIsBetter /></TableCell>
                  <TableCell className="text-right text-sm"><MoneyChange current={market.last7d.cpm} prior={market.prev7d.cpm} lowerIsBetter /></TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          </div>
        ) : <p className="py-6 text-center text-sm text-muted-foreground">{t("追踪中的帖子还没有对应的 Spark Ads。", "No tracked post has run as a Spark Ad yet.")}</p>}
        {topPosts?.length ? (
          <div>
            <p className="mb-2 text-xs text-muted-foreground">{t("近 7 天注册最多的帖子", "Most registrations, last 7 days")}</p>
            <div className="space-y-2">{topPosts.map((post) => (
              <Link className="flex items-center justify-between gap-3 rounded-lg border border-white/8 px-3 py-2 text-sm hover:bg-white/[0.03]" href={`/posts/${post.id}`} key={post.id}>
                <span className="min-w-0 truncate"><span className="mr-2 font-mono text-xs text-muted-foreground">{post.market}</span>{post.creatorHandle ?? post.url}</span>
                <span className="shrink-0 font-mono text-xs">{count(post.ads?.last7d.registrations)} · {formatMoney(post.ads?.last7d.cpr)}</span>
              </Link>
            ))}</div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
