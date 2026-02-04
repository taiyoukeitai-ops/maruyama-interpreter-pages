export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("OK");
  }

  const events = body?.events;
  if (!Array.isArray(events) || events.length === 0) {
    return new Response("OK");
  }

  context.waitUntil(handleEvents(events, env));
  return new Response("OK");
}

async function handleEvents(events, env) {
  for (const ev of events) {
    try {
      if (ev?.type !== "message") continue;
      if (ev?.message?.type !== "text") continue;

      const text = (ev.message.text ?? "").trim();
      if (!text) continue;

      // ===== コマンド =====
      if (text === "//debug") {
        const report = await debugReport(env.OPENAI_API_KEY);
        await sendLine(ev, report, env.LINE_CHANNEL_ACCESS_TOKEN);
        continue;
      }

      // //why <文章> または //why 改行 文章
      if (text.startsWith("//why")) {
        let q = text.replace(/^\/\/why[ \t]*/m, "");
        q = q.replace(/^\n+/, "").trim();
        if (!q) {
          await sendLine(ev, "【WHY】使い方： //why <翻訳したい文章>（改行して本文でもOK）", env.LINE_CHANNEL_ACCESS_TOKEN);
          continue;
        }

        const dir = detectDirection(q);
        const targetLanguage = dir === "JA→TH" ? "Thai" : "Japanese";
        const system = `Translate to ${targetLanguage}. Output translation only.`;

        const r = await callOpenAIChatCompletions(q, system, env.OPENAI_API_KEY, 20000);
        if (r.ok) {
          await sendLine(ev, `【WHY】OK / len=${r.text.length}`, env.LINE_CHANNEL_ACCESS_TOKEN);
        } else {
          await sendLine(ev, `【WHY】fail reason=${r.reason} / detail=${r.errorDetail || r.text || "no detail"}`, env.LINE_CHANNEL_ACCESS_TOKEN);
        }
        continue;
      }

      // 翻訳しない：文頭が // なら無反応
      if (text.startsWith("//")) continue;

      if (text.length <= 2) continue;

      const dir = detectDirection(text); // JA→TH / TH→JA / EN→JA
      const targetLanguage = dir === "JA→TH" ? "Thai" : "Japanese";

      function dirLabel(dir) {
  if (dir === "JA→TH") return "🇯🇵→🇹🇭";
  if (dir === "TH→JA") return "🇹🇭→🇯🇵";
  if (dir === "EN→JA") return "🌐→🇯🇵";
  return "🌐";
}

      // 長文対策（速度重視）
      const chunks = splitTextSmart(text, 1400);

      const translatedParts = [];
      for (const chunk of chunks) {
        const t = await translateFast(chunk, targetLanguage, env.OPENAI_API_KEY);
        translatedParts.push(t);
      }

      if (translatedParts.some((p) => p.includes("（翻訳に失敗しました）"))) {
        await sendLine(
          ev,
          "（翻訳に失敗しました）もう一度送ってください。長文は分けると安定します。※翻訳不要なら先頭に //",
          env.LINE_CHANNEL_ACCESS_TOKEN
        );
        continue;
      }

      const out = `${dirLabel(dir)}\n${translatedParts.join("\n")}`;

      await sendLine(ev, out, env.LINE_CHANNEL_ACCESS_TOKEN);
    } catch {
      await sendLine(
        ev,
        "（翻訳に失敗しました）もう一度送ってください。長文は分けると安定します。※翻訳不要なら先頭に //",
        env.LINE_CHANNEL_ACCESS_TOKEN
      );
    }
  }
}

/** reply優先（グループでも確実） */
async function sendLine(ev, text, token) {
  if (!token) return;

  const replyToken = ev?.replyToken;
  if (replyToken) {
    const res = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: "text", text }],
      }),
    });
    if (res.ok) return;
  }

  const to = getPushTarget(ev);
  if (!to) return;

  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to,
      messages: [{ type: "text", text }],
    }),
  });
}

function getPushTarget(ev) {
  const s = ev?.source || {};
  if (s.userId) return s.userId;
  if (s.groupId) return s.groupId;
  if (s.roomId) return s.roomId;
  return null;
}

function detectDirection(text) {
  if (/[\u0E00-\u0E7F]/.test(text)) return "TH→JA";
  if (/[ぁ-んァ-ン一-龯]/.test(text)) return "JA→TH";
  if (/[A-Za-z]/.test(text)) return "EN→JA";
  return "JA→TH";
}

function splitTextSmart(text, maxLen) {
  if (text.length <= maxLen) return [text];

  const lines = text.split("\n");
  const chunks = [];
  let buf = "";

  for (const line of lines) {
    if (line.length > maxLen) {
      if (buf.trim()) {
        chunks.push(buf.trim());
        buf = "";
      }
      chunks.push(...hardSplit(line, maxLen));
      continue;
    }

    if ((buf + line + "\n").length > maxLen) {
      if (buf.trim()) chunks.push(buf.trim());
      buf = line + "\n";
    } else {
      buf += line + "\n";
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

function hardSplit(s, n) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

/** 速度重視：リトライ無し（必要なら戻せます） */
async function translateFast(text, targetLanguage, apiKey) {
  if (!apiKey) return "（翻訳に失敗しました：APIキー未設定）";

  const system = `Translate to ${targetLanguage}. Output translation only. Keep names/numbers/symbols and line breaks.`;

  const r = await callOpenAIChatCompletions(text, system, apiKey, 25000);
  if (r.ok) return r.text;

  return "（翻訳に失敗しました）";
}

/**
 * ✅ Chat Completions API（parseが安定）
 */
async function callOpenAIChatCompletions(userText, systemText, apiKey, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: systemText },
          { role: "user", content: userText },
        ],
        // temperature は入れない（不要）
        max_tokens: 900, // 翻訳ならこれで十分。長文なら増やす
      }),
    });

    const raw = await res.text();

    if (!res.ok) {
      let msg = "";
      try {
        const j = JSON.parse(raw);
        msg = j?.error?.message ? String(j.error.message) : "";
      } catch {}
      return {
        ok: false,
        text: `OpenAI ${res.status}`,
        reason: "http",
        errorDetail: msg ? `status=${res.status} / ${msg}` : `status=${res.status}`,
      };
    }

    const json = JSON.parse(raw);
    const out = json?.choices?.[0]?.message?.content;

    if (typeof out === "string" && out.trim()) {
      return { ok: true, text: out.trim() };
    }

    return { ok: false, text: "no choices[0].message.content", reason: "parse", errorDetail: "parse: content missing" };
  } catch (e) {
    const isTimeout = e?.name === "AbortError";
    return { ok: false, text: isTimeout ? "timeout" : "fetch error", reason: isTimeout ? "timeout" : "fetch", errorDetail: isTimeout ? "timeout" : "fetch error" };
  } finally {
    clearTimeout(t);
  }
}

async function debugReport(apiKey) {
  const keyLen = (apiKey || "").length;
  if (!apiKey) {
    return "【DEBUG】OPENAI_API_KEY が読めていません（undefined）。Pages → Settings → Variables（Production）を確認して再デプロイしてください。";
  }

  try {
    const r = await callOpenAIChatCompletions("OK", "Return OK.", apiKey, 15000);
    if (r.ok) return `【DEBUG】OPENAI_API_KEY length=${keyLen} / OpenAI status=200`;
    return `【DEBUG】OPENAI_API_KEY length=${keyLen} / ${r.errorDetail || r.text}`;
  } catch (e) {
    return `【DEBUG】OPENAI_API_KEY length=${keyLen} / error=${e?.name || "error"}`;
  }
}
