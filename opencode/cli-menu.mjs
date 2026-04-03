import { ANSI, confirm, select, isTTY } from "./cli-ui.mjs";
import {
  formatAccountType,
  formatOverage,
  formatUtilization,
  getConfig,
  listAccountsWithHealth,
  removeAccount,
  resetAccount,
  setConfig,
} from "./management.mjs";

function colorizeStatusBadge(account) {
  const text = account.statusBadge ?? "";
  if (!text) return "";
  if (account.isDead || text.includes("dead")) return `${ANSI.red}${text}${ANSI.reset}`;
  if (account.isCoolingDown || text.includes("cooling") || text.includes("auth-failing")) {
    return `${ANSI.yellow}${text}${ANSI.reset}`;
  }
  return `${ANSI.green}${text}${ANSI.reset}`;
}

function isActiveForSummary(account) {
  return account.status === "active"
    && !account.isDead
    && !account.isCoolingDown
    && !String(account.statusBadge).includes("auth-failing");
}

function buildAccountLabel(account, index) {
  const type = `[${formatAccountType(account.type)}]`;
  const badge = colorizeStatusBadge(account);
  return `${index + 1}. ${account.label} ${type} ${badge}`.trim();
}

function buildAccountHint(account) {
  if (account.type === "apikey" && account.maskedAccess) {
    return account.maskedAccess;
  }
  return `5h: ${formatUtilization(account.util5h)} · 7d: ${formatUtilization(account.util7d)}`;
}

function buildMainMenuItems(accounts) {
  const activeCount = accounts.filter(isActiveForSummary).length;
  const accountItems = accounts.length > 0
    ? accounts.map((account, index) => ({
        label: buildAccountLabel(account, index),
        hint: buildAccountHint(account),
        value: { type: "account", accountId: account.id },
      }))
    : [{ label: "No accounts configured yet", value: { type: "none" }, disabled: true }];

  return [
    { label: "Actions", value: { type: "noop" }, kind: "heading" },
    { label: "Add Claude Pro/Max account", value: { type: "add-oauth" }, color: "cyan" },
    { label: "Add API Key", value: { type: "add-apikey" }, color: "cyan" },
    { label: "Pool config", value: { type: "pool-config" }, color: "cyan" },
    { label: "", value: { type: "noop" }, separator: true },
    { label: `Accounts (${accounts.length} total, ${activeCount} active)`, value: { type: "noop" }, kind: "heading" },
    ...accountItems,
    { label: "", value: { type: "noop" }, separator: true },
    { label: "Danger zone", value: { type: "noop" }, kind: "heading" },
    { label: "Remove all accounts", value: { type: "remove-all" }, color: "red", disabled: accounts.length === 0 },
  ];
}


async function showPoolConfigMenu(db) {
  while (true) {
    const cfg = getConfig(db);
    const items = [
      ...cfg.entries.map(({ key, value, description }) => ({
        label: `${key}: ${String(value)} — ${description}`,
        value: { type: "toggle", key, value },
        color: "cyan",
      })),
      { label: "Back", value: { type: "back" } },
    ];

    const result = await select(items, {
      message: "Pool Configuration",
      clearScreen: true,
      help: "Up/Down to select | Enter: toggle | Esc: back",
    });

    if (!result || result.type === "back") return;

    const nextValue = typeof result.value === "boolean" ? !result.value : result.value;
    setConfig(result.key, String(nextValue), db);
  }
}

async function showAccountDetailsMenu(db, accountId) {
  while (true) {
    const account = listAccountsWithHealth(db).find((entry) => entry.id === accountId);
    if (!account) return;

    const result = await select(
      [
        { label: "Back", value: "back" },
        { label: "Reset account", value: "reset", color: "cyan" },
        { label: "Remove account", value: "remove", color: "red" },
      ],
      {
        message: `${account.label} [${formatAccountType(account.type)}] ${colorizeStatusBadge(account)}`,
        subtitle: `5h util: ${formatUtilization(account.util5h)} · 7d util: ${formatUtilization(account.util7d)} · Overage: ${formatOverage(account.overage)}`,
        clearScreen: true,
      },
    );

    if (!result || result === "back") return;

    if (result === "reset") {
      resetAccount(account.id, db);
      continue;
    }

    if (result === "remove") {
      const approved = await confirm(`Remove ${account.label}?`);
      if (!approved) continue;
      removeAccount(account.id, db);
      return;
    }
  }
}

export async function showAccountMenu(db, deps = {}) {
  const { persistAccountCredentials } = deps;

  while (true) {
    const accounts = listAccountsWithHealth(db);
    const result = await select(buildMainMenuItems(accounts), {
      message: "Anthropic Account Management",
      subtitle: "Select an action or account",
      clearScreen: true,
    });

    if (!result) return null;

    switch (result.type) {
      case "add-oauth":
        return "add-oauth";
      case "add-apikey": {
        const key = await promptApiKey();
        if (key && persistAccountCredentials) {
          persistAccountCredentials(db, "API Key", { apiKey: key }, Date.now(), "apikey");
          console.log(`\n  \x1b[32m✓\x1b[0m API key added to pool (${key.slice(0, 10)}...${key.slice(-4)})\n`);
        } else if (key) {
          console.log("\n  \x1b[31m✗\x1b[0m Invalid key or missing persistence function\n");
        }
        // Stay in menu so user can see the new account
        break;
      }
      case "pool-config":
        await showPoolConfigMenu(db);
        break;
      case "account":
        await showAccountDetailsMenu(db, result.accountId);
        break;
      case "remove-all": {
        const approved = await confirm("Remove ALL accounts? This cannot be undone.");
        if (!approved) break;
        for (const account of accounts) {
          removeAccount(account.id, db);
        }
        break;
      }
      default:
        return null;
    }
  }
}

async function promptApiKey() {
  const { createInterface } = await import("node:readline");
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question("\nPaste your Anthropic API key (sk-ant-...): ", (answer) => {
      rl.close();
      const key = answer.trim();
      if (key && key.startsWith("sk-")) {
        resolve(key);
      } else if (key) {
        console.log("\n  \x1b[31m✗\x1b[0m Invalid format. Expected sk-ant-... or sk-...\n");
        resolve(null);
      } else {
        resolve(null);
      }
    });
  });
}

export const __test = {
  buildAccountHint,
  buildAccountLabel,
  buildMainMenuItems,
  colorizeStatusBadge,
  isActiveForSummary,
};
