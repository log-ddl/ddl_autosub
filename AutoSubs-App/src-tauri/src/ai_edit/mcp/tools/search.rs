//! `search_media`: find footage to download. YouTube through yt-dlp's flat
//! search (titles and descriptions, the biggest library: events, people,
//! products), Pexels and Pixabay through their APIs (free stock B-roll,
//! searched by what is in the picture). Several queries in one call run at
//! once, since the agent CLIs run MCP calls one after another.

use base64::Engine;
use futures_util::future::join_all;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::ai_edit::mcp::tools::tool;
use crate::media::download as media_download;
use crate::media::stock::{self, StockHit, StockQuery, StockSite};

const MAX_QUERIES: usize = 10;
const DEFAULT_LIMIT: usize = 6;
const MAX_LIMIT: usize = 20;

pub fn tools() -> Vec<Value> {
    vec![tool(
        "search_media",
        "Search for footage to download. Sources: youtube (titles and descriptions; the place for real \
         events, people, places, products, news; often long compilations, watermarks and no reuse \
         rights unless license is \"cc\"), pexels and pixabay (free stock B-roll with no watermark, \
         matched on what is in the picture: city, forest, people working; need a free API key in \
         Settings). Default: every source that is set up. Each hit is one line with its length and the \
         link to pass to download_media. Pass several searches in queries (up to 10) in ONE call: they \
         run at once. Filters: minSec/maxSec on the clip length, orientation, and for YouTube license, \
         uploaded and sort.",
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" },
                "queries": {
                    "type": "array",
                    "maxItems": MAX_QUERIES,
                    "items": { "type": "string" },
                    "description": "Several searches at once, instead of query"
                },
                "sources": {
                    "type": "array",
                    "items": { "type": "string", "enum": ["youtube", "pexels", "pixabay"] },
                    "description": "Default: all that are set up"
                },
                "limit": { "type": "integer", "description": "Hits per source and query (default 6, max 20)" },
                "minSec": { "type": "number", "description": "Shortest clip length, seconds" },
                "maxSec": { "type": "number", "description": "Longest clip length, seconds" },
                "orientation": { "type": "string", "enum": ["landscape", "portrait", "square"] },
                "license": { "type": "string", "enum": ["any", "cc"], "description": "YouTube: cc = Creative Commons only" },
                "uploaded": { "type": "string", "enum": ["hour", "today", "week", "month", "year"], "description": "YouTube: uploaded within" },
                "sort": { "type": "string", "enum": ["relevance", "date", "views", "rating"], "description": "YouTube order (default relevance)" }
            }
        }),
    )]
}

pub async fn call(app: &AppHandle, name: &str, args: &Value) -> Option<Result<String, String>> {
    if name != "search_media" {
        return None;
    }
    Some(search(app, args).await)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Source {
    Youtube,
    Stock(StockSite),
}

impl Source {
    fn name(self) -> &'static str {
        match self {
            Source::Youtube => "YouTube",
            Source::Stock(s) => s.name(),
        }
    }
}

#[derive(Clone, Debug, Default)]
struct Options {
    limit: usize,
    min_sec: Option<f64>,
    max_sec: Option<f64>,
    orientation: Option<String>,
    cc_only: bool,
    uploaded: Option<String>,
    sort: Option<String>,
}

fn str_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

