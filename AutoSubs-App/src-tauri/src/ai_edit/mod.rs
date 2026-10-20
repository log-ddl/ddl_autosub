//! AI Edit timeline actions and the MCP server that exposes them to the agent.
//!
//! - `actions`: the action types and the single dispatch point.
//! - `editors`: one backend per editor (DaVinci Resolve, CapCut, Premiere Pro).
//! - `mcp`: the MCP transport and tool schemas.
//! - `media`: the agent's download tools (videos, web articles).
//! - `transcript`: `get_transcript`, the saved transcripts as the agent reads them.

pub mod actions;
pub mod editors;
pub mod media;
pub mod mcp;
pub mod transcript;
