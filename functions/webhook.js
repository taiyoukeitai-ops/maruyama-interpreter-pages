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

  // LINEへは即200（タイムアウト回避）
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

      // ====== コマンド ======
      // 1) デバッグ：OpenAI疎通確認（通常運用に影響なし）
      if (text === "//debug") {
        const report = await debugReport(env.OPENAI_API_KEY);
        await sendLine(ev, report, env.LINE_CHANNEL_ACCESS_TOKEN);
        continue;
      }
            // 1.5) 翻訳失敗の理由確認（このコマンド時だけ返す）
      // 使い方：
      //   ① //why <文章>
      //   ② //why \n <文章>   ←改行でもOK
      if (text.startsWith("//why")) {
        // 1行目の //why を取り除き、残り全部（改行含む）を本文として扱う
        // 例: "//why\nこんにちは" もOK
        let q = text.replace(/^\/\/why[ \t]*/m, ""); // //why と直後の半角空白/タブを削除
        q = q.replace(/^\n+/, "");                   // 先頭の改行を削除
        q = q.trim();

        if (!q) {
          await sendLine(ev, "【WHY】使い方： //why <翻訳したい文章>（改行して本文でもOK）", env.LINE_CHANNEL_ACCESS_TOKEN);
          continue;
        }

        const dir = detectDirection(q);
        const targetLanguage = dir === "JA→TH" ? "Thai" : "Japanese";
        const system = `Translate to ${targetLanguage}. Output translation only.`;

        const r = await callOpenAI(q, system, env.OPENAI_API_KEY, 20000);

        if (r.ok) {
          await sendLine(ev, `【WHY】OK / extracted_len=${r.text.length}`, env.LINE_CHANNEL_ACCESS_TOKEN);
        } else {
          await sendLine(
            ev,
            `【WHY】fail reason=${r.reason} / detail=${r.errorDetail || r.text || "no detail"}`,
            env.LINE_CHANNEL_ACCESS_TOKEN
          );
        }
        continue;
      }


      // 2) 翻訳しない：文頭が // なら無反応
      if (text.startsWith("//")) continue;

      // 短すぎるものは無視（誤爆防止）
      if (text.length <= 2) continue;

      // ====== 翻訳方向判定 ======
      const dir = detectDirection(text); // "JA→TH" / "TH→JA" / "EN→JA"
      const targetLanguage = dir === "JA→TH" ? "Thai" : "Japanese";

      // ====== 長文対策（速度優先） ======
      // ここを大きくすると分割が減って速くなるが、失敗時のリスクも上がる
      const chunks = splitTextSmart(text, 1400);

      const translatedParts = [];
      for (const chunk of chunks) {
        const t = await translateFast(chunk, targetLanguage, env.OPENAI_API_KEY);
        translatedParts.push(t);
      }

      // どこか1つでも失敗文字列が入ったら、全体を失敗扱い（1通だけ）
      if (translatedParts.some((p) => p.includes("（翻訳に失敗しました）"))) {
        await sendLine(
          ev,
          "（翻訳に失敗しました）もう一度送ってください。長文は分けると安定します。※翻訳不要なら先頭に //",
          env.LINE_CHANNEL_ACCESS_TOKEN
        );
        continue;
      }

      const translated = translatedParts.join("\n");
      const out = `【${dir}】\n${translated}`;

      // 成功時：翻訳結果のみ（1通）
      await sendLine(ev, out, env.LINE_CHANNEL_ACCESS_TOKEN);
    } catch {
      // 失敗時のみ（1通）
      await sendLine(
        ev,
        "（翻訳に失敗しました）もう一度送ってください。長文は分けると安定します。※翻訳不要なら先頭に //",
        env.LINE_CHANNEL_ACCESS_TOKEN
      );
    }
  }
}

