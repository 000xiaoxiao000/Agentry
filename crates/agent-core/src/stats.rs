// ---------- 跨工具汇总统计 ----------
#[derive(serde::Serialize)]
pub struct ConnStat {
    pub connector: String,
    pub count: usize,
    pub size: u64,
    // 按类型拆分：总览卡片要显示「会话 / 文件」，比笼统的「产物」更有信息量。
    pub conversations: usize,
    pub files: usize,
}

#[derive(serde::Serialize)]
pub struct KindStat {
    pub kind: String,
    pub count: usize,
}

#[derive(serde::Serialize)]
pub struct ArtifactStats {
    pub total: usize,
    pub total_size: u64,
    pub connectors: Vec<ConnStat>,
    pub kinds: Vec<KindStat>,
}
