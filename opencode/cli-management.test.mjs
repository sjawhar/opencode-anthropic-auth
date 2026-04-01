import { describe, expect, test } from "bun:test";

import { AnthropicAuthPlugin, __test } from "./index.mjs";

const { runManagementMenu } = __test;

// ---------------------------------------------------------------------------
// Structural tests — verify methods array shape
// ---------------------------------------------------------------------------

describe("4th auth method structure", () => {
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

  test("4th method has label Manage accounts and type oauth", async () => {
    const plugin = await AnthropicAuthPlugin({ client: {} });
    const method = plugin.auth.methods[3];

    expect(method.label).toBe("Manage accounts");
    expect(method.type).toBe("oauth");
    expect(typeof method.authorize).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Menu helpers
// ---------------------------------------------------------------------------

function makePrompt(responses) {
  let i = 0;
  return async (_question) => responses[i++] ?? "5";
}

function makeMgmt(overrides = {}) {
  return {
    listAccountsWithHealth: () => [],
    removeAccount: () => true,
    resetAccount: () => ({ reset: true, account: { status: "active" } }),
    getConfig: () => ({ values: {}, entries: [] }),
    setConfig: () => ({ values: {}, entries: [] }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// runManagementMenu — unit tests with injected dependencies
// ---------------------------------------------------------------------------

describe("runManagementMenu", () => {
  test("exits immediately on choice 5", async () => {
    const calls = [];
    const mgmt = makeMgmt({
      listAccountsWithHealth: () => {
        calls.push("list");
        return [];
      },
    });

    await runManagementMenu(null, mgmt, makePrompt(["5"]));

    // Called once for the header display
    expect(calls).toEqual(["list"]);
  });

  test("exits on unrecognised input (default case)", async () => {
    const mgmt = makeMgmt();
    // anything other than 1-5 triggers the default branch which sets running = false
    await runManagementMenu(null, mgmt, makePrompt(["banana"]));
    // just verify it doesn't hang
  });

  test("list accounts (choice 1) calls listAccountsWithHealth twice", async () => {
    let callCount = 0;
    const mgmt = makeMgmt({
      listAccountsWithHealth: () => {
        callCount++;
        return [];
      },
    });

    await runManagementMenu(null, mgmt, makePrompt(["1", "5"]));

    // once for header, once inside case "1", once for second loop header
    expect(callCount).toBe(3);
  });

  test("list accounts shows details when accounts exist", async () => {
    const accounts = [
      {
        id: "a1",
        label: "Pro",
        type: "oauth",
        statusBadge: "[active]",
        util5h: 0.42,
        util7d: 0.15,
        util5hRelative: "2m ago",
        util7dRelative: "1h ago",
      },
    ];
    const mgmt = makeMgmt({ listAccountsWithHealth: () => accounts });

    // Should not throw
    await runManagementMenu(null, mgmt, makePrompt(["1", "5"]));
  });

  test("remove account (choice 2) dispatches removeAccount on confirmation", async () => {
    const removed = [];
    const accounts = [
      { id: "acct-1", label: "Test", type: "oauth", statusBadge: "[active]" },
    ];
    const mgmt = makeMgmt({
      listAccountsWithHealth: () => accounts,
      removeAccount: (id) => {
        removed.push(id);
        return true;
      },
    });

    // "2" → remove, "1" → account #1, "y" → confirm, "5" → exit
    await runManagementMenu(null, mgmt, makePrompt(["2", "1", "y", "5"]));

    expect(removed).toEqual(["acct-1"]);
  });

  test("remove account cancels on non-y confirmation", async () => {
    const removed = [];
    const accounts = [
      { id: "acct-1", label: "Test", type: "oauth", statusBadge: "[active]" },
    ];
    const mgmt = makeMgmt({
      listAccountsWithHealth: () => accounts,
      removeAccount: (id) => {
        removed.push(id);
        return true;
      },
    });

    // "2" → remove, "1" → account #1, "n" → cancel, "5" → exit
    await runManagementMenu(null, mgmt, makePrompt(["2", "1", "n", "5"]));

    expect(removed).toEqual([]);
  });

  test("remove account rejects invalid selection", async () => {
    const removed = [];
    const accounts = [
      { id: "acct-1", label: "Test", type: "oauth", statusBadge: "[active]" },
    ];
    const mgmt = makeMgmt({
      listAccountsWithHealth: () => accounts,
      removeAccount: (id) => {
        removed.push(id);
      },
    });

    // "2" → remove, "9" → invalid index, "5" → exit
    await runManagementMenu(null, mgmt, makePrompt(["2", "9", "5"]));

    expect(removed).toEqual([]);
  });

  test("remove account handles empty account list", async () => {
    const mgmt = makeMgmt({ listAccountsWithHealth: () => [] });

    // "2" → remove, (no accounts → prints message), "5" → exit
    await runManagementMenu(null, mgmt, makePrompt(["2", "5"]));
    // Should not throw or prompt for account number
  });

  test("reset account (choice 3) dispatches resetAccount", async () => {
    const resets = [];
    const accounts = [
      { id: "acct-1", label: "Test", type: "oauth", statusBadge: "[active]" },
    ];
    const mgmt = makeMgmt({
      listAccountsWithHealth: () => accounts,
      resetAccount: (id) => {
        resets.push(id);
        return { reset: true, account: { status: "active" } };
      },
    });

    // "3" → reset, "1" → account #1, "5" → exit
    await runManagementMenu(null, mgmt, makePrompt(["3", "1", "5"]));

    expect(resets).toEqual(["acct-1"]);
  });

  test("reset account rejects invalid selection", async () => {
    const resets = [];
    const accounts = [
      { id: "acct-1", label: "Test", type: "oauth", statusBadge: "[active]" },
    ];
    const mgmt = makeMgmt({
      listAccountsWithHealth: () => accounts,
      resetAccount: (id) => {
        resets.push(id);
        return { reset: true, account: {} };
      },
    });

    // "3" → reset, "0" → invalid, "5" → exit
    await runManagementMenu(null, mgmt, makePrompt(["3", "0", "5"]));

    expect(resets).toEqual([]);
  });

  test("reset account handles empty list", async () => {
    const mgmt = makeMgmt({ listAccountsWithHealth: () => [] });

    await runManagementMenu(null, mgmt, makePrompt(["3", "5"]));
  });

  test("pool config (choice 4) shows config and toggles boolean", async () => {
    const setCalls = [];
    const mgmt = makeMgmt({
      listAccountsWithHealth: () => [],
      getConfig: () => ({
        values: { prefer_apikey_over_overage: false },
        entries: [
          {
            key: "prefer_apikey_over_overage",
            value: false,
            description: "Prefer API key over overage",
          },
        ],
      }),
      setConfig: (key, value) => {
        setCalls.push({ key, value });
        return { values: {}, entries: [] };
      },
    });

    // "4" → config, "prefer_apikey_over_overage" → toggle, "5" → exit
    await runManagementMenu(
      null,
      mgmt,
      makePrompt(["4", "prefer_apikey_over_overage", "5"]),
    );

    expect(setCalls).toEqual([
      { key: "prefer_apikey_over_overage", value: "true" },
    ]);
  });

  test("pool config skips toggle on empty input", async () => {
    const setCalls = [];
    const mgmt = makeMgmt({
      listAccountsWithHealth: () => [],
      getConfig: () => ({ values: {}, entries: [] }),
      setConfig: (key, value) => {
        setCalls.push({ key, value });
      },
    });

    // "4" → config, "" → skip toggle, "5" → exit
    await runManagementMenu(null, mgmt, makePrompt(["4", "", "5"]));

    expect(setCalls).toEqual([]);
  });

  test("pool config reports unknown key", async () => {
    const setCalls = [];
    const mgmt = makeMgmt({
      listAccountsWithHealth: () => [],
      getConfig: () => ({
        values: { known: true },
        entries: [{ key: "known", value: true, description: "d" }],
      }),
      setConfig: (key, value) => {
        setCalls.push({ key, value });
      },
    });

    // "4" → config, "nope" → unknown key, "5" → exit
    await runManagementMenu(null, mgmt, makePrompt(["4", "nope", "5"]));

    expect(setCalls).toEqual([]);
  });
});
