// 协议层单元测试：mock DSH 核心服务 + mock 腾讯 iLink 云，
// 验证桥接插件的 HTTP/OpenAI 兼容行为、微信 iLink 直连流程与远程办公指令。
// 运行方式：scripts/test.ps1（会把插件放进 DSH 的 node_modules 树以解析依赖，
// 并用临时 USERPROFILE 隔离）。
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import net from "node:net";
import { createHash, createCipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- mock 腾讯 iLink 云（ilinkai.weixin.qq.com 的替身） ----
const sentMessages = [];
const sentHeaders = [];
const qrPolls = [];
let ilinkQrFetches = 0; // get_bot_qrcode 拉取计数（登录重入锁断言用）
const pendingMsgs = []; // getupdates 每次弹出并清空

const mockIlink = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (obj) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const readBody = (cb) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => cb(body));
  };
  if (url.pathname === "/ilink/bot/get_bot_qrcode") {
    ilinkQrFetches += 1;
    return send({ ret: 0, data: { qrcode: "qr-mock-1", qrcode_img_content: "https://liteapp.weixin.qq.com/q/mock" } });
  }
  if (url.pathname === "/ilink/bot/get_qrcode_status") {
    qrPolls.push(url.searchParams.get("verify_code"));
    const n = qrPolls.length;
    if (n <= 1) return send({ ret: 0, data: { status: "wait" } });
    if (n === 2) return send({ ret: 0, data: { status: "scaned" } });
    return send({
      ret: 0,
      data: {
        status: "confirmed",
        bot_token: "tok-mock-abc",
        ilink_bot_id: "mockbot@im.bot",
        ilink_user_id: "mockuser@im.wechat",
      },
    });
  }
  if (url.pathname === "/ilink/bot/getupdates") {
    return readBody(() => {
      const msgs = pendingMsgs.splice(0, pendingMsgs.length);
      return send({ ret: 0, data: { msgs, get_updates_buf: "buf-1" } });
    });
  }
  if (url.pathname === "/ilink/bot/sendmessage") {
    sentHeaders.push(req.headers);
    return readBody((bodyText) => {
      sentMessages.push(JSON.parse(bodyText));
      send({ ret: 0 });
    });
  }
  return send({ ret: -1 });
});
await new Promise((resolve) => mockIlink.listen(65411, "127.0.0.1", resolve));

// 必须在导入插件前设置，wechat.js/feishu.js/qq.js 在模块加载时读取这些环境变量
process.env.OPENCLAW_BRIDGE_ILINK_BASE = "http://127.0.0.1:65411";
process.env.OPENCLAW_BRIDGE_FEISHU_BASE = "http://127.0.0.1:65414";
process.env.OPENCLAW_BRIDGE_QQ_BASE = "http://127.0.0.1:65416";
process.env.OPENCLAW_BRIDGE_QQ_SANDBOX_BASE = "http://127.0.0.1:65416";
process.env.OPENCLAW_BRIDGE_QQ_TOKEN_URL = "http://127.0.0.1:65416/app/getAppAccessToken";
const mod = await import("@deepseek-ai/dsh-openclaw-bridge");
const { name, inject, apply } = mod;
// 共享层与 vendored WS 客户端直测（package.json exports "./lib/*" 开放子路径）
const { convKey, sessionIdFor, agentKeyFor, splitText, segmentReply } = await import("@deepseek-ai/dsh-openclaw-bridge/lib/core/session.js");
const { createDedupe } = await import("@deepseek-ai/dsh-openclaw-bridge/lib/core/dedupe.js");
const { createInboundQuota, createOutboundQueue } = await import("@deepseek-ai/dsh-openclaw-bridge/lib/core/quota.js");
const { parseWhitelist, isAllowed } = await import("@deepseek-ai/dsh-openclaw-bridge/lib/core/whitelist.js");
const { createChannelLogger } = await import("@deepseek-ai/dsh-openclaw-bridge/lib/core/logs.js");
const wsMod = await import("@deepseek-ai/dsh-openclaw-bridge/lib/ws.js");
const feishuMod = await import("@deepseek-ai/dsh-openclaw-bridge/lib/channels/feishu.js");

const CHAT = "/openclaw-bridge/v1/chat/completions";
const HEALTH = "/openclaw-bridge/health";
const WX_STATUS = "/openclaw-bridge/wechat/status";
const WX_LOGIN = "/openclaw-bridge/wechat/login";

// ---- mock agent：followup 后异步产生一轮回复 ----
function makeMockAgent(label) {
  const events = [];
  let followupCalls = 0;
  const agent = {
    session: {
      id: "session-" + label,
      get seq() { return events.length; },
      events,
      meta: { cwd: "mock-cwd" },
    },
    followup(msg) {
      followupCalls += 1;
      events.push({ seq: events.length, type: "user/message", data: msg });
      events.push({ seq: events.length, type: "turn/start", data: {} });
      setTimeout(() => {
        events.push({
          seq: events.length,
          type: "assistant/message",
          data: { message: { content: [{ type: "text", text: "[" + label + " 第" + followupCalls + "轮] 你好，我是桥接的 DSH agent。" }] } },
        });
        events.push({ seq: events.length, type: "turn/end", data: { reason: { kind: "completed" } } });
      }, 40);
    },
    whenIdle() { return new Promise((r) => setTimeout(r, 90)); },
  };
  return { agent, getFollowupCalls: () => followupCalls };
}

// ---- mock OpenAI 兼容端点（自定义 provider 的目标） ----
let mockOpenAiMode = "text"; // text | tool | auth
const mockOpenAi = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const sse = (payload) => res.write("data: " + JSON.stringify(payload) + "\n\n");
    if (mockOpenAiMode === "auth") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad api key", type: "invalid_request_error" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (mockOpenAiMode === "tool") {
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "say", arguments: "{\"a\":1" } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      sse({ usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    // text 模式
    sse({ choices: [{ index: 0, delta: { content: "hello " }, finish_reason: null }] });
    sse({ choices: [{ index: 0, delta: { content: "from custom" }, finish_reason: null }] });
    sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    sse({ usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((resolve) => mockOpenAi.listen(65412, "127.0.0.1", resolve));

// ---- mock WebSocket 服务（验证 lib/ws.js vendored 客户端）----
// 手工实现最小 WS 服务端：101 握手 + 解析客户端掩码帧 + 文本回声 / ping / 分片 / 关闭。
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const wsEvents = []; // "text:xxx" / "ping" / "pong" / "close"

function wsServerFrame(opcode, payload, fin = true) {
  let len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  return Buffer.concat([header, payload]);
}

const mockWsServer = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  let handshakeText = "";
  let handshakeDone = false;
  sock.on("data", (c) => {
    if (!handshakeDone) {
      handshakeText += c.toString("latin1");
      const idx = handshakeText.indexOf("\r\n\r\n");
      if (idx === -1) {
        if (handshakeText.length > 65536) sock.destroy();
        return;
      }
      const head = handshakeText.slice(0, idx);
      const keyLine = head.split("\r\n").find((l) => l.toLowerCase().startsWith("sec-websocket-key:"));
      const accept = createHash("sha1").update(String(keyLine || "").split(":")[1].trim() + WS_GUID).digest("base64");
      sock.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
      );
      handshakeDone = true;
      buf = Buffer.from(handshakeText.slice(idx + 4), "latin1");
    } else {
      buf = Buffer.concat([buf, c]);
    }
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      let maskKey = null;
      if (masked) {
        if (buf.length < off + 4) return;
        maskKey = buf.subarray(off, off + 4);
        off += 4;
      }
      if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      if (maskKey) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
        payload = out;
      }
      if (op === 0x1) {
        const text = payload.toString("utf8");
        wsEvents.push("text:" + text.slice(0, 200));
        if (text === "@frag") {
          sock.write(wsServerFrame(0x1, Buffer.from("frag"), false));
          sock.write(wsServerFrame(0x0, Buffer.from("ment"), true));
        } else if (text === "@ping") {
          sock.write(wsServerFrame(0x9, Buffer.from("hb")));
        } else {
          sock.write(wsServerFrame(0x1, Buffer.from("echo:" + text.slice(0, 60))));
        }
      } else if (op === 0x8) {
        wsEvents.push("close");
        sock.write(wsServerFrame(0x8, Buffer.from([0x03, 0xe8])));
        sock.end();
      } else if (op === 0x9) {
        wsEvents.push("ping");
        sock.write(wsServerFrame(0xa, payload));
      } else if (op === 0xa) {
        wsEvents.push("pong");
      }
    }
  });
});
await new Promise((resolve) => mockWsServer.listen(65413, "127.0.0.1", resolve));

