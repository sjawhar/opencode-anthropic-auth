export function persistAccountCredentials(db, label, credentials, now = Date.now()) {
  const id = credentials.account?.uuid;
  if (!id) {
    throw new Error("Authorization succeeded but account UUID is missing.");
  }

  db.prepare(
    "INSERT OR REPLACE INTO account (id, label, refresh, access, expires, status, consecutive_failures) VALUES (?, ?, ?, ?, ?, 'active', 0)",
  ).run(
    id,
    label.trim() || "unnamed",
    credentials.refresh_token,
    credentials.access_token || "",
    credentials.expires_in ? now + credentials.expires_in * 1000 : 0,
  );

  return id;
}
