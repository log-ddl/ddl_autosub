// A browser session whose cookies yt-dlp borrows, for YouTube, Instagram,
// Facebook, TikTok and the other sites in `SITES`.
//
// Without cookies YouTube answers yt-dlp with HTTP 429 and "Sign in to confirm
// you're not a bot" on many networks, and Instagram or Vimeo refuse almost
// everything. For sites where a visitor's cookies are enough (YouTube,
// TikTok), the app loads the site's home page in a hidden webview before the
// download and reads the cookies it got. For sites that want an account, the
// user signs in once through a visible window on the same cookie store, and
// every later download carries that account. The cookies reach yt-dlp as a
// Netscape cookie file (`--cookies`).
//
// All the sites share one cookie store of their own (a data directory, or a
// data store identifier on macOS), apart from the app's own webview storage.
// The webviews load remote content, so they are not in any capability and
// have no access to the app's commands.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::webview::{Cookie, PageLoadEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const SESSION_LABEL: &str = "site-session";
/// Fresh cookies are re-read after this long.
const CACHE_TTL: Duration = Duration::from_secs(30 * 60);
const LOAD_TIMEOUT: Duration = Duration::from_secs(25);
/// Fixed so every launch reopens the same macOS data store. (It predates the
/// other sites, hence the name; changing it would sign everyone out.)
const MAC_DATA_STORE: [u8; 16] = *b"autosubs-youtube";

/// A site the session knows how to sign in to.
#[derive(Debug)]
pub struct Site {
    /// Stable id the frontend passes back to open the sign-in window.
    pub key: &'static str,
    pub name: &'static str,
    /// Hosts the site's URLs and cookies live on (subdomains included).
    domains: &'static [&'static str],
    home: &'static str,
    login: &'static str,
    /// Whether loading the home page as a visitor already helps yt-dlp.
    warm: bool,
}

pub const SITES: &[Site] = &[
    Site {
        key: "youtube",
        name: "YouTube",
        domains: &["youtube.com", "youtu.be", "google.com"],
        home: "https://www.youtube.com/",
        login: "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F",
        warm: true,
    },
    Site {
        key: "tiktok",
        name: "TikTok",
        domains: &["tiktok.com"],
        home: "https://www.tiktok.com/",
        login: "https://www.tiktok.com/login",
        warm: true,
    },
    Site {
        key: "instagram",
        name: "Instagram",
        domains: &["instagram.com"],
        home: "https://www.instagram.com/",
        login: "https://www.instagram.com/accounts/login/",
        warm: false,
    },
    Site {
        key: "facebook",
        name: "Facebook",
        domains: &["facebook.com", "fb.watch", "fb.com"],
        home: "https://www.facebook.com/",
        login: "https://www.facebook.com/login/",
        warm: false,
    },
    Site {
        key: "x",
        name: "X (Twitter)",
        domains: &["x.com", "twitter.com"],
        home: "https://x.com/",
        login: "https://x.com/i/flow/login",
        warm: false,
    },
    Site {
        key: "pinterest",
        name: "Pinterest",
        domains: &["pinterest.com", "pin.it"],
        home: "https://www.pinterest.com/",
        login: "https://www.pinterest.com/login/",
        warm: false,
    },
    Site {
        key: "vimeo",
        name: "Vimeo",
        domains: &["vimeo.com"],
        home: "https://vimeo.com/",
        login: "https://vimeo.com/log_in",
        warm: false,
    },
];

fn host_matches(host: &str, domain: &str) -> bool {
    let host = host.trim_start_matches('.').to_ascii_lowercase();
    host == domain || host.ends_with(&format!(".{}", domain))
}

/// The host of a URL, without pulling in the `url` crate.
fn host_of(url: &str) -> String {
    let after_scheme = url.split("://").nth(1).unwrap_or(url);
    let authority = after_scheme.split(['/', '?', '#']).next().unwrap_or("");
    authority.rsplit('@').next().unwrap_or("").split(':').next().unwrap_or("").to_ascii_lowercase()
}

/// The site a URL belongs to. Pinterest's country domains (pinterest.co.uk,
/// pinterest.de, ...) count as Pinterest.
pub fn site_for_url(url: &str) -> Option<&'static Site> {
    let host = host_of(url);
    if host.split('.').any(|label| label == "pinterest") {
        return SITES.iter().find(|s| s.key == "pinterest");
    }
    SITES.iter().find(|s| s.domains.iter().any(|d| host_matches(&host, d)))
}

pub fn site_by_key(key: &str) -> Option<&'static Site> {
    SITES.iter().find(|s| s.key == key)
}