// ---- mock 飞书云（P1）：HTTP 管理面（token/端点发现/发送）+ protobuf 帧 WS 网关 ----
const { createFeishuAdapter, feishuDecrypt, encodeFrame, decodeFrame, normalizeFeishuEvent } = feishuMod;
const feishuHttpCalls = []; // {method, pathname, query, body}
const mockFeishuHttp = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (obj, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    let parsed = {};
    try {
      parsed = JSON.parse(body || "{}");
    } catch {}
    feishuHttpCalls.push({ method: req.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), body: parsed });
    if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
      if (parsed.app_secret !== "test_secret") return send({ code: 10003, msg: "invalid app_secret", data: {} });
      return send({ code: 0, msg: "ok", tenant_access_token: "t-mock-feishu", expire: 7200 });
    }
    if (url.pathname === "/callback/ws/endpoint") {
      if (parsed.AppSecret !== "test_secret") return send({ code: 1000040346, msg: "app_id is invalid", data: { URL: "" } });
      return send({
        code: 0,
        msg: "ok",
        data: {
          URL: "ws://127.0.0.1:65415/connect?device_id=dev-1&service_id=777",
          ClientConfig: { PingInterval: 3, ReconnectCount: 1, ReconnectInterval: 1, ReconnectNonce: 1 },
        },
      });
    }
    if (url.pathname.startsWith("/open-apis/im/v1/messages")) {
      return send({ code: 0, msg: "ok", data: { message_id: "om_sent_" + feishuHttpCalls.length } });
    }
    send({ code: 404, msg: "not found", data: {} }, 404);
  });
});
await new Promise((resolve) => mockFeishuHttp.listen(65414, "127.0.0.1", resolve));

const feishuWsSockets = [];
const feishuClientFrames = []; // 客户端上行帧（decodeFrame 后）
const mockFeishuWs = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  let handshakeText = "";
  let handshakeDone = false;
  sock.on("data", (c) => {
    if (!handshakeDone) {
      handshakeText += c.toString("latin1");
      const idx = handshakeText.indexOf("\r\n\r\n");
      if (idx === -1) return;
      const head = handshakeText.slice(0, idx);
      const keyLine = head.split("\r\n").find((l) => l.toLowerCase().startsWith("sec-websocket-key:"));
      const accept = createHash("sha1").update(String(keyLine || "").split(":")[1].trim() + WS_GUID).digest("base64");
      sock.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
      );
      handshakeDone = true;
      buf = Buffer.from(handshakeText.slice(idx + 4), "latin1");
    } else {
      buf = Buffer.concat([buf, c]);
    }
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      let maskKey = null;
      if (masked) {
        if (buf.length < off + 4) return;
        maskKey = buf.subarray(off, off + 4);
        off += 4;
      }
      if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      if (maskKey) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
        payload = out;
      }
      if (op === 0x2) {
        const f = decodeFrame(payload);
        feishuClientFrames.push(f);
        const type = (f.headers.find((h) => h.key === "type") || {}).value;
        if (f.method === 0 && type === "ping") {
          sock.write(wsServerFrame(0x2, encodeFrame({
            service: 777,
            method: 0,
            headers: [{ key: "type", value: "pong" }],
            payload: Buffer.from(JSON.stringify({ PingInterval: 3, ReconnectCount: 1, ReconnectInterval: 1, ReconnectNonce: 1 }), "utf8"),
          })));
        }
      } else if (op === 0x8) {
        sock.write(wsServerFrame(0x8, Buffer.from([0x03, 0xe8])));
        sock.end();
      }
    }
  });
  sock.on("close", () => {
    const i = feishuWsSockets.indexOf(sock);
    if (i >= 0) feishuWsSockets.splice(i, 1);
  });
  feishuWsSockets.push(sock);
});
await new Promise((resolve) => mockFeishuWs.listen(65415, "127.0.0.1", resolve));

// ---- mock QQ 开放平台（HTTP 65416：token + gateway + 发送；WS 65417：网关）----
const qqHttpCalls = [];
const mockQqHttp = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  let body = "";
  for await (const c of req) body += c;
  let parsed = {};
  try {
    parsed = JSON.parse(body || "{}");
  } catch {}
  const send = (obj, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  qqHttpCalls.push({
    method: req.method,
    pathname: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: req.headers,
    body: parsed,
  });
  if (url.pathname === "/app/getAppAccessToken") {
    if (parsed.appId !== "qq_test_app" || parsed.clientSecret !== "qq_test_secret") {
      return send({ code: 6000, message: "invalid credentials", data: null });
    }
    return send({ code: 0, message: "ok", access_token: "qq-at-mock", expires_in: "7200" });
  }
  if (url.pathname === "/gateway/bot") {
    if (!/^QQBot /.test(req.headers.authorization || "")) return send({ code: 11244, message: "invalid token" }, 401);
    return send({
      url: "ws://127.0.0.1:65417/websocket",
      shards: 1,
      session_start_limit: { total: 1, remaining: 1, reset_after: 60000, max_concurrency: 1 },
    });
  }
  if (/^\/v2\/(groups|users)\//.test(url.pathname) && url.pathname.endsWith("/messages")) {
    return send({ id: "qq_msg_" + qqHttpCalls.length, timestamp: String(Date.now()) });
  }
  send({ code: 404, message: "not found" }, 404);
});
await new Promise((resolve) => mockQqHttp.listen(65416, "127.0.0.1", resolve));

const qqWsSockets = [];
const qqClientFrames = []; // 客户端上行帧（JSON 解析后 {op,d,t,s,id}）
let qqSrvSeq = 0;
const mockQqWs = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  let handshakeText = "";
  let handshakeDone = false;
  sock.on("data", (c) => {
    if (!handshakeDone) {
      handshakeText += c.toString("latin1");
      const idx = handshakeText.indexOf("\r\n\r\n");
      if (idx === -1) return;
      const head = handshakeText.slice(0, idx);
      const keyLine = head.split("\r\n").find((l) => l.toLowerCase().startsWith("sec-websocket-key:"));
      const accept = createHash("sha1").update(String(keyLine || "").split(":")[1].trim() + WS_GUID).digest("base64");
      sock.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
      );
      handshakeDone = true;
      buf = Buffer.from(handshakeText.slice(idx + 4), "latin1");
      // 网关协议：连接建立后立即下发 HELLO（heartbeat_interval 1500ms）
      sock.write(wsServerFrame(0x1, Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 1500 } }), "utf8")));
    } else {
      buf = Buffer.concat([buf, c]);
    }
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      let maskKey = null;
      if (masked) {
        if (buf.length < off + 4) return;
        maskKey = buf.subarray(off, off + 4);
        off += 4;
      }
      if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      if (maskKey) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
        payload = out;
      }
      if (op === 0x1) {
        let f = {};
        try {
          f = JSON.parse(payload.toString("utf8"));
        } catch {}
        qqClientFrames.push(f);
        if (f.op === 2) {
          // IDENTITY → READY
          qqSrvSeq++;
          sock.write(wsServerFrame(0x1, Buffer.from(JSON.stringify({
            op: 0, s: qqSrvSeq, t: "READY",
            d: { version: 1, session_id: "qq-sess-1", user: { id: "qqbot1", username: "bot", bot: true }, shard: [0, 1] },
            id: "ready_1",
          }), "utf8")));
        } else if (f.op === 1) {
          // HEARTBEAT → ACK
          sock.write(wsServerFrame(0x1, Buffer.from(JSON.stringify({ op: 11, d: null }), "utf8")));
        } else if (f.op === 6) {
          // RESUME → RESUMED
          qqSrvSeq++;
          sock.write(wsServerFrame(0x1, Buffer.from(JSON.stringify({ op: 0, s: qqSrvSeq, t: "RESUMED", d: null, id: "resumed_1" }), "utf8")));
        }
      } else if (op === 0x8) {
        sock.write(wsServerFrame(0x8, Buffer.from([0x03, 0xe8])));
        sock.end();
      }
    }
  });
  sock.on("close", () => {
    const i = qqWsSockets.indexOf(sock);
    if (i >= 0) qqWsSockets.splice(i, 1);
  });
  qqWsSockets.push(sock);
});
await new Promise((resolve) => mockQqWs.listen(65417, "127.0.0.1", resolve));
const pushQqEvent = (t, d) => {
  qqSrvSeq++;
  const f = JSON.stringify({ op: 0, s: qqSrvSeq, t, id: "evt_" + t, d });
  for (const s of qqWsSockets) s.write(wsServerFrame(0x1, Buffer.from(f, "utf8")));
};

