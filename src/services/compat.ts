// 兼容层（替代 internal/server/compat_*.go）。
// 把 Responses API / Anthropic Messages API 请求翻译为 OpenAI chat 体。

/** OpenAI Responses API -> chat.completions。 */
export function responsesToChat(body: any): any {
  const messages: any[] = [];
  const input = body.input;
  const arr = Array.isArray(input) ? input : input ? [input] : [];
  for (const item of arr) {
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
    } else if (item.role) {
      messages.push({ role: item.role, content: item.content ?? "" });
    } else if (item.type === "message" && item.role) {
      messages.push({ role: item.role, content: item.content });
    }
  }
  if (body.instructions) messages.unshift({ role: "system", content: body.instructions });
  return {
    model: body.model,
    messages,
    stream: body.stream ?? false,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_output_tokens,
  };
}

/** Anthropic Messages API -> chat.completions。 */
export function anthropicToChat(body: any): any {
  const messages: any[] = [];
  for (const m of body.messages ?? []) {
    if (Array.isArray(m.content)) {
      const text = m.content.map((c: any) => (c.type === "text" ? c.text : "")).join("");
      messages.push({ role: m.role, content: text });
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }
  if (body.system) messages.unshift({ role: "system", content: body.system });
  return {
    model: body.model,
    messages,
    stream: body.stream ?? false,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_tokens,
  };
}
