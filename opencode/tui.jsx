/** @jsxImportSource @opentui/solid */
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { open } from "./db.mjs"
import * as mgmt from "./management.mjs"

// --- Helpers ---

const truncate = (s, n) =>
  s && s.length > n ? s.slice(0, n - 1) + "…" : s || ""

const colors = (current) => ({
  panel: current.backgroundPanel,
  border: current.border,
  text: current.text,
  muted: current.textMuted,
  accent: current.primary,
  success: current.success,
  warning: current.warning,
  error: current.error,
})

const utilLine = (a) => {
  const u5 =
    typeof a.util5h === "number" ? (a.util5h * 100).toFixed(0) + "%" : "?"
  const u7 =
    typeof a.util7d === "number" ? (a.util7d * 100).toFixed(0) + "%" : "?"
  const s5 = a.isStale5h ? " (stale)" : ""
  const s7 = a.isStale7d ? " (stale)" : ""
  return `5h: ${u5}${s5} · 7d: ${u7}${s7} · ${a.util5hRelative || "never"}`
}

// --- Dialog flows ---

function showAccountList(api, db) {
  const accounts = mgmt.listAccountsWithHealth(db)
  const active = accounts.filter((a) => !a.isDead && !a.isCoolingDown).length

  const options = accounts.map((a) => ({
    title: `${truncate(a.label, 20)} ${a.type === "apikey" ? "[API Key]" : "[OAuth]"} ${a.statusBadge}`,
    value: a.id,
    description: utilLine(a),
  }))
  options.push({
    title: "Config",
    value: "__config__",
    description: "Pool configuration settings",
  })
  options.push({
    title: "Back",
    value: "__back__",
    description: "Return home",
  })

  const DialogSelect = api.ui.DialogSelect
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() => (
    <DialogSelect
      title={`Anthropic Accounts (${accounts.length} total, ${active} active)`}
      options={options}
      onSelect={(item) => {
        api.ui.dialog.clear()
        if (item.value === "__back__") {
          api.route.navigate("home")
          return
        }
        if (item.value === "__config__") {
          showConfig(api, db)
          return
        }
        const account = accounts.find((a) => a.id === item.value)
        if (account) showAccountDetail(api, db, account)
      }}
    />
  ))
}

function showAccountDetail(api, db, account) {
  const options = []
  if (account.isDead || account.isCoolingDown) {
    options.push({
      title: "Reset",
      value: "reset",
      description: "Reset to active state",
    })
  }
  options.push({
    title: "Remove",
    value: "remove",
    description: "Remove from pool permanently",
  })
  options.push({ title: "Back", value: "back" })

  const DialogSelect = api.ui.DialogSelect
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() => (
    <DialogSelect
      title={`${truncate(account.label, 30)} (${account.type})`}
      options={options}
      onSelect={(item) => {
        api.ui.dialog.clear()
        if (item.value === "reset") {
          try {
            mgmt.resetAccount(account.id, db)
            api.ui.toast({
              variant: "success",
              title: "Account Reset",
              message: `"${truncate(account.label, 20)}" reset to active`,
              duration: 3000,
            })
          } catch (e) {
            api.ui.toast({
              variant: "error",
              title: "Reset Failed",
              message: String(e.message || e),
              duration: 4000,
            })
          }
          showAccountList(api, db)
        } else if (item.value === "remove") {
          showRemoveConfirm(api, db, account)
        } else {
          showAccountList(api, db)
        }
      }}
    />
  ))
}

function showRemoveConfirm(api, db, account) {
  const DialogConfirm = api.ui.DialogConfirm
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() => (
    <DialogConfirm
      title="Remove Account"
      message={`Remove "${truncate(account.label, 30)}"? This cannot be undone.`}
      onConfirm={() => {
        try {
          mgmt.removeAccount(account.id, db)
          api.ui.toast({
            variant: "success",
            title: "Removed",
            message: `"${truncate(account.label, 20)}" removed from pool`,
            duration: 3000,
          })
        } catch (e) {
          api.ui.toast({
            variant: "error",
            title: "Remove Failed",
            message: String(e.message || e),
            duration: 4000,
          })
        }
        showAccountList(api, db)
      }}
      onCancel={() => showAccountDetail(api, db, account)}
    />
  ))
}