// 测试侧推帧工具：header 构造 + 事件 payload 构造
const evtHeaders = (eventId, opts = {}) => [
  { key: "type", value: "event" },
  { key: "message_id", value: "om_" + eventId },
  { key: "sum", value: String(opts.sum || 1) },
  { key: "seq", value: String(opts.seq || 0) },
  { key: "trace_id", value: "tr_" + eventId },
];
const evtPayload = (eventId, over = {}) =>
  JSON.stringify({
    schema: "2.0",
    header: { event_id: eventId, event_type: "im.message.receive_v1", create_time: String(Date.now()), token: "t", app_id: "cli_feishu_test", tenant_key: "tk" },
    event: {
      sender: { sender_id: { open_id: "ou_mock_user1" }, sender_type: "user", tenant_key: "tk" },
      message: {
        message_id: "om_" + eventId,
        chat_id: "oc_p2p_1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "你好飞书" }),
        mentions: [],
        ...over,
      },
    },
  });
const pushFeishuFrame = (headers, payloadStr) => {
  const f = encodeFrame({ service: 777, method: 1, headers, payload: Buffer.from(payloadStr, "utf8") });
  for (const s of feishuWsSockets) s.write(wsServerFrame(0x2, f));
};

// ---- mock ctx ----
const routes = new Map();
const poolMocks = new Map();
const agentOptionsLog = [];
let mockSettingsValue = { model: "", token: "", workspace: "", allowlist: "", customBaseURL: "", customApiKey: "", customModel: "" };

const ctx = {
  llm: {
    registerAdapter() {
      const dispose = () => {};
      dispose.replace = () => {};
      return dispose;
    },
  },
  inject(deps, cb) {
    if (Array.isArray(deps) && deps.includes("settings")) {
      const scope = {
        get: () => ({ ...mockSettingsValue }),
        watch: () => () => {},
      };
      cb({ effect: () => () => {}, settings: { register: () => scope } });
    }
    return () => {};
  },
  webServer: {
    port: 6100,
    register(route) {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  },
  get(key) {
    if (key === "agents") {
      return {
        async create(opts) {
          agentOptionsLog.push(opts.agentOptions || {});
          const mock = makeMockAgent(opts.meta.cwd.split(/[\\/]/).pop());
          poolMocks.set(opts.meta.cwd.split(/[\\/]/).pop(), mock);
          opts.setup?.({ on: () => () => {} });
          return { agent: mock.agent, dispose() {} };
        },
        async resume(opts) {
          const mock = makeMockAgent("attached-" + opts.resumeSessionId);
          poolMocks.set("attached-" + opts.resumeSessionId, mock);
          opts.setup?.({ on: () => () => {} });
          return { agent: mock.agent, dispose() {} };
        },
        get() { return undefined; },
        list() { return []; },
      };
    }
    if (key === "llm") return ctx.llm;
    if (key === "sessions") return { async flush() {} };
    if (key === "sessionPersistence") {
      return {
        async list() {
          return [{ id: "session-999", meta: { cwd: "C:\\attach-ws" } }];
        },
      };
    }
    if (key === "agentDefaultModel") {
      return { currentSelection: () => ({ provider: "test-provider", model: "test-model" }) };
    }
    return undefined;
  },
};

const cleanup = apply(ctx);

// ---- fake http ----
function fakeReq(method, path, { remote = "127.0.0.1", headers = {}, body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = path;
  req.headers = headers;
  req.socket = { remoteAddress: remote };
  req.destroy = () => {};
  queueMicrotask(() => {
    if (body !== null) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    ended: false,
    headersSent: false,
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers || {}); this.headersSent = true; },
    write(chunk) { this.body += String(chunk); },
    end(data) { if (data !== undefined) this.body += String(data); this.ended = true; },
    destroy() {},
  };
}

async function untilEnded(res, ms = 3000) {
  const start = Date.now();
  while (!res.ended) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for response");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function waitFor(pred, ms = 5000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function chat(body) {
  const res = fakeRes();
  await routes.get(CHAT)(fakeReq("POST", CHAT, { body: JSON.stringify(body) }), res);
  if (body.stream) await untilEnded(res);
  return res;
}

async function poolKeys() {
  const res = fakeRes();
  await routes.get(HEALTH)(fakeReq("GET", HEALTH), res);
  return JSON.parse(res.body).agents || [];
}

/** 等 sentMessages 增长到目标数量（微信回复送达 mock 腾讯云）。 */
async function waitSent(count, ms = 30000) {
  const deadline = Date.now() + ms;
  while (sentMessages.length < count && Date.now() < deadline) await sleep(300);
  return sentMessages;
}

function wxMsg(from, text, token) {
  return {
    from_user_id: from,
    to_user_id: "mockbot@im.bot",
    message_type: 1,
    context_token: token || "ctx-x",
    item_list: [{ type: 1, text_item: { text } }],
  };
}

function lastSentText() {
  if (sentMessages.length === 0) return "";
  const last = sentMessages[sentMessages.length - 1];
  return last.msg.item_list.map((i) => (i.text_item ? i.text_item.text : "")).join("");
}

// ---- tests ----
let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  passed += 1;
  console.log("  ✓ " + label);
}

console.log("plugin exports:");
ok(name === "@deepseek-ai/dsh-openclaw-bridge", "name 导出正确");
ok(Array.isArray(inject) && inject.includes("agents"), "inject 含 agents 服务");

// 1) health
{
  const res = fakeRes();
  await routes.get(HEALTH)(fakeReq("GET", HEALTH), res);
  const data = JSON.parse(res.body);
  ok(res.statusCode === 200 && data.ok === true, "health 返回 ok");
  ok(data.servicesReady === true, "health 报告核心服务就绪");
}

// 2) 非流式一轮对话
{
  const res = await chat({ model: "dsh-bridge/test-a", messages: [{ role: "user", content: "你好" }] });
  const data = JSON.parse(res.body);
  ok(res.statusCode === 200, "chat 非流式 200");
  ok(data.object === "chat.completion" && data.model === "dsh-bridge/test-a", "响应回显 model");
  ok(/桥接的 DSH agent/.test(data.choices[0].message.content), "助手文本返回");
  ok(poolMocks.get("dsh-bridge-test-a").getFollowupCalls() === 1, "注入一次用户消息");
}

// 3) 历史去重
{
  const res = await chat({ model: "dsh-bridge/test-a", messages: [{ role: "user", content: "你好" }] });
  const data = JSON.parse(res.body);
  ok(res.statusCode === 200 && /桥接的 DSH agent/.test(data.choices[0].message.content), "去重后仍返回上次回复");
  ok(poolMocks.get("dsh-bridge-test-a").getFollowupCalls() === 1, "相同历史不重复注入");
}

// 4) 历史追加
{
  const res = await chat({
    model: "dsh-bridge/test-a",
    messages: [
      { role: "user", content: "你好" },
      { role: "user", content: "第二条消息" },
    ],
  });
  const data = JSON.parse(res.body);
  ok(/第2轮/.test(data.choices[0].message.content), "只注入了新增的第二条消息");
}

// 5) 不同 model 名 = 独立会话
{
  const res = await chat({ model: "dsh-bridge/test-b", messages: [{ role: "user", content: "你好" }] });
  const data = JSON.parse(res.body);
  ok(/第1轮/.test(data.choices[0].message.content), "新 model 名开启独立会话（第1轮）");
  ok(poolMocks.size === 2, "两个映射会话并存");
}

// 6) 流式 SSE
{
  const res = await chat({ model: "dsh-bridge/test-c", stream: true, messages: [{ role: "user", content: "你好" }] });
  ok(res.statusCode === 200, "stream 200");
  ok(/text\/event-stream/.test(res.headers["content-type"]), "SSE content-type");
  ok(res.body.includes("chat.completion.chunk"), "包含 chunk 帧");
  ok(res.body.includes("data: [DONE]"), "以 [DONE] 结束");
  ok(/桥接的 DSH agent/.test(res.body), "流式帧包含助手文本");
}

// 7) 鉴权：非回环无 token → 401
{
  const res = fakeRes();
  await routes.get(CHAT)(fakeReq("POST", CHAT, { remote: "192.168.1.5", body: JSON.stringify({ model: "x", messages: [] }) }), res);
  ok(res.statusCode === 401, "非回环无 token 拒绝 401");
  const data = JSON.parse(res.body);
  ok(data.error && data.error.type === "authentication_error", "返回 authentication_error");
}

