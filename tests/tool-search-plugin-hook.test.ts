import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const pluginRoot = fileURLToPath(
  new URL("../plugin/claude/tool-search/", import.meta.url),
)
const hookScript = path.join(pluginRoot, "scripts", "allow-tool-search.js")

const runHook = (input: string | Record<string, unknown>): string => {
  const result = spawnSync("node", [hookScript], {
    encoding: "utf8",
    input: typeof input === "string" ? input : JSON.stringify(input),
  })

  if (result.status !== 0) {
    throw new Error(
      `Hook failed with status ${String(result.status)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
  }

  return result.stdout.trim()
}

describe("tool-search Claude plugin", () => {
  test("registers a narrowly scoped PermissionRequest hook", () => {
    const hooks = JSON.parse(
      fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"),
    ) as unknown
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(pluginRoot, ".claude-plugin", "plugin.json"),
        "utf8",
      ),
    ) as { version?: string }

    expect(hooks).toEqual({
      hooks: {
        PermissionRequest: [
          {
            matcher: "mcp__plugin_tool-search_tool_search__search",
            hooks: [
              {
                type: "command",
                command:
                  'node "${CLAUDE_PLUGIN_ROOT}/scripts/allow-tool-search.js"',
              },
            ],
          },
        ],
      },
    })
    expect(manifest.version).toBe("1.0.2")
  })

  test("auto-approves only the plugin tool-search bridge", () => {
    const output = runHook({
      hook_event_name: "PermissionRequest",
      tool_name: "mcp__plugin_tool-search_tool_search__search",
      tool_input: { names: "TaskList,TaskGet" },
    })

    expect(JSON.parse(output)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
        },
      },
    })
  })

  test("does not approve unrelated or malformed requests", () => {
    expect(
      runHook({
        hook_event_name: "PermissionRequest",
        tool_name: "mcp__fetch__fetch",
      }),
    ).toBe("")
    expect(
      runHook({
        hook_event_name: "PreToolUse",
        tool_name: "mcp__plugin_tool-search_tool_search__search",
      }),
    ).toBe("")
    expect(runHook("not json")).toBe("")
  })
})
