//! AI Edit timeline actions and the MCP server that exposes them to the agent.
//!
//! - `actions`: the action types and the single dispatch point.
//! - `editors`: one backend per editor (Premiere Pro).
//! - `mcp`: the MCP transport and every tool the agent sees (`mcp/tools/`).

pub mod actions;
pub mod editors;
pub mod mcp;
