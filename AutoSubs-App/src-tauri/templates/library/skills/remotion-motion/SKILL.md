---
name: remotion-motion
description: Làm motion graphic bằng Remotion (title, lower third, callout, số liệu, bản đồ, 3D, caption động, chuyển cảnh, hiệu ứng, nền động) rồi render ra video để đặt lên timeline. Đọc trước khi viết bất kỳ cảnh Remotion nào: có mọi thư viện Remotion, skill và tài liệu chính thức của Remotion, và cách xem trước bằng contact sheet.
---
# Motion graphic bằng Remotion

Bạn viết code cảnh, tool lo cài đặt và render. Kit dùng chung đã cài sẵn MỌI thư viện Remotion dùng được trong một cảnh (bảng dưới), project nào cũng link tới nó. Không tự chạy npm, pnpm, npx, bun hay remotion.

## Tài liệu chính thức của Remotion (cùng phiên bản với kit)

Thư mục `reference/` nằm cạnh file SKILL.md này (cùng thư mục):

- `reference/skills/`: bộ skill Remotion viết cho AI agent. Bắt đầu từ `reference/skills/remotion-markup/SKILL.md` (cách viết cảnh, mỗi chủ đề một file: `3d.md`, `transitions.md`, `text-highlights.md`, `light-leaks.md`, `lottie.md`, `google-fonts.md`, `audio-visualization.md`, `effects.md`, `timing.md`...). Bản đồ: `reference/skills/remotion-maps/SKILL.md`. Caption: `reference/skills/remotion-captions/SKILL.md`.
- `reference/docs/`: toàn bộ tài liệu Remotion dạng `.mdx`, mỗi gói một thư mục (`reference/docs/transitions/`, `reference/docs/three.mdx`, `reference/docs/effects/`, `reference/docs/rough-notation/`...). Không chắc một API nhận gì thì tìm (grep) trong đây thay vì đoán.

Skill của Remotion viết cho người tự dựng project, nên trong AutoSubs bỏ qua các phần sau:
- Tạo project mới (`npx create-video`), cài gói (`npx remotion add`, `npm i`): đã có starter và kit.
- `npx remotion render` / `still` / `studio`, Lambda, Cloud Run, SaaS, Player: dùng `preview_motion` và `render_motion`.
- Tailwind, Skia: kit không bật được.
- Tìm docs trên web: đã có `reference/docs/` ở máy.

Nếu thư mục `reference/` chưa có (máy chưa có git, hoặc kit đang cài lần đầu) thì làm theo phần dưới đây là đủ.

## Quy trình

1. Chép `templates/motion-graphics/remotion-starter` (đường dẫn đầy đủ có trong system prompt hoặc `get_project_context`) sang `motion-graphics/<tên>` của project. Một cảnh một thư mục, tên ngắn không dấu (`intro-title`, `stat-gdp`).
2. Sửa `src/Scene.tsx` (nội dung) và `src/Root.tsx` (kích thước, fps, độ dài, `defaultProps`). Có thể thêm file trong `src/`. Ảnh, video, nhạc, font, Lottie JSON đặt trong `public/` của project và gọi bằng `staticFile("ten-file.png")`.
3. `preview_motion` rồi MỞ contact sheet ra xem. Kiểm tra: chữ có tràn hay bị cắt, có nằm trong vùng an toàn (cách mép khoảng 5%), các phần có đè lên nhau, cỡ chữ đọc được trên điện thoại, màu có tương phản với footage, chuyển động qua các mốc thời gian có hợp lý. Sai thì sửa code và preview lại. Cần nhìn kỹ một khoảnh khắc thì truyền `atSec` 1 đến 2 mốc để có tile lớn.
4. Chỉ khi sheet đã ổn mới `render_motion`. Overlay đè lên footage để `transparent: true` (mặc định, ProRes 4444 có alpha); card full khung có nền để `false` (H.264 nhẹ hơn nhiều).
5. Đặt file trong `exports/` bằng `build_storyboard`, đúng giây cần xuất hiện.

Thay chữ hay số mà không đổi bố cục thì truyền `props` cho cả `preview_motion` và `render_motion`, không cần sửa code. Nhiều biến thể của một mẫu = một project, nhiều lần render với `props` và `output` khác nhau.

## Khung hình

- Mặc định 1920x1080, 30 fps. Video dọc (TikTok, Reels, Shorts) là 1080x1920. Theo đúng timeline đang dựng nếu biết.
- Độ dài = `durationInFrames / fps`. Muốn độ dài theo props thì dùng `calculateMetadata` của `<Composition>`:

