// index.mjs
import { createHash, randomBytes } from "node:crypto";
var CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
var CLAUDE_CODE_VERSION = "2.1.76";
var CLAUDE_CODE_AGENT = `claude-code/${CLAUDE_CODE_VERSION}`;
var TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
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
    "Content-Type": "application/json",
    "User-Agent": CLAUDE_CODE_AGENT,
    ...extra
  };
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
  const result = await fetch(TOKEN_URL, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier
    })
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
async function refreshAccessToken(refreshToken) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID
    })
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
            ctx.runtime.log(`
Open this URL in your browser to authorize:

  ${url}
`);
            try {
              await ctx.openUrl(url);
            } catch {
            }
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
      }
    });
  }
};
var index_default = plugin;
export {
  index_default as default
};