/// Whether a cookie belongs to `site` (or to any known site when `None`).
fn cookie_for(domain: &str, site: Option<&Site>) -> bool {
    let wanted = |s: &Site| {
        s.domains.iter().any(|d| host_matches(domain, d))
            || (s.key == "pinterest" && domain.split('.').any(|l| l == "pinterest"))
    };
    match site {
        Some(s) => wanted(s),
        None => SITES.iter().any(wanted),
    }
}

/// Every cookie in the store, as last read, plus which sites were warmed.
struct Cache {
    at: Instant,
    cookies: Vec<Cookie<'static>>,
    warmed: HashSet<&'static str>,
}

static CACHE: Lazy<Mutex<Option<Cache>>> = Lazy::new(|| Mutex::new(None));
/// One harvest at a time; a second caller waits and then uses the cache.
static HARVEST: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

/// A desktop browser user agent. Google and Instagram refuse sign-in from
/// user agents they do not recognise as a browser, which a bare WKWebView is.
fn user_agent() -> &'static str {
    if cfg!(target_os = "macos") {
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
    } else {
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"
    }
}

fn session_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("youtube-session"))
}

/// A webview on the sites' shared cookie store.
fn builder<'a>(
    app: &'a AppHandle,
    label: &'a str,
    url: &str,
) -> Result<WebviewWindowBuilder<'a, tauri::Wry, AppHandle>, String> {
    let url = url.parse().map_err(|e| format!("Bad URL {}: {}", url, e))?;
    let mut b = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .inner_size(1000.0, 760.0)
        .user_agent(user_agent());
    if cfg!(target_os = "macos") {
        b = b.data_store_identifier(MAC_DATA_STORE);
    } else {
        b = b.data_directory(session_dir(app)?);
    }
    Ok(b)
}

fn field(s: &str) -> String {
    s.replace(['\t', '\r', '\n'], "")
}

/// The cookies of `site` (all known sites when `None`) as a Netscape cookie
/// file, the format yt-dlp's `--cookies` reads.
fn netscape(cookies: &[Cookie<'static>], site: Option<&Site>) -> String {
    let mut out = String::from("# Netscape HTTP Cookie File\n");
    for c in cookies {
        let Some(domain) = c.domain().filter(|d| cookie_for(d, site)) else { continue };
        let domain = if domain.starts_with('.') { domain.to_string() } else { format!(".{}", domain) };
        let expires = c.expires_datetime().map(|t| t.unix_timestamp().max(0)).unwrap_or(0);
        out.push_str(&format!(
            "{}{}\tTRUE\t{}\t{}\t{}\t{}\t{}\n",
            if c.http_only().unwrap_or(false) { "#HttpOnly_" } else { "" },
            field(&domain),
            field(c.path().unwrap_or("/")),
            if c.secure().unwrap_or(false) { "TRUE" } else { "FALSE" },
            expires,
            field(c.name()),
            field(c.value()),
        ));
    }
    out
}

/// Read every cookie in the store through a hidden webview. With `warm_url`
/// it first loads that page and waits for it, so the visit's cookies count.
async fn harvest(app: &AppHandle, warm_url: Option<&str>) -> Result<Vec<Cookie<'static>>, String> {
    // Left over from a harvest that failed half-way: start clean.
    if let Some(stale) = app.get_webview_window(SESSION_LABEL) {
        let _ = stale.destroy();
    }
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let tx = Mutex::new(Some(tx));
    let window: WebviewWindow = builder(app, SESSION_LABEL, warm_url.unwrap_or("about:blank"))?
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .on_page_load(move |_w, payload| {
            if payload.event() == PageLoadEvent::Finished {
                if let Some(tx) = tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            }
        })
        .build()
        .map_err(|e| format!("Could not open the browser session: {}", e))?;
    if warm_url.is_some() {
        // A page that never reports done still leaves whatever cookies it got.
        let _ = tokio::time::timeout(LOAD_TIMEOUT, rx).await;
        // Sites set a few cookies from script right after load.
        tokio::time::sleep(Duration::from_millis(1500)).await;
    }
    let cookies = window.cookies().map_err(|e| format!("Could not read the session's cookies: {}", e));
    let _ = window.destroy();
    cookies
}