```tsx
<Composition id="Main" component={Scene} fps={30} width={1920} height={1080}
  durationInFrames={150} defaultProps={{ title: "…", seconds: 5 }}
  calculateMetadata={({ props }) => ({ durationInFrames: Math.round(props.seconds * 30) })} />
```

- Overlay: để nền trong suốt (không đặt `backgroundColor` cho `AbsoluteFill` ngoài cùng). Trên sheet, vùng trong suốt hiện ô caro xám.
- WebGL (3D, light leak, effects, Lottie canvas) chạy được: render dùng `--gl=angle`.

## Ràng buộc kỹ thuật khi render

Gói `remotion` (gói chính) có đủ mọi API trong `reference/docs/`. Remotion chụp từng frame riêng lẻ, nên chỉ cần giữ mấy điều sau:

- Mọi chuyển động tính từ `useCurrentFrame()`. CSS animation, CSS transition, `setTimeout`, `requestAnimationFrame` không chạy đúng khi render.
- Ngẫu nhiên dùng `random("seed")` của Remotion, không dùng `Math.random` (mỗi frame sẽ ra một giá trị khác).
- `interpolate` nên kèm `extrapolateLeft/Right: "clamp"` để giá trị không vượt ra ngoài khoảng.
- Ảnh, video, âm thanh dùng `<Img>`, `<OffthreadVideo>` (hoặc `<Video>` của `@remotion/media`), `<Audio>` để Remotion chờ tải xong trước khi chụp frame.

## Thư viện có sẵn trong kit