// 8) 坏 JSON → 400；GET → 405
{
  const res2 = fakeRes();
  await routes.get(CHAT)(fakeReq("POST", CHAT, { body: "{bad json" }), res2);
  ok(res2.statusCode === 400, "坏 JSON 400");
  const res3 = fakeRes();
  await routes.get(CHAT)(fakeReq("GET", CHAT), res3);
  ok(res3.statusCode === 405, "GET 405");
}

// 9) 微信 iLink 直连流程（mock 腾讯云）
{
  const res0 = fakeRes();
  await routes.get(WX_STATUS)(fakeReq("GET", WX_STATUS), res0);
  const st0 = JSON.parse(res0.body);
  ok(st0.state === "disconnected", "微信初始未连接");

  const res1 = fakeRes();
  await routes.get(WX_LOGIN)(fakeReq("POST", WX_LOGIN, { body: "{}" }), res1);
  const st1 = JSON.parse(res1.body);
  ok(st1.state === "waiting-scan", "登录请求进入待扫码状态");
  ok(/liteapp/.test(st1.qrcodeUrl || ""), "返回微信小程序绑定链接");

  const resBad = fakeRes();
  await routes.get(WX_STATUS)(fakeReq("GET", WX_STATUS, { remote: "192.168.1.5" }), resBad);
  ok(resBad.statusCode === 403, "微信控制路由非回环拒绝 403");

  // 首条消息入队（确认连接后由长轮询拉走）
  pendingMsgs.push(wxMsg("mockuser@im.wechat", "微信里发来的消息", "ctx-1"));

  const sent = await waitSent(1);
  ok(sent.length >= 1, "mock 腾讯云收到 sendmessage");
  const first = sent[0];
  ok(first.msg.to_user_id === "mockuser@im.wechat", "回复发给微信用户");
  ok(first.msg.context_token === "ctx-1", "context_token 原样回传");
  ok(/桥接的 DSH agent/.test(JSON.stringify(first.msg.item_list)), "回复内容来自 DSH agent");
  ok(poolMocks.get("wx-mockuser-im.wechat") !== undefined, "微信用户映射到独立 DSH 会话");
  ok(typeof first.msg.run_id === "string" && first.msg.run_id.length > 10, "sendmessage 带 run_id");
  const h = sentHeaders[0] || {};
  ok(h["ilink-app-clientversion"] === "132102", "iLink-App-ClientVersion 为十进制字符串（0x020406 -> 132102）");

  const res2 = fakeRes();
  await routes.get(WX_STATUS)(fakeReq("GET", WX_STATUS), res2);
  const st2 = JSON.parse(res2.body);
  ok(st2.state === "connected", "扫码确认后进入已连接状态");
  ok(st2.botId === "mockbot@im.bot", "状态携带 botId");
}

// 10) 微信指令：/help、/attach（含失败）、/list
{
  const base = sentMessages.length;
  pendingMsgs.push(wxMsg("mockuser@im.wechat", "/help", "ctx-help"));
  await waitSent(base + 1);
  ok(lastSentText().includes("/attach"), "/help 返回指令说明");

  pendingMsgs.push(wxMsg("mockuser@im.wechat", "/attach nope", "ctx-attach-bad"));
  await waitSent(base + 2);
  ok(lastSentText().includes("session not found"), "/attach 不存在会话报错");

  pendingMsgs.push(wxMsg("mockuser@im.wechat", "/attach session-999", "ctx-attach-ok"));
  await waitSent(base + 3);
  ok(lastSentText().includes("已接管会话 session-999"), "/attach 成功接管持久化会话");

  // 接管后普通消息进入被接管会话（回复带 attached 标签）
  pendingMsgs.push(wxMsg("mockuser@im.wechat", "被接管后的消息", "ctx-attached-msg"));
  await waitSent(base + 4);
  ok(/attached-session-999/.test(lastSentText()), "接管后消息进入目标会话");

  pendingMsgs.push(wxMsg("mockuser@im.wechat", "/list", "ctx-list"));
  await waitSent(base + 5);
  ok(lastSentText().includes("session-999"), "/list 列出持久化会话");
}

// 11) 白名单：非白名单用户消息被静默忽略
{
  mockSettingsValue = { ...mockSettingsValue, allowlist: "boss@im.wechat" };
  const base = sentMessages.length;
  pendingMsgs.push(wxMsg("mockuser@im.wechat", "白名单外的消息", "ctx-evil"));
  await sleep(2500);
  ok(sentMessages.length === base, "白名单外用户的消息被忽略（不回复）");
  mockSettingsValue = { ...mockSettingsValue, allowlist: "" };
}

// 12) 工作目录配置：/new 后新会话使用配置的真实目录
{
  mockSettingsValue = { ...mockSettingsValue, workspace: "C:\\remote-office-ws" };
  const base = sentMessages.length;
  pendingMsgs.push(wxMsg("mockuser@im.wechat", "/new", "ctx-new"));
  await waitSent(base + 1);
  ok(lastSentText().includes("已开启新会话"), "/new 重置会话绑定");
  pendingMsgs.push(wxMsg("mockuser@im.wechat", "远程办公的消息", "ctx-remote"));
  await waitSent(base + 2);
  ok(poolMocks.get("remote-office-ws") !== undefined, "新会话使用配置的工作目录");
  mockSettingsValue = { ...mockSettingsValue, workspace: "" };
}

// 13) 自定义 OpenAI 兼容端点：桥接路由到 openclaw-custom provider
{
  mockSettingsValue = { ...mockSettingsValue, customBaseURL: "http://127.0.0.1:65412/v1", customModel: "test-model" };
  const res = await chat({ model: "dsh-bridge/test-custom", messages: [{ role: "user", content: "你好" }] });
  ok(res.statusCode === 200, "自定义端点路由 200");
  const last = agentOptionsLog[agentOptionsLog.length - 1];
  ok(last && last.provider === "openclaw-custom" && last.model === "test-model", "agent 使用 openclaw-custom provider");

  mockSettingsValue = { ...mockSettingsValue, customModel: "" };
  const res2 = await chat({ model: "dsh-bridge/test-custom2", messages: [{ role: "user", content: "你好" }] });
  ok(res2.statusCode === 400 && /customModel/.test(res2.body), "customBaseURL 已填而 customModel 为空时 400");
  mockSettingsValue = { ...mockSettingsValue, customBaseURL: "", customModel: "" };
}

// 14) OpenAiCompatAdapter 直测：文本流
{
  mockOpenAiMode = "text";
  const { OpenAiCompatAdapter } = mod;
  const adapter = new OpenAiCompatAdapter(() => ({ baseURL: "http://127.0.0.1:65412/v1", apiKey: "sk-test", model: "test-model" }));
  const chunks = [];
  for await (const chunk of adapter.stream({
    model: "test-model",
    system: "you are helpful",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    signal: void 0,
  })) {
    chunks.push(chunk);
  }
  const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
  ok(text === "hello from custom", "适配器流式文本完整拼接");
  ok(chunks.some((c) => c.type === "usage"), "适配器产出 usage");
  ok(chunks.some((c) => c.type === "finish" && c.reason.kind === "stop"), "适配器产出 finish(stop)");
}

// 15) OpenAiCompatAdapter 直测：工具调用增量
{
  mockOpenAiMode = "tool";
  const { OpenAiCompatAdapter } = mod;
  const adapter = new OpenAiCompatAdapter(() => ({ baseURL: "http://127.0.0.1:65412/v1", apiKey: "sk-test", model: "test-model" }));
  const chunks = [];
  for await (const chunk of adapter.stream({
    model: "test-model",
    messages: [{ role: "user", content: [{ type: "text", text: "call say" }] }],
    tools: [{ name: "say", description: "say", parameters: { type: "object" } }],
    signal: void 0,
  })) {
    chunks.push(chunk);
  }
  const toolChunks = chunks.filter((c) => c.type === "tool-call-delta");
  ok(toolChunks.length >= 2 && toolChunks[0].name === "say", "工具调用增量解析出 name");
  const finish = chunks.find((c) => c.type === "finish");
  ok(finish && finish.reason.kind === "tool-calls", "工具调用 finish(kind=tool-calls)");
}

// 16) OpenAiCompatAdapter 直测：鉴权错误映射
{
  mockOpenAiMode = "auth";
  const { OpenAiCompatAdapter } = mod;
  const adapter = new OpenAiCompatAdapter(() => ({ baseURL: "http://127.0.0.1:65412/v1", apiKey: "sk-bad", model: "test-model" }));
  let caught = null;
  try {
    for await (const _ of adapter.stream({ model: "test-model", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], signal: void 0 })) {
      // noop
    }
  } catch (err) {
    caught = err;
  }
  ok(caught !== null && /bad api key|AUTH/.test(String(caught?.message || "") + " " + String(caught?.code || "")), "401 映射为 AUTH 错误");
}

