// Save a web article (a news story, a blog post) as markdown plus its images,
// for the Download tab and the AI Edit agent's `save_article` tool.
//
// The page is fetched over HTTP and parsed here; no browser is opened, so
// pages that build their text with JavaScript come back thin, which the
// result reports. The article body is found by known selectors of common
// news sites first, then by the element holding the most paragraph text.
// Lazy-loaded images are read from their data-src / srcset attributes.

use std::path::{Path, PathBuf};
use std::time::Duration;

use scraper::{ElementRef, Html, Node, Selector};
use serde::Serialize;

const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const MAX_IMAGES: usize = 60;
/// Smaller files are icons, spacers and tracking pixels.
const MIN_IMAGE_BYTES: usize = 4 * 1024;
/// Below this much body text the page most likely renders with JavaScript.
const THIN_TEXT: usize = 300;

/// Article bodies of sites whose markup is known, tried before the guess.
const BODY_SELECTORS: &[&str] = &[
    "[itemprop=\"articleBody\"]",
    ".fck_detail",          // VnExpress
    ".detail-cmain",        // Tuoi Tre
    ".singular-content",    // Dan Tri
    ".detail-content",
    ".article-body",
    ".article__body",
    ".article-content",
    ".entry-content",
    ".post-content",
    ".story-body",
];

/// Containers that are never part of the story.
const SKIP_TAGS: &[&str] = &[
    "script", "style", "noscript", "iframe", "form", "nav", "footer", "header", "aside", "button",
    "svg", "select", "template", "video", "audio",
];
const SKIP_HINTS: &[&str] = &[
    "related", "share", "social", "comment", "advert", "banner", "recommend", "newsletter",
    "breadcrumb", "sidebar", "subscribe", "tag-list", "tags", "author-box", "read-more", "box-tinlienquan",
];

#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Heading(String),
    Paragraph(String),
    Quote(String),
    ListItem(String),
    Image { src: String, alt: String, caption: String },
}

#[derive(Debug, Clone, Default)]
pub struct Article {
    pub title: String,
    pub site_name: String,
    pub author: String,
    pub published: String,
    pub description: String,
    pub lead_image: Option<String>,
    pub blocks: Vec<Block>,
}

impl Article {
    pub fn text_chars(&self) -> usize {
        self.blocks
            .iter()
            .map(|b| match b {
                Block::Heading(t) | Block::Paragraph(t) | Block::Quote(t) | Block::ListItem(t) => t.chars().count(),
                Block::Image { .. } => 0,
            })
            .sum()
    }
}

fn sel(s: &str) -> Selector {
    Selector::parse(s).expect("static selector")
}

fn clean(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn text_of(el: ElementRef) -> String {
    clean(&el.text().collect::<String>())
}

fn meta(doc: &Html, keys: &[&str]) -> String {
    for key in keys {
        let s = sel(&format!("meta[property=\"{k}\"], meta[name=\"{k}\"], meta[itemprop=\"{k}\"]", k = key));
        if let Some(v) = doc.select(&s).filter_map(|m| m.value().attr("content")).map(clean).find(|v| !v.is_empty()) {
            return v;
        }
    }
    String::new()
}

/// `href` resolved against the page URL; None for data URIs and the like.
fn absolute(base: &reqwest::Url, href: &str) -> Option<String> {
    let href = href.trim();
    if href.is_empty() || href.starts_with("data:") || href.starts_with("javascript:") {
        return None;
    }
    let url = base.join(href).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}

/// The widest candidate of a srcset ("a.jpg 320w, b.jpg 1024w").
fn largest_in_srcset(srcset: &str) -> Option<&str> {
    srcset
        .split(',')
        .filter_map(|part| {
            let mut it = part.split_whitespace();
            let url = it.next()?;
            let width = it
                .next()
                .and_then(|w| w.trim_end_matches(['w', 'x']).parse::<f64>().ok())
                .unwrap_or(0.0);
            Some((url, width))
        })
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(u, _)| u)
}