| Gói | Dùng khi | Gọi (chi tiết: `reference/docs/<gói>/`) |
| :--- | :--- | :--- |
| `@remotion/google-fonts` | Mọi chữ cần font đẹp. Tiếng Việt: BeVietnamPro, Inter, Montserrat, Roboto, Nunito, Lexend | `import { loadFont } from "@remotion/google-fonts/BeVietnamPro"; const { fontFamily } = loadFont("normal", { weights: ["400", "800"], subsets: ["vietnamese", "latin"] });` gọi ở ngoài component |
| `@remotion/fonts` | Font riêng trong `public/` | `loadFont({ family, url: staticFile("x.woff2"), weight })` |
| `@remotion/layout-utils` | Chữ dài không biết trước (props): tự co cho vừa | `fitText({ text, withinWidth, fontFamily, fontWeight }).fontSize`, `fitTextOnNLines({ text, maxLines, maxBoxWidth, fontFamily, fontWeight, maxFontSize })` trả `{ fontSize, lines }`, `measureText(...)` |
| `@remotion/transitions` | Nhiều cảnh nối nhau có chuyển cảnh | `<TransitionSeries>` với `<TransitionSeries.Sequence durationInFrames>` xen `<TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: 15 })} />`. Hiệu ứng: `fade`, `slide({ direction: "from-left" })`, `wipe`, `flip`, `clockWipe({ width, height })`, `iris({ width, height })`, import từ `@remotion/transitions/<tên>`. Tổng độ dài = tổng các sequence trừ độ dài các transition |
| `@remotion/animation-utils` | Ghép transform gọn, nội suy cả object style | `transform: makeTransform([translateY(y), scale(s), rotate(r)])`, `interpolateStyles(frame, [0, 20], [{ opacity: 0 }, { opacity: 1 }])` |
| `@remotion/gsap` + `gsap` | Quen viết timeline GSAP | `useGsapTimeline(...)`, xem `reference/docs/gsap/` |
| `@remotion/shapes` | Khối, nhãn, huy hiệu, mũi tên, khung chú thích | `<Rect width height cornerRadius fill />`, `<Circle radius />`, `<Triangle length direction />`, `<Star points innerRadius outerRadius />`, `<Arrow length headWidth shaftWidth direction />`, `<Callout />`, `<Pie progress radius />` (vòng tiến độ) |
| `@remotion/paths` | Đường vẽ dần (gạch chân, khoanh tròn, đường đi, biểu đồ đường) | `const { strokeDasharray, strokeDashoffset } = evolvePath(progress, d)` gắn vào `<path>`; `getLength`, `getPointAtLength` (vật chạy theo đường), `interpolatePath` (biến hình) |
| `@remotion/rough-notation` | Khoanh, gạch chân, highlight kiểu vẽ tay quanh chữ | `<Circle>`, `<Underline>`, `<Highlight>`, `<Box>`, `<CrossedOff>`, xem `reference/docs/rough-notation/` |
| `@remotion/rounded-text-box` | Nền bo tròn ôm sát từng dòng chữ (caption TikTok, highlight) | `createRoundedTextBox({ textMeasurements, textAlign: "center", horizontalPadding, borderRadius })` trả `{ d, boundingBox }`; `textMeasurements` lấy từ `measureText` từng dòng |
| `@remotion/svg-3d-engine` | Chữ hoặc hình SVG đùn nổi 3D | xem `reference/skills/remotion-markup/3d.md` |
| `@remotion/three` + `three` + `@react-three/fiber` | 3D thật: vật thể, ánh sáng, bóng, camera bay | `<ThreeCanvas width height camera={{ position: [0, 1, 6], fov: 45 }} shadows>` chứa `<mesh>`, `<ambientLight>`, `<directionalLight castShadow>`; xoay theo `frame`, không dùng `useFrame` của R3F. Xem `reference/skills/remotion-markup/3d.md` |
| `@remotion/effects` | Hiệu ứng cho component canvas: `cornerPin` (ghép hình vào mặt phẳng nghiêng), `linearGradient`, `linearGradientTint`, `pattern`, `rings`, `tile`, `zigzag`, `gridlines`, `checkerboard` | truyền qua prop `effects`, xem `reference/docs/effects/` và `reference/skills/remotion-markup/effects.md` |
| `@remotion/noise` | Chuyển động tự nhiên: trôi nhẹ, rung máy, hạt bay | `noise2D("seed", x, frame / 60)` trả -1..1 (`noise3D`, `noise4D`) |
| `@remotion/motion-blur` | Chữ hoặc vật bay nhanh trông mượt | `<CameraMotionBlur shutterAngle={180} samples={10}>`, `<Trail layers={6} lagInFrames={0.5} trailOpacity={0.6}>`. Render chậm theo `samples` |
| `@remotion/light-leaks` | Vệt sáng chuyển cảnh kiểu phim | `<LightLeak seed={3} hueShift={30} durationInFrames={30} />` |
| `@remotion/starburst` | Nền tia sáng xoay (giật tít, quà tặng, giảm giá) | `<Starburst rays={16} colors={["#ffcc00", "#ff8800"]} rotation={frame} />` |
| `@remotion/animated-emoji` | Emoji động của Google | `<AnimatedEmoji emoji="fire" />` |
| `@remotion/mac-cursors` | Con trỏ chuột macOS cho cảnh demo phần mềm | xem `reference/docs/mac-cursors/` |
| `@remotion/captions` | Caption hiện từng chữ theo giọng nói | `createTikTokStyleCaptions({ captions, combineTokensWithinMilliseconds: 800 })` trả `pages` (mỗi page có `startMs`, `durationMs`, `tokens` với `fromMs`/`toMs`). `captions` là mảng `{ text, startMs, endMs, timestampMs, confidence }` dựng từ word timing của `get_transcript`, truyền qua `props` |
| `@remotion/lottie` + `lottie-web` | Icon hoặc animation Lottie (LottieFiles) | `import data from "./anim.json"; <Lottie animationData={data} loop />` |
| `@remotion/rive` | Animation Rive (`.riv`) | `<RemotionRiveCanvas src={staticFile("x.riv")} />` |
| `@remotion/gif` | GIF chạy đúng nhịp frame | `<Gif src={staticFile("x.gif")} width height fit="cover" />` |
| `@remotion/media` | Thẻ `<Video>`/`<Audio>` mới (WebCodecs), cắt `trimBefore`/`trimAfter` | xem `reference/docs/media/` |
| `@remotion/media-utils` | Sóng âm, visualizer theo nhạc | `useWindowedAudioData` / `useAudioData(staticFile("nhac.mp3"))` + `visualizeAudio({ audioData, frame, fps, numberOfSamples: 32 })` |
| `@remotion/sfx` | Hiệu ứng âm thanh có sẵn: `whoosh`, `whip`, `ding`, `mouseClick`, `pageTurn`, `uiSwitch`, `shutterModern`, `recordScratch`, `vineBoom`... | `import { whoosh } from "@remotion/sfx"; <Audio src={whoosh} />`, xem `reference/skills/remotion-markup/sfx.md` |
| `@remotion/maptiler` | Bản đồ vector động (cần API key MapTiler) | xem `reference/skills/remotion-maps/SKILL.md`; không có key thì vẽ bản đồ SVG tĩnh + `paths` |
| `@remotion/preload`, `@remotion/media-parser`, `@remotion/webcodecs`, `@remotion/zod-types` + `zod` | Tải trước tài nguyên, đọc thông số file media, kiểu cho props | xem `reference/docs/` |

Lỗi render trả về vài chục dòng cuối của Remotion: đọc dòng lỗi TypeScript hay import, sửa file đó rồi preview lại.
