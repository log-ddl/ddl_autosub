//! One module per editor AI Edit can drive. Each exposes the same functions
//! (`timeline_snapshot`, `build_storyboard`, `add_markers`, `add_text`,
//! `update_segment`, `delete_segments`) plus `edit_tools()`, the MCP tool
//! schemas describing what that editor supports. `actions::execute` picks the
//! module from `EditTarget::editor`.

pub mod premiere;
