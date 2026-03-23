import { createHash, randomBytes } from "node:crypto";

export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_CODE_VERSION = "2.1.76";
export const CLAUDE_CODE_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;

export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
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
    "User-Agent": CLAUDE_CODE_AGENT,
    ...extra,
  };
}

function formBody(params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      body.set(key, String(value));
    }
  }
  return body;
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
  const body = formBody({
    code: splits[0],
    state: splits[1],
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  const result = await fetch(TOKEN_URL, {
    method: "POST",
    headers: authHeaders({
      "Content-Type": "application/x-www-form-urlencoded",
    }),
    body,
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
  const body = formBody({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: authHeaders({
      "Content-Type": "application/x-www-form-urlencoded",
    }),
    body,
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