function showConfig(api, db) {
  const cfg = mgmt.getConfig(db)
  const options = cfg.entries.map((e) => ({
    title: `${e.key}: ${e.value}`,
    value: e.key,
    description: e.description,
  }))
  options.push({ title: "Back", value: "__back__" })

  const DialogSelect = api.ui.DialogSelect
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() => (
    <DialogSelect
      title="Pool Configuration"
      options={options}
      onSelect={(item) => {
        api.ui.dialog.clear()
        if (item.value === "__back__") {
          showAccountList(api, db)
          return
        }
        const current = cfg.values[item.value]
        if (typeof current === "boolean") {
          showConfigToggle(api, db, item.value, current)
        } else {
          api.ui.toast({
            variant: "info",
            title: "Info",
            message: `"${item.value}" is not toggleable`,
            duration: 2000,
          })
          showConfig(api, db)
        }
      }}
    />
  ))
}

function showConfigToggle(api, db, key, current) {
  const DialogConfirm = api.ui.DialogConfirm
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() => (
    <DialogConfirm
      title="Toggle Config"
      message={`Set "${key}" to ${!current}?`}
      onConfirm={() => {
        try {
          mgmt.setConfig(key, String(!current), db)
          api.ui.toast({
            variant: "success",
            title: "Config Updated",
            message: `${key} = ${!current}`,
            duration: 3000,
          })
        } catch (e) {
          api.ui.toast({
            variant: "error",
            title: "Update Failed",
            message: String(e.message || e),
            duration: 4000,
          })
        }
        showConfig(api, db)
      }}
      onCancel={() => showConfig(api, db)}
    />
  ))
}

// --- Route Screen ---

const AccountListScreen = (props) => {
  const dim = useTerminalDimensions()
  const skin = colors(props.api.theme.current)
  const accounts = mgmt.listAccountsWithHealth(props.db)
  const active = accounts.filter((a) => !a.isDead && !a.isCoolingDown).length

  // Open the interactive selection dialog when route first renders
  setTimeout(() => {
    if (props.api.route.current.name === "accounts.list") {
      showAccountList(props.api, props.db)
    }
  }, 0)

  useKeyboard((evt) => {
    if (props.api.route.current.name !== "accounts.list") return
    if (props.api.ui.dialog.open) return
    if (evt.name === "escape") {
      evt.preventDefault()
      evt.stopPropagation()
      props.api.route.navigate("home")
    }
  })

  return (
    <box
      width={dim().width}
      height={dim().height}
      backgroundColor={skin.panel}
      flexDirection="column"
      paddingTop={1}
      paddingLeft={2}
      paddingRight={2}
    >
      <box paddingBottom={1}>
        <text fg={skin.text}>
          <b>Anthropic Account Management</b>
          <span style={{ fg: skin.muted }}>
            {" "}— {accounts.length} total, {active} active
          </span>
        </text>
      </box>
      {accounts.map((a) => (
        <box flexDirection="column" paddingBottom={1}>
          <text fg={skin.text}>
            {truncate(a.label, 20)}{" "}
            <span style={{ fg: skin.accent }}>
              {a.type === "apikey" ? "[API Key]" : "[OAuth]"}
            </span>{" "}
            <span style={{ fg: skin.muted }}>{a.statusBadge}</span>
          </text>
          <text fg={skin.muted}> {utilLine(a)}</text>
        </box>
      ))}
    </box>
  )
}

// --- Plugin entry ---

const tui = async (api, options, meta) => {
  const db = open()

  // Register route
  api.route.register([
    {
      name: "accounts.list",
      render: ({ params }) => (
        <AccountListScreen api={api} db={db} params={params} />
      ),
    },
  ])

  // Register commands
  api.command.register(() => [
    {
      title: "Manage Accounts",
      value: "anthropic-auth.accounts",
      category: "Anthropic Auth",
      slash: { name: "accounts" },
      onSelect: () => api.route.navigate("accounts.list"),
    },
  ])

  // Register home footer slot
  api.slots.register({
    slots: {
      home_footer(ctx) {
        const skin = colors(ctx.theme.current)
        const accounts = mgmt.listAccountsWithHealth(db)
        const active = accounts.filter(
          (a) => !a.isDead && !a.isCoolingDown,
        ).length
        const label =
          accounts.length === 0
            ? "Anthropic: No accounts"
            : `Anthropic: ${accounts.length} accounts (${active} active)`

        return (
          <box paddingLeft={1}>
            <text fg={skin.muted}>
              <span style={{ fg: skin.accent }}>●</span> {label}
            </text>
          </box>
        )
      },
    },
  })

  // Cleanup
  api.lifecycle.onDispose(() => {})
}

const plugin = { id: "anthropic-auth-tui", tui }

export default plugin
