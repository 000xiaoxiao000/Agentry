#!/usr/bin/env bash
# 构建可分发的 release 版本。
#
# ---------- 关键：必须带 --features custom-protocol ----------
#
# tauri-macros 里是 `dev: cfg!(not(feature = "custom-protocol"))`：
#   - 开了这个 feature → dev=false → 前端资源（dist/）**嵌进二进制**，双击即用
#   - 没开           → dev=true  → 运行时去连 devUrl http://localhost:5173
#
# 没开的话，release 二进制启动后就是一个**白屏窗口一直等**（本机没有 vite dev server）。
# 这个坑很隐蔽：编译不报错、二进制也能跑，就是白屏。
# 所以本脚本在构建后**自检**前端有没有真的嵌进去，嵌不上直接报错。
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
# 外置盘上的 cargo 缓存（registry 依赖都在那儿）
if [ -d /Volumes/EAGET/dev-home/cargo ]; then
  export CARGO_HOME="${CARGO_HOME:-/Volumes/EAGET/dev-home/cargo}"
  export PATH="$CARGO_HOME/bin:$PATH"
fi

echo "==> 1/3 构建前端"
npm run build

echo "==> 2/3 构建桌面端（带 custom-protocol，嵌入前端）"
cargo build --release -p agentry --features custom-protocol

echo "==> 3/3 构建远端代理 + headless 中心"
cargo build --release -p agentry-proxy
cargo build --release -p agentry --bin agentry-center-helper

BIN="$ROOT/target/release/agentry"

echo
echo "==> 自检：前端是否真的嵌进二进制"
if [ ! -f "$BIN" ]; then
  echo "✗ 找不到 $BIN" >&2
  exit 1
fi
# dist 里至少要有一个带 hash 的资源，名字应出现在二进制的资源表里
miss=0
for f in dist/assets/*; do
  base="$(basename "$f")"
  if ! grep -aq "$base" "$BIN"; then
    echo "  ✗ 二进制里找不到前端资源：$base"
    miss=1
  fi
done
if [ "$miss" != 0 ]; then
  echo
  echo "✗ 前端没嵌进二进制 —— 启动会白屏（会去连 devUrl 5173）。" >&2
  echo "  多半是漏了 --features custom-protocol。" >&2
  exit 1
fi

echo "  ✓ 前端已嵌入（$(du -h "$BIN" | cut -f1)）"
echo
echo "完成："
ls -la "$ROOT/target/release/agentry" \
       "$ROOT/target/release/agentry-proxy" \
       "$ROOT/target/release/agentry-center-helper"
