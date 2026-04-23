# Workflow 重构计划

本文档用于记录当前 `workflow` 重构方案，并明确区分：

- 第一阶段：已确认，可以按本文执行。
- 第二阶段：仅作为候选增强方向记录，当前未获确认，不得执行。

## 背景

当前实现中，`workflow.ts` 同时承担了多类职责：

1. 业务步骤编排
2. 并发与顺序调度
3. 运行时状态存储
4. CLI 进度展示
5. report 归约与最终发布

这导致业务语义和调度语义耦合过深。当前暴露出来的死锁问题，本质上是：

- 调度层要求顺序位完整存在才能推进。
- 业务层却在前置步骤成功之前，才临时注册后续顺序任务。
- 一旦前置步骤失败，对应顺序位不会进入任何终态，而是直接缺失。
- 后续页就会永久等待。

因此，这次重构目标不是只修一个死锁，而是把“计划、执行、状态归约、展示”分层。

## 第一阶段目标

第一阶段已确认，可以执行。

第一阶段目标是解决结构问题，不主动改变外部行为。

### 第一阶段必须保持不变的行为

- CLI 参数不变。
- 输出目录和文件命名不变。
- `report.json` schema 不变。
- 当前模型选择方式不变。
- `short` part 仍然是 `skipped`。
- 缺字幕仍然是 `skipped`，不是 `error`。
- `segmentJsonPath` 存在但 relative 缺失时，仍然直接报错。
- 单个 part 的硬失败仍然导致整视频最终为 `error`。
- 视频最终 `error` 时，仍然不 merge。
- merge 输出路径和 shownotes 输出路径不变。

### 第一阶段总体方向

把当前脚本式控制流改成“计划驱动的执行器”，但只重构内部组织，不改对外行为。

建议的新模块边界如下。

### `workflow.ts`

职责只保留入口编排：

- 解析参数
- 列视频、取 parts
- 为每个 video 构建执行计划
- 调用执行器
- 调用 `stageEpisodes`
- 调用 release 发布逻辑

### `workflow_plan.ts`

职责：把业务规则编译成固定执行计划。

输出建议包括：

- `VideoExecutionPlan`
- `PartExecutionPlan`
- `TaskPlan`

这里决定：

- 哪些 part 可处理
- 每个 part 有哪些任务
- 任务间依赖关系
- 哪些任务需要顺序约束
- 哪些任务需要哪类资源池

这里不执行 IO。

### `workflow_executor.ts`

职责：消费执行计划并运行任务。

它只负责：

- 判断一个 task 是否可以启动
- 判断资源池是否允许启动
- 在 task 完成后推进后继任务
- 判断所有任务是否进入终态

这里不写 report，不更新 CLI，不决定 merge 策略。

### `workflow_state.ts`

职责：定义统一状态模型和 reducer。

建议定义：

- `TaskStatus = "pending" | "running" | "succeeded" | "failed" | "skipped"`
- `PartStatus`
- `VideoStatus`
- `ExecutionEvent`

并负责处理：

- `taskStarted`
- `taskSucceeded`
- `taskFailed`
- `taskSkipped`

以及派生：

- part 状态
- video 状态
- part 处理耗时
- 汇总错误

### `workflow_report.ts`

保留当前 report schema，但改成“从状态生成 report”，而不是由主流程中的 scattered promises 拼接。

### `workflow_progress.ts`

职责：把执行状态渲染成 CLI progress payload。

它只订阅状态，不参与执行。

### `workflow_tasks.ts`

职责：承载具体步骤实现。

建议拆成独立任务函数：

- `runSubtitleTask`
- `runSegmentExtractionTask`
- `runAudioDownloadTask`
- `runAudioSliceTask`
- `runVideoMergeTask`

这些函数继续复用现有能力：

- `downloadSubtitle()`
- `extractSegments()`
- `downloadAudio()`
- `sliceAndConcatAudio()`
- `concatAudioFiles()`

## 第一阶段核心数据结构

建议核心从“part 函数返回值”切换成“任务图 + 状态表”。

### `TaskKey`

例子：

- `subtitle:p2`
- `segments:p2`
- `audio:p2`
- `slice:p2`
- `video-merge`

