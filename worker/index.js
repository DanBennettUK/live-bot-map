/**
 * Serve the static map and a short-cached /status.json feed stored in KV.
 * PUT /status.json is reserved for the refresher and is protected by PUBLISH_TOKEN.
 */
const FEED_KEY = "status.json";
const MAX_BYTES = 512 * 1024;

const FEED_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=15, s-maxage=15",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

async function tokensMatch(provided, expected) {
  const enc = new TextEncoder();
  const a = enc.encode(provided);
  const b = enc.encode(expected);
  if (a.byteLength !== b.byteLength || a.byteLength === 0) {
    return false;
  }
  const algorithm = { name: "HMAC", hash: "SHA-256" };
  const key = await crypto.subtle.generateKey(algorithm, false, ["sign"]);
  const [sigA, sigB] = await Promise.all([
    crypto.subtle.sign(algorithm, key, a),
    crypto.subtle.sign(algorithm, key, b),
  ]);
  const left = new Uint8Array(sigA);
  const right = new Uint8Array(sigB);
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}

function bearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return "";
  }
  return header.slice(prefix.length).trim();
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: FEED_HEADERS,
  });
}

function isFeedPayload(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.generatedAt === "string" &&
    Array.isArray(value.bots)
  );
}

async function handleFeed(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (request.method === "PUT") {
    const expected = env.PUBLISH_TOKEN;
    if (!expected) {
      return jsonError(500, "publish token is not configured");
    }
    const ok = await tokensMatch(bearerToken(request), expected);
    if (!ok) {
      return jsonError(401, "unauthorized");
    }

    const lengthHeader = request.headers.get("Content-Length");
    if (lengthHeader && Number(lengthHeader) > MAX_BYTES) {
      return jsonError(413, "payload too large");
    }

    const body = await request.text();
    if (body.length > MAX_BYTES) {
      return jsonError(413, "payload too large");
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return jsonError(400, "invalid json");
    }
    if (!isFeedPayload(parsed)) {
      return jsonError(400, "invalid feed");
    }

    await env.FEED.put(FEED_KEY, body);
    return new Response(null, {
      status: 204,
      headers: { ...corsHeaders(), "Cache-Control": "no-store" },
    });
  }

  if (request.method === "GET" || request.method === "HEAD") {
    const value = await env.FEED.get(FEED_KEY);
    if (value === null) {
      return jsonError(404, "feed not published yet");
    }
    return new Response(request.method === "HEAD" ? null : value, {
      status: 200,
      headers: FEED_HEADERS,
    });
  }

  return new Response("Method not allowed", {
    status: 405,
    headers: { Allow: "GET, HEAD, PUT, OPTIONS", ...corsHeaders() },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/status.json") {
      return handleFeed(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
