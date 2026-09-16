export const MCP_SUBCOMMAND = "mcp"

// HTTP transport and global CLI options must use the normal argument parser.
export const isMcpFastPath = (argv: ReadonlyArray<string>): boolean =>
  argv.length === 3 && argv[2] === MCP_SUBCOMMAND
