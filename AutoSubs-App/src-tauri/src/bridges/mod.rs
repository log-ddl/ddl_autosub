//! How the app talks to each video editor, independent of AI Edit.
//!
//! - `davinci`: file mailbox to the Lua loop inside Resolve, plus the
//!   launcher it installs into Resolve's Scripts folder.
//! - `capcut`: reads and writes CapCut draft JSON on disk.
//! - `adobe`: WebSocket server the Premiere Pro / After Effects CEP panel
//!   connects to.

pub mod adobe;
pub mod capcut;
pub mod davinci;
