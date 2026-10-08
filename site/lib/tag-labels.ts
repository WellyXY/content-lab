// Display-only translations. Persisted taxonomy keys stay unchanged.
const dimensionLabels: Record<string, string> = {
  format: "內容形式", hook_type: "開場手法", hook_channels: "吸睛管道",
  topic: "內容主題", emotional_tone: "情緒基調", structure: "敘事結構",
  share_trigger: "互動動機", product_timing: "品牌首次出現", cta: "行動呼籲",
  person_presence: "真人出鏡", format_elements: "輔助元素",
  brand_visibility: "品牌呈現", product_role: "產品角色",
};

const valueLabels: Record<string, string> = {
  talking_head: "對鏡口播", skit_pov: "情境短劇", chat_screenshot: "聊天截圖",
  text_on_image: "文字圖文", vlog_lifestyle: "生活紀錄", montage_music: "音樂混剪",
  app_screen: "應用程式畫面", other: "其他", photo_life: "生活照片",
  contrast: "對比反差", suspense: "懸念提問", result_first: "結果先行",
  identity_callout: "點名特定族群", relatable_pain: "共鳴痛點",
  counterintuitive: "反常識觀點", emotional_quote: "情緒金句",
  trend_template: "熱門模板", visual_spectacle: "視覺吸睛", weak: "無明確吸睛點",
  on_screen_text: "畫面文字", spoken: "口播", visual: "畫面表現", audio_trend: "熱門音樂／音效",
  crush_ambiguity: "暗戀曖昧", trust_jealousy: "信任與吃醋", heartbreak: "失戀心碎",
  couple_sweet: "情侶日常", dating_meetup: "約會見面", social_hangout: "交友聚會",
  singlehood: "單身心聲", emotional_support: "情感陪伴", friend_banter: "朋友鬥嘴",
  self_worth: "自我價值", flirting_skill: "搭訕聊天技巧",
  sweet: "甜蜜心動", sad: "傷感虐心", funny: "搞笑自嘲", relatable: "真實共鳴",
  aspirational: "嚮往療癒", sharp: "犀利諷刺",
  single_beat: "單一畫面／笑點", setup_twist: "鋪墊反轉", contrast_pair: "前後對照",
  story_arc: "完整故事", list_tips: "清單步驟", montage_flow: "情緒場景堆疊",
  tag_someone: "想傳給某人", self_expression: "表達心聲", debate: "站隊討論",
  entertainment: "娛樂欣賞", useful: "實用收藏", none: "無",
  na: "不適用", opening: "開場", middle: "中段", ending: "結尾",
  comment: "引導留言", share_tag: "引導分享／標記", dm_invite: "邀請私訊",
  soft_suggest: "委婉推薦", download: "引導下載使用", follow: "引導追蹤",
  face: "清楚露臉", partial: "局部出鏡",
  chat_overlay: "聊天訊息疊圖", meme_insert: "梗圖插入", real_photo: "生活照片",
  notification: "手機通知", split_screen: "分割畫面", face_filter: "臉部濾鏡",
  app_badge: "應用程式圖示／角標",
  caption_only: "僅文案提及", unbranded_ui: "未確認品牌介面", name_text: "文字提及品牌",
  name_spoken: "口播提及品牌", branded_ui: "可辨識品牌介面",
  absent: "產品未出現", background: "背景點綴", enabler: "推動情節", punchline: "笑點／反差核心",
};

const noValueLabels: Record<string, string> = {
  share_trigger: "無明顯互動動機", cta: "無行動呼籲", person_presence: "無真人出鏡",
  format_elements: "無輔助元素", brand_visibility: "無品牌線索",
};

export function tagDimensionLabel(dimension: string): string {
  return dimensionLabels[dimension] ?? dimension.replaceAll("_", " ");
}

export function tagLabel(value: string | readonly string[], dimension?: string): string {
  if (typeof value !== "string") return value.map((item) => tagLabel(item, dimension)).join("、") || "—";
  if (value === "none" && dimension && noValueLabels[dimension]) return noValueLabels[dimension];
  return valueLabels[value] ?? value.replaceAll("_", " ");
}

export function tagConfidenceLabel(confidence: string): string {
  return ({ high: "信心高", medium: "信心中", low: "信心低" } as Record<string, string>)[confidence] ?? "信心未評定";
}
