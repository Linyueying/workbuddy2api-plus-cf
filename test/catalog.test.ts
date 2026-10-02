import { describe, it, expect } from "vitest";
import {
  CODEBUDDY_CLI_UA,
  CODEBUDY_IDE_UA,
  ENTERPRISE_PROBE_PATHS,
  dynEntryOf,
  extractEfforts,
  mergeCatalog,
  mergeEffortBuckets,
  mergeEffortDefaults,
  nonChatModel,
  parseCatalog,
  parseEnterpriseCli,
  parseLooseEntry,
  parseV3Config,
  realmPrefix,
  resolveCatalogArray,
} from "../src/services/catalog";

describe("UA 常量", () => {
  it("IDE UA 带 CodeBuddyIDE + CodeBuddy 版本号（缺失会被上游 400/12403）", () => {
    expect(CODEBUDY_IDE_UA).toMatch(/^CodeBuddyIDE\/\d+\.\d+\.\d+ CodeBuddy\/\d+\.\d+\.\d+$/);
  });

  it("CLI UA 是三段式（与 IDE UA 是不同模型集合的探测维度）", () => {
    expect(CODEBUDDY_CLI_UA).toMatch(/^CLI\/\d+\.\d+\.\d+ CodeBuddy\/\d+\.\d+\.\d+$/);
    expect(CODEBUDDY_CLI_UA).not.toBe(CODEBUDY_IDE_UA);
  });

  it("企业端点家族顺序：/v2 首选，/console 兜底", () => {
    expect(ENTERPRISE_PROBE_PATHS[0]).toBe("/v2/enterprises/personal/models");
    expect(ENTERPRISE_PROBE_PATHS[1]).toBe("/console/enterprises/personal/models");
  });
});

describe("nonChatModel", () => {
  it("nes-/completion-/codewise- 前缀剔除", () => {
    expect(nonChatModel("nes-embed", 8192, [])).toBe(true);
    expect(nonChatModel("completion-foo", 8192, [])).toBe(true);
    expect(nonChatModel("codewise-bar", 8192, [])).toBe(true);
    expect(nonChatModel("NES-Upper", 8192, [])).toBe(true); // 大小写不敏感
  });

  it("maxOutputTokens ≤ 256 剔除（0 = 未知，放行）", () => {
    expect(nonChatModel("m", 256, [])).toBe(true);
    expect(nonChatModel("m", 1, [])).toBe(true);
    expect(nonChatModel("m", 0, [])).toBe(false); // 未知不当 tiny
    expect(nonChatModel("m", 257, [])).toBe(false);
  });

  it("tags 含 text-to-image 剔除", () => {
    expect(nonChatModel("m", 8192, ["text-to-image"])).toBe(true);
    expect(nonChatModel("m", 8192, ["chat"])).toBe(false);
  });

  it("普通对话模型放行", () => {
    expect(nonChatModel("deepseek-v4.1-flash", 393216, [])).toBe(false);
    expect(nonChatModel("hy3", 32768, ["general"])).toBe(false);
  });
});