async fn search(app: &AppHandle, args: &Value) -> Result<String, String> {
    let mut queries: Vec<String> = args
        .get("queries")
        .and_then(|v| v.as_array())
        .map(|list| list.iter().filter_map(|q| q.as_str()).map(str::trim).filter(|q| !q.is_empty()).map(String::from).collect())
        .unwrap_or_default();
    if queries.is_empty() {
        queries.extend(str_arg(args, "query"));
    }
    if queries.is_empty() {
        return Err("Pass query (or queries).".into());
    }
    if queries.len() > MAX_QUERIES {
        return Err(format!("search_media takes at most {} queries; split them over several calls.", MAX_QUERIES));
    }
    let opts = Options {
        limit: args.get("limit").and_then(|v| v.as_u64()).map_or(DEFAULT_LIMIT, |l| l as usize).clamp(1, MAX_LIMIT),
        min_sec: args.get("minSec").and_then(|v| v.as_f64()),
        max_sec: args.get("maxSec").and_then(|v| v.as_f64()),
        orientation: str_arg(args, "orientation"),
        cc_only: str_arg(args, "license").as_deref() == Some("cc"),
        uploaded: str_arg(args, "uploaded"),
        sort: str_arg(args, "sort"),
    };

    let requested: Option<Vec<String>> = args
        .get("sources")
        .and_then(|v| v.as_array())
        .map(|l| l.iter().filter_map(|s| s.as_str()).map(|s| s.to_ascii_lowercase()).collect())
        .filter(|l: &Vec<String>| !l.is_empty());
    let mut sources = Vec::new();
    let mut notes = Vec::new();
    for (key, source) in [
        ("youtube", Source::Youtube),
        ("pexels", Source::Stock(StockSite::Pexels)),
        ("pixabay", Source::Stock(StockSite::Pixabay)),
    ] {
        if requested.as_ref().is_some_and(|r| !r.iter().any(|s| s == key)) {
            continue;
        }
        let ready = match source {
            Source::Youtube => media_download::is_installed(app),
            Source::Stock(site) => stock::api_key(app, site).is_some(),
        };
        if ready {
            sources.push(source);
        } else {
            notes.push(match source {
                Source::Youtube => {
                    "YouTube: the downloader is not installed; ask the user to open the Download tab once.".to_string()
                }
                Source::Stock(site) => format!("{}: no API key; ask the user to add a free one in Settings.", site.name()),
            });
        }
    }
    if sources.is_empty() {
        return Err(notes.join("\n"));
    }

    let jobs = queries.iter().map(|q| search_query(app, q.clone(), sources.clone(), opts.clone()));
    let blocks: Vec<String> = join_all(jobs).await;
    let mut out = blocks.join("\n\n");
    if !notes.is_empty() {
        out.push_str("\n\n");
        out.push_str(&notes.join("\n"));
    }
    Ok(out)
}

/// One query on every source at once, as a block of numbered lines.
async fn search_query(app: &AppHandle, query: String, sources: Vec<Source>, opts: Options) -> String {
    let jobs = sources.iter().map(|&source| {
        let (query, opts) = (query.clone(), opts.clone());
        async move { (source, search_source(app, source, &query, &opts).await) }
    });
    let results = join_all(jobs).await;
    let mut lines = vec![format!("\"{}\":", query)];
    let mut n = 0;
    for (source, result) in results {
        match result {
            Ok(hits) if hits.is_empty() => lines.push(format!("  {}: nothing found", source.name())),
            Ok(hits) => {
                for hit in hits {
                    n += 1;
                    lines.push(format!("  {}. [{}] {}", n, source.name(), hit));
                }
            }
            Err(e) => lines.push(format!("  {}: FAILED: {}", source.name(), e.replace('\n', " "))),
        }
    }
    lines.join("\n")
}

async fn search_source(app: &AppHandle, source: Source, query: &str, opts: &Options) -> Result<Vec<String>, String> {
    match source {
        Source::Youtube => {
            let url = youtube_results_url(query, opts);
            // Over-fetch: channels, shorts and lengths outside the range are dropped here.
            let hits = media_download::search_youtube(app, &url, opts.limit * 2).await?;
            Ok(hits
                .into_iter()
                .filter(|h| within(h.duration, opts))
                .take(opts.limit)
                .map(|h| {
                    let mut line = format!("\"{}\"", h.title);
                    if let Some(c) = h.channel.filter(|c| !c.is_empty()) {
                        line.push_str(&format!(" by {}", c));
                    }
                    if let Some(d) = h.duration {
                        line.push_str(&format!(", {}", fmt_len(d)));
                    }
                    if let Some(v) = h.views {
                        line.push_str(&format!(", {} views", fmt_count(v)));
                    }
                    line.push_str(&format!(". https://www.youtube.com/watch?v={}", h.id));
                    line
                })
                .collect())
        }
        Source::Stock(site) => {
            let q = StockQuery {
                query: query.to_string(),
                limit: opts.limit,
                orientation: opts.orientation.clone(),
                min_duration: opts.min_sec,
                max_duration: opts.max_sec,
            };
            Ok(stock::search(app, site, &q).await?.iter().map(stock_line).collect())
        }
    }
}

fn stock_line(h: &StockHit) -> String {
    let mut line = format!("\"{}\"", h.title);
    if let Some(a) = h.author.as_deref().filter(|a| !a.is_empty()) {
        line.push_str(&format!(" by {}", a));
    }
    line.push_str(&format!(", {}, {}x{}, free to use. {}", fmt_len(h.duration), h.width, h.height, h.file_url));
    line
}

