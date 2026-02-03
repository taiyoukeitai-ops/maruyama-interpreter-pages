export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    // LINEの疎通用：JSONでなくても200を返す
    return new Response("OK");
  }

  const events = body?.events;
  if (!Array.isArray(events) || events.length === 0) {
    return new Response("OK");
  }

  // LINEには即200（タイムアウト回避）
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

            // デバッグ（このコマンドだけは返信する）
      if (text.startsWith("//debug")) {
        const to = getPushTarget(ev);
        if (!to) continue;
        const report = await debugReport(env.OPENAI_API_KEY);
        await pushLine(to, report, env.LINE_CHANNEL_ACCESS_TOKEN);
        continue;
      }

      // 翻訳しない指定：文頭が // の場合は何もしない
      if (text.startsWith("//")) continue;


      // 短すぎるものは無視（スタンプ代わり等）
      if (text.length <= 2) continue;

      const to = getPushTarget(ev);
      if (!to) continue;

      // 方向判定
      const dir = detectDirection(text); // "JA→TH" / "TH→JA" / "EN→JA"
      const targetLanguage =
        dir === "JA→TH" ? "Thai" : "Japanese";

      // 長文対策：適度に分割（速度優先）
      const chunks = splitTextSmart(text, 900);

      const translatedParts = [];
      for (const chunk of chunks) {
        const t = await translateFast(chunk, targetLanguage, env.OPENAI_API_KEY);
        translatedParts.push(t);
      }

      const translated = translatedParts.join("\n");
      const out = `【${dir}】\n${translated}`;

      // 成功時：翻訳結果のみ（1通）
      await pushLine(to, out, env.LINE_CHANNEL_ACCESS_TOKEN);

    } catch (e) {
      // 失敗時のみメッセージ（1通）
      const to = getPushTarget(ev);
      if (to) {
        await pushLine(
          to,
          "（翻訳に失敗しました）もう一度送ってください。長文の場合は分けて送ると安定します。※翻訳不要なら先頭に //",
          env.LINE_CHANNEL_ACCESS_TOKEN
        );
      }
    }
  }
}

function getPushTarget(ev) {
  const s = ev?.source || {};
  if (s.userId) return s.userId;
  if (s.groupId) return s.groupId;
  if (s.roomId) return s.roomId;
  return null;
}

function detectDirection(text) {
  // Thai
  if (/[\u0E00-\u0E7F]/.test(text)) return "TH→JA";
  // Japanese (Hiragana/Katakana/Kanji)
  if (/[ぁ-んァ-ン一-龯]/.test(text)) return "JA→TH";
  // English letters -> Japanese
  if (/[A-Za-z]/.test(text)) return "EN→JA";
  // default
  return "JA→TH";
}

/**
 * 速度優先の分割：
 * - 改行を優先してまとめる
 * - それでも長い場合は文字数で切る
 */
function splitTextSmart(text, maxLen) {
  if (text.length <= maxLen) return [text];

  const lines = text.split("\n");
  const chunks = [];
  let buf = "";

  for (const line of lines) {
    // 1行が長すぎる場合は強制カット
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
  for (let i = 0; i < s.length; i += n) {
    out.push(s.slice(i, i + n));
  }
  return out;
}

/**
 * OpenAI：速度重視
 * - system短め
 * - 出力トークン上限
 * - タイムアウト短め＋1回リトライ
 */
async function translateFast(text, targetLanguage, apiKey) {
  if (!apiKey) return "（翻訳に失敗しました：APIキー未設定）";

  const system =
    `Translate into ${targetLanguage}. ` +
    `Return translation only. Keep names/numbers/symbols.`;

  // 1回目：短めタイムアウト
  const first = await callOpenAI(text, system, apiKey, 8000);
  if (first.ok) return first.text;

  // 2回目：少し長めで再試行（ネット揺れ対策）
  const second = await callOpenAI(text, system, apiKey, 12000);
  if (second.ok) return second.text;

  // 失敗理由はユーザーに出しすぎない（業務運用向け）
  return "（翻訳に失敗しました）";
}

async function callOpenAI(userText, systemText, apiKey, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5-mini",
        max_output_tokens: 800,
        input: [
          { role: "system", content: systemText },
          { role: "user", content: userText },
        ],
      }),
    });

    const raw = await res.text();
    if (!res.ok) {
      return { ok: false, text: `OpenAI ${res.status}` };
    }

    const json = JSON.parse(raw);

    // まずは output_text を優先
    const out = (json?.output_text ?? "").trim();
    if (out) return { ok: true, text: out };

    // 念のため fallback（構造が違う場合）
    const alt = extractTextFromResponses(json);
    if (alt) return { ok: true, text: alt };

    return { ok: false, text: "no output_text" };
  } catch (e) {
    return { ok: false, text: e?.name === "AbortError" ? "timeout" : "error" };
  } finally {
    clearTimeout(t);
  }
}

function extractTextFromResponses(json) {
  // responsesのfallback抽出
  const output = json?.output;
  if (!Array.isArray(output)) return "";

  for (const item of output) {
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      const txt = (c?.text ?? "").trim();
      if (txt) return txt;
    }
  }
  return "";
}

async function pushLine(to, text, token) {
  if (!token) return;

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
async function debugReport(apiKey) {
  const keyLen = (apiKey || "").length;

  if (!apiKey) {
    return "【DEBUG】OPENAI_API_KEY が読めていません（undefined）。Cloudflare Pages → Settings → Variables（Production）を確認して再デプロイしてください。";
  }

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5-mini",
        max_output_tokens: 32, // ★16以上必須
        input: [
          { role: "system", content: "Return OK." },
          { role: "user", content: "OK" },
        ],
      }),
    });

    const raw = await res.text();
    let hint = "";
    try {
      const j = JSON.parse(raw);
      if (j?.error?.message) hint = ` / ${j.error.message}`;
    } catch {}

    return `【DEBUG】OPENAI_API_KEY length=${keyLen} / OpenAI status=${res.status}${hint}`;
  } catch (e) {
    return `【DEBUG】OPENAI_API_KEY length=${keyLen} / OpenAI fetch error=${e?.name || "error"}`;
  }
}