/// Where an <img> really points: lazy-load attributes win over `src`, which
/// is often a placeholder until the page's script swaps it.
fn image_src(img: ElementRef, base: &reqwest::Url) -> Option<String> {
    let v = img.value();
    let candidates = [
        v.attr("data-src"),
        v.attr("data-original"),
        v.attr("data-lazy-src"),
        v.attr("data-srcset").and_then(largest_in_srcset),
        v.attr("srcset").and_then(largest_in_srcset),
        v.attr("src"),
    ];
    let src = candidates.into_iter().flatten().find_map(|c| absolute(base, c))?;
    let lower = src.to_ascii_lowercase();
    if lower.ends_with(".svg") || lower.ends_with(".gif") || ["logo", "icon", "avatar", "sprite", "pixel", "blank"].iter().any(|w| lower.contains(w)) {
        return None;
    }
    // Explicitly tiny images are decorations.
    let small = |a: &str| v.attr(a).and_then(|n| n.trim_end_matches("px").parse::<u32>().ok()).is_some_and(|n| n < 120);
    if small("width") || small("height") {
        return None;
    }
    Some(src)
}

fn skipped(el: ElementRef) -> bool {
    let v = el.value();
    if SKIP_TAGS.contains(&v.name()) {
        return true;
    }
    let hints = format!("{} {}", v.attr("class").unwrap_or(""), v.attr("id").unwrap_or("")).to_ascii_lowercase();
    SKIP_HINTS.iter().any(|h| hints.contains(h))
}

/// Paragraph text directly under `el` (not nested deeper), which is how the
/// story's container stands out from the page around it.
fn paragraph_score(el: ElementRef, p: &Selector) -> usize {
    el.select(p)
        .filter(|para| para.parent().and_then(ElementRef::wrap).is_some_and(|parent| parent.id() == el.id()))
        .map(|para| text_of(para).chars().count())
        .filter(|n| *n >= 40)
        .sum()
}

/// The element holding the story.
fn find_body(doc: &Html) -> Option<ElementRef<'_>> {
    let p = sel("p");
    for s in BODY_SELECTORS {
        if let Some(el) = doc.select(&sel(s)).max_by_key(|el| el.select(&p).map(|x| text_of(x).len()).sum::<usize>()) {
            if el.select(&p).map(|x| text_of(x).chars().count()).sum::<usize>() >= 200 {
                return Some(el);
            }
        }
    }
    doc.select(&sel("article, main, section, div"))
        .filter(|el| !skipped(*el))
        .map(|el| (paragraph_score(el, &p), el))
        .filter(|(score, _)| *score > 0)
        .max_by_key(|(score, _)| *score)
        .map(|(_, el)| el)
}

/// Walk the body in document order, collecting text and images.
fn walk(el: ElementRef, base: &reqwest::Url, out: &mut Vec<Block>) {
    for child in el.children() {
        let Some(child) = ElementRef::wrap(child) else {
            // Loose text straight inside the body (sites that skip <p>).
            if let Node::Text(t) = child.value() {
                let t = clean(t);
                if t.chars().count() >= 40 {
                    out.push(Block::Paragraph(t));
                }
            }
            continue;
        };
        if skipped(child) {
            continue;
        }
        match child.value().name() {
            "img" => {
                if let Some(src) = image_src(child, base) {
                    let alt = clean(child.value().attr("alt").unwrap_or(""));
                    out.push(Block::Image { src, alt, caption: String::new() });
                }
            }
            "h1" | "h2" | "h3" | "h4" => {
                let t = text_of(child);
                if !t.is_empty() {
                    out.push(Block::Heading(t));
                }
            }
            "p" => {
                // Images sit inside paragraphs on many sites.
                let mut inner = Vec::new();
                for img in child.select(&sel("img")) {
                    if let Some(src) = image_src(img, base) {
                        inner.push(Block::Image { src, alt: clean(img.value().attr("alt").unwrap_or("")), caption: String::new() });
                    }
                }
                let t = text_of(child);
                out.extend(inner);
                if !t.is_empty() {
                    out.push(Block::Paragraph(t));
                }
            }
            "blockquote" => {
                let t = text_of(child);
                if !t.is_empty() {
                    out.push(Block::Quote(t));
                }
            }
            "li" => {
                let t = text_of(child);
                if !t.is_empty() {
                    out.push(Block::ListItem(t));
                }
            }
            "figcaption" => {
                let t = text_of(child);
                if let Some(Block::Image { caption, .. }) = out.iter_mut().rev().find(|b| matches!(b, Block::Image { .. })) {
                    if caption.is_empty() {
                        *caption = t;
                    }
                }
            }
            _ => walk(child, base, out),
        }
    }
}

