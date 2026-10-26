# 技术设计：auto mode 本地分类器 env 注入

日期：2026-10-26

## 1. 总体数据流

```text
Key.model_mapping (autoMode.enabled/model)
        │
        ▼
terminal::resolve_launch_preview
        │  apply_auto_mode_launch_env(&mut preview.env, mapping)
        ▼
wrapper 脚本 / env（进程级）
        │
        ▼
claude (>= 2.1.302)                         
  CLAUDE_CODE_AUTO_MODE_SERVER=0  → 不再请求服务端审查
  CLAUDE_CODE_AUTO_MODE_MODEL=... → 本地分类器使用该模型
        │
        ▼
cc-use daemon → 供应商（分类器请求与普通请求都照常转发、计费、记录）
```

环境变量在进程启动时固化，因此设置变更只影响新会话。`terminal_get_launch_preview` 与真实启动走同一个 `resolve_launch_preview`，保证 UI 预览与实际注入一致。

## 2. 配置模型

复用现有 Key `modelMapping` 中的 `autoMode`：

```json
{
  "autoMode": {
    "enabled": true,
    "model": "provider-model-id"
  }
}
```

- `enabled`：是否注入。默认 `false`。
- `model`：`CLAUDE_CODE_AUTO_MODE_MODEL` 的值。必须是非空、trim 后的上游模型 ID。
- `thinking`（历史字段）：保留解析容忍，但不再读取、不再渲染、不再参与代理改写。

兼容两种存储形态，统一走 `shared_runtime::model_mapping::upstream_mapping(mapping, "claude_code")`：

- v2：`clients.claude_code.upstream.autoMode`
- 旧格式：顶层 `autoMode`

新增纯函数（`model_mapping.rs`）：

```rust
/// Some(model) only when enabled && model.trim() is non-empty.
pub fn auto_mode_classifier_model(mapping: Option<&str>) -> Option<String>;
```

## 3. 启动注入

### 3.1 Helper

在 `shared_runtime/launch_preview.rs` 增加可单测的纯函数：

```rust
pub fn apply_auto_mode_launch_env(env: &mut EnvObject, mapping: Option<&str>) {
    let Some(model) = model_mapping::auto_mode_classifier_model(mapping) else {
        return;
    };
    // 用户显式设置优先
    env.entry("CLAUDE_CODE_AUTO_MODE_SERVER".into())
        .or_insert_with(|| "0".into());
    env.entry("CLAUDE_CODE_AUTO_MODE_MODEL".into())
        .or_insert(model);
}
```

- 只在 `cli_type` 为 `claude` / `claude_code` 时调用。
- 位置：`terminal/mod.rs::resolve_launch_preview`，在 `resolve_launch_preview_from_configs` 之后、其他 Claude 默认项注入附近。
- 使用 `entry().or_insert()`，保留 Key / 全局 Claude 配置里的显式 env。
- 不新增版本探测：旧版本忽略未知 env，天然满足“只对最新版生效”。

### 3.2 不做的事

- 不注入 `CLAUDE_CODE_ENABLE_AUTO_MODE`。
- 不在 daemon 运行时修改 client env（进程内不可变）。
- 不根据 User-Agent 猜测版本后决定是否注入。

## 4. 移除旧代理改写

删除 `src-tauri/src/proxy/auto_mode.rs` 中：

- `AutoModeState`、`Mapping`、`Config`、模型会话缓存、`adapt` / `adapt_with_hint`
- 对应的 `AppState.auto_mode` 字段、初始化与 handler 调用

保留：

- `is_classifier(body)`：用于 `request_kind = Some("auto_mode")`，供控制台 / 统计标记。
- `is_message_response(bytes)`：既有响应兼容校验，与本任务无关。
- `claude_session_id`：若仍有调用方则保留，否则一并删除。

处理顺序：先移除 handler 中的改写调用，再删状态与类型，最后清理测试。

风险：最新版本地分类器的 system prompt 可能与旧前缀不同，`is_classifier` 可能识别不到。该问题只影响统计标记，不影响转发；在 E2E 中抓一次请求确认，必要时在后续任务更新识别规则。

## 5. 前端

`ModelMappingEditor.tsx` 的 `autoMode` 区域：

- 开关名称改为「Auto mode 兼容（本地分类器）」。
- 保留分类器模型输入；placeholder 改为“供应商可用的模型 ID”。
- 删除“分类器思考强度”下拉（`thinking`）。
- 开关打开且模型为空时显示行内警告：“填写分类器模型后才生效”。
- 新增固定说明文案：
  - 需要最新版 Claude Code；自定义分类器模型需要 2.1.302+。
  - 修改后需要重新启动会话才生效。
  - 分类器请求会计入该 Key 的 token 用量。

`src/renderer/utils/modelMapping.ts`：

- 类型中的 `thinking` 改为可选/保留兼容，不再写入新值；`parseModelMapping` 继续容忍旧字段。
- 序列化只输出 `enabled` 与 `model`（非空才输出）。

`src/renderer/locales/zh.ts` / `en.ts`：更新文案，删除不再使用的 `autoModeThinking*` key。

## 6. 兼容与回滚

- Claude Code < 2.1.278：未知 env 忽略，行为不变。
- 2.1.278–2.1.301：`SERVER=0` 生效，`MODEL` 被忽略，分类器使用默认 Sonnet 5；UI 已注明 2.1.302+。
- ≥ 2.1.302：两变量均生效。
- 开关关闭即回到“纯透传 + 依赖 Claude Code 自动回退”。
- `CLAUDE_CODE_AUTO_MODE_SERVER` 若被官方移除，最坏退回自动回退路径（可能出现计费提示），不影响启动。

## 7. 测试策略

Rust（inline）：

- `auto_mode_classifier_model`：v2、旧格式、disabled、空模型、空白字符。
- `apply_auto_mode_launch_env`：注入两个变量；disabled 不注入；显式 env 不被覆盖。
- 旧 `auto_mode` 改写测试随代码删除；保留 `is_classifier` 的识别用例（若保留函数）。

前端：

- `modelMapping.test.ts`：开启 + 模型序列化；关闭不输出；旧 `thinking` 字段可解析但不回写。
- 组件渲染如已有测试，补充“重启生效”文案断言。

E2E（手动）：

1. 用 Claude Code ≥ 2.1.302 + 第三方 Key，开启开关并填写分类器模型。
2. 从项目页启动，确认 wrapper env 含两变量。
3. 会话中 `/status` 显示 `Auto mode server: Disabled`。
4. daemon 请求记录出现分类器请求，模型为配置值。
5. 关闭开关，重启会话，确认不再注入、行为回到默认。