### `TaskPlan`

建议字段：

- `key`
- `kind`
- `partPage`
- `dependsOn`
- `resource`
- `orderKey`
- `retryPolicy`
- `run`

### `TaskState`

建议字段：

- `status`
- `attemptCount`
- `startedAtMs`
- `completedAtMs`
- `error`
- `output`

### `PartExecutionPlan`

建议字段：

- `page`
- `title`
- `durationSeconds`
- `taskKeys`

### `VideoExecutionPlan`

建议字段：

- `bvid`
- `title`
- `outputDir`
- `reportPath`
- `parts`
- `tasks`

关键约束：

每个 part 的任务必须在计划阶段就固定下来，不能在运行中根据某一步是否成功，动态决定某个后续任务是否存在。

## 第一阶段任务依赖模型

对一个正常可处理的 part，建议任务关系如下：

- `subtitle`
- `segments` depends on `subtitle`
- `audio`
- `slice` depends on `segments + audio`

关于 `audio` 是否依赖 `subtitle`：

- 如果希望保留音频下载和字幕下载的相对独立性，则 `audio` 不依赖 `subtitle`
- 如果希望保留“开始处理 part 后再下载音频”的节奏，也可以让 `audio` 依赖 `subtitle`

这一点属于第一阶段内部实现决策，但不应影响外部行为。

对于短 part：

- 不创建正常处理任务
- 在计划层直接标记该 part 为 `short` 且 `skipped`

对于 `MissingSubtitleError`：

- `subtitle` task 终态为 `skipped`
- `segments` 和 `slice` 由依赖传播自动进入 `skipped`
- `audio` 建议也随之 `skipped`，以保持现有行为

这样一来，“前页失败导致后页永久等待”的问题会从结构上消失，因为前页对应的任务从一开始就存在，只是进入不同终态，而不会出现顺序位缺失。

## 第一阶段调度原则

第一阶段不要继续让业务代码直接驱动 ordered runner 的注册时机。

调度层建议只理解两类约束：

### 资源池约束

例如：

- `llm` concurrency = 4
- `audio-download` concurrency = 2
- `part` global concurrency = N

### 顺序约束

例如同一视频内：

- `segments` 按 `page` 顺序启动
- `audio` 按 `page` 顺序启动

关键点：

顺序约束应当作用于“已经存在的 task 的状态推进”，而不是作用于“调用方未来会不会注册这个 task”。

也就是说，executor 内部应该基于固定顺序列表推进：

- 当某一顺序位进入终态，不论是 `succeeded`、`failed` 还是 `skipped`
- 后一个顺序位都可以继续检查是否满足启动条件

## 第一阶段状态归约原则

不要再依赖：

- `completedPartCount`
- `processedPartSettledResults`
- `finalizeResultPromise`

来判断系统是否完成。

建议统一改成状态归约：

### part 终态条件

- 该 part 的所有任务都进入终态
- 或该 part 在计划层已被直接判定为 `short` 并 `skipped`

### video 终态条件

- 所有 parts 都进入终态
- 然后根据当前结果决定执行 merge 或直接进入 `error`

### report 生成原则

- 统一从 `VideoExecutionState` 派生
- 不允许在多个 `try/catch/finally` 中各自拼装 report

## 第一阶段迁移顺序

建议按以下顺序推进，以降低回归风险。

### 1. 抽离 `workflow_progress.ts`

先把 progress bar 相关逻辑从 `workflow.ts` 抽出去。

这是最安全的一步，因为不会改变执行语义。

### 2. 抽离 `workflow_plan.ts`

把以下逻辑显式抽成计划层：

- 输出目录构建
- part 是否可处理
- part 的步骤定义

此时仍可暂时保留旧 executor。

### 3. 抽离 `workflow_tasks.ts`

把当前 `processPart()` 拆成具体步骤函数。

目标是消灭“大函数包办全部”的结构。

### 4. 引入 `workflow_state.ts`

用显式状态模型替换：

- `processedPartSettledResults`
- `completedPartCount`
- `isFinalized`
- `finalizeResultPromise`

### 5. 引入 `workflow_executor.ts`

把以下逻辑迁入执行器：

