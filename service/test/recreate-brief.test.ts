import { describe, expect, it } from "vitest";
import { buildRecreateBrief, RECREATE_SYSTEM_PROMPT, recreateTaskPrompt } from "../src/recreate/brief.js";

const base = {
  postId: "p1", market: "VN", durationS: 18.4, caption: "hẹn hò #popup",
  transcript: { language: "vi", segments: [{ start: 0, end: 2.1, text: "Ngoài ra khi đi học về" }] },
  script: [{ start_s: 0, end_s: 2, role: "hook", visual_zh: "女生回家" }],
  assessment: { band: "medium", suggestions: ["第一秒直接展示 PopUp 通知"], missing: ["前 1 秒钩子"], antiPatterns: [] },
  playbookSummary: "高表现帖子前 1 秒出现产品界面", memories: "",
};

describe("recreate brief", () => {
  it("carries suggestions, language, duration limit and marks post text as untrusted", () => {
    const brief = buildRecreateBrief(base);
    expect(brief).toContain("第一秒直接展示 PopUp 通知");
    expect(brief).toContain("Vietnamese (vi)");
    expect(brief).toContain("18.4");
    expect(brief).toMatch(/untrusted/i);
    expect(RECREATE_SYSTEM_PROMPT).toMatch(/1080.?×.?1920|1080x1920/);
    expect(recreateTaskPrompt()).toContain("brief.md");
  });

  it("tells the agent not to invent dialogue when there is no speech", () => {
    const brief = buildRecreateBrief({ ...base, transcript: null });
    expect(brief).toMatch(/no speech/i);
    expect(brief).toMatch(/do not invent/i);
  });
});

describe("recreate prompt scope", () => {
  it("limits the agent to what an edit can do, keeps the brand subtle, and asks for skipped suggestions", () => {
    expect(RECREATE_SYSTEM_PROMPT).toMatch(/cannot film|no new footage/i);
    expect(RECREATE_SYSTEM_PROMPT).toMatch(/skipped/);
    expect(RECREATE_SYSTEM_PROMPT).toMatch(/never .*download/i);
    expect(RECREATE_SYSTEM_PROMPT).not.toMatch(/\bCTA\b/);
  });
});

describe("recreate prompt tools", () => {
  it("points the agent at the check tools, not a shell", () => {
    expect(RECREATE_SYSTEM_PROMPT).toContain("hyperframes_check");
    expect(RECREATE_SYSTEM_PROMPT).toContain("hyperframes_snapshot");
    expect(RECREATE_SYSTEM_PROMPT).not.toMatch(/\bnpx\b/);
  });
});

describe("recreate prompt branding", () => {
  it("never adds PopUp branding the original post did not have", () => {
    expect(RECREATE_SYSTEM_PROMPT).toMatch(/never add (any )?new PopUp branding/i);
    expect(RECREATE_SYSTEM_PROMPT).toMatch(/already (appears|in the source)/i);
    expect(RECREATE_SYSTEM_PROMPT).not.toMatch(/brand sting|end card|app icon/i);
  });
});
