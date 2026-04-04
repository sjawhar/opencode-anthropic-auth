import { describe, expect, test } from "bun:test";

import { AnthropicAuthPlugin } from "./index.mjs";
import { __test as menuTest } from "./cli-menu.mjs";
import { formatAccountType, formatOverage, formatUtilization } from "./management.mjs";

describe("auth method structure", () => {
  let methods;

  test("plugin exposes 4 auth methods", async () => {
    const plugin = await AnthropicAuthPlugin({ client: {} });
    methods = plugin.auth.methods;
    expect(methods).toHaveLength(4);
  });

  test("first 3 methods are unchanged", async () => {
    const plugin = await AnthropicAuthPlugin({ client: {} });
    methods = plugin.auth.methods;

    expect(methods[0]).toMatchObject({ label: "Claude Pro/Max", type: "oauth" });
    expect(methods[1]).toMatchObject({ label: "Create an API Key", type: "oauth" });
    expect(methods[2]).toMatchObject({ label: "Manually enter API Key", type: "api" });
  });

  test("4th method is Manage accounts (CLI-only)", async () => {
    const plugin = await AnthropicAuthPlugin({ client: {} });
    const method = plugin.auth.methods[3];

    expect(method.label).toBe("Manage accounts");
    expect(method.type).toBe("oauth");
    expect(typeof method.authorize).toBe("function");
  });

  test("manage accounts TUI path returns CLI guidance", async () => {
    const plugin = await AnthropicAuthPlugin({ client: {} });
    const method = plugin.auth.methods[3];
    const result = await method.authorize();

    expect(result).toMatchObject({
      url: "",
      instructions: "Use `opencode auth login` to manage accounts.",
      method: "auto",
    });
    await expect(result.callback()).resolves.toEqual({ type: "failed" });
  });
});

describe("cli menu helpers", () => {
  test("formatting helpers produce user-facing labels", () => {
    expect(formatAccountType("oauth")).toBe("OAuth");
    expect(formatAccountType("apikey")).toBe("API Key");
    expect(formatUtilization(0.42)).toBe("42%");
    expect(formatOverage(0)).toBe("$0.00");
  });

  test("buildAccountLabel includes numbering, type, and status", () => {
    const label = menuTest.buildAccountLabel({
      label: "Claude Pro/Max",
      type: "oauth",
      statusBadge: "[active]",
      isDead: false,
      isCoolingDown: false,
    }, 0);

    expect(label).toContain("1. Claude Pro/Max");
    expect(label).toContain("[OAuth]");
    expect(label).toContain("[active]");
  });

  test("buildAccountHint prefers masked API key display", () => {
    expect(menuTest.buildAccountHint({ type: "apikey", maskedAccess: "sk-ant-...xyzw" })).toBe("sk-ant-...xyzw");
  });

  test("buildAccountHint shows utilization for oauth accounts", () => {
    expect(menuTest.buildAccountHint({ type: "oauth", util5h: 0.42, util7d: 0.15 })).toBe("5h: 42% · 7d: 15%");
  });

  test("buildMainMenuItems includes actions, accounts summary, and danger zone", () => {
    const items = menuTest.buildMainMenuItems([
      {
        id: "acct-1",
        label: "Claude Pro/Max",
        type: "oauth",
        statusBadge: "[active]",
        util5h: 0.42,
        util7d: 0.15,
        isDead: false,
        isCoolingDown: false,
        status: "active",
      },
      {
        id: "acct-2",
        label: "My API Key",
        type: "apikey",
        statusBadge: "[auth-failing]",
        maskedAccess: "sk-ant-...xyzw",
        isDead: false,
        isCoolingDown: false,
        status: "active",
      },
    ]);

    expect(items[0]).toMatchObject({ label: "Actions", kind: "heading" });
    expect(items[1]).toMatchObject({ label: "Add Claude Pro/Max account" });
    expect(items[2]).toMatchObject({ label: "Add API Key" });
    expect(items.some((item) => item.kind === "heading" && item.label === "Accounts (2 total, 1 active)")).toBe(true);
    expect(items.some((item) => item.label?.includes("1. Claude Pro/Max"))).toBe(true);
    expect(items.some((item) => item.label?.includes("2. My API Key"))).toBe(true);
    expect(items.at(-2)).toMatchObject({ label: "Danger zone", kind: "heading" });
    expect(items.at(-1)).toMatchObject({ label: "Remove all accounts", color: "red" });
  });

  test("empty account menu disables destructive action", () => {
    const items = menuTest.buildMainMenuItems([]);
    expect(items.some((item) => item.label === "No accounts configured yet" && item.disabled)).toBe(true);
    expect(items.at(-1)).toMatchObject({ label: "Remove all accounts", disabled: true });
  });
});