// 17) 共享层直测：去重 / 限流 / 白名单 / 会话映射 / 分段 / 日志
{
  const d = createDedupe(100);
  ok(d.check("wechat:e1"), "去重：新事件键放行");
  ok(!d.check("wechat:e1"), "去重：重复事件键拒绝");
  for (let i = 0; i < 150; i++) d.check("k" + i);
  ok(d.size() <= 100, "去重：LRU 容量上限生效");
}
{
  const q = createInboundQuota({ maxPerMinute: 3 });
  for (let i = 0; i < 3; i++) ok(q.allow("u1").allowed, "限流：窗口内放行（" + (i + 1) + "/3）");
  const denied = q.allow("u1");
  ok(!denied.allowed && denied.retryAfter > 0, "限流：第 4 条拒绝并给出 retryAfter");
  ok(q.allow("u2").allowed, "限流：不同用户独立计数");
}
{
  const out = createOutboundQueue({ minIntervalMs: 20 });
  const order = [];
  const t0 = Date.now();
  const runs = [out.enqueue(async () => { order.push(1); }), out.enqueue(async () => { order.push(2); }), out.enqueue(async () => { order.push(3); })];
  await Promise.all(runs);
  ok(order.join("") === "123", "出站队列串行有序");
  ok(Date.now() - t0 >= 40, "出站队列最小间隔生效");
}
{
  ok(isAllowed([], "anyone"), "白名单：空列表放行");
  ok(isAllowed("a,b", "a") && !isAllowed("a,b", "c"), "白名单：逗号分隔精确匹配");
  ok(parseWhitelist(" a , b ").length === 2, "白名单：解析去空白");
}
{
  ok(convKey("wechat", "u1") === "wechat:u1", "会话键 = channel:convId");
  const sid = sessionIdFor("wechat:u1");
  ok(sid === sessionIdFor("wechat:u1") && /^dsh-im-[0-9a-f]{12}$/.test(sid), "sessionId 确定性 + 前缀");
  ok(/^im-[0-9a-f]{24}$/.test(agentKeyFor("feishu:ou_1")), "agentKey 安全字符");
  const segs = splitText("a".repeat(3200), 1500);
  ok(segs.length === 3 && segs.every((s) => s.length <= 1500), "分段：全部 ≤1500");
  const segs2 = splitText("短\n" + "长".repeat(2000) + "\n尾", 100);
  ok(segs2.every((s) => s.length <= 100) && segs2.join("").replace(/\n/g, "") === "短" + "长".repeat(2000) + "尾", "分段：段落感知不丢字");
  const capped = segmentReply("x".repeat(4500));
  ok(capped.join("").length === 4010 && /截断/.test(capped.join("")), "回复整编：总长 ≤4000 + 截断标记");
}
{
  const dir = mkdtempSync(join(tmpdir(), "dsh-bridge-log-"));
  const logger = createChannelLogger(dir, "wechat");
  logger.info("hello");
  logger.warn("careful");
  // 单行最长 4000 字符（MAX_LINE 截断），用多条长行凑过 1MB 触发轮转
  for (let i = 0; i < 320; i++) logger.info("y".repeat(4000));
  logger.info("tail");
  const file = join(dir, "wechat.log");
  ok(existsSync(file) && readFileSync(file, "utf8").includes("[info] tail"), "渠道日志落盘且轮转后继续写");
  ok(existsSync(file + ".1"), "1MB 轮转生成 .1 旧档");
}

// 18) 渠道注册表 / 迁移 / 开关 / 池上限（A-02）
{
  const res = fakeRes();
  await routes.get("/openclaw-bridge/channels")(fakeReq("GET", "/openclaw-bridge/channels"), res);
  const data = JSON.parse(res.body);
  ok(res.statusCode === 200 && Array.isArray(data.channels) && data.channels.length === 3, "注册表返回三渠道");
  const wx = data.channels.find((c) => c.id === "wechat");
  const fs = data.channels.find((c) => c.id === "feishu");
  const qq = data.channels.find((c) => c.id === "qq");
  ok(wx && wx.implemented === true && wx.enabled === true, "微信 implemented 且默认启用");
  ok(fs && fs.implemented === true && fs.enabled === true, "飞书已实现且默认启用");
  ok(qq && qq.implemented === true && qq.enabled === true, "QQ 已实现且默认启用");

  const res2 = fakeRes();
  await routes.get("/openclaw-bridge/channels/")(fakeReq("POST", "/openclaw-bridge/channels/telegram/login", { body: "{}" }), res2);
  ok(res2.statusCode === 404 && /unknown channel/.test(res2.body), "未知渠道 login 返回 404 + unknown channel");

  // 白名单迁移：whitelistWechat 优先于旧 allowlist
  mockSettingsValue = { ...mockSettingsValue, allowlist: "", whitelistWechat: "boss2@im.wechat" };
  const base = sentMessages.length;
  pendingMsgs.push(wxMsg("mockuser@im.wechat", "新白名单拦截测试", "ctx-wl-new"));
  await sleep(2500);
  ok(sentMessages.length === base, "whitelistWechat 生效：非名单用户消息忽略");
  mockSettingsValue = { ...mockSettingsValue, whitelistWechat: "" };

  // 渠道开关：enableWechat "0" 整体关闭
  mockSettingsValue = { ...mockSettingsValue, enableWechat: "0" };
  const base2 = sentMessages.length;
  pendingMsgs.push(wxMsg("mockuser@im.wechat", "关闭后的消息", "ctx-off"));
  await sleep(2500);
  ok(sentMessages.length === base2, "enableWechat=0 时微信消息被忽略");
  mockSettingsValue = { ...mockSettingsValue, enableWechat: "" };

  // 池上限 + LRU 淘汰：maxAgents = 当前池大小 → 新会话先淘汰最旧
  const before = await poolKeys();
  mockSettingsValue = { ...mockSettingsValue, maxAgents: String(before.length) };
  const res3 = await chat({ model: "dsh-bridge/lru-test", messages: [{ role: "user", content: "hi" }] });
  ok(res3.statusCode === 200, "maxAgents=池大小 时新会话仍成功（LRU 淘汰一个）");
  const after = await poolKeys();
  ok(after.length === before.length && after.includes("dsh-bridge-lru-test"), "池大小不变且新 key 在池中");
  ok(!after.includes(before[0]), "最旧（插入序首个）被 LRU 淘汰");
  mockSettingsValue = { ...mockSettingsValue, maxAgents: "" };
}

// 19) vendored WS 客户端（lib/ws.js）：握手 / 回声 / 大帧 / 分片 / ping-pong / 关闭
{
  const { connect } = wsMod;
  const ws = connect("ws://127.0.0.1:65413/echo");
  ws.on("error", () => {}); // 握手失败等错误不炸进程，由断言体现
  const got = [];
  ws.on("message", (m) => got.push(m));
  await new Promise((r) => ws.on("open", r));
  ok(ws.readyState === 1, "ws 握手后进入 OPEN");

  ws.send("hello");
  await waitFor(() => got.includes("echo:hello"));
  ok(got.includes("echo:hello"), "ws 文本回声");

  ws.send("B".repeat(200000));
  await waitFor(() => got.some((m) => typeof m === "string" && m.length === 65 && m.startsWith("echo:B")));
  ok(got.some((m) => typeof m === "string" && m.length === 65 && m.startsWith("echo:B")), "ws 大帧（64 位长度）");

  ws.send("@frag");
  await waitFor(() => got.includes("fragment"));
  ok(got.includes("fragment"), "ws 分片重组");

  ws.send("@ping");
  await waitFor(() => wsEvents.includes("pong"));
  ok(wsEvents.includes("pong"), "ws 收到 ping 自动回 pong");

  const closed = new Promise((r) => ws.on("close", (code) => r(code)));
  ws.close(1000, "bye");
  const code = await closed;
  ok(code === 1000, "ws 正常关闭握手 1000");
  ws.destroy();
}

