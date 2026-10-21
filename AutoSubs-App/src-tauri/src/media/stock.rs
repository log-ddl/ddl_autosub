//! Stock footage search on Pexels and Pixabay: free to use, no watermark,
//! searched by what is in the picture (tags), unlike YouTube's titles. Both
//! need a free API key, set in Settings (or PEXELS_API_KEY / PIXABAY_API_KEY).
//! Hits carry a direct MP4 link that `download_media` fetches like any URL.

use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

/// The settings file and key the frontend's settings store persists to.
const STORE_FILE: &str = "autosubs-store.json";
const STORE_KEY: &str = "settings";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StockSite {
    Pexels,
    Pixabay,
}

impl StockSite {
    pub fn name(self) -> &'static str {
        match self {
            StockSite::Pexels => "Pexels",
            StockSite::Pixabay => "Pixabay",
        }
    }

    fn setting(self) -> (&'static str, &'static str) {
        match self {
            StockSite::Pexels => ("pexelsApiKey", "PEXELS_API_KEY"),
            StockSite::Pixabay => ("pixabayApiKey", "PIXABAY_API_KEY"),
        }
    }
}

/// The API key from Settings, else from the environment.
pub fn api_key(app: &AppHandle, site: StockSite) -> Option<String> {
    let (field, env) = site.setting();
    app.store(STORE_FILE)
        .ok()
        .and_then(|s| s.get(STORE_KEY))
        .and_then(|v| v.get(field).and_then(|k| k.as_str()).map(str::to_string))
        .or_else(|| std::env::var(env).ok())
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
}

#[derive(Clone, Debug, PartialEq)]
pub struct StockHit {
    pub site: StockSite,
    /// What the clip shows: Pexels' page slug, Pixabay's tags.
    pub title: String,
    pub author: Option<String>,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    /// Direct MP4 link, the one to download.
    pub file_url: String,
    pub page_url: String,
}

#[derive(Clone, Debug, Default)]
pub struct StockQuery {
    pub query: String,
    pub limit: usize,
    /// "landscape" | "portrait" | "square"
    pub orientation: Option<String>,
    pub min_duration: Option<f64>,
    pub max_duration: Option<f64>,
}

pub async fn search(app: &AppHandle, site: StockSite, q: &StockQuery) -> Result<Vec<StockHit>, String> {
    let key = api_key(app, site).ok_or_else(|| {
        format!("No {} API key. Ask the user to add one in Settings (it is free).", site.name())
    })?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    // Ask for more than needed: the length filter runs on our side.
    let per_page = (q.limit * 2).clamp(5, 80).to_string();
    let request = match site {
        StockSite::Pexels => {
            let mut params = vec![("query", q.query.clone()), ("per_page", per_page)];
            if let Some(o) = &q.orientation {
                params.push(("orientation", o.clone()));
            }
            client.get("https://api.pexels.com/videos/search").header("Authorization", key).query(&params)
        }
        // Pixabay's video API has no orientation filter; `fits` drops the
        // wrong shapes afterwards.
        StockSite::Pixabay => client.get("https://pixabay.com/api/videos/").query(&[
            ("key", key),
            ("q", q.query.clone()),
            ("per_page", per_page),
            ("safesearch", "true".into()),
        ]),
    };
    let resp = request.send().await.map_err(|e| format!("{} search failed: {}", site.name(), e))?;
    let status = resp.status();
    if !status.is_success() {
        // Pexels answers a bad key with 401, Pixabay with 400 "Invalid or missing API key".
        let body = resp.text().await.unwrap_or_default();
        if matches!(status.as_u16(), 401 | 403) || body.to_lowercase().contains("api key") {
            return Err(format!("{} rejected the API key. Ask the user to check it in Settings.", site.name()));
        }
        return Err(format!("{} search failed: HTTP {} {}", site.name(), status, body.trim()));
    }
    let data: Value = resp.json().await.map_err(|e| format!("Bad {} answer: {}", site.name(), e))?;
    let hits = match site {
        StockSite::Pexels => parse_pexels(&data),
        StockSite::Pixabay => parse_pixabay(&data),
    };
    Ok(hits.into_iter().filter(|h| fits(h, q)).take(q.limit).collect())
}

fn fits(h: &StockHit, q: &StockQuery) -> bool {
    if q.min_duration.is_some_and(|m| h.duration < m) || q.max_duration.is_some_and(|m| h.duration > m) {
        return false;
    }
    match q.orientation.as_deref() {
        Some("landscape") => h.width > h.height,
        Some("portrait") => h.height > h.width,
        Some("square") => h.width == h.height,
        _ => true,
    }
}

/// `https://www.pexels.com/video/aerial-view-of-a-city-at-night-856193/` becomes
/// "aerial view of a city at night".
fn pexels_title(page_url: &str) -> String {
    let slug = page_url.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    let words: Vec<&str> = slug.split('-').collect();
    let words = match words.split_last() {
        Some((last, rest)) if last.chars().all(|c| c.is_ascii_digit()) => rest,
        _ => &words[..],
    };
    let title = words.join(" ");
    if title.is_empty() { "untitled".into() } else { title }
}

