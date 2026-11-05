# chat-memory-benchmark 适配器

用 dot 的**真实记忆代码**（`src/memory/memory.js`、`recall.js`、`store.js`）跑 [Ornn8/chat-memory-benchmark](https://github.com/Ornn8/chat-memory-benchmark) 六人物正式卷（714 题）。不进 npm 包。

## 跑

```sh
git pull && npm install            # coordination 分支
git clone https://github.com/Ornn8/chat-memory-benchmark.git ../chat-memory-benchmark
export DEEPSEEK_API_KEY=sk-...
node bench/chat-memory-benchmark.mjs \
  --dataset ../chat-memory-benchmark/datasets/natural-timegrid-20261101-v2 \
  --out ~/dsh-bench/2026-11
# 中断后同一命令加 --resume 接着跑；--persona P01 可重复，只跑指定人物
```

环境变量：`DEEPSEEK_API_KEY`（必填）、`DEEPSEEK_BASE_URL`（默认 `https://api.deepseek.com`）、`DSH_BENCH_MODEL`（默认 `deepseek-chat`，非思考）、`DSH_BENCH_EXTRA_BODY`（并入每个请求的 JSON，比如某渠道需要显式关思考时用）、`DSH_BENCH_MAX_TOKENS_CAP`（默认 8192）、`DSH_BENCH_PRICE_RMB`（默认 `0.2,2,3`：每百万 token 缓存命中输入 / 未命中输入 / 输出，按 DeepSeek 官网价假设）。

其他参数：`--recall off`（不用自动召回）、`--window 6`、`--save-prompts`（把每题真实发给模型的消息写进 `prompts.jsonl`，自查输入边界用，公开前先检查）、`--fake-llm`（离线测试：整理返回固定 JSON，回答是固定句子）、`--max-questions N`。

**第一次运行**会把 `@huggingface/transformers` 装进 `$DSH_HOME/dsh-dot-recall/`（300–480 MB），再下 `Xenova/multilingual-e5-small`（约 129 MB），和 dot 自己第一次用自动召回一样；已经装过就直接用。镜像沿用 `$DSH_HOME/dsh-memory.json` 里的 `recall.mirror`，没有就 `HF_ENDPOINT`，再没有就 `https://hf-mirror.com`。除此之外不读你的 dot 设置：运行用 `<out>/dsh-home` 作为 `DSH_HOME`，全部默认配置。

## 怎么接的

- **写入**：每个人物一个独立 dot home。历史逐轮按逻辑时间回放成 memory.js 监听的会话事件（他的消息 + 已有的助手回复），时钟是假的（`Date.now()` / `new Date()` 给逻辑时间）。之后发生什么全由插件决定：transcript、每 20 行整理、超过 `handoffTokens` 交班、召回索引。
- **维护**：插件自己的 60 秒定时器，在它能做事的每一分钟触发：最后一句话 30 分钟后且有 ≥3 行新记录时空闲整理；每天 23:30 整理并写日记（日记本身不进她的上下文，但这次整理会改记忆，所以照跑；没有新记录的日子也会调一次模型，这是插件的真实行为）。整理失败或回复不是 JSON 时，定时器下一分钟会重试，这里每件事最多 4 次。交班按插件规则判断，会话 token 用 `基础 10000 + 每轮文字估算` 计；正式卷最大的 P14 约 9.6 万，到不了 15 万，所以实际不会交班。
- **考试**：先推进到考试时间、跑完到期的维护，再开一个独立会话：`dot:now` 一行 + 插件注入的 `dot:memory`（画像 + 碎片）+ 用题目走 `recall.prepare` 得到的 `dot:recall`（默认过滤：话太少不查 4、对比度 0.35、top 8、≤1500 token）+ 最近 6 个完整回合作为聊天消息。不带工具，一次回答。题目和回答不进 transcript、记忆和索引。
- **短期窗口 6 轮**：和基准里 Soul、ROFM、Qwen 对照、OpenViking、Hindsight、Suzu 的设置一致。`recallWindowTurns` 设成 6（插件为"宿主只显示最近 N 轮"准备的开关），已经在窗口里的轮次不再被召回一遍。
- 整理和答题同一个模型。

## 产物

- `answers.jsonl`：`{"id","answer"}`，直接给 `python grading/grade.py prepare --answers …`。
- `run.jsonl`：每题的截止轮、考试时间、召回条数和方式、记忆字数、窗口轮数、错误。没拿到回复的题只记在这里，不重试刷答案。
- `meta.json`：dsh-dot commit、适配器版本、模型、数据集 manifest SHA、窗口、召回配置、每个人物的整理次数（按 lines / idle / daily / handoff 分）、交班次数、token 用量和估算费用。
- `personas/<P>/dot/memory/`：插件自己写的 memory.json / memory.md / transcript / calls.jsonl / diary.md / 召回索引；`checkpoint/` 是每题之后的快照，`--resume` 从这里接上。

## 量

按 `--fake-llm` 全量跑出来的调用次数（真实运行除重试外相同）：

| 人物 | 整理调用 | 答题 |
|---|---|---|
| P01 | 215 | 88 |
| P12 | 288 | 79 |
| P14 | 287 | 82 |
| P16 | 262 | 123 |
| P17 | 262 | 172 |
| P20 | 303 | 170 |
| 合计 | 1617 | 714 |

输入约 570 万（整理）+ 200 万（答题）token（按字数 / 1.5 估）。串行跑大约要几个小时；可以按人物分开开几个进程（各自 `--out`），最后把 `answers.jsonl` 拼起来。
