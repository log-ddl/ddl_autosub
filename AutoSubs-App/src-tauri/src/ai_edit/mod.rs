//! AI Edit timeline actions and the MCP server that exposes them to the agent.
//!
//! - `actions`: the action types and the single dispatch point.
//! - `editors`: one backend per editor (DaVinci Resolve, CapCut, Premiere Pro).
//! - `mcp`: the MCP transport and tool schemas.

pub mod actions;
pub mod editors;
pub mod mcp;