- 依赖判断
- 资源池判断
- 顺序推进
- 终态判断

这一步完成后，旧的 `processVideoPartTask()` 和 `finalizeVideoProcessingState()` 可以移除。

### 6. 替换旧 ordered runner 的直接业务用法

`concurrency.ts` 中的基础 limiter 仍可继续保留，但业务代码不应再直接依赖“什么时候调用 `runOrdered()`”这种脆弱语义。

## 第二阶段候选增强

第二阶段以下内容仅作记录和展开说明。

这些内容当前未获确认，不得执行。

如果未来需要进入第二阶段，必须由用户再次明确确认。

### 用户当前意图

用户当前只确认了第一阶段。

用户没有确认第二阶段。

因此：

- 第二阶段内容当前只是备选方向
- 不应在第一阶段实现中顺手带入
- 不应以“反正以后可能要做”为理由提前修改行为

## 第二阶段候选增强的展开说明

### 1. 支持“部分 part 失败但仍然产出部分 merge”

当前语义是：

- 任意一个 part 硬失败
- 整个 video 最终就是 `error`
- 且不 merge

未来候选增强可以考虑改成：

- 若有部分 part 成功生成了可用产物
- 允许视频整体进入一种新的汇总状态
- 例如 `partial`，或者仍记为 `error` 但允许附带部分 merge 结果

这会影响：

- `report.json` 的状态定义
- merge 决策逻辑
- shownotes 的内容完整性语义
- 后续 `stageEpisodes` 是否接受部分结果

这是产品语义变更，不属于第一阶段。

### 2. 支持 fail-fast 策略切换

当前系统接近于“尽量跑完后统一收尾”，但实现方式混乱。

未来候选增强可以考虑把策略显式化：

- `continue-on-error`
- `fail-fast-per-video`
- `fail-fast-global`

含义示例：

- `continue-on-error`：某个 part 失败后，其他 part 继续跑完，再统一归约
- `fail-fast-per-video`：某个 video 内 part 失败后，停止该 video 的后续可取消任务，但其他 video 不受影响
- `fail-fast-global`：任意 part 失败后，全局尽快停止

这会影响：

- executor 的取消模型
- in-flight task 的处理方式
- report 的时间点和终态语义

这也是独立产品策略，不属于第一阶段。

### 3. 支持 resume 单个失败 task

未来候选增强可以考虑：

- 针对单个 task 记录稳定 key
- 将 task 输入、输出和终态落盘
- 允许用户只重跑失败 task，而不是整个 video

这要求：

- 更稳定的 task identity
- 状态持久化
- executor 支持从部分已完成状态恢复

这会明显扩大系统复杂度，不属于第一阶段。

### 4. 提供更丰富的诊断输出

未来候选增强可以考虑输出更强的可观测性，例如：

- 某 task 当前在等待哪个依赖
- 某 task 当前在等待哪个资源池
- 某顺序任务被哪个前序 task 阻塞
- 某 video 当前 finalize 为什么还没发生

这类增强非常有价值，但前提是第一阶段先完成统一状态模型和执行器分层。

在没有统一状态模型之前，直接补诊断信息容易继续把脆弱实现复杂化。

### 5. 持续写增量 report，而不只写起始态和终态

未来候选增强可以考虑：

- 每当 task 终态变化，就更新一次 report
- 或生成单独的状态快照文件

收益：

- 外部观察更容易
- 崩溃时更容易看出停在哪一步

代价：

- 状态落盘频率增加
- 要明确 report 的“运行中 schema”
- 要考虑并发写入与一致性

这不是第一阶段必需项。

### 6. 引入取消与中断机制

未来候选增强可以考虑：

- 当用户手动停止某个 video 或全局运行时
- in-flight 的音频下载、LLM 调用、ffmpeg 切音是否允许取消

这要求：

- executor 具备取消传播机制
- task 实现支持中断
- 状态模型支持 `cancelled`

这是大改，不属于第一阶段。

### 7. 更细粒度的策略化配置

未来候选增强可以考虑把以下内容配置化：

