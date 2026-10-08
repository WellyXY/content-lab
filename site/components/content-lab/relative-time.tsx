"use client";

import { useEffect, useState } from "react";

import { timeAgo } from "@/lib/content-lab";

export function RelativeTime({ value }: { value: string | null }) {
  const [referenceTime, setReferenceTime] = useState<number | null>(null);

  useEffect(() => {
    const update = () => setReferenceTime(Date.now());
    update();
    const timer = window.setInterval(update, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return <>{referenceTime == null ? "—" : timeAgo(value, referenceTime)}</>;
}
