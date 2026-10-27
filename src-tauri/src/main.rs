// agentry 的二进制入口。
//
// 业务逻辑都在 lib.rs（agentry::run）—— 这样集成测试能直接调用中心的
// hub 与合并门面，不用真的开一个窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    agentry::run()
}
