"use client";

import Link from "next/link";
import { Bell, Clapperboard, Flame, ListPlus, ScanSearch, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { RelativeTime } from "@/components/content-lab/relative-time";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/lib/i18n";
import { unreadCount, type NotificationItem, type NotificationKind } from "@/lib/notifications";

const SEEN_KEY = "content-lab:notifications-seen";
const ICONS: Record<NotificationKind, typeof Bell> = { signal: Flame, recreation_done: Clapperboard, recreation_failed: TriangleAlert, new_posts: ListPlus, analysis_done: ScanSearch };

const readSeen = (): string | null => { try { return window.localStorage.getItem(SEEN_KEY); } catch { return null; } };
const writeSeen = (value: string): void => { try { window.localStorage.setItem(SEEN_KEY, value); } catch { /* private mode: unread stays per visit */ } };

/** Header bell: what happened recently, with a per-browser unread count. */
export function NotificationBell() {
  const { t, lang } = useLocale();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [seen, setSeen] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = () => fetch("/api/notifications", { cache: "no-store", signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<{ items: NotificationItem[] }> : { items: [] })
      .then((result) => { setSeen(readSeen()); setItems(result.items); })
      .catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (panel.current && !panel.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const unread = unreadCount(items, seen);
  function toggle() {
    if (!open && items[0]) { writeSeen(items[0].at); setSeen(items[0].at); }
    setOpen(!open);
  }

  return (
    <div className="relative" ref={panel}>
      <Button aria-label={t(`通知（${unread} 条未读）`, `Notifications (${unread} unread)`)} className="relative" onClick={toggle} size="icon" variant="ghost">
        <Bell />
        {unread > 0 ? <span className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-[#ff715b] px-1 font-mono text-[10px] leading-4 text-white">{unread > 99 ? "99+" : unread}</span> : null}
      </Button>
      {open ? (
        <div className="absolute right-0 top-11 z-50 w-[min(360px,calc(100vw-32px))] overflow-hidden rounded-xl border border-white/10 bg-popover shadow-2xl">
          <div className="border-b border-white/8 px-4 py-3 text-sm font-medium">{t("通知", "Notifications")}</div>
          <div className="max-h-[420px] overflow-y-auto">
            {items.length ? items.map((item) => {
              const Icon = ICONS[item.kind];
              const isNew = seen === null || item.at > (seen ?? "");
              return (
                <Link className="flex gap-3 border-b border-white/6 px-4 py-3 last:border-0 hover:bg-white/[0.04]" href={item.href} key={item.id} onClick={() => setOpen(false)}>
                  <Icon className={`mt-0.5 size-4 shrink-0 ${item.kind === "recreation_failed" ? "text-[#ff9c8d]" : item.kind === "signal" ? "text-[#ff8a76]" : "text-primary"}`} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{lang === "en" ? item.titleEn : item.titleZh}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{lang === "en" ? item.detailEn : item.detailZh}</p>
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground"><RelativeTime value={item.at} /></p>
                  </div>
                  {isNew ? <span className="mt-1.5 size-2 shrink-0 rounded-full bg-[#ff715b]" /> : null}
                </Link>
              );
            }) : <p className="px-4 py-10 text-center text-sm text-muted-foreground">{t("最近 14 天没有新通知。", "Nothing new in the last 14 days.")}</p>}
          </div>
        </div>
      ) : null}
    </div>
  );
}
