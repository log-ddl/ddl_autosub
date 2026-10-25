# AutoSubs


Dùng độc lập, hoặc nối với Adobe Premiere Pro (phụ đề, AI Edit, motion graphics bằng Remotion).


## Build

Cần cài trước: Node.js, Rust, LLVM, và Visual Studio Build Tools kèm workload C++. Riêng Windows muốn tăng tốc GPU thì cần thêm Vulkan SDK. Xem [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
cd AutoSubs-App
npm install
npm run dev:win        # chạy thử
npm run build:win      # tạo bộ cài
```

macOS và Linux đổi thành `dev:mac:arm64`, `dev:linux`, `build:mac:arm64`, `build:linux`.

## Giấy phép

MIT, bản quyền gốc thuộc Tom Moroney. Xem [LICENSE](LICENSE).