describe("dynEntryOf", () => {
  it("全字段解析 + defaultEffort 新老双键", () => {
    const e = dynEntryOf({
      id: "hy3",
      name: "HY3",
      maxInputTokens: 128000,
      maxOutputTokens: 32768,
      maxAllowedSize: 1024,
      descriptionZh: "中文描述",
      credits: "x0.5",
      tags: ["general"],
      vendor: "tencent",
      isDefault: true,
      supportsReasoning: true,
      supportsToolCall: true,
      onlyReasoning: false,
      supportsImages: true,
      reasoning: { supportedEfforts: ["low", "high", "max"], defaultEffort: "high", canDisableThinking: true, summary: "s" },
    });
    expect(e.id).toBe("hy3");
    expect(e.context_window).toBe(128000);
    expect(e.max_tokens).toBe(32768);
    expect(e.max_allowed_size).toBe(1024);
    expect(e.description).toBe("中文描述");
    expect(e.credits).toBe("x0.5");
    expect(e.vendor).toBe("tencent");
    expect(e.is_default).toBe(true);
    expect(e.supports_reasoning).toBe(true);
    expect(e.supports_tool_call).toBe(true);
    expect(e.supports_images).toBe(true);
    expect(e.can_disable_thinking).toBe(true);
    expect(e.reasoning_summary).toBe("s");
    expect(e.efforts).toEqual(["low", "high", "max"]);
    expect(e.default_effort).toBe("high");
  });

  it("reasoning.effort 老键兜底", () => {
    expect(dynEntryOf({ id: "m", reasoning: { effort: "medium" } }).default_effort).toBe("medium");
  });

  it("reasoning 缺失时字段为空而非崩", () => {
    const e = dynEntryOf({ id: "m" });
    expect(e.efforts).toEqual([]);
    expect(e.default_effort).toBe("");
    expect(e.reasoning_summary).toBe("");
  });

  it("fallbackId 生效（name 兜底形态）", () => {
    expect(dynEntryOf({ name: "gpt-x" }, "gpt-x").id).toBe("gpt-x");
  });

  it("id 回退链 id→modelId→model→name", () => {
    expect(dynEntryOf({ modelId: "a" }).id).toBe("a");
    expect(dynEntryOf({ model: "b" }).id).toBe("b");
    expect(dynEntryOf({ name: "c" }).id).toBe("c");
  });
});

describe("resolveCatalogArray", () => {
  it("payload 本身是数组直接用", () => {
    expect(resolveCatalogArray([1, 2])).toEqual([1, 2]);
  });

  it("五键逐一命中", () => {
    for (const k of ["models", "items", "list", "data", "result"]) {
      expect(resolveCatalogArray({ [k]: [{ id: "m" }] })).toEqual([{ id: "m" }]);
    }
  });

  it("递归下钻（data.models.items）", () => {
    expect(resolveCatalogArray({ data: { models: { items: [{ id: "x" }] } } })).toEqual([{ id: "x" }]);
  });

  it("找不到数组 → null", () => {
    expect(resolveCatalogArray({ foo: "bar" })).toBeNull();
    expect(resolveCatalogArray("str")).toBeNull();
    expect(resolveCatalogArray(null)).toBeNull();
  });

  it("空数组不是有效目录（返回它自己，交给上层判空报错）", () => {
    // Go 侧 resolve 同样返回空数组（`[` 前缀即命中），空判定在 parse 层做。
    expect(resolveCatalogArray({ models: [] })).toEqual([]);
    expect(parseCatalog({ models: [] }).error).toBeTruthy();
  });
});