// 20) 飞书渠道（P1）：归一化 / 加密 / 端点发现 / protobuf 帧 / 心跳 / ACK / 分片 / 发送 / 端到端
{
  // 归一化单测（不依赖网络）
  const n1 = normalizeFeishuEvent(JSON.parse(evtPayload("norm1")));
  ok(n1 && n1.channel === "feishu" && n1.conv.kind === "p2p" && n1.text === "你好飞书" && n1.conv.memberId === "ou_mock_user1", "飞书私聊事件归一化");
  ok(n1.eventId === "norm1" && n1.replyToMessageId === "om_norm1", "飞书事件 id / 回复目标");
  const n2 = normalizeFeishuEvent(JSON.parse(evtPayload("grp1", { chat_id: "oc_g1", chat_type: "group", mentions: [{ key: "@_1", id: { open_id: "ou_bot" }, mentioned_type: "app", name: "机器人" }] })));
  ok(n2 && n2.conv.kind === "group" && n2.conv.id === "oc_g1", "飞书群聊 @机器人 事件归一化");
  ok(normalizeFeishuEvent(JSON.parse(evtPayload("grp2", { chat_id: "oc_g2", chat_type: "group", mentions: [{ key: "@_1", id: { open_id: "ou_other" }, mentioned_type: "user", name: "同事" }] }))) === null, "群聊未@机器人 → 不触发");
  ok(normalizeFeishuEvent(JSON.parse(evtPayload("img1", { message_type: "image", content: JSON.stringify({ image_key: "x" }) }))) === null, "非文本消息不触发（M1）");

  // 事件解密往返（SDK AESCipher 同构）
  const encKey = "test-encrypt-key";
  const aesKey = createHash("sha256").update(encKey).digest();
  const iv1 = randomBytes(16);
  const c1 = createCipheriv("aes-256-cbc", aesKey, iv1);
  const encBuf1 = Buffer.concat([iv1, c1.update(Buffer.from("加密事件明文", "utf8")), c1.final()]);
  ok(feishuDecrypt(encBuf1.toString("base64"), encKey) === "加密事件明文", "AES-256-CBC 事件解密往返");

  // mock 适配器（base 指向本地 mock 飞书云）
  const fsStates = [];
  const fsMsgs = [];
  const feishuAdapter = createFeishuAdapter({
    getConfig: () => ({ appId: "cli_feishu_test", appSecret: "test_secret", encryptKey: encKey }),
    base: "http://127.0.0.1:65414",
    logger: { info() {}, warn() {}, error() {} },
    onState: (s) => fsStates.push(s.state),
    onMessage: async (m) => fsMsgs.push(m),
  });
  ok((await feishuAdapter.validate({ appId: "cli_feishu_test", appSecret: "test_secret" })).ok === true, "飞书凭据校验通过（有效 Secret）");
  ok((await feishuAdapter.validate({ appId: "cli_feishu_test", appSecret: "bad-secret" })).ok === false, "飞书凭据校验拒绝错误 Secret");

  await feishuAdapter.start();
  await waitFor(() => feishuAdapter.status().state === "connected");
  ok(feishuAdapter.status().state === "connected", "飞书长连接进入 connected");
  ok(feishuHttpCalls.some((c) => c.pathname === "/callback/ws/endpoint" && c.body.AppID === "cli_feishu_test"), "端点发现接口被调用（AppID 正确）");

  await waitFor(() => feishuClientFrames.some((f) => f.method === 0 && (f.headers.find((h) => h.key === "type") || {}).value === "ping"));
  ok(feishuClientFrames.some((f) => f.method === 0 && (f.headers.find((h) => h.key === "type") || {}).value === "ping"), "open 后立即发送 ping 帧");
  await waitFor(() => feishuAdapter.status().pongCount >= 1);
  ok(feishuAdapter.status().pongCount >= 1, "收到服务端 pong 心跳应答");

  // 私聊事件推送 → onMessage 归一化消息 + ACK
  pushFeishuFrame(evtHeaders("evt_a"), evtPayload("evt_a"));
  await waitFor(() => fsMsgs.some((m) => m.eventId === "evt_a"));
  ok(fsMsgs.some((m) => m.eventId === "evt_a" && m.text === "你好飞书" && m.conv.kind === "p2p"), "私聊事件经长连接上送");
  await waitFor(() => feishuClientFrames.some((f) => f.method === 1 && (f.headers.find((h) => h.key === "message_id") || {}).value === "om_evt_a"));
  ok(feishuClientFrames.some((f) => f.method === 1 && (f.headers.find((h) => h.key === "message_id") || {}).value === "om_evt_a"), "事件回 ACK 帧（带原 message_id）");

  // sum/seq 分片重组
  const fragStr = evtPayload("evt_frag", { content: JSON.stringify({ text: "分片消息内容" }) });
  const half = Math.ceil(fragStr.length / 2);
  pushFeishuFrame(evtHeaders("evt_frag", { sum: 2, seq: 0 }), fragStr.slice(0, half));
  pushFeishuFrame(evtHeaders("evt_frag", { sum: 2, seq: 1 }), fragStr.slice(half));
  await waitFor(() => fsMsgs.some((m) => m.eventId === "evt_frag"));
  ok(fsMsgs.some((m) => m.eventId === "evt_frag" && m.text === "分片消息内容"), "sum/seq 分片重组后上送");

  // 加密事件 → 自动解密上送
  const encPlain = evtPayload("evt_enc", { content: JSON.stringify({ text: "加密的消息" }) });
  const iv2 = randomBytes(16);
  const c2 = createCipheriv("aes-256-cbc", aesKey, iv2);
  const encBuf2 = Buffer.concat([iv2, c2.update(Buffer.from(encPlain, "utf8")), c2.final()]);
  pushFeishuFrame(evtHeaders("evt_enc"), JSON.stringify({ encrypt: encBuf2.toString("base64") }));
  await waitFor(() => fsMsgs.some((m) => m.eventId === "evt_enc"));
  ok(fsMsgs.some((m) => m.eventId === "evt_enc" && m.text === "加密的消息"), "加密信封事件解密后上送");

  // 未@机器人的群消息不上送
  const src = fsMsgs.length;
  pushFeishuFrame(evtHeaders("evt_nobot"), evtPayload("evt_nobot", { chat_id: "oc_g9", chat_type: "group", mentions: [{ key: "@_1", id: { open_id: "ou_other" }, mentioned_type: "user", name: "同事" }] }));
  await sleep(400);
  ok(!fsMsgs.some((m) => m.eventId === "evt_nobot"), "群聊未@机器人事件不上送");

  // 发送：私聊 / 群聊 / 引用回复
  const s1 = await feishuAdapter.send({ kind: "p2p", id: "ou_mock_user1" }, "私聊回复内容");
  ok(s1.ok === true, "飞书私聊发送成功");
  const call1 = feishuHttpCalls.filter((c) => c.pathname === "/open-apis/im/v1/messages" && c.query.receive_id_type === "open_id").pop();
  ok(call1 && call1.body.receive_id === "ou_mock_user1" && call1.body.msg_type === "text" && JSON.parse(call1.body.content).text === "私聊回复内容", "私聊发送体正确（receive_id_type=open_id）");
  const s2 = await feishuAdapter.send({ kind: "group", id: "oc_grp_1" }, "群聊回复");
  ok(s2.ok === true, "飞书群聊发送成功");
  const call2 = feishuHttpCalls.filter((c) => c.pathname === "/open-apis/im/v1/messages" && c.query.receive_id_type === "chat_id").pop();
  ok(call2 && call2.body.receive_id === "oc_grp_1", "群聊发送 receive_id_type=chat_id");
  const s3 = await feishuAdapter.send({ kind: "p2p", id: "ou_mock_user1" }, "引用回复", { replyTo: "om_target" });
  ok(s3.ok === true && feishuHttpCalls.some((c) => c.pathname === "/open-apis/im/v1/messages/om_target/reply"), "引用回复走 reply API");
  await feishuAdapter.dispose();
  ok(feishuAdapter.status().state === "disconnected", "dispose 后飞书适配器断开");

  // 端到端：经插件注册的飞书适配器（index.js）→ 闸门/白名单/agent → 回复进群
  mockSettingsValue = { ...mockSettingsValue, feishuAppId: "cli_feishu_test", feishuAppSecret: "test_secret" };
  const resL = fakeRes();
  await routes.get("/openclaw-bridge/channels/")(fakeReq("POST", "/openclaw-bridge/channels/feishu/login", { body: "{}" }), resL);
  ok(resL.statusCode === 200 && /connected/.test(resL.body), "插件级飞书渠道 login 后 connected");
  await waitFor(() => feishuWsSockets.length >= 1);
  await sleep(200); // 等插件侧 ping 已发
  const sentBase = feishuHttpCalls.filter((c) => c.pathname.startsWith("/open-apis/im/v1/messages")).length;
  pushFeishuFrame(evtHeaders("evt_e2e"), evtPayload("evt_e2e", { content: JSON.stringify({ text: "端到端你好" }) }));
  await waitFor(() => feishuHttpCalls.filter((c) => c.pathname.startsWith("/open-apis/im/v1/messages")).length > sentBase);
  const replyCall = feishuHttpCalls.filter((c) => c.pathname.startsWith("/open-apis/im/v1/messages")).pop();
  ok(replyCall && JSON.parse(replyCall.body.content).text.includes("桥接的 DSH agent"), "端到端：飞书消息 → agent 回合 → 回复发出");
  ok(replyCall && /\/reply$/.test(replyCall.pathname), "端到端：回复走引用回复（reply API）");
  const resLog = fakeRes();
  await routes.get("/openclaw-bridge/channels/")(fakeReq("POST", "/openclaw-bridge/channels/feishu/logout", { body: "{}" }), resLog);
  mockSettingsValue = { ...mockSettingsValue, feishuAppId: "", feishuAppSecret: "" };
}

