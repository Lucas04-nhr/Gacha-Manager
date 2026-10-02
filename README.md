# Gacha Metadata API

为博客抽卡记录管理页面提供公共物品与卡池元数据查询的 Cloudflare Worker。前端发送游戏、语言和物品／卡池 ID，Worker 从现有 D1 数据库 `gacha_meta` 返回名称、物品类型、原始等级等信息。

本仓库只负责元数据查询与维护。UIGF 文件导入导出、用户记录整理展示、授权链接解析、增量抓取和本地存储全部属于前端；Worker 不接收这些文件、记录、UID、Cookie 或授权链接。无需账号系统。

## 数据与绑定

`wrangler.jsonc` 已配置现有数据库的真实 ID，Worker 使用 `env.DB` 访问 D1。`ALLOWED_ORIGINS` 是 CORS 配置变量，默认 `*`，适用于不带凭据的公共查询；可改为逗号分隔的博客来源，例如 `https://blog.example.com,http://localhost:8080`。来源必须包含协议及必要的端口，不包含路径或末尾 `/`。来源限制不是身份认证，API 仍是公共服务。

本服务只需要 D1 绑定，不需要为用户数据增加 KV、R2 或 Durable Objects。`workers_dev: true` 使部署后的 Worker 具有网页和 API 访问地址。当前源码并不意味着已经完成云端部署或远程迁移。

| `game` | 独立 D1 表 | 元数据范围 |
| --- | --- | --- |
| `hk4e` | `genshin_meta` | 原神普通祈愿物品与卡池 |
| `hk4e_ugc` | `genshin_ugc_meta` | 千星奇域衣装抽卡物品与卡池 |
| `hkrpg` | `starrail_meta` | 星穹铁道跃迁物品与卡池 |
| `nap` | `zenless_meta` | 绝区零调频物品与卡池 |

每张表通过 `kind` 区分 `item`／`pool`，以 `(namespace, kind, lang, entity_id)` 作为主键。同一个数字 ID 可以属于不同游戏、不同语言、物品或卡池，互不覆盖。四张表只保存公共元数据；Cloudflare 内部表和 Wrangler 迁移记录表不计入这四张业务表。

`pool_id` 是具体卡池／排期 ID，`gacha_type` 是卡池类别，两者不可互换。星铁和绝区零的 `pool_id` 对应记录中的 `gacha_id`，千星衣装对应 `schedule_id`；千星的类别字段 `op_gacha_type` 在此 API 统一返回为 `gacha_type`。普通原神的具体卡池 ID 需要来自公共卡池配置，普通祈愿记录中的 `gacha_type` 不能充当排期 ID。此服务不会根据用户记录推断卡池。

## 本地运行与验证

需要当前 Wrangler 支持的 Node.js 版本和 npm。依赖版本锁定在 `package-lock.json`。

```sh
npm ci
npm run types
npm run check
npm run db:migrate:local
npm run dev
```

打开 `http://localhost:8787/` 查看 API 说明网页。开发默认连接本地模拟 D1，不修改线上数据库。迁移只创建表，不填入元数据；空表的查询正常返回 `missing_ids`。

```sh
npm test
```

测试先执行 Wrangler 部署 dry run，然后在 Miniflare/workerd 与真实本地 D1 上验证四表隔离、物品／卡池隔离、批量查询、语言、原始等级、CORS、错误响应和维护脚本。测试数据含合成衣装与卡池，仅用于测试，不能用于生产。`npm run build` 仅生成 `dist/`，不会发布 Worker。

## 查询 API

所有端点支持 `GET`、`HEAD`、`OPTIONS`，不接受写入。没有认证、Cookie 或用户数据请求体。只允许列出的查询参数，每个参数只能出现一次。

| 路径 | 用途 |
| --- | --- |
| `/` | HTML API 说明页 |
| `/api/v1/health` | 检查四张元数据表能否查询；空表不代表故障 |
| `/api/v1/games` | 命名空间、允许的语言、默认语言与批量上限；不代表数据已完整收录 |
| `/api/v1/items?game=hk4e&lang=zh-cn&ids=10000003,11401` | 按物品 ID 查询 |
| `/api/v1/pools?game=hkrpg&lang=zh-cn&ids=2003` | 按具体卡池 ID 查询 |

`game` 必填，`lang` 默认 `en-us`，`ids` 必填，包含 1–90 个逗号分隔的十进制字符串，每个 ID 最多 20 位。服务去重并按请求顺序返回。请先在前端去重，再每 90 个 ID 分批调用。D1 查询包含额外的命名空间、类别和语言参数，因此不使用 100 个 ID 的批量大小。

物品响应结构示例（不代表这些 ID 已写入数据库）：

```json
{
  "game": "hk4e",
  "lang": "zh-cn",
  "items": [
    {
      "item_id": "10000003",
      "name": "琴",
      "item_type": "角色",
      "rank_type": "5",
      "rarity": 5,
      "source": "https://example.com/public-metadata",
      "updated_at": "2026-10-02T00:00:00.000Z"
    }
  ],
  "missing_ids": ["11401"]
}
```

`rank_type` 保留游戏原始字符串。原神普通祈愿和星铁的 `rarity` 是 3/4/5；绝区零原始 `rank_type` 为 2/3/4，展示 `rarity` 为 3/4/5。千星衣装保留原始等级，`rarity` 返回 `null`，避免未经核实的星级转换。`item_type` 是维护者提供的本地化类型文本，不是统一枚举。

卡池响应使用 `pools` 数组，每个元素包含 `pool_id`、`name`、`gacha_type`、`source`、`updated_at`，也有顶层 `game`、`lang`、`missing_ids`。

