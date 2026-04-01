/** @jsxImportSource @opentui/solid */
import { useTerminalDimensions } from "@opentui/solid"

const tui = async (api, options, meta) => {
  // Register routes
  api.route.register([
    {
      name: "accounts.list",
      render: ({ params }) => (
        <div>Accounts List (placeholder)</div>
      ),
    },
  ])

  // Register commands
  api.command.register(() => [
    {
      title: "Manage Accounts",
      value: "anthropic-auth.manage-accounts",
      category: "Anthropic Auth",
      onSelect: () => {
        api.route.navigate("accounts.list")
      },
    },
  ])

  // Register slots
  api.slots.register({
    slots: {
      home_footer(ctx) {
        return <div>Anthropic: loading...</div>
      },
    },
  })

  // Cleanup
  api.lifecycle.onDispose(() => {
    // Cleanup logic here
  })
};

const plugin = { id: "anthropic-auth-tui", tui };

export default plugin;