- 是否允许部分 merge
- 哪类错误可降级为 skipped
- 哪类错误允许重试
- 每类 task 的最大尝试次数
- 顺序约束作用于哪些任务
- 各类资源池并发度
- report 粒度

第一阶段不应为了未来配置化而过度设计。

### 8. 支持单次运行内自动重试

未来候选增强可以考虑为失败 task 增加自动重试，但应明确限定为“单次 workflow 运行内的自动重试”，不要和“resume 单个失败 task”混为一谈：

- `retry`：同一次运行里，某个 task 失败后由 executor 自动再次调度
- `resume`：一次运行结束后，未来基于持久化状态只重跑失败 task

建议优先支持 `task` 级重试，而不是 `part` 级重试。

原因：

- 当前第一阶段的核心抽象是固定 task 图
- `part` 级重试会引入“已成功 task 是否重跑”的额外语义
- 容易造成重复下载、重复切音、产物覆盖和状态归约复杂化
- `task` 级重试与当前文档中的 plan / executor / state 分层更一致

因此，建议语义是：

- 每个 task 可以声明自己的最大尝试次数
- 某次 attempt 失败但未耗尽次数时，task 不进入终态
- executor 将该 task 重新放回可调度状态，等待下一次 attempt
- 只有 attempt 全部耗尽后，task 才进入最终 `failed`
- `part` 和 `video` 状态仍然只由 task 最终态归约，不额外引入“整 part 重跑一次”的语义

如未来确实要引入“一个 part 最多尝试几次”的产品语义，应单独设计 `part attempt` 模型，而不要把它隐含实现为当前 task 图上的一组特殊规则。

这会影响以下设计。

#### `TaskPlan`

建议补充重试策略字段，例如：

- `retryPolicy`

其语义至少应能表达：

- `maxAttempts`
- 是否允许重试，或哪些错误属于可重试错误

#### `TaskState`

建议补充 attempt 维度状态，例如：

- `attemptCount`
- `lastError`
- `lastStartedAtMs`
- `lastCompletedAtMs`

如果未来需要更强诊断能力，也可以进一步细化为 attempt 列表，但这不属于当前候选增强的最小必需集合。

#### `ExecutionEvent`

如果进入这一增强，当前事件模型也需要扩展。除了：

- `taskStarted`
- `taskSucceeded`
- `taskFailed`
- `taskSkipped`

还应考虑增加：

- `taskAttemptStarted`
- `taskAttemptFailed`
- `taskRetryScheduled`

其中：

- `taskFailed` 应保留为“重试次数耗尽后的最终失败”
- 单次 attempt 失败不应直接被视为 task 终态

#### executor 语义

executor 需要明确区分“attempt 失败”和“task 终态失败”：

- attempt 失败但仍可重试时，不释放顺序位给后继 ordered task
- 该 task 仍然阻塞依赖它的下游 task
- 只有 `succeeded`、`skipped` 或最终 `failed` 才算真正终态

这意味着顺序推进规则要保持一致：

- 顺序位推进依据的是 task 终态
- 不是某次 attempt 的临时失败

#### 状态归约语义

引入自动重试后，需要明确：

- `part` 不会因为某个 task 的单次 attempt 失败就立即进入 `failed`
- 只有某个关键 task 最终 `failed`，才会把 `part` 归约为 `failed`
- `video` 也只根据 task 最终态和 part 最终态做归约

#### 错误分类

自动重试不应做成模糊兜底，必须显式限定哪些错误允许重试。

建议至少明确：

- `MissingSubtitleError` 不重试，直接 `skipped`
- 配置错误、路径错误、schema 错误不重试，直接失败
- 网络抖动、临时下载失败、临时模型调用失败可重试

这是产品与执行语义上的增量，不属于第一阶段。

## 第二阶段边界声明

再次明确：

- 第二阶段所有内容当前都没有被确认。
- 第一阶段执行过程中，不允许顺手实现第二阶段语义。
- 如果未来要做第二阶段，必须先单独评审目标与行为变化。

## 当前建议结论

当前可执行的方向只有第一阶段：

- 先把 `workflow` 拆成计划、执行、状态、展示、报告几层
- 让调度器只处理稳定 task 图
- 不改变对外行为

第二阶段增强暂时只记录，不执行。
