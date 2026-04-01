// tui.jsx
import { useTerminalDimensions } from "@opentui/solid";
import { jsx } from "@opentui/solid/jsx-runtime";
var tui = async (api, options, meta) => {
  api.route.register([
    {
      name: "accounts.list",
      render: ({ params }) => /* @__PURE__ */ jsx("div", { children: "Accounts List (placeholder)" })
    }
  ]);
  api.command.register(() => [
    {
      title: "Manage Accounts",
      value: "anthropic-auth.manage-accounts",
      category: "Anthropic Auth",
      onSelect: () => {
        api.route.navigate("accounts.list");
      }
    }
  ]);
  api.slots.register({
    slots: {
      home_footer(ctx) {
        return /* @__PURE__ */ jsx("div", { children: "Anthropic: loading..." });
      }
    }
  });
  api.lifecycle.onDispose(() => {
  });
};
var plugin = { id: "anthropic-auth-tui", tui };
var tui_default = plugin;
export {
  tui_default as default
};
