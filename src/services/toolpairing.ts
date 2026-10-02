// 出站请求体的 tool_call ↔ tool 结果配对清理 + tool 结果块重排
// （替代 internal/upstream/tool_pairing.go，语义对齐参考仓库 sse.ts resolveToolPairing）。
//
// 背景：OpenAI 兼容协议要求带 tool_calls 的 assistant 消息，其每一个 tool_call id
// 都必须有对应的一条 role:tool 结果消息；反之 role:tool 消息也必须有对应的前置
// tool_call。缺任一侧，上游都会以 HTTP 400 拒绝整个请求。
//
// 工具执行失败时（参数非法、超时、工具不存在）客户端会把 assistant 的 tool_calls
// 持久化进会话历史，却写不回结果消息。这条坏历史随后被每次请求原样重放——上游对
// 之后每一条用户消息都返回 400，整条会话报废。网关是最后一道防线：发出请求前剔除
// 无法配对的条目让会话自愈，宁可丢一轮工具上下文，也好过整条会话死亡。

/**
 * repackToolResultBlocks 把插在 assistant.tool_calls 与其 tool 结果之间的非 tool 消息
 * 挪到整组之后，保证同一批 tool_call 的结果在 wire 上连续。
 *
 * 背景：Codex 的 image_resize_notice 特性会把 <image_resize_notice> 作为一条
 * developer/system 消息插在 tool 输出后面。并行调用时它插在两份 tool 结果中间：
 *
 *   assistant tool_calls=[c00 c01] | tool c00 | developer <notice> | tool c01
 *
 * OpenAI 兼容协议要求 tool 结果紧跟 assistant，中间插任何消息都算配对断裂，上游判
 * 11148（tool_call_sequence_broken）并顶死整条会话。这里只调顺序、不改内容。
 * 无插入消息时零改动零分配（返回原数组）。
 */
export function repackToolResultBlocks(messages: any[]): [any[], boolean] {
  if (messages.length < 3) return [messages, false];
  const out: any[] = [];
  let changed = false;
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (!m || typeof m !== "object" || m.role !== "assistant") {
      out.push(m);
      i++;
      continue;
    }
    const tcs = m.tool_calls;
    if (!Array.isArray(tcs) || tcs.length === 0) {
      out.push(m);
      i++;
      continue;
    }
    const want = new Set<string>();
    for (const tci of tcs) {
      const id = tci && typeof tci === "object" ? String((tci as any).id ?? "") : "";
      if (id) want.add(id);
    }
    out.push(m);
    i++;
    const results: any[] = [];
    const between: any[] = [];
    let sawNonTool = false;
    while (i < messages.length) {
      const mm = messages[i];
      if (!mm || typeof mm !== "object") break;
      const role = String((mm as any).role ?? "");
      if (role === "tool") {
        const id = String((mm as any).tool_call_id ?? "");
        if (!want.has(id)) break;
        results.push(mm);
        if (sawNonTool) changed = true;
        i++;
        continue;
      }
      if (results.length === 0) break; // assistant 后没有结果：交由 cleanupOrphanToolCalls
      // 下一组 assistant.tool_calls 是新的组头，绝不能当插入物吞掉：一旦被收进
      // between，它永远不再被外层循环当作组头处理，它自己那批结果也就永远得不到
      // 重排。必须 break 交还外层循环。
      if (role === "assistant") {
        const next = (mm as any).tool_calls;
        if (Array.isArray(next) && next.length > 0) break;
      }
      between.push(mm);
      sawNonTool = true;
      i++;
    }
    out.push(...results, ...between);
  }
  return changed ? [out, true] : [messages, false];
}

/**
 * cleanupOrphanToolCalls 剔除无法配对的 tool_call 与 tool 结果（所有模型）。
 *
 *   - 收集全线 role:tool 消息的 tool_call_id（结果集）与 assistant.tool_calls[].id（调用集）；
 *   - 一批 assistant.tool_calls 按 keepCalls 对称裁剪：只留有结果配对的调用（部分保留
 *     不会留下无结果的 tool_call），过滤后为空才删掉整个 tool_calls 键；
 *   - role:tool 只在对应 tool_call 被保留时才保留，否则删除整条消息；
 *   - 无任何工具流量 → 原数组原样返回（零分配零改动）。
 *
 * 两侧共用同一份 keepCalls 按 id 对称裁剪，避免出现「无 tool_calls 的 assistant +
 * 孤儿 tool」这种半截配对（上游判 11148 并顶死整条会话）。
 */
export function cleanupOrphanToolCalls(messages: any[]): [any[], boolean] {
  if (messages.length === 0) return [messages, false];
  const callIDs = new Set<string>();
  const resultIDs = new Set<string>();
  let hasTraffic = false;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const role = String((m as any).role ?? "");
    if (role === "tool") {
      const id = String((m as any).tool_call_id ?? "");
      if (id) {
        resultIDs.add(id);
        hasTraffic = true;
      }
    } else if (role === "assistant") {
      const tcs = (m as any).tool_calls;
      if (Array.isArray(tcs)) {
        for (const tci of tcs) {
          const id = tci && typeof tci === "object" ? String((tci as any).id ?? "") : "";
          if (id) {
            callIDs.add(id);
            hasTraffic = true;
          }
        }
      }
    }
  }
  if (!hasTraffic) return [messages, false];
  // keepCalls：调用 id 是否双侧齐全（调用存在且结果存在）。
  const keepCalls = new Set<string>();
  for (const id of callIDs) if (resultIDs.has(id)) keepCalls.add(id);

  let changed = false;
  // 1) assistant.tool_calls：按 keepCalls 对称裁剪——只留有结果的调用，过滤后为空则删键。
  for (const m of messages) {
    if (!m || typeof m !== "object" || m.role !== "assistant") continue;
    const tcs = m.tool_calls;
    if (!Array.isArray(tcs) || tcs.length === 0) continue;
    const keptCalls = tcs.filter((tc: any) => tc && typeof tc === "object" && keepCalls.has(String(tc.id ?? "")));
    if (keptCalls.length === tcs.length) continue; // 整批齐全：零改动
    changed = true;
    if (keptCalls.length === 0) delete m.tool_calls;
    else m.tool_calls = keptCalls;
  }
  // 2) role:tool 结果：只有对应 tool_call 被保留才保留；孤儿结果整条删除。
  const kept: any[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") {
      kept.push(m);
      continue;
    }
    if (m.role === "tool") {
      if (!keepCalls.has(String(m.tool_call_id ?? ""))) {
        changed = true;
        continue;
      }
    }
    kept.push(m);
  }
  return changed ? [kept, true] : [messages, false];
}
