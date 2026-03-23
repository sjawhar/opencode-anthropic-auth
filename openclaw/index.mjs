// ../shared/oauth.mjs
import { createHash, randomBytes } from "node:crypto";
var CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
var CLAUDE_CODE_VERSION = "2.1.76";
var CLAUDE_CODE_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;
var TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
var AUTHORIZE_URL_BASE = {
  console: "https://console.anthropic.com/oauth/authorize",
  max: "https://claude.ai/oauth/authorize"
};
var REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
var SCOPES = "org:create_api_key user:profile user:inference";
function toBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function generatePkce() {
  const verifier = toBase64Url(randomBytes(32));
  const challenge = toBase64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}
function authHeaders(extra = {}) {
  return {
    "User-Agent": CLAUDE_CODE_AGENT,
    ...extra
  };
}
function formBody(params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== void 0 && value !== null) {
      body.set(key, String(value));
    }
  }
  return body;
}
async function authorize(mode = "max") {
  const pkce = generatePkce();
  const authorizeUrl = mode === "console" ? AUTHORIZE_URL_BASE.console : AUTHORIZE_URL_BASE.max;
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
async function exchange(code, verifier) {
  const splits = String(code ?? "").split("#");
  const body = formBody({
    code: splits[0],
    state: splits[1],
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier
  });
  const result = await fetch(TOKEN_URL, {
    method: "POST",
    headers: authHeaders({
      "Content-Type": "application/x-www-form-urlencoded"
    }),
    body
  });
  if (!result.ok) return { type: "failed" };
  const json = await result.json();
  return {
    type: "success",
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1e3
  };
}

async function createApiKeyFromAccessToken(accessToken) {
  const response = await fetch("https://api.anthropic.com/api/oauth/claude_cli/create_api_key", {
    method: "POST",
    headers: authHeaders({
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    }),
    body: "{}"
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API key creation failed: ${response.status}${body ? ` ${body}` : ""}`);
  }
  const json = await response.json();
  const key = typeof json?.raw_key === "string" ? json.raw_key.trim() : "";
  if (!key)
    throw new Error("API key creation failed: missing raw_key");
  return key;
}
async function refreshAccessToken(refreshToken) {
  const body = formBody({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: authHeaders({
      "Content-Type": "application/x-www-form-urlencoded"
    }),
    body
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Token refresh failed: ${response.status}${body ? ` ${body}` : ""}`
    );
  }
  const json = await response.json();
  return {
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1e3
  };
}

// index.mjs
var PROVIDER_ID = "anthropic";
var PROFILE_ID = "anthropic:claude-oauth";
var plugin = {
  id: "openclaw-anthropic-oauth",
  name: "Anthropic OAuth Provider",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Anthropic (OAuth)",
      auth: [
        {
          id: "claude-oauth",
          label: "Claude Pro/Max (Browser OAuth)",
          kind: "oauth",
          async run(ctx) {
            const { url, verifier } = await authorize("max");
            ctx.runtime.log(`\nOpen this URL in your browser to authorize:\n\n  ${url}\n`);
            try { await ctx.openUrl(url); } catch {}
            const code = await ctx.prompter.text({
              message: "Paste the authorization code here:"
            });
            const token = await exchange(code, verifier);
            if (token.type === "failed") {
              throw new Error("Anthropic OAuth authorization failed");
            }
            return {
              profiles: [
                {
                  profileId: PROFILE_ID,
                  credential: {
                    type: "oauth",
                    provider: PROVIDER_ID,
                    refresh: token.refresh,
                    access: token.access,
                    expires: token.expires
                  }
                }
              ]
            };
          }
        }
      ],
      async refreshOAuth(cred) {
        const refreshToken = cred.refresh;
        if (!refreshToken) throw new Error("OAuth refresh token missing");
        const token = await refreshAccessToken(refreshToken);
        return {
          ...cred,
          type: "oauth",
          provider: PROVIDER_ID,
          refresh: token.refresh,
          access: token.access,
          expires: token.expires
        };
      },
    });
  }
};
var index_default = plugin;
export {
  index_default as default
};