/**
 * グループ/ルーム/個別すべて確実に返すため、
 * replyToken があれば reply API を優先（最速・確実）
 * なければ push にフォールバック
 */
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
    // reply失敗時のみ pushへ
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
  // Thai
  if (/[\u0E00-\u0E7F]/.test(text)) return "TH→JA";
  // Japanese
  if (/[ぁ-んァ-ン一-龯]/.test(text)) return "JA→TH";
  // English
  if (/[A-Za-z]/.test(text)) return "EN→JA";
  // default
  return "JA→TH";
}

/**
 * 速度優先の分割
 * - 改行を優先してまとめる
 * - それでも長い行は強制カット
 */
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

/**
 * OpenAI：速度重視・安定重視（Responses API）
 * - instructions + input で送る（安定）
 * - temperature は入れない（モデルが拒否する）
 * - 1回目短め、タイムアウト時のみリトライ
 */
async function translateFast(text, targetLanguage, apiKey) {
  if (!apiKey) return "（翻訳に失敗しました：APIキー未設定）";

  const system = `Translate to ${targetLanguage}. Output translation only.`;

  const r = await callOpenAI(text, system, apiKey, 25000); // 25秒
  if (r.ok) return r.text;

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
  instructions: systemText,
  input: userText,
  max_output_tokens: 600,
  text: { format: { type: "text" } },
  store: false
}),



    const raw = await res.text();
    if (!res.ok) {
  // エラーの本文から message を抜く（短く）
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

    // Responses APIの正しい抽出
    const out = extractOutputText(json);
    if (out) return { ok: true, text: out };

    return {
  ok: false,
  text: "no output_text",
  reason: "parse",
  errorDetail: "parse: output_text not found in output[].content[]",
};

  } catch (e) {
    const isTimeout = e?.name === "AbortError";
    return {
      ok: false,
      text: isTimeout ? "timeout" : "fetch error",
      reason: isTimeout ? "timeout" : "fetch",
    };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Responses APIの output からテキストを抽出
 * - content[].type === "output_text" を最優先
 * - 念のため type==="text" のケースも拾う
 */
function extractOutputText(json) {
  // 1) もし top-level に output_text があればそれを優先（SDK互換の形が入ることがある）
  if (typeof json?.output_text === "string" && json.output_text.trim()) {
    return json.output_text.trim();
  }

  const output = json?.output;
  if (!Array.isArray(output)) return "";

  const texts = [];

  for (const item of output) {
    // 2) item直下に output_text がある場合
    if (typeof item?.output_text === "string" && item.output_text.trim()) {
      texts.push(item.output_text.trim());
    }

    const content = item?.content;
    if (!Array.isArray(content)) continue;

    for (const c of content) {
      // 3) content[].text が string の場合
      if (typeof c?.text === "string" && c.text.trim()) {
        texts.push(c.text.trim());
        continue;
      }

      // 4) content[].text が object の場合（例：{ value: "..." }）
      if (c?.text && typeof c.text === "object") {
        if (typeof c.text.value === "string" && c.text.value.trim()) {
          texts.push(c.text.value.trim());
          continue;
        }
        if (typeof c.text.content === "string" && c.text.content.trim()) {
          texts.push(c.text.content.trim());
          continue;
        }
      }

      // 5) type によって別名フィールドがある場合に備える
      if (typeof c?.output_text === "string" && c.output_text.trim()) {
        texts.push(c.output_text.trim());
        continue;
      }
      if (typeof c?.value === "string" && c.value.trim()) {
        texts.push(c.value.trim());
        continue;
      }
    }
  }

  return texts.join("\n").trim();
}


/**
 * デバッグ：OpenAI疎通とエラー内容を一行で返す
 */
async function debugReport(apiKey) {
  const keyLen = (apiKey || "").length;

  if (!apiKey) {
    return "【DEBUG】OPENAI_API_KEY が読めていません（undefined）。Pages → Settings → Variables（Production）を確認して再デプロイしてください。";
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
        instructions: "Return OK.",
        input: "OK",
        max_output_tokens: 32,
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
