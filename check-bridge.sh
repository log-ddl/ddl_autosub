#!/usr/bin/env bash
# Cho biết server Lua nào đang chạy trong Resolve: bản cũ hay bản có AutoEdit.
r=$(curl -s -m 5 -X POST http://127.0.0.1:56002/ \
      -H "Content-Type: application/json" \
      -d '{"func":"ResolveRpc","objectId":0,"method":"GetVersionString","args":[],"argCount":0}')

if [ -z "$r" ]; then
  echo "[X] Không kết nối được cổng 56002."
  echo "    -> Resolve chưa mở, hoặc chưa chạy script AutoSubs nào."
elif echo "$r" | grep -q '"result"'; then
  echo "[OK] Server AutoEdit đang chạy. Resolve trả về:"
  echo "     $r"
  echo "     -> Chạy được cả tab Built-in lẫn tab Import."
else
  echo "[!] Server Lua BẢN CŨ đang chạy (chưa có AutoEdit)."
  echo "    Nó trả về: $r"
  echo "    -> Vào Resolve: Workspace > Scripts > AutoSubs (Dev)"
fi