/// The best file up to 4K, preferring 1080p-ish when there is one: 4K files
/// are huge and editors rarely need them for B-roll.
fn pick_pexels_file(files: &[Value]) -> Option<(&str, u32, u32)> {
    let mut best: Option<(&str, u32, u32)> = None;
    for f in files {
        if f.get("file_type").and_then(|t| t.as_str()) != Some("video/mp4") {
            continue;
        }
        let (Some(link), Some(w), Some(h)) = (
            f.get("link").and_then(|l| l.as_str()),
            f.get("width").and_then(|v| v.as_u64()).map(|v| v as u32),
            f.get("height").and_then(|v| v.as_u64()).map(|v| v as u32),
        ) else {
            continue;
        };
        let short = w.min(h);
        let score = |s: u32| if s <= 1080 { s as i64 } else { 1080 - (s as i64 - 1080) / 4 };
        if best.map_or(true, |(_, bw, bh)| score(short) > score(bw.min(bh))) {
            best = Some((link, w, h));
        }
    }
    best
}

fn parse_pexels(data: &Value) -> Vec<StockHit> {
    let videos = data.get("videos").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    videos
        .iter()
        .filter_map(|v| {
            let page_url = v.get("url")?.as_str()?.to_string();
            let files = v.get("video_files")?.as_array()?;
            let (link, w, h) = pick_pexels_file(files)?;
            Some(StockHit {
                site: StockSite::Pexels,
                title: pexels_title(&page_url),
                author: v.pointer("/user/name").and_then(|n| n.as_str()).map(String::from),
                duration: v.get("duration").and_then(|d| d.as_f64()).unwrap_or(0.0),
                width: w,
                height: h,
                file_url: link.to_string(),
                page_url,
            })
        })
        .collect()
}

fn parse_pixabay(data: &Value) -> Vec<StockHit> {
    let hits = data.get("hits").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    hits.iter()
        .filter_map(|v| {
            let videos = v.get("videos")?;
            // "large" is often empty (no 4K/1080 source); fall back down the sizes.
            let file = ["large", "medium", "small"].iter().find_map(|k| {
                let f = videos.get(*k)?;
                let url = f.get("url")?.as_str().filter(|u| !u.is_empty())?;
                Some((url, f.get("width")?.as_u64()? as u32, f.get("height")?.as_u64()? as u32))
            })?;
            Some(StockHit {
                site: StockSite::Pixabay,
                title: v.get("tags").and_then(|t| t.as_str()).unwrap_or("untitled").to_string(),
                author: v.get("user").and_then(|n| n.as_str()).map(String::from),
                duration: v.get("duration").and_then(|d| d.as_f64()).unwrap_or(0.0),
                width: file.1,
                height: file.2,
                file_url: file.0.to_string(),
                page_url: v.get("pageURL").and_then(|u| u.as_str()).unwrap_or_default().to_string(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn titles_pexels_clips_by_their_slug() {
        assert_eq!(
            pexels_title("https://www.pexels.com/video/aerial-view-of-a-city-at-night-856193/"),
            "aerial view of a city at night"
        );
        assert_eq!(pexels_title("https://www.pexels.com/video/856193/"), "untitled");
    }

    #[test]
    fn picks_a_1080p_pexels_file_over_4k() {
        let data = json!({ "videos": [{
            "url": "https://www.pexels.com/video/city-1/",
            "duration": 12,
            "user": { "name": "Ann" },
            "video_files": [
                { "file_type": "video/mp4", "link": "https://v/4k.mp4", "width": 3840, "height": 2160 },
                { "file_type": "video/mp4", "link": "https://v/hd.mp4", "width": 1920, "height": 1080 },
                { "file_type": "video/mp4", "link": "https://v/sd.mp4", "width": 640, "height": 360 }
            ]
        }]});
        let hits = parse_pexels(&data);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].file_url, "https://v/hd.mp4");
        assert_eq!(hits[0].title, "city");
        assert_eq!(hits[0].author.as_deref(), Some("Ann"));
    }

    #[test]
    fn falls_back_to_smaller_pixabay_files_and_filters() {
        let data = json!({ "hits": [
            { "tags": "forest, fog", "duration": 20, "user": "Bo", "pageURL": "https://pixabay.com/videos/x-1/",
              "videos": { "large": { "url": "", "width": 0, "height": 0 },
                          "medium": { "url": "https://p/m.mp4", "width": 1920, "height": 1080 } } },
            { "tags": "phone", "duration": 4, "videos": { "large": { "url": "https://p/l.mp4", "width": 1080, "height": 1920 } } }
        ]});
        let hits = parse_pixabay(&data);
        assert_eq!(hits[0].file_url, "https://p/m.mp4");
        let q = StockQuery { orientation: Some("landscape".into()), min_duration: Some(5.0), ..Default::default() };
        let kept: Vec<_> = hits.iter().filter(|h| fits(h, &q)).collect();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].title, "forest, fog");
    }
}
