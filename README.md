# sequential-launch

amount 为用户结算金额，visible 是本地时间轴，assignment 是分配版本。

项目提供本地记录校验、输入指纹、按 `arm` 的原始核算，以及**预先登记的组序贯上线设计**。分析人员可以保留完整输入并复查每次导出的 JSON；原始数据不被命令改写。业务配置位于 `data/policy.json`，登记计划位于 `data/plan.json`，字段约定在 `docs/data.md`。

上线决定只能发生在计划内的观察点：每天重算普通 p 值不会推进台账，也不会获得额外的一次 alpha 机会。边界按 alpha-spending 与累计统计量的相关结构求解，并做登记在案的有限样本校正。已停止或已完成的计划不能靠追加用户重开；后到数据与更正进入补充分析，原决定保持不变。

## 运行

使用 Node.js 22 LTS（>=22.22.1 且 <23）和 npm，无第三方运行依赖。
`.nvmrc` 选择 22 主版本，清单与锁文件记录相同的兼容范围；Dockerfile 仍固定基础镜像摘要，容器构建可精确复现。

```sh
npm ci --ignore-scripts --no-audit --no-fund --offline
npm run build
npm test

# 现有的一次性核算（不消费序贯设计）
node src/cli.js inspect --input data/records.json
node src/cli.js summary --input data/records.json --out var/summary.json

# 预先登记的设计与边界
node src/cli.js design --plan data/plan.json --out var/design.json

# 组序贯分析：每次请求最多消费一个计划内观察点
node src/cli.js look --plan data/plan.json --input <累计导出.json> --store var/ledger.json

# 计划结束后的后到数据/更正：只追加补充分析
node src/cli.js supplement --plan data/plan.json --input <更正后导出.json> \
  --store var/ledger.json --reason "后到结算更正"

# 零效应模拟（规模与种子可配）
node src/cli.js simulate --plan data/plan.json --runs 400 --seed 83 --out var/simulate.json

npm run demo            # 原有演示
npm run sequential-demo # 序贯设计的短演示与示例
```

`look` 与 `supplement` 以 `--store` 指向的 JSON 台账保存状态，写入使用临时文件替换并持有排他锁；`--out` 只写当次返回的文档，不改写台账。重复提交同一份导出是幂等的：不会新增观察点，也不会重复消耗 alpha。

`npm run demo` 在本地打印输入、现有核算及配置并生成 `var/summary.json`，不访问网络、不等待真实业务时间，通常几秒内完成。`npm run sequential-demo` 用小规模数据演示信息量不足、重复请求、分组污染、提前停止和补充分析；模拟只用可复现的随机种子，结果中的数值近似误差与假设会随设计一起输出。输出目录可删除后重新运行，测试只使用临时目录。

## 容器

```sh
docker build -t sequential-launch:local .
docker run --rm --network none sequential-launch:local
```

Dockerfile 固定 Node.js 基础镜像摘要，构建时执行语法检查和测试。镜像构建完成后演示无需联网；可覆盖命令运行 `npm test`。构建不需要真实账号、邮件服务、数据库或线上数据。

## 目录

- `src/dataset.js`：记录校验、规范序列化和数据指纹。
- `src/domain.js`：现有业务分组核算。
- `src/normal.js`：正态分位数、尾概率、高斯积分与模拟用随机数。
- `src/sequential.js`：计划校验、信息量规则、alpha-spending、边界求解、用户级截尾核算。
- `src/trial.js`：观察点台账、幂等请求、停止后追加限制与补充分析。
- `src/simulate.js`：零效应误报率与情景模拟。
- `src/cli.js`：本地读取、检查、设计与序贯分析入口。
- `src/output.js`：以临时文件写入后替换完整 JSON。
- `test/`：输入约束、领域核对、数值、序贯决策、模拟与命令回归。
- `data/`：合成记录、独立核对值、本地业务配置与登记计划。
