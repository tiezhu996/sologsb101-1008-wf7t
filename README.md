# 供热管网水力平衡调节台（sologsb101-1008）

面向供热公司运行调度与二次网平衡调节班组，按换热站—楼栋—单元三级登记阀门开度与设计流量，用实测流量与室温反馈计算失衡度并下发调节单。核心动作：建站与楼栋、登记阀位与设计参数、录入实测流量与供回水温、算失衡度排序、下发调节单并复核；两站并网后通过**并站迁移台**把楼栋分批划到新站，按生效时点切换归属，历史数据认原站不追溯。

> 纯前端单页应用（SPA）：**无后端 / 无数据库服务 / 无 API**，全部数据保存在浏览器本地 IndexedDB。

## 一、Docker 一键启动（推荐）

在项目根目录（本 README 所在目录）执行：

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22808**

常用运维命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并删除容器
docker compose up -d --build      # 改代码后重新构建启动
```

如需更换宿主端口，修改 `.env` 中的 `FRONTEND_PORT` 后重新 `docker compose up -d`。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3.5 | `<script setup>` + Composition API |
| 语言 | TypeScript 5.7 | `strict` 严格模式，构建前执行 `vue-tsc --noEmit` |
| UI 组件 | TDesign Vue Next 1.20 | 表格、表单、Dialog、Tag、Descriptions、Progress |
| 状态管理 | Pinia 2.3 | `stationStore` / `valveStore` / `adjustStore` / `migrationStore` |
| 路由 | Vue Router 4.5 | History 模式，nginx `try_files` 回退 |
| 本地持久化 | Dexie 4（IndexedDB） | 版本号 + `upgrade` 迁移 + 幂等播种 |
| 构建 | Vite 6 | 输出 `dist/`，按路由自动分包 |
| 运行 | nginx:alpine | 静态托管 + gzip + SPA 回退 |

## 三、目录结构

```
sologsb101-1008/
├── README.md
├── docker-compose.yml          # 不写 version；顶层 name: gbheatgrid
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html + gzip
    ├── .dockerignore
    ├── package.json / tsconfig.json / vite.config.ts / index.html
    ├── public/favicon.svg
    └── src/
        ├── types/              # station.ts building.ts valve.ts measure.ts adjust.ts migration.ts
        ├── stores/             # stationStore.ts valveStore.ts adjustStore.ts migrationStore.ts
        ├── components/common/  # BalanceTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useImbalanceRank.ts useIdbTable.ts
        ├── pages/              # StationList.vue ValveList.vue MeasureEntry.vue BalanceBoard.vue AdjustOrder.vue MigrationConsole.vue
        ├── router/index.ts
        ├── utils/              # balance.ts db.ts export.ts migration.ts
        ├── styles/main.css
        ├── App.vue
        └── main.ts
```

## 四、页面与路由

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/stations` | 换热站与楼栋台账 | Station、Building | 新建/编辑/删除换热站与楼栋；按供热方式与面积区间筛选；卡片回显失衡楼栋数与待复核单数 |
| `/valves` | 阀位与设计参数登记 | Valve、Building | 登记口径/位置/开度/设计流量；开度改动进入草稿后可逐条或批量提交；失衡标签与开度校核 |
| `/measures` | 实测流量/供回水温录入 | Measure、Valve | 按日期成组录入流量与三温；支持「阀门编号,日期,流量,供温,回温,室温,录入人」批量粘贴导入并即时预览失衡度 |
| `/balance` | 失衡度计算与排序 | Valve、Measure | 按失衡度降序排行；仅看失衡；导出失衡度 CSV；单条/一键生成调节单 |
| `/adjusts` | 调节单下发与复核 | Adjust、Valve、Measure | 状态机 待下发→已调节（回写阀门开度）→已复核（记录复核意见）；导出调节单 CSV 与全量 JSON |
| `/migrations` | 并站迁移台 | StationMigration、Building、Valve、Adjust | 选来源/目标站与生效时点分批划楼；预检列出受影响阀门并被未完调节单拦截；三处同事务写入、revision 乐观锁、失败回滚；历史实测/调节单/导出按当时归属认原站 |

## 五、数据存储说明

- **IndexedDB 库名**：`gbheatgrid`（Dexie 封装，`src/utils/db.ts`）
- **对象表**：`stations`、`buildings`、`valves`、`measures`、`adjusts`、`stationMigrations`
- **数据结构版本**：`DB_VERSION = 3`
  - v1 → v2：阀门回填 `stationId` 冗余列、规整开度与复核字段
  - v2 → v3：新增 `stationMigrations` 迁移记录表；实测 / 调节单补 `stationId` 归属快照索引。旧行不强制回填快照，读取侧用迁移记录按时效解析兜底，因此**旧备份可直接导入**
- **并站迁移认账口径**（详见 `src/utils/migration.ts`）：
  - 生效时点之后：排行、录实测、派调节单、阀门归属走目标站；
  - 生效时点之前：历史实测按实测日期、调节单按派单时间认来源站，导出（CSV/JSON）同样保留原站，不追溯改站；
  - 未完调节单（待下发、已调节未复核）未闭环前挡住迁移；
  - 楼栋归属、阀门冗余站标识、迁移记录在同一事务内三处一起写入；确认前楼栋/阀门 revision 被他人改过则整包不写入并保留原数据；事务失败按迁移前快照恢复；
  - 生效时点在未来的预约批次只先写迁移记录，到点后幂等激活补齐两处物理写入
- **首屏自动播种**：`initDatabase()` 中 `if (await db.stations.count() === 0) await seedDatabase()`，播种 2 座换热站 → 5 栋楼 → 10 只阀门 → 20 条实测 → 4 张调节单 → 2 条迁移记录（1 条已生效、1 条待生效）的互相引用数据；播种幂等
- **localStorage 辅助键**：`gbheatgrid:db-version`、`gbheatgrid:last-backup-at`、`gbheatgrid:ui-prefs`（上次选中换热站、仅看失衡开关）
- 应用为**无状态容器**：数据不落容器磁盘、不使用数据库服务、不挂载命名卷

## 六、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22808
npm run build      # vue-tsc --noEmit && vite build（类型检查 + 生产构建）
npm run preview    # 本地预览构建产物
```

迁移领域逻辑（预检拦截、乐观锁冲突、三处原子写入、到点激活、时效归属、旧备份兼容）可用
`scripts/verify-migration.ts` 做运行时验证（Node + fake-indexeddb，非应用运行依赖）。

## 七、判定口径

- 流量比 `= 实测流量 ÷ 设计流量`；流量偏差率 `= (流量比 − 1) × 100%`
- 室温偏差 `= 室温 − 20℃`
- 合成失衡度 `= |流量偏差率| × 0.7 + |室温偏差| × 1.5`（单位 %）
- 判级：`≤ 10%` 平衡，`10% ~ 25%` 偏大 / 偏小（按流量方向），`> 25%` 严重失衡
- 目标开度建议 `= 当前开度 ÷ 流量比`，按 5% 取整并限制在 20% ~ 100%
