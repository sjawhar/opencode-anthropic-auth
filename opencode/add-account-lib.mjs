import { randomUUID } from "node:crypto";

export function persistAccountCredentials(db, label, credentials, now = Date.now(), type = "oauth") {
  let id;
  let access;
  let refresh;
  let expires;

  if (type === "apikey") {
    id = randomUUID();
    access = credentials.apiKey;
    refresh = "";
    expires = 0;
  } else {
    id = credentials.account?.uuid;
    if (!id) {
      throw new Error("Authorization succeeded but account UUID is missing.");
    }
    access = credentials.access_token || "";
    refresh = credentials.refresh_token;
    expires = credentials.expires_in ? now + credentials.expires_in * 1000 : 0;
  }

  db.prepare(
    "INSERT OR REPLACE INTO account (id, label, refresh, access, expires, status, consecutive_failures, type) VALUES (?, ?, ?, ?, ?, 'active', 0, ?)",
  ).run(
    id,
    label.trim() || "unnamed",
    refresh,
    access,
    expires,
    type,
  );

  return id;
}
