#!/usr/bin/env bun
import { generatePKCE } from "@openauthjs/openauth/pkce";
import { createInterface } from "node:readline";
import { open } from "./db.mjs";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

function prompt(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(q, (a) => {
      rl.close();
      resolve(a);
    }),
  );
}

async function main() {
  const label = await prompt("Account label (e.g. personal, work): ");
  const pkce = await generatePKCE();

  const url = new URL("https://claude.ai/oauth/authorize");
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "redirect_uri",
    "https://console.anthropic.com/oauth/code/callback",
  );
  url.searchParams.set(
    "scope",
    "org:create_api_key user:profile user:inference",
  );
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.verifier);

  console.log("\nOpen this URL in your browser:\n");
  console.log(url.toString());
  const code = await prompt("\nPaste the authorization code here: ");

  const splits = code.split("#");
  const result = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: "https://console.anthropic.com/oauth/code/callback",
      code_verifier: pkce.verifier,
    }),
  });

  if (!result.ok) {
    console.error("Authorization failed:", result.status);
    process.exit(1);
  }

  const json = await result.json();
  const id = json.account?.uuid;
  if (!id) {
    console.error("Authorization succeeded but account UUID is missing.");
    process.exit(1);
  }

  const db = open();
  db.prepare(
    "INSERT OR REPLACE INTO account (id, label, refresh) VALUES (?, ?, ?)",
  ).run(id, label.trim() || "unnamed", json.refresh_token);

  const count = db.prepare("SELECT COUNT(*) as n FROM account").get().n;
  console.log(`\nAccount "${label}" added. Pool now has ${count} account(s).`);
}

main();
