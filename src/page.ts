import catalog from './catalog.json';

export const apiPage = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gacha Metadata API</title>
<style>body{font:16px/1.7 system-ui,sans-serif;max-width:800px;margin:60px auto;padding:0 24px;color:#203040}code,pre{background:#f0f3f6;border-radius:6px;padding:3px 6px}pre{padding:16px;overflow:auto}a{color:#1764b0}li{margin:12px 0}</style>
<main><h1>Gacha Metadata API</h1><p>供抽卡记录管理前端查询公共物品名称、类型和星级。此服务不接收抽卡记录文件、UID 或授权链接。</p>
<ul><li><a href="/api/v1/health">GET /api/v1/health</a>：检查 D1 业务表是否可查询。</li>
<li><a href="/api/v1/games">GET /api/v1/games</a>：支持的游戏、语言和批量查询限制。</li>

<li><a href="/api/v1/items?game=hk4e&amp;lang=zh-cn&amp;ids=10000003,11401">GET /api/v1/items?game=hk4e&amp;lang=zh-cn&amp;ids=10000003,11401</a>：按 ID 批量查询。</li></ul>
<p>game 使用 UIGF 游戏键：原神 hk4e、星穹铁道 hkrpg、绝区零 nap、千星衣装 hk4e_ugc（独立第四张表）。lang 默认为 ${catalog.default_lang}；每次最多 ${catalog.max_ids} 个字符串 ID，去重后按请求顺序返回。</p>
<pre>{ "game": "hk4e", "lang": "zh-cn", "items": [
  { "item_id": "10000003", "name": "琴", "item_type": "角色",
    "rank_type": "5", "rarity": 5, "source": "…", "updated_at": "…" }
], "missing_ids": ["11401"] }</pre>
<p>上方为响应结构示例，不代表数据库已收录这些物品。缺失 ID 位于 missing_ids，服务不会猜测星级或回退到其他语言。</p>
<p>rank_type 保留游戏原始值；rarity 为展示星级。绝区零 rank_type 为 2/3/4，对应 rarity 3/4/5。千星源等级 1–5 直接展示，0 或未知等级为 null。item_type 是元数据维护者提供的本地化类型文本。</p>
<p>错误返回 { "error": { "code": "…", "message": "…" } }。400 参数错误、403 来源不允许、404 路径不存在、405 方法不支持、414 查询过长、503 数据库不可用。</p>
<p>公共查询支持 GET、HEAD、OPTIONS；前端使用 credentials: "omit"，只发送游戏、语言和公共物品 ID。不维护卡池日程。</p>
<p>管理员维护：POST /api/v1/admin/metadata，需 Authorization: Bearer 管理密钥及 application/json，使用 README 中的 source/entries 格式。仅供维护脚本调用，不允许浏览器 Origin；不要把密钥放入博客。每次最多 2000 行、1 MiB，校验后跨表原子 upsert，不删除历史数据。</p>
<p>每天 UTC 03:00 同步 Enka processed store，Dimbreath 仅补全缺字段；邦布和千星衣装使用 Starward 公共静态元数据。衣装仅有 zh-cn。POST /api/v1/admin/sync 可由维护脚本携带管理密钥立即触发，不接收请求体。</p><p>响应 data 字典按 ID 返回 name、rank、type、icon；items 还包含原始等级、来源和时间。额外规范化源由 METADATA_FEEDS 配置；详情见 README。</p></main></html>`;