/// Read the article out of a page's HTML.
pub fn extract(html: &str, page_url: &str) -> Article {
    let doc = Html::parse_document(html);
    let base = reqwest::Url::parse(page_url).unwrap_or_else(|_| reqwest::Url::parse("https://example.com/").unwrap());
    let mut article = Article {
        title: Some(meta(&doc, &["og:title", "twitter:title"]))
            .filter(|t| !t.is_empty())
            .or_else(|| doc.select(&sel("h1")).map(text_of).find(|t| !t.is_empty()))
            .or_else(|| doc.select(&sel("title")).map(text_of).next())
            .unwrap_or_default(),
        site_name: meta(&doc, &["og:site_name", "application-name"]),
        author: meta(&doc, &["author", "article:author", "dable:author"]),
        published: meta(&doc, &["article:published_time", "pubdate", "datePublished", "date"]),
        description: meta(&doc, &["og:description", "description", "twitter:description"]),
        lead_image: Some(meta(&doc, &["og:image", "twitter:image"])).and_then(|u| absolute(&base, &u)),
        blocks: Vec::new(),
    };
    if let Some(body) = find_body(&doc) {
        walk(body, &base, &mut article.blocks);
    }
    // The same picture is often repeated (a lazy copy, a lightbox copy).
    let mut seen = std::collections::HashSet::new();
    article.blocks.retain(|b| match b {
        Block::Image { src, .. } => seen.insert(src.clone()),
        _ => true,
    });
    // A paragraph that only repeats the headline or the lede adds nothing
    // (the lede is already written out above the body).
    let (title, lede) = (article.title.clone(), article.description.clone());
    article.blocks.retain(|b| !matches!(b, Block::Heading(t) | Block::Paragraph(t) if *t == title || *t == lede));
    article
}

/// The output folder name: the URL's own slug (news URLs carry an ASCII one),
/// else the host plus a timestamp.
fn folder_name(page_url: &str) -> String {
    let url = reqwest::Url::parse(page_url).ok();
    let last = url
        .as_ref()
        .and_then(|u| u.path_segments())
        .and_then(|segs| segs.filter(|s| !s.is_empty()).last().map(str::to_string))
        .unwrap_or_default();
    let stem = last.rsplit_once('.').map(|(a, _)| a.to_string()).unwrap_or(last);
    let slug: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let slug: String = slug.chars().take(80).collect();
    if slug.len() >= 3 {
        slug
    } else {
        let host = url.as_ref().and_then(|u| u.host_str()).unwrap_or("article").replace('.', "-");
        format!("{}-{}", host, chrono_stamp())
    }
}

fn chrono_stamp() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn extension_for(content_type: &str, url: &str) -> &'static str {
    let ct = content_type.to_ascii_lowercase();
    if ct.contains("png") {
        "png"
    } else if ct.contains("webp") {
        "webp"
    } else if ct.contains("avif") {
        "avif"
    } else if ct.contains("jpeg") || ct.contains("jpg") {
        "jpg"
    } else {
        let lower = url.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
        ["png", "webp", "avif", "jpeg"].into_iter().find(|e| lower.ends_with(&format!(".{}", e))).map(|e| if e == "jpeg" { "jpg" } else { e }).unwrap_or("jpg")
    }
}

