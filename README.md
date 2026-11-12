# dsh-automation

不需要 agent 的定時檢查與收集。排程在宿主進程裡跑純 Node 工作，**不呼叫模型、不花 token**。

## 為什麼不是用 schedule

DSH 官方的 `schedule` 是「時間到了，把 prompt 送給某個 session」——那仍然需要一個 LLM 在迴圈裡。
這支插件處理的是另一半：磁碟、HTTP 狀態、RSS、JSON 端點、本機指令。這些事情沒有判斷需求，
只需要週期性執行 + 留下可比對的紀錄。

## 資料位置

```
~/.dsh/automation/
├── jobs.json          工作定義（第一次啟動自動寫入範例）
├── state.json         每項最後一次執行
├── latest/<id>.json   最新一筆結果
└── runs/<id>.jsonl    歷史（每項上限 500 行）
```

## 內建 adapter（固定幾套，其他自己加）

| type | 做什麼 | 主要欄位 |
|---|---|---|
| `rss` | 抓 RSS/Atom，解析 item/entry | `url`, `keep` |
| `http-json` | 抓 JSON，可選點路徑取值 | `url`, `pick`, `keep` |
| `http-status` | 只看狀態碼/延遲/大小（健康檢查） | `url`, `method` |
| `shell` | 執行本機指令，記錄 exit code 與輸出尾巴 | `command`, `timeoutMs` |
| `disk` | 家目錄/指定路徑剩餘空間 | `path`, `warnGB` |

共同欄位：`id`（唯一）、`type`、`every`（`30s`/`5m`/`2h`/`1d` 或秒數）、`note`。

## 範例（預設 jobs.json）

- `hn-top`：Hacker News 首頁（RSS，15 分鐘）
- `dsh-releases`：上游 release atom（1 小時）
- `local-web`：本機 DSH host 健康檢查（5 分鐘）
- `disk-home`：家目錄剩餘空間（30 分鐘，低於 20GB 標記失敗）
- `echo-check`：shell adapter 範例（10 分鐘）

## 工具面

- `automation_list` — 列出工作與最後一次結果
- `automation_run {id}` — 立刻跑一項（`id:"all"` 跑全部）
- `automation_status` — 工作數、失敗項、資料目錄

## 邊界與安全

- **只在本機執行**；不開任何網路服務、不上傳資料。
- `shell` adapter 會執行 `jobs.json` 裡寫的指令——這個檔案是使用者自己的，等於一份本機 cron。
  不要把不可信的內容寫進去。
- 排程器每 30 秒掃一次「誰到期了」，單一 job 序列執行；一個 job 失敗不會擋住其他 job。
- 沒有 `jobs.json` 時會自動生成範例；刪掉檔案不會影響其他資料。
