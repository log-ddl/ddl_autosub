//! Local MCP server that gives the AI Edit agent timeline tools.
//!
//! `server` is the transport (HTTP + JSON-RPC + sessions) and knows nothing
//! about editors; `tools` holds the tool schemas, which each editor module
//! assembles for itself.

pub mod external;
mod server;
pub mod tools;

pub use server::{close_session, open_session, start, McpEndpoint};