fn markdown(article: &Article, url: &str, local: &dyn Fn(&str) -> Option<String>) -> String {
    let mut md = format!("# {}\n\n", article.title);
    let mut source = vec![format!("Source: {}", url)];
    for (label, value) in [("Site", &article.site_name), ("Author", &article.author), ("Published", &article.published)] {
        if !value.is_empty() {
            source.push(format!("{}: {}", label, value));
        }
    }
    md.push_str(&format!("> {}\n\n", source.join(" | ")));
    if !article.description.is_empty() {
        md.push_str(&format!("**{}**\n\n", article.description));
    }
    let has_images = article.blocks.iter().any(|b| matches!(b, Block::Image { .. }));
    if let (false, Some(lead)) = (has_images, &article.lead_image) {
        if let Some(path) = local(lead) {
            md.push_str(&format!("![]({})\n\n", path));
        }
    }
    for b in &article.blocks {
        match b {
            Block::Heading(t) => md.push_str(&format!("## {}\n\n", t)),
            Block::Paragraph(t) => md.push_str(&format!("{}\n\n", t)),
            Block::Quote(t) => md.push_str(&format!("> {}\n\n", t)),
            Block::ListItem(t) => md.push_str(&format!("- {}\n", t)),
            Block::Image { src, alt, caption } => {
                if let Some(path) = local(src) {
                    md.push_str(&format!("![{}]({})\n", alt.replace(['[', ']'], ""), path));
                    if !caption.is_empty() {
                        md.push_str(&format!("*{}*\n", caption));
                    }
                    md.push('\n');
                }
            }
        }
    }
    md
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleSnapshot {
    pub title: String,
    pub folder: String,
    pub markdown_path: String,
    pub images: Vec<String>,
    pub text_chars: usize,
    /// Things the user (or agent) should know: a thin page, images that failed.
    pub warnings: Vec<String>,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

/// Fetch `page_url`, save its article as `article.md` plus `images/` in a new
/// folder under `output_directory`, and say what was saved.
pub async fn snapshot(page_url: &str, output_directory: &Path) -> Result<ArticleSnapshot, String> {
    let client = client()?;
    let response = client
        .get(page_url)
        .header("Accept-Language", "vi,en;q=0.8")
        .send()
        .await
        .map_err(|e| format!("Could not open the page: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("The page answered HTTP {}", response.status().as_u16()));
    }
    let final_url = response.url().to_string();
    let html = response.text().await.map_err(|e| format!("Could not read the page: {}", e))?;
    let article = extract(&html, &final_url);

    let folder: PathBuf = output_directory.join(folder_name(&final_url));
    let images_dir = folder.join("images");
    tokio::fs::create_dir_all(&images_dir)
        .await
        .map_err(|e| format!("Could not create {}: {}", images_dir.display(), e))?;

    let mut wanted: Vec<String> = article
        .blocks
        .iter()
        .filter_map(|b| match b {
            Block::Image { src, .. } => Some(src.clone()),
            _ => None,
        })
        .collect();
    if wanted.is_empty() {
        wanted.extend(article.lead_image.clone());
    }
    let mut warnings = Vec::new();
    if wanted.len() > MAX_IMAGES {
        warnings.push(format!("Only the first {} of {} images were saved.", MAX_IMAGES, wanted.len()));
        wanted.truncate(MAX_IMAGES);
    }

    let mut saved: Vec<(String, String)> = Vec::new(); // (source URL, path relative to folder)
    let mut failed = 0;
    for src in &wanted {
        let result = async {
            let r = client.get(src).header("Referer", &final_url).send().await.map_err(|e| e.to_string())?;
            if !r.status().is_success() {
                return Err(format!("HTTP {}", r.status().as_u16()));
            }
            let ct = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            if !ct.is_empty() && !ct.starts_with("image/") {
                return Err(format!("not an image ({})", ct));
            }
            let bytes = r.bytes().await.map_err(|e| e.to_string())?;
            Ok((bytes, ct))
        }
        .await;
        match result {
            Ok((bytes, _)) if bytes.len() < MIN_IMAGE_BYTES => {}
            Ok((bytes, ct)) => {
                let name = format!("{:02}.{}", saved.len() + 1, extension_for(&ct, src));
                if tokio::fs::write(images_dir.join(&name), &bytes).await.is_ok() {
                    saved.push((src.clone(), format!("images/{}", name)));
                } else {
                    failed += 1;
                }
            }
            Err(_) => failed += 1,
        }
    }
    if failed > 0 {
        warnings.push(format!("{} image(s) could not be downloaded.", failed));
    }

    let text_chars = article.text_chars();
    if text_chars < THIN_TEXT {
        warnings.push(format!(
            "Only {} characters of text were found: this page probably builds its content with JavaScript, or is not an article.",
            text_chars
        ));
    }

    let local = |src: &str| saved.iter().find(|(s, _)| s == src).map(|(_, p)| p.clone());
    let md = markdown(&article, &final_url, &local);
    let md_path = folder.join("article.md");
    tokio::fs::write(&md_path, md).await.map_err(|e| format!("Could not write {}: {}", md_path.display(), e))?;
    if saved.is_empty() {
        let _ = tokio::fs::remove_dir(&images_dir).await;
    }

    Ok(ArticleSnapshot {
        title: article.title,
        folder: folder.to_string_lossy().to_string(),
        markdown_path: md_path.to_string_lossy().to_string(),
        images: saved.iter().map(|(_, p)| folder.join(p).to_string_lossy().to_string()).collect(),
        text_chars,
        warnings,
    })
}

#[tauri::command]
pub async fn article_snapshot(url: String, output_directory: String) -> Result<ArticleSnapshot, String> {
    snapshot(url.trim(), Path::new(&output_directory)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"<html><head>
        <title>Ignored | Site</title>
        <meta property="og:title" content="Fire on the wing">
        <meta property="og:site_name" content="VnExpress">
        <meta property="og:image" content="https://cdn.example.com/lead.jpg">
        <meta name="author" content="Reporter">
      </head><body>
        <header><img src="/logo.png"><nav><p>Home News Sports and more links here to skip</p></nav></header>
        <article class="fck_detail">
          <p class="description">A plane's engine caught fire just before take-off, passengers said on Monday.</p>
          <figure><img data-src="/img/a.jpg" src="data:image/gif;base64,R0lGOD" alt="The wing"><figcaption>The left wing, burning.</figcaption></figure>
          <h2>What happened</h2>
          <p>The crew stopped the take-off and the fire service reached the aircraft within two minutes of the call.</p>
          <p><img srcset="/img/b-320.jpg 320w, /img/b-1024.jpg 1024w"></p>
          <div class="box-tinlienquan"><p>Related: another story that should not be in the article body at all.</p></div>
          <ul><li>No one was hurt.</li></ul>
          <img src="/img/a.jpg">
          <img src="/img/tiny.jpg" width="40">
        </article>
        <footer><p>Copyright and other footer text that is long enough to look like a paragraph.</p></footer>
      </body></html>"#;

    #[test]
    fn reads_the_story_in_order() {
        let a = extract(PAGE, "https://vnexpress.net/fire-5134430.html");
        assert_eq!(a.title, "Fire on the wing");
        assert_eq!(a.site_name, "VnExpress");
        assert_eq!(a.author, "Reporter");
        assert_eq!(a.lead_image.as_deref(), Some("https://cdn.example.com/lead.jpg"));
        assert_eq!(
            a.blocks,
            vec![
                Block::Paragraph("A plane's engine caught fire just before take-off, passengers said on Monday.".into()),
                Block::Image { src: "https://vnexpress.net/img/a.jpg".into(), alt: "The wing".into(), caption: "The left wing, burning.".into() },
                Block::Heading("What happened".into()),
                Block::Paragraph("The crew stopped the take-off and the fire service reached the aircraft within two minutes of the call.".into()),
                Block::Image { src: "https://vnexpress.net/img/b-1024.jpg".into(), alt: String::new(), caption: String::new() },
                Block::ListItem("No one was hurt.".into()),
            ]
        );
    }

    #[test]
    fn guesses_the_body_without_known_markup() {
        let html = r#"<body><div id="menu"><p>Short</p></div>
            <div class="x"><p>First paragraph of a story that is long enough to count as text.</p>
            <p>Second paragraph of the same story, also long enough to count as text.</p></div></body>"#;
        let a = extract(html, "https://blog.example.com/post");
        assert_eq!(a.blocks.len(), 2);
        assert!(a.text_chars() > 100);
    }

    #[test]
    fn names_the_folder_from_the_url() {
        assert_eq!(
            folder_name("https://video.vnexpress.net/dong-co-phun-lua-5134430.html"),
            "dong-co-phun-lua-5134430"
        );
        assert!(folder_name("https://example.com/").starts_with("example-com-"));
    }

    #[test]
    fn writes_markdown_with_local_images() {
        let a = extract(PAGE, "https://vnexpress.net/fire-5134430.html");
        let md = markdown(&a, "https://vnexpress.net/fire-5134430.html", &|src: &str| {
            src.ends_with("a.jpg").then(|| "images/01.jpg".to_string())
        });
        assert!(md.starts_with("# Fire on the wing\n\n> Source: https://vnexpress.net/fire-5134430.html | Site: VnExpress"));
        assert!(md.contains("![The wing](images/01.jpg)\n*The left wing, burning.*"));
        assert!(!md.contains("b-1024"), "images that were not saved are left out");
    }

    /// Real pages: `ARTICLE_URLS="url1 url2" ARTICLE_OUT=/tmp/x cargo test -- --ignored live_pages --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_pages() {
        let out = std::env::var("ARTICLE_OUT").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string());
        for url in std::env::var("ARTICLE_URLS").unwrap_or_default().split_whitespace() {
            match snapshot(url, Path::new(&out)).await {
                Ok(s) => println!("OK {} | {} | {} chars | {} images | {:?}", url, s.title, s.text_chars, s.images.len(), s.warnings),
                Err(e) => println!("ERR {} | {}", url, e),
            }
        }
    }
}