fn within(duration: Option<f64>, opts: &Options) -> bool {
    let Some(d) = duration else {
        // Live streams and some shorts have no length in the flat listing.
        return opts.min_sec.is_none() && opts.max_sec.is_none();
    };
    !(opts.min_sec.is_some_and(|m| d < m) || opts.max_sec.is_some_and(|m| d > m))
}

/// A YouTube results page URL whose `sp` parameter carries the filters. `sp`
/// is a protobuf: field 1 the sort order, field 2 a filter message (1 upload
/// date, 2 type, 3 length, 6 Creative Commons).
fn youtube_results_url(query: &str, opts: &Options) -> String {
    let mut filters: Vec<u8> = vec![0x10, 0x01]; // type: video (no channels, playlists)
    if let Some(v) = opts.uploaded.as_deref().and_then(|u| match u {
        "hour" => Some(1),
        "today" => Some(2),
        "week" => Some(3),
        "month" => Some(4),
        "year" => Some(5),
        _ => None,
    }) {
        filters.extend([0x08, v]);
    }
    // YouTube's own length buckets: under 4 min, 4 to 20, over 20.
    let length = match (opts.min_sec, opts.max_sec) {
        (_, Some(max)) if max <= 240.0 => Some(1),
        (Some(min), _) if min >= 1200.0 => Some(2),
        (Some(min), Some(max)) if min >= 240.0 && max <= 1200.0 => Some(3),
        _ => None,
    };
    if let Some(v) = length {
        filters.extend([0x18, v]);
    }
    if opts.cc_only {
        filters.extend([0x30, 0x01]);
    }
    let mut sp: Vec<u8> = Vec::new();
    if let Some(v) = opts.sort.as_deref().and_then(|s| match s {
        "rating" => Some(1),
        "date" => Some(2),
        "views" => Some(3),
        _ => None,
    }) {
        sp.extend([0x08, v]);
    }
    sp.push(0x12);
    sp.push(filters.len() as u8);
    sp.extend(filters);
    let sp = base64::engine::general_purpose::STANDARD.encode(sp);
    format!(
        "https://www.youtube.com/results?search_query={}&sp={}",
        urlencode(query),
        urlencode(&sp)
    )
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn fmt_len(secs: f64) -> String {
    let s = secs.round() as u64;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}

fn fmt_count(n: u64) -> String {
    match n {
        0..=999 => n.to_string(),
        1_000..=999_999 => format!("{:.0}k", n as f64 / 1e3),
        _ => format!("{:.1}M", n as f64 / 1e6),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sp_of(url: &str) -> Vec<u8> {
        let sp = url.split("&sp=").nth(1).unwrap().replace("%3D", "=").replace("%2B", "+").replace("%2F", "/");
        base64::engine::general_purpose::STANDARD.decode(sp).unwrap()
    }

    #[test]
    fn builds_youtube_filters() {
        let plain = youtube_results_url("drone city night", &Options::default());
        assert!(plain.starts_with("https://www.youtube.com/results?search_query=drone+city+night&sp="));
        // The same `sp` YouTube's own "Type: Video" filter makes.
        assert!(plain.ends_with("sp=EgIQAQ%3D%3D"));

        let opts = Options {
            cc_only: true,
            uploaded: Some("week".into()),
            sort: Some("date".into()),
            max_sec: Some(120.0),
            ..Default::default()
        };
        assert_eq!(
            sp_of(&youtube_results_url("x", &opts)),
            vec![0x08, 0x02, 0x12, 0x08, 0x10, 0x01, 0x08, 0x03, 0x18, 0x01, 0x30, 0x01]
        );
    }

    #[test]
    fn keeps_lengths_in_range() {
        let opts = Options { min_sec: Some(5.0), max_sec: Some(60.0), ..Default::default() };
        assert!(within(Some(30.0), &opts));
        assert!(!within(Some(3600.0), &opts));
        assert!(!within(None, &opts));
        assert!(within(None, &Options::default()));
    }

    #[test]
    fn formats_lengths_and_counts() {
        assert_eq!(fmt_len(17.0), "0:17");
        assert_eq!(fmt_len(3927.0), "1:05:27");
        assert_eq!(fmt_count(804_496), "804k");
        assert_eq!(fmt_count(1_250_000), "1.2M");
        assert_eq!(urlencode("cà phê"), "c%C3%A0+ph%C3%AA");
    }
}