/// The store's cookies, read again when stale or when `site` wants a visit
/// it has not had yet.
async fn current_cookies(app: &AppHandle, site: Option<&'static Site>) -> Result<Vec<Cookie<'static>>, String> {
    // A batch can hold any site; YouTube is the one that fails without a visit.
    let warm = match site {
        Some(s) if s.warm => Some(s),
        Some(_) => None,
        None => site_by_key("youtube"),
    };
    let fresh = |cache: &Option<Cache>| {
        cache
            .as_ref()
            .filter(|c| c.at.elapsed() < CACHE_TTL)
            .filter(|c| warm.is_none_or(|s| c.warmed.contains(s.key)))
            .map(|c| c.cookies.clone())
    };
    if let Some(cookies) = fresh(&CACHE.lock().unwrap()) {
        return Ok(cookies);
    }
    let _guard = HARVEST.lock().await;
    // Another caller may have refreshed it while this one waited.
    if let Some(cookies) = fresh(&CACHE.lock().unwrap()) {
        return Ok(cookies);
    }
    let cookies = harvest(app, warm.map(|s| s.home)).await?;
    let mut cache = CACHE.lock().unwrap();
    let mut warmed = cache
        .as_ref()
        .filter(|c| c.at.elapsed() < CACHE_TTL)
        .map(|c| c.warmed.clone())
        .unwrap_or_default();
    if let Some(s) = warm {
        warmed.insert(s.key);
    }
    *cache = Some(Cache { at: Instant::now(), cookies: cookies.clone(), warmed });
    Ok(cookies)
}

/// Write the cookies yt-dlp needs for `site` (every known site when `None`,
/// for a batch) to `path`. Returns false when there are none, in which case
/// yt-dlp runs without cookies.
pub async fn write_cookie_file(app: &AppHandle, path: &Path, site: Option<&'static Site>) -> bool {
    let cookies = match current_cookies(app, site).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[site-session] {}", e);
            return false;
        }
    };
    let body = netscape(&cookies, site);
    if body.lines().count() <= 1 {
        return false;
    }
    tokio::fs::write(path, body).await.is_ok()
}

/// Forget the cached cookies so the next download reads them again (after a
/// sign-in, or when a site still refused the old ones).
pub fn invalidate() {
    *CACHE.lock().unwrap() = None;
}

/// A site's sign-in, as the frontend offers it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteLogin {
    pub key: String,
    pub name: String,
}

impl From<&Site> for SiteLogin {
    fn from(s: &Site) -> Self {
        SiteLogin { key: s.key.into(), name: s.name.into() }
    }
}

/// The sites the app can sign in to, for the Download tab's account menu.
#[tauri::command]
pub fn site_session_sites() -> Vec<SiteLogin> {
    SITES.iter().map(SiteLogin::from).collect()
}

/// Open a window to sign in to `site` on the shared cookie store. When it
/// closes, the cached cookies are dropped so the next download reads the
/// signed-in session.
#[tauri::command]
pub async fn site_session_login(app: AppHandle, site: String) -> Result<(), String> {
    let site = site_by_key(&site).ok_or_else(|| format!("Unknown site: {}", site))?;
    let label = format!("site-login-{}", site.key);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_focus();
        return Ok(());
    }
    let window = builder(&app, &label, site.login)?
        .title(format!("Sign in to {}", site.name))
        .build()
        .map_err(|e| format!("Could not open the {} sign-in window: {}", site.name, e))?;
    window.on_window_event(|event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            invalidate();
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_only_the_sites_cookies_in_netscape_format() {
        let yt = Cookie::build(("VISITOR_INFO1_LIVE", "abc"))
            .domain(".youtube.com")
            .path("/")
            .secure(true)
            .http_only(true)
            .build();
        let ig = Cookie::build(("sessionid", "s")).domain(".instagram.com").build();
        let other = Cookie::build(("sid", "x")).domain("example.com").build();
        let all = [yt, ig, other];

        let youtube = netscape(&all, site_by_key("youtube"));
        let lines: Vec<&str> = youtube.lines().collect();
        assert_eq!(lines[0], "# Netscape HTTP Cookie File");
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1], "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tVISITOR_INFO1_LIVE\tabc");

        // A batch gets every known site, never an unrelated one.
        let batch = netscape(&all, None);
        assert_eq!(batch.lines().count(), 3);
        assert!(!batch.contains("example.com"));
    }

    #[test]
    fn finds_the_site_of_a_url() {
        let key = |u: &str| site_for_url(u).map(|s| s.key);
        assert_eq!(key("https://youtu.be/abc"), Some("youtube"));
        assert_eq!(key("https://m.youtube.com/watch?v=1"), Some("youtube"));
        assert_eq!(key("https://www.instagram.com/reel/x/"), Some("instagram"));
        assert_eq!(key("https://fb.watch/abc/"), Some("facebook"));
        assert_eq!(key("https://twitter.com/a/status/1"), Some("x"));
        assert_eq!(key("https://www.pinterest.co.uk/pin/1/"), Some("pinterest"));
        assert_eq!(key("https://vm.tiktok.com/xyz/"), Some("tiktok"));
        assert_eq!(key("https://notyoutube.com/x"), None);
        assert_eq!(key("https://example.com/v.mp4"), None);
    }
}
