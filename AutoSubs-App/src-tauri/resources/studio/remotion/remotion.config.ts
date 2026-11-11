/**
 * Cấu hình CLI Remotion. Mọi lệnh chạy với cwd = remotion/ (core/tools/*.py tự làm việc này),
 * entry là projects/<id>/.build/entry.tsx và public dir là projects/<id>/.build/public.
 * Alias: @core/* → core/kit, @skill/<tên>/* → skills/<tên>/lib (mọi skill có lib/).
 */
import { Config } from "@remotion/cli/config";
import fs from "node:fs";
import path from "node:path";

Config.setRspack(true);
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setDefaultPremountInSeconds(2);
// GPU qua ANGLE cho cảnh 3D (bóng đổ, hậu kỳ); render phần mềm rất chậm.
Config.setChromiumOpenGlRenderer("angle");

const RUNTIME = process.cwd();
const ROOT = path.resolve(RUNTIME, "..");
const SKILLS = path.join(ROOT, "skills");
const ALIAS: Record<string, string> = { "@core": path.join(ROOT, "core/kit") };
for (const name of fs.existsSync(SKILLS) ? fs.readdirSync(SKILLS) : []) {
  const lib = path.join(SKILLS, name, "lib");
  if (fs.existsSync(lib)) ALIAS[`@skill/${name}`] = lib;
}
const MODULES = [path.join(RUNTIME, "node_modules"), "node_modules"];
Config.overrideRspackConfig((c) => ({
  ...c,
  resolve: { ...c.resolve, alias: { ...((c.resolve?.alias as object) ?? {}), ...ALIAS }, modules: MODULES },
}));

// Render bằng chrome-headless-shell tải kèm Remotion. Không dùng Chrome hệ thống: ở chế độ ẩn nó chụp khung
// trước khi GPU vẽ xong lớp nặng (filter #sh/#glow), làm vật thể/chữ 2D chớp mất ngẫu nhiên trong video xuất.
