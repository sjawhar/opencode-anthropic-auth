import { createHash, randomBytes } from "node:crypto";

export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_CODE_VERSION = "2.1.76";
export const CLAUDE_CODE_AGENT = `claude-code/${CLAUDE_CODE_VERSION}`;

export const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
export const AUTHORIZE_URL_BASE = {
  console: "https://console.anthropic.com/oauth/authorize",
  max: "https://claude.ai/oauth/authorize",
};
export const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
export const SCOPES = "org:create_api_key user:profile user:inference";

function toBase64Url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function generatePkce() {
  const verifier = toBase64Url(randomBytes(32));
  const challenge = toBase64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function authHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    "User-Agent": CLAUDE_CODE_AGENT,
    ...extra,
  };
}

export async function authorize(mode = "max") {
  const pkce = generatePkce();
  const authorizeUrl =
    mode === "console" ? AUTHORIZE_URL_BASE.console : AUTHORIZE_URL_BASE.max;

  const url = new URL(authorizeUrl);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.verifier);

  return { url: url.toString(), verifier: pkce.verifier };
}

export async function exchange(code, verifier) {
  const splits = String(code ?? "").split("#");
  const result = await fetch(TOKEN_URL, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!result.ok) return { type: "failed" };
  const json = await result.json();
  return {
    type: "success",
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

export async function refreshAccessToken(refreshToken) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Token refresh failed: ${response.status}${body ? ` ${body}` : ""}`,
    );
  }

  const json = await response.json();
  return {
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}