// 21) QQ 开放平台机器人渠道（P2，SPEC §7 / docs/qq-bot-dsh-report.md）
{
  const qqMod = await import("@deepseek-ai/dsh-openclaw-bridge/lib/channels/qq.js");
  const { normalizeQqEvent, createQqAdapter } = qqMod;

  // 归一化：4 类事件 + <@bot> 清洗 + null 分支
  const g = normalizeQqEvent({ t: "GROUP_AT_MESSAGE_CREATE", d: { id: "gid1", group_openid: "G1", content: "<@!qqbot1> 大家好", timestamp: 1000, author: { user_openid: "U1" }, mentions: [] } });
  ok(g && g.channel === "qq" && g.conv.kind === "group" && g.conv.id === "G1" && g.conv.memberId === "U1" && g.text === "大家好" && g.msgId === "gid1", "群@事件归一化 + <@bot> 清洗");
  const c = normalizeQqEvent({ t: "C2C_MESSAGE_CREATE", d: { id: "cid1", user_openid: "U2", content: "在吗", timestamp: 2000, author: { user_openid: "U2" } } });
  ok(c && c.conv.kind === "p2p" && c.conv.id === "U2" && c.conv.memberId === "U2", "C2C 私聊归一化");
  const a = normalizeQqEvent({ t: "AT_MESSAGE_CREATE", d: { id: "aid1", channel_id: "CH1", guild_id: "GU1", content: "hi <@bot>", author: { id: "UA1", username: "某人" } } });
  ok(a && a.conv.kind === "group" && a.conv.id === "CH1" && a.conv.member.name === "某人", "频道@按频道会话（群视）");
  const di = normalizeQqEvent({ t: "DIRECT_MESSAGE_CREATE", d: { id: "did1", src_guild_id: "GU2", channel_id: "CH2", content: "私信", author: { id: "UA2" } } });
  ok(di && di.conv.kind === "p2p" && di.conv.id === "GU2", "频道私信按来源频道");
  ok(normalizeQqEvent({ t: "GROUP_AT_MESSAGE_CREATE", d: { id: "x", content: "" } }) === null, "空文本 → null");
  ok(normalizeQqEvent({ t: "GUILD_MEMBER_ADD" }) === null, "非目标事件 → null");

  // 凭据校验
  const qqAdapter = createQqAdapter({
    getConfig: () => ({ appId: "qq_test_app", appSecret: "qq_test_secret", qqSandbox: "1" }),
    onState: () => {},
    onMessage: () => {},
  });
  const vOk = await qqAdapter.validate();
  ok(vOk.ok === true, "QQ 凭据校验通过（有效 AppID/Token）");
  const vBad = await qqAdapter.validate({ appId: "qq_test_app", appSecret: "bad" });
  ok(vBad.ok === false, "QQ 凭据校验拒绝错误 Token");
  ok(qqAdapter.status().sandbox === true, "缺省沙箱模式（qqSandbox 非 '0'）");

  // 连接：gateway → identify → READY → heartbeat
  const qqStates = [];
  const qqMsgs = [];
  const qqLog = { info() {}, warn() {}, error() {} };
  const qq2 = createQqAdapter({
    getConfig: () => ({ appId: "qq_test_app", appSecret: "qq_test_secret", qqSandbox: "1" }),
    logger: qqLog,
    onState: (s) => qqStates.push(s),
    onMessage: (m) => qqMsgs.push(m),
  });
  await qq2.start();
  ok(qq2.status().state === "connected", "QQ 网关连接进入 connected");
  const gwCall = qqHttpCalls.find((x) => x.pathname === "/gateway/bot");
  ok(gwCall && /^QQBot qq-at-mock$/.test(gwCall.headers.authorization || ""), "gateway 调用带 QQBot Bearer");
  await waitFor(() => qqClientFrames.some((f) => f.op === 2));
  const idf = qqClientFrames.find((f) => f.op === 2);
  ok(
    idf && idf.d.token === "QQBot qq-at-mock" && idf.d.intents === (1 << 25 | 1 << 30) && idf.d.shard && idf.d.shard[0] === 0,
    "identify 帧：QQBot token + intents((1<<25)|(1<<30)) + shard[0,1]"
  );
  await waitFor(() => qqClientFrames.some((f) => f.op === 1), 6000);
  ok(qqClientFrames.some((f) => f.op === 1), "HELLO 后按 heartbeat_interval 发送心跳");

  // 事件上送
  pushQqEvent("GROUP_AT_MESSAGE_CREATE", { id: "qqev1", group_openid: "G1", content: "<@!qqbot1> 群事件测试", timestamp: Date.now(), author: { user_openid: "U1" }, mentions: [] });
  await waitFor(() => qqMsgs.some((m) => m.eventId === "qqev1"));
  const qm = qqMsgs.find((m) => m.eventId === "qqev1");
  ok(qm && qm.text === "群事件测试" && qm.conv.id === "G1" && qm.conv.kind === "group", "群@事件经网关上送并清洗");

  // 发送：群聊（带 msg_id 被动回复）/ 私聊
  const s1 = await qq2.send({ kind: "group", id: "G1" }, "群回复", { msgId: "qqev1" });
  ok(s1.ok === true, "QQ 群聊发送成功");
  const gc = qqHttpCalls.filter((x) => x.pathname === "/v2/groups/G1/messages").pop();
  ok(gc && gc.body.content === "群回复" && gc.body.msg_type === 0 && gc.body.msg_id === "qqev1", "群聊发送体（content/msg_type:0/msg_id）");
  const s2 = await qq2.send({ kind: "p2p", id: "U2" }, "私聊回复");
  ok(s2.ok === true && qqHttpCalls.some((x) => x.pathname === "/v2/users/U2/messages"), "QQ 私聊发送成功（/v2/users）");
  const s3 = await qq2.send({ kind: "group", id: "G1" }, "坏凭据发送", { msgId: "qqevX" });
  ok(s3.ok === true, "QQ 发送成功（沿用已缓存 token）");

  // 沙箱开关翻转
  const qqProd = createQqAdapter({ getConfig: () => ({ appId: "a", appSecret: "s", qqSandbox: "0" }), onState: () => {}, onMessage: () => {} });
  ok(qqProd.status().sandbox === false, "qqSandbox='0' → 生产环境（sandbox=false）");

  await qq2.stop();
  ok(qq2.status().state === "disconnected", "stop 后 QQ 适配器断开");
  qqAdapter.dispose();
  qqProd.dispose();

  // 端到端：经插件注册的 QQ 适配器（index.js）→ 闸门/白名单/agent → 被动回复（msg_id）
  mockSettingsValue = { ...mockSettingsValue, qqBotAppId: "qq_test_app", qqBotToken: "qq_test_secret" };
  const resQ = fakeRes();
  await routes.get("/openclaw-bridge/channels/")(fakeReq("POST", "/openclaw-bridge/channels/qq/login", { body: "{}" }), resQ);
  ok(resQ.statusCode === 200 && /connected/.test(resQ.body), "插件级 QQ 渠道 login 后 connected");
  await waitFor(() => qqWsSockets.length >= 1);
  await sleep(300); // 等插件侧 identify 完成
  const sentBase2 = qqHttpCalls.filter((x) => x.pathname.startsWith("/v2/")).length;
  pushQqEvent("GROUP_AT_MESSAGE_CREATE", { id: "qqev_e2e", group_openid: "G1", content: "端到端 QQ 你好", timestamp: Date.now(), author: { user_openid: "U1" }, mentions: [] });
  await waitFor(() => qqHttpCalls.filter((x) => x.pathname.startsWith("/v2/")).length > sentBase2);
  const qqReply = qqHttpCalls.filter((x) => x.pathname.startsWith("/v2/")).pop();
  ok(qqReply && qqReply.body.content.includes("桥接的 DSH agent") && qqReply.body.msg_id === "qqev_e2e", "端到端：QQ 消息 → agent 回合 → 被动回复（带 msg_id）");
  const resQLog = fakeRes();
  await routes.get("/openclaw-bridge/channels/")(fakeReq("POST", "/openclaw-bridge/channels/qq/logout", { body: "{}" }), resQLog);
  mockSettingsValue = { ...mockSettingsValue, qqBotAppId: "", qqBotToken: "" };
}

