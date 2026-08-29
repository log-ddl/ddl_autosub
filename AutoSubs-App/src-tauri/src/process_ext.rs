//! Keeps child processes from flashing a console window on Windows.
//!
//! When a process has no console of its own, Windows hands every child it
//! spawns a brand new one. Release builds set `windows_subsystem = "windows"`
//! (see `main.rs`) so the app itself has no console — which means yt-dlp,
//! ffmpeg, python and friends each pop a black terminal over the user's editor.
//! Debug builds keep a console that children quietly inherit, which is why this
//! only ever shows up in packaged builds.
//!
//! `tauri_plugin_shell` already passes this flag for sidecars, so only the raw
//! `std`/`tokio` commands in this crate need it. Every `Command` built here
//! should get `.hidden()` before it is spawned.

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub trait HiddenConsole {
    /// Suppress the console window Windows would otherwise allocate. A no-op on
    /// other platforms, so call sites stay free of `cfg` noise.
    fn hidden(&mut self) -> &mut Self;
}

impl HiddenConsole for std::process::Command {
    fn hidden(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

impl HiddenConsole for tokio::process::Command {
    fn hidden(&mut self) -> &mut Self {
        #[cfg(windows)]
        self.creation_flags(CREATE_NO_WINDOW);
        self
    }
}
