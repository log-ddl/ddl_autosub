// Tài sản gọi theo mã trong assets/ASSETS.json: asset('a012'). Viết mã dạng chuỗi hằng để build quét được,
// và chỉ gọi bên trong component (sổ được nạp trước khi cảnh chạy, không phải lúc import).
import { staticFile } from 'remotion';

export type AssetInfo = { file: string; kind: string; width?: number; height?: number; duration?: number; tags?: string[] };

const REG: Record<string, AssetInfo> = {};

/** .build/assets.ts gọi một lần, trước mọi cảnh. */
export const registerAssets = (m: Record<string, AssetInfo>) => Object.assign(REG, m);

export const assetInfo = (id: string): AssetInfo => {
  const a = REG[id];
  if (!a) throw new Error(`tài sản ${id} chưa có trong .build (kiểm assets/ASSETS.json rồi chạy build)`);
  return a;
};

/** Đường dẫn dùng cho <Img>, <Video>, <Audio>. */
export const asset = (id: string) => staticFile(assetInfo(id).file);