// 22) 代码审查修复轮回归（0.7.2）
{
  // ⑤ 本地二维码：编码器 + 路由（不再依赖第三方 api.qrserver.com）
  const { qrSvg } = await import("@deepseek-ai/dsh-openclaw-bridge/lib/core/qrcode.js");
  const svg = qrSvg("https://example.com/scan?x=1", { size: 220 });
  ok(svg.startsWith("<svg") && svg.includes('shape-rendering="crispEdges"'), "qrSvg 输出 SVG 文档（含渲染属性）");
  const parsed = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
  ok(parsed && Number(parsed[1]) === Number(parsed[2]) && Number(parsed[1]) % 2 === 1, "viewBox 为奇数边长（QR 码含静区）");
  ok((svg.match(/<rect/g) || []).length > 20, "二维码码元数量合理（>20）");
  const qrRes = fakeRes();
  await routes.get("/openclaw-bridge/qr")(
    fakeReq("GET", "/openclaw-bridge/qr?text=" + encodeURIComponent("https://example.com") + "&size=220"),
    qrRes
  );
  ok(qrRes.statusCode === 200 && /image\/svg\+xml/.test(qrRes.headers["content-type"]), "QR 路由返回 SVG");
  ok(qrRes.body.includes("<svg"), "QR 路由响应体是 SVG 文档");
  const qrBad = fakeRes();
  await routes.get("/openclaw-bridge/qr")(fakeReq("GET", "/openclaw-bridge/qr?text=x", { remote: "192.168.1.5" }), qrBad);
  ok(qrBad.statusCode === 403, "QR 路由非回环拒绝 403");
  const qrEmpty = fakeRes();
  await routes.get("/openclaw-bridge/qr")(fakeReq("GET", "/openclaw-bridge/qr?text="), qrEmpty);
  ok(qrEmpty.statusCode === 400, "QR 路由缺 text 参数 400");

  // ④ QQ token 响应兼容嵌套 data
  const { pickTokenPayload } = await import("@deepseek-ai/dsh-openclaw-bridge/lib/channels/qq.js");
  const flatTok = pickTokenPayload({ code: 0, message: "ok", access_token: "a", expires_in: "7200" });
  const nestedTok = pickTokenPayload({ code: 0, data: { access_token: "b", expires_in: 3600 } });
  const errTok = pickTokenPayload({ code: 11244, message: "bad" });
  ok(flatTok.access_token === "a" && flatTok.code === 0, "QQ token 平铺响应解析");
  ok(nestedTok.access_token === "b" && nestedTok.code === 0, "QQ token 嵌套 data 响应解析");
  ok(errTok.code === 11244 && !errTok.access_token, "QQ token 错误响应不带 access_token");

  // ③ 会话映射持久化（重启续接的存储层）
  const { createSessionMap } = await import("@deepseek-ai/dsh-openclaw-bridge/lib/core/session.js");
  const mapFile = join(await mkdtempSync(join(tmpdir(), "dsh-bridge-map-")), "map.json");
  const m1 = createSessionMap(mapFile);
  m1.load();
  m1.set("wx-user-1", "dsh-im-abcdef123456");
  const m2 = createSessionMap(mapFile);
  m2.load();
  ok(m2.get("wx-user-1") === "dsh-im-abcdef123456", "会话映射落盘后可被新实例读回（重启续接语义）");
  m2.remove("wx-user-1");
  const m3 = createSessionMap(mapFile);
  m3.load();
  ok(m3.get("wx-user-1") === undefined, "移除后映射持久化删除（/new 开新会话语义）");

  // ⑨ 微信 bot_agent 版本号随 package.json（不再硬编码 0.7.0）
  const pkgUrl = import.meta.resolve("@deepseek-ai/dsh-openclaw-bridge/package.json");
  const bridgePkg = JSON.parse(readFileSync(new URL(pkgUrl), "utf8"));
  ok(
    sentMessages[0] && sentMessages[0].base_info && sentMessages[0].base_info.bot_agent === "dsh-openclaw-bridge/" + bridgePkg.version,
    "微信 bot_agent 版本号与 package.json 一致（" + bridgePkg.version + "）"
  );

  // ⑨ 微信登录重入锁：快速连点只触发一轮 QR 拉取
  const { createWechatClient } = await import("@deepseek-ai/dsh-openclaw-bridge/lib/wechat.js");
  const sessFile = join(await mkdtempSync(join(tmpdir(), "dsh-bridge-wx-")), "session.json");
  const wxClient = createWechatClient({ sessionFile: sessFile, onState: () => {}, onMessage: () => {} });
  const wxBase = ilinkQrFetches;
  await wxClient.startLogin();
  await wxClient.startLogin(); // 重入：应被忽略
  await sleep(100);
  ok(ilinkQrFetches - wxBase === 1, "startLogin 重入锁：两次调用只触发一次 QR 拉取");
  wxClient.logout();
  wxClient.dispose();

  // ⑧ authAlways 严格鉴权（回环也需要 Token）
  const tokenFile = join(homedir(), ".dsh", "openclaw-bridge", "token.txt");
  const tok = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";
  ok(tok.length > 0, "桥接 token 已自动生成（token.txt）");
  mockSettingsValue = { ...mockSettingsValue, authAlways: "1" };
  const r401 = fakeRes();
  await routes.get(CHAT)(fakeReq("POST", CHAT, { body: JSON.stringify({ model: "x", messages: [] }) }), r401);
  ok(r401.statusCode === 401, "authAlways 开启后回环无 token 拒绝 401");
  const rOk = fakeRes();
  await routes.get(CHAT)(fakeReq("POST", CHAT, { headers: { authorization: "Bearer " + tok }, body: JSON.stringify({ model: "x", messages: [] }) }), rOk);
  ok(rOk.statusCode === 200, "authAlways 开启后带 Bearer 通过");
  const rX = fakeRes();
  await routes.get(CHAT)(fakeReq("POST", CHAT, { headers: { "x-openclaw-bridge-token": tok }, body: JSON.stringify({ model: "x", messages: [] }) }), rX);
  ok(rX.statusCode === 200, "authAlways 开启后 x-openclaw-bridge-token 通过");
  const rWrong = fakeRes();
  await routes.get(CHAT)(fakeReq("POST", CHAT, { headers: { authorization: "Bearer wrong-token" }, body: JSON.stringify({ model: "x", messages: [] }) }), rWrong);
  ok(rWrong.statusCode === 401, "错误 token 仍拒绝");
  mockSettingsValue = { ...mockSettingsValue, authAlways: "" };

  // 流式响应补 usage 帧（choices 空数组）
  const resS = await chat({ model: "dsh-bridge/test-usage", stream: true, messages: [{ role: "user", content: "hi" }] });
  ok(/"usage"/.test(resS.body) && /choices":\[\]/.test(resS.body), "流式响应含 usage 帧（choices 空数组）");

  // ① /new 移除池记录（agent 释放 + 池不泄漏）
  pendingMsgs.push(wxMsg("pooltest@im.wechat", "首个消息", "ctx-pool1"));
  await waitSent(sentMessages.length + 1);
  ok((await poolKeys()).includes("wx-pooltest-im.wechat"), "新微信用户入池（前置条件）");
  pendingMsgs.push(wxMsg("pooltest@im.wechat", "/new", "ctx-pool2"));
  await waitSent(sentMessages.length + 1);
  ok(!(await poolKeys()).includes("wx-pooltest-im.wechat"), "/new 后池中不再保留该微信会话记录");
}

console.log("\nall " + passed + " checks passed");

cleanup();
mockIlink.close();
mockOpenAi.close();
mockWsServer.close();
mockFeishuHttp.close();
mockFeishuWs.close();
mockQqHttp.close();
mockQqWs.close();
setTimeout(() => process.exit(0), 800);