describe("parseCatalog", () => {
  it("形态 1：data.models 对象数组全字段", () => {
    const p = parseCatalog({ code: 0, data: { models: [{ id: "hy3", maxOutputTokens: 32768, reasoning: { supportedEfforts: ["low", "high"] } }] } });
    expect(p.error).toBeUndefined();
    expect(p.names).toEqual(["hy3"]);
    expect(p.infos?.[0].max_tokens).toBe(32768);
    expect(p.efforts).toEqual({ hy3: ["low", "high"] });
  });

  it("code 非 0 → 拒（无 code 字段放行）", () => {
    expect(parseCatalog({ code: 401, data: { models: [{ id: "m" }] } }).error).toBeTruthy();
    expect(parseCatalog({ data: { models: [{ id: "m" }] } }).error).toBeUndefined();
    expect(parseCatalog({ code: 0, data: { models: [{ id: "m" }] } }).error).toBeUndefined();
  });

  it("data 为 null/空串 → 回落整包", () => {
    expect(parseCatalog({ code: 0, data: null, models: [{ id: "m" }] }).names).toEqual(["m"]);
    expect(parseCatalog({ code: 0, data: "  ", models: [{ id: "m" }] }).names).toEqual(["m"]);
  });

  it("disabled 剔除", () => {
    const p = parseCatalog({ models: [{ id: "a" }, { id: "b", disabled: true }] });
    expect(p.names).toEqual(["a"]);
  });

  it("形态 2：窄表字符串数组 → infos 为 null", () => {
    const p = parseCatalog({ models: ["a", "b"] });
    expect(p.names).toEqual(["a", "b"]);
    expect(p.infos).toBeNull();
  });

  it("窄表条目去空白、丢空串", () => {
    expect(parseCatalog({ models: [" a ", "", "b"] }).names).toEqual(["a", "b"]);
  });

  it("形态 3：混合数组里的裸 ID 按窄表条目处理", () => {
    const p = parseCatalog({ models: ["a", { model: "b" }, { id: "c", contextWindow: 4096 }] });
    expect(p.names).toEqual(["a", "b", "c"]);
    expect(p.infos?.[0].id).toBe("a");
    expect(p.infos?.[2].context_window).toBe(4096);
  });

  it("形态 3：宽松键名（id 缺失时 model/name 兜底）", () => {
    // 全部是对象 → 走形态 1 的 dynEntryOf（严格键，无宽松回退，与 Go 一致）。
    const p = parseCatalog({ items: [{ name: "gpt-x", maxTokens: 2048 }] });
    expect(p.names).toEqual(["gpt-x"]);
    expect(p.infos?.[0].max_tokens).toBe(0); // maxTokens 是宽松键，形态 1 不认
  });

  it("形态 3：主形态解析不出可用条目时才走宽松回退（maxTokens/contextWindow）", () => {
    // 混入一个无 id 的对象 → allObjects 破功 → 落宽松解析，宽松键生效。
    const p = parseCatalog({ items: [{ foo: 1 }, { name: "gpt-x", maxTokens: 2048 }] });
    expect(p.names).toEqual(["gpt-x"]);
    expect(p.infos?.[0].max_tokens).toBe(2048);
  });

  it("全空 / 找不到数组 → error", () => {
    expect(parseCatalog({ models: [] }).error).toBeTruthy();
    expect(parseCatalog({ foo: 1 }).error).toBeTruthy();
    expect(parseCatalog(null).error).toBeTruthy();
  });

  it("efforts 桶只收有档位的模型", () => {
    const p = parseCatalog({ models: [{ id: "a", reasoning: { supportedEfforts: ["low"] } }, { id: "b" }] });
    expect(Object.keys(p.efforts)).toEqual(["a"]);
  });

  it("defaultEffort 独立入 defaults 桶（无 supportedEfforts 也记）", () => {
    const p = parseCatalog({ models: [{ id: "a", reasoning: { defaultEffort: "high" } }] });
    expect(p.defaults).toEqual({ a: "high" });
    expect(p.efforts).toEqual({});
  });
});

describe("parseLooseEntry", () => {
  it("窗口/上限键回退", () => {
    const e = parseLooseEntry({ name: "m", contextWindow: 8192, maxTokens: 1024 });
    expect(e?.id).toBe("m");
    expect(e?.context_window).toBe(8192);
    expect(e?.max_tokens).toBe(1024);
  });

  it("id 回退链", () => {
    expect(parseLooseEntry({ modelId: "a" })?.id).toBe("a");
    expect(parseLooseEntry({ model: "b" })?.id).toBe("b");
    expect(parseLooseEntry({ name: "c" })?.id).toBe("c");
    expect(parseLooseEntry({ foo: 1 })).toBeNull();
  });

  it("credits 恒不解析（倍率不进 global 路径）", () => {
    expect(parseLooseEntry({ id: "m", credits: "x0.29" })?.credits).toBe("");
  });

  it("disabled 剔除", () => {
    expect(parseLooseEntry({ id: "m", disabled: true })).toBeNull();
  });

  it("reasoning 档位新键优先老键兜底", () => {
    expect(parseLooseEntry({ id: "m", reasoning: { defaultEffort: "max", effort: "low" } })?.default_effort).toBe("max");
    expect(parseLooseEntry({ id: "m", reasoning: { effort: "low" } })?.default_effort).toBe("low");
  });
});

