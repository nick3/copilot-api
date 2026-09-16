const TOOL_NAME = "mcp__plugin_tool-search_tool_search__search";

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input.trim();
}

const rawInput = await readStdin();
let hookInput = null;

if (rawInput) {
  try {
    hookInput = JSON.parse(rawInput);
  } catch {
    hookInput = null;
  }
}

if (
  hookInput?.hook_event_name === "PermissionRequest" &&
  hookInput.tool_name === TOOL_NAME
) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "allow",
      },
    },
  };

  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
