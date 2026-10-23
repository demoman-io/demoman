// apps/mcp/src/version.ts
//
// This server's version, as its MCP name and in the peer handshake (spec
// §2.6.2). Kept equal to package.json's by bin.test, since a hand-over
// bundle carries no package.json to read it from.
export const SERVER_VERSION = "0.1.0";