describe("mergeCatalog", () => {
  it("主路字段权威，副路只补缺失 id", () => {
    const r = mergeCatalog(
      { names: ["a", "b"], infos: [dynEntryOf({ id: "a", credits: "P" }), dynEntryOf({ id: "b", credits: "P" })] },
      { names: ["b", "c"], infos: [dynEntryOf({ id: "b", credits: "S" }), dynEntryOf({ id: "c", credits: "S" })] },
    );
    expect(r.names).toEqual(["a", "b", "c"]);
    expect(r.infos?.map((e) => e.credits)).toEqual(["P", "P", "S"]);
  });

  it("副路为空 → 原样返回主路内容", () => {
    const p = { names: ["a"], infos: [dynEntryOf({ id: "a" })] };
    const r = mergeCatalog(p, { names: [], infos: null });
    expect(r.names).toEqual(["a"]);
    expect(r.infos?.[0].id).toBe("a");
  });

  it("窄表副路不编造字段（infis 保持 null）", () => {
    const r = mergeCatalog({ names: [], infos: null }, { names: ["a", "b"], infos: null });
    expect(r.names).toEqual(["a", "b"]);
    expect(r.infos).toBeNull();
  });

  it("输出顺序稳定（主路原序 + 副路补充项原序）", () => {
    const r = mergeCatalog({ names: ["z", "a"], infos: null }, { names: ["m", "b"], infos: null });
    expect(r.names).toEqual(["z", "a", "m", "b"]);
  });
});

describe("mergeEffortBuckets / mergeEffortDefaults", () => {
  it("主路权威，副路只补缺失", () => {
    expect(mergeEffortBuckets({ a: ["low"] }, { a: ["x"], b: ["high"] })).toEqual({ a: ["low"], b: ["high"] });
    expect(mergeEffortDefaults({ a: "high" }, { a: "low", b: "medium" })).toEqual({ a: "high", b: "medium" });
  });

  it("副路为空 → 返回主路引用", () => {
    const p = { a: ["low"] };
    expect(mergeEffortBuckets(p, {})).toBe(p);
    const d = { a: "high" };
    expect(mergeEffortDefaults(d, {})).toBe(d);
  });

  it("不修改入参", () => {
    const p = { a: ["low"] };
    mergeEffortBuckets(p, { b: ["high"] });
    expect(p).toEqual({ a: ["low"] });
  });
});

describe("parseEnterpriseCli", () => {
  const env = {
    code: 0,
    data: {
      agents: [
        { name: "ide", models: ["x"] },
        { name: "cli", models: ["hy3", "gpt-5.3-codex"] },
      ],
      models: [
        { id: "hy3", maxInputTokens: 128000, maxOutputTokens: 32768, reasoning: { supportedEfforts: ["low", "high"] } },
        { id: "gpt-5.3-codex", maxOutputTokens: 16384 },
        { id: "nes-embed", maxOutputTokens: 8192 },
        { id: "unlisted", maxOutputTokens: 8192 },
      ],
    },
  };

  it("只取 agents[cli] 的名单", () => {
    const out = parseEnterpriseCli(env);
    expect(out.map((e) => e.id)).toEqual(["hy3", "gpt-5.3-codex"]);
  });

  it("nonChatModel 条目根本不进表（即便 cli 名单里有）", () => {
    const out = parseEnterpriseCli({
      code: 0,
      data: { agents: [{ name: "cli", models: ["nes-embed", "hy3"] }], models: [{ id: "nes-embed", maxOutputTokens: 8192 }, { id: "hy3", maxOutputTokens: 32768 }] },
    });
    expect(out.map((e) => e.id)).toEqual(["hy3"]);
  });

  it("disabled 剔除", () => {
    const out = parseEnterpriseCli({
      code: 0,
      data: { agents: [{ name: "cli", models: ["a"] }], models: [{ id: "a", maxOutputTokens: 32768, disabled: true }] },
    });
    expect(out).toEqual([]);
  });

  it("无 cli agent → 空（不是全量下发）", () => {
    expect(parseEnterpriseCli({ code: 0, data: { agents: [{ name: "ide", models: ["x"] }], models: [{ id: "x" }] } })).toEqual([]);
    expect(parseEnterpriseCli({ code: 0, data: { models: [{ id: "x" }] } })).toEqual([]);
  });

  it("code 非 0 → 空", () => {
    expect(parseEnterpriseCli({ code: 500, data: { agents: [{ name: "cli", models: ["x"] }], models: [{ id: "x" }] } })).toEqual([]);
  });

  it("cli 名单里的模型不在 models 表中 → 跳过（不编造字段）", () => {
    const out = parseEnterpriseCli({ code: 0, data: { agents: [{ name: "cli", models: ["ghost"] }], models: [] } });
    expect(out).toEqual([]);
  });
});