服务只匹配请求的语言，不自动回退。`missing_ids` 表示当前游戏和语言没有对应元数据，可能是新物品、新卡池或尚未维护的语言；前端应保留原始文件信息或展示未知状态，不能猜测名称和等级。全部缺失仍返回 HTTP 200。成功查询可缓存 300 秒，配置可缓存 3600 秒；数据库更新后旧响应最多可能保留相应缓存时间。

```js
const params = new URLSearchParams({
  game: 'hk4e_ugc',
  lang: 'zh-cn',
  ids: publicItemIds.join(','),
});
const response = await fetch(`${metadataApiBase}/api/v1/items?${params}`, {
  credentials: 'omit',
});
if (!response.ok) throw new Error(`Metadata API: ${response.status}`);
const { items, missing_ids } = await response.json();
```

错误响应统一为：

```json
{ "error": { "code": "INVALID_GAME", "message": "game must be hk4e, hk4e_ugc, hkrpg or nap." } }
```

| HTTP 状态 | 情况 |
| --- | --- |
| 400 | 不支持的游戏／语言、缺失或非法 ID、未知或重复参数 |
| 403 | 浏览器来源未获 CORS 配置允许 |
| 404 | 路径不存在 |
| 405 | 方法或预检请求不支持 |
| 414 | 查询字符串超过 4096 字符 |
| 503 | D1 查询失败或未应用迁移 |

错误响应使用 `no-store`，不会暴露原始 SQL 或异常。应用日志只记录固定故障事件，不记录请求参数；配置还关闭了调用日志并启用查询字符串脱敏。Cloudflare 其他平台层仍可能记录请求信息，因此前端必须保证请求仅包含公共元数据条件。

## 元数据维护

生产 API 不提供写入端点。维护者从已核实的公开数据源整理以下 JSON，由离线脚本校验并生成 upsert SQL：

```json
{
  "source": "https://example.com/public-metadata",
  "entries": [
    {
      "game": "hk4e",
      "lang": "zh-cn",
      "kind": "item",
      "item_id": "10000003",
      "name": "琴",
      "item_type": "角色",
      "rank_type": "5"
    },
    {
      "game": "hkrpg",
      "lang": "zh-cn",
      "kind": "pool",
      "pool_id": "2003",
      "name": "来自公开配置的卡池名称",
      "gacha_type": "11"
    }
  ]
}
```

这是格式示例；替换来源和所有示例值后才能用于生产。来源必须是公开 HTTPS URL，不能带凭据、查询参数或 fragment。不同来源使用不同文件。每行必须包含准确名称和类型／等级或卡池类别；缺失信息必须先在维护流程中解决，脚本不会推断。千星衣装使用 `game: "hk4e_ugc"`；普通物品和衣装即使 ID 相同也会写入独立表。

```sh
npm run metadata:sql -- metadata.json metadata.sql
npx wrangler d1 execute gacha_meta --local --file metadata.sql
```

脚本先校验整个文件，拒绝未知字段（包括用户数据）、数字类型 ID、重复键和非法等级，正确转义 SQL 文本。不会访问网络或自行修改数据库；不会覆盖已有输出文件。维护文件自身也不应包含任何用户记录。upsert 更新名称等属性，保留历史卡池及其他语言，不执行全表清空。多个批次不是整个数据集的原子发布；较大更新应在维护流程中安排并核对数量。

本实现没有预置完整生产数据，也没有自动同步／定时抓取任务。四个命名空间的查询结构已支持，但实际覆盖取决于维护者导入的公共元数据，尤其是千星衣装和历史具体卡池。不要把测试 fixture 当作数据源。

## 云端初始化和部署

现有 `gacha_meta` 已绑定，无需 `wrangler d1 create`。下面命令会修改远程数据库和发布 Worker，执行前先完成本地验证并检查配置：

```sh
npx wrangler login
npm run db:migrate:remote
npx wrangler d1 execute gacha_meta --remote --file metadata.sql
npm run deploy
```

部署输出的 `https://gacha-manager.<你的子域>.workers.dev/` 是 API 说明网页，前端基址为相同来源，查询路径为 `/api/v1/items` 或 `/api/v1/pools`。若需要自定义域名，再按博客域名配置路由。发布后检查 `/api/v1/health`，并使用已导入的物品和卡池 ID 验证实际响应。CI 中通过 Cloudflare 环境变量设置部署凭据，不提交 token。

## 参考与约定

- [UIGF v4.2 标准](https://uigf.org/en/standards/uigf.html)：游戏键及原始物品字段，包含 `hk4e_ugc`、`schedule_id` 和 `op_gacha_type`。
- [PizzaHelperUnited](https://github.com/pizza-studio/PizzaHelperUnited)：`Packages/GachaKit` 中游戏等级与展示星级的区分，特别是绝区零的偏移处理。
- [GachaMetaGenerator](https://github.com/pizza-studio/GachaMetaGenerator)：PizzaHelper 的多语言物品 ID／名称／等级映射；其现有输出针对普通原神与星铁，不能当作完整的千星／绝区零／卡池数据源。
- [hoyo-buddy](https://github.com/seriaati/hoyo-buddy/blob/main/hoyo_buddy/utils/gacha_data.py)：按游戏和语言维护公共物品字典、校验上游结构的方式；本服务不移植其账号与用户记录存储。
- [Cloudflare D1 绑定配置](https://developers.cloudflare.com/workers/wrangler/configuration/#d1-databases)与[迁移文档](https://developers.cloudflare.com/d1/reference/migrations/)。

项目沿用仓库现有的 [LICENSE](LICENSE)。公共游戏元数据及参考项目内容的权利归各自权利人；本实现没有复制参考项目源代码或打包其完整数据。