describe("parseV3Config", () => {
  const ok = {
    code: 0,
    data: {
      models: [
        { id: "hy3", maxInputTokens: 128000, maxOutputTokens: 32768, credits: "x1", tags: ["chat"] },
        { id: "nes-embed", maxOutputTokens: 8192 },
        { id: "img", maxOutputTokens: 8192, tags: ["text-to-image"] },
      ],
      modelPromotions: [{ modelIds: ["hy3"], priority: 1 }],
    },
  };

  it("剔除非对话条目", () => {
    const r = parseV3Config(ok);
    expect([...r.table.keys()]).toEqual(["hy3"]);
  });

  it("透出 modelPromotions", () => {
    expect(parseV3Config(ok).promotions).toHaveLength(1);
  });

  it("试用横幅模型补入（能力继承 targetModelId，credits/tags 清空）", () => {
    const r = parseV3Config({
      code: 0,
      data: {
        models: [{ id: "hy4-preview", maxOutputTokens: 32768, credits: "x0.29", tags: ["badge"] }],
        productFeaturesConfig: { ModelTrialBanner: { banners: [{ modelId: "hy4-preview-f", targetModelId: "hy4-preview", trialDays: 14 }] } },
      },
    });
    const trial = r.table.get("hy4-preview-f");
    expect(trial).toBeTruthy();
    expect(trial!.max_tokens).toBe(32768); // 能力继承
    expect(trial!.credits).toBe(""); // 显式清空
    expect(trial!.tags).toEqual([]);
  });

  it("试用模型无target 时只补 ID（不编造能力）", () => {
    const r = parseV3Config({
      code: 0,
      data: { models: [], productFeaturesConfig: { ModelTrialBanner: { banners: [{ modelId: "solo" }] } } },
    });
    expect(r.table.get("solo")?.id).toBe("solo");
    expect(r.table.get("solo")?.max_tokens).toBe(0);
  });

  it("试用模型已存在于 models → 不覆盖（不剥 credits/tags）", () => {
    const r = parseV3Config({
      code: 0,
      data: {
        models: [{ id: "hy3", maxOutputTokens: 32768, credits: "keep", tags: ["badge"] }],
        productFeaturesConfig: { ModelTrialBanner: { banners: [{ modelId: "hy3", targetModelId: "hy3" }] } },
      },
    });
    expect(r.table.get("hy3")?.credits).toBe("keep");
    expect(r.table.get("hy3")?.tags).toEqual(["badge"]);
  });

  it("code 非 0 → error", () => {
    expect(parseV3Config({ code: 12403 }).error).toContain("12403");
  });

  it("空 models → error", () => {
    expect(parseV3Config({ code: 0, data: { models: [] } }).error).toBeTruthy();
  });

  it("非对象 → error", () => {
    expect(parseV3Config("str").error).toBeTruthy();
  });
});

describe("extractEfforts", () => {
  it("抽 names + effort 桶 + default 桶", () => {
    const r = extractEfforts([
      dynEntryOf({ id: "a", reasoning: { supportedEfforts: ["low", "high"], defaultEffort: "high" } }),
      dynEntryOf({ id: "b" }),
    ]);
    expect(r.names).toEqual(["a", "b"]);
    expect(r.efforts).toEqual({ a: ["low", "high"] });
    expect(r.defaults).toEqual({ a: "high" });
  });

  it("infos 为 null（窄表）→ 空结果，不崩", () => {
    expect(extractEfforts(null).names).toEqual([]);
  });
});

describe("realmPrefix", () => {
  it("加前缀", () => {
    expect(realmPrefix("cn", "hy3")).toBe("cn:hy3");
    expect(realmPrefix("global", "hy3")).toBe("global:hy3");
  });
});
