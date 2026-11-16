# Delivery Loop 全局实施评估与后续执行契约

日期：2026-11-03。对应原始评估：2026-10-28-global-assessment.md；对应完整计划：../superpowers/plans/2026-10-28-global-reliability-plan.md。本报告描述已落地的实现及验证边界，不替代原计划的全局验收矩阵。

## 工程判断

保留 Skill → MCP → 确定性控制器 → 独立 Worker 的结构。当前主要问题是边界契约不足：模型结果被当作事实、Git index 被当作内容、状态写入被当作流程事务、进程 spawn 被当作执行准备完成。增加 Agent 角色或换一套编排框架都不能直接修复这些问题。

本轮采用三个约束：内容身份独立于 staging 和 commit；候选先验证再发布；外部动作必须有可重放的意图与结果。控制器继续拥有状态、验收和计量权威，Worker 仅提交候选结果。受监督的单机项目使用有条件改善；目前仍不能将其定义为无人值守生产级交付系统。

没有引入第二套 v2 controller，没有初始化当前目录的 Git，没有执行付费真实模型调用或发布。存在 release tgz 仍为历史版本，未覆盖它。

## 已实施的修正

| 领域 | 具体行为与意义 | 主要回归 |
| --- | --- | --- |
| 内容身份 | manifest 对实际文件字节、类型、模式和 symlink target 计算身份；staging、commit 相同内容不改变身份；排除 .delivery | content-snapshot-real-git.test.ts |
| 补丁完整性 | 临时 index 不改变真实 index；任务启动后冻结 seed index，staged 修改和新增也可导出；空 patch 可成功；二进制/删除/异常路径往返 | patch-roundtrip-real-git.test.ts、worktree-manager.test.ts |
| 候选集成 | 每次基于最新 accepted 创建独立 candidate；验证后更新 accepted pointer；失败保留候选；缓存重放校验内容和 artifact digest | patch-integration-adapter.test.ts、reliability.test.ts |
| 修复上下文 | debugger 获取失败实现而非空 baseline；保存 stdout/stderr、完整 findings、规格、需求、验收与决策答案；修复后原任务重验 | reliability.test.ts、reliability-real-git.test.ts |
| 验收 | 只读 reviewer/acceptance 不导出/应用 patch；禁止观察任务或 verifier 改源码；最终在最新内容重跑 mandatory AC 与全局矩阵；尊重预期非零退出码 | delivery-controller.test.ts、acceptance.test.ts |
| 故障分类 | verifier 的 error 阻断运行，不消耗代码修复链；环境修复后显式 resume 保留原 workspace；无法归因的最终失败阻断，不扩大 scope | reliability.test.ts |
| 人工决策 | 完整 blocker 与答案持久化；同任务全部问题回答后才就绪；取消后迟到答案不复活运行 | reliability.test.ts、recovery.test.ts |
| 进程管理 | Worker/verifier 共用 supervisor；TERM→grace→KILL；等待 close 和日志 flush；正常退出也清理同组残留后代；启动预中止不 spawn | process-supervisor.test.ts、codex-process-contract.test.ts |
| 启动准备 | detached parent 等待匹配 run_id 的 runtime_initialized IPC；错误、提前退出、错误身份和超时清理后返回明确错误 | detached-worker.test.ts |
| 用量 | 只信任测量 JSONL，忽略模型自报；失败/评审/异常已知值计入，0 与未知分离；status/certificate 暴露 usage_incomplete；任务局部上限不得突破配置上限 | codex-process-contract.test.ts、reliability.test.ts、tools.test.ts |
| 冻结能力 | Skill 全树字节/模式/路径/symlink 校验，拒绝外逃；角色分配冻结；安装 capabilities 删除后仍可从冻结 bundle 恢复 | skill-resolver.test.ts、runtime-factory.test.ts |
| 状态存储 | 文件 fsync+rename+目录 sync、revision、可选 expectedRevision；持久结构校验；运行路径拒绝 symlink/逃逸 | state-store.test.ts、evidence-ledger.test.ts |
| 队列 | QUEUED 不占 writer capacity；FIFO 准入；终态执行者退出前保留所有权；退出 drain、resume/answer 竞态回归 | run-manager-queue.test.ts |
| 查询/报告 | status 直接读 store，不触发 preflight/执行；返回 revision/blockers/error/用量；report 使用已解析仓库与真实 evidence/finalization journal | tools.test.ts、report-writer.test.ts |
| 最终交付 | per-run finalize lock 和 journal 绑定 action/snapshot/certificate；重复完成请求不执行；中断 commit/push 对账；拒绝他人同名 ref | finalizer.test.ts、run-manager-finalization.test.ts |
| 发布检查 | Schema 一致性、typecheck/build/Skills/tests、临时 npm pack、独立生产依赖安装、从解包安装的 launcher 完成 MCP stdio 9 工具握手 | scripts/verify-release.ts |

新增的真实 Git E2E 分别验证“错误实现→修复→评审→候选集成→最终验证→证书→全补丁在新 baseline 应用”和“两任务顺序集成后在最终合并内容重验早期 AC”。这些测试使用脚本化 Worker，不能证明真实模型服务的协议兼容性。

## 默认执行政策

新运行默认 container。必须配置本地已存在且以 digest 固定的镜像，不隐式 pull、不降级 host。容器参数限制网络、capabilities、用户、根文件系统、进程数、CPU/内存；source 副本排除 .git/.delivery 后以只读挂载，构建输出需指向 /tmp。没有实际 runtime 的本机只验证了缺环境时拒绝执行与 runtime error 分类，不能宣称隔离已实测有效。

trusted-host 需要显式配置，只提供环境过滤、临时 HOME 和进程管理；它仍拥有宿主用户可访问的文件权限。source 副本仍可能包含项目内秘密或忽略文件，不能把“无宿主 HOME”当作自动秘密隔离。

不支持的 worktree_isolation=false、batch review、custom provider 和忽略 required Skill 已明确拒绝。OpenSpec 当前是 Skill overlay 和 CLI preflight，尚无独立 lifecycle adapter。artifact acceptance 没有通用 provider 时明确缺证据。

## 仍需继续实施的完整方案

以下是系统职责与验收条件，不是研发阶段。既有计划仍适用，以下补充当前实现与目标的差距。

| 优先级 | 剩余契约 | 实施方案 | 可验收条件 |
| --- | --- | --- | --- |
| P1 | 仓库身份和旧执行者隔离 | 以 realpath Git common-dir 为 repo key，发放单调 epoch；状态、candidate publication、finalize 都校验当前 lease；gateway 只提交持久命令 | 两个 worktree 发起运行只有一个有效 writer；旧 epoch 复活后所有写入被拒绝 |
| P1 | 跨记录一致性 | 设计单 run envelope/事务日志，把 attempt、accepted pointer、task DONE、evidence/usage 引用、outbox 放在一次带 revision/epoch 的提交里；恢复从日志对账 | 在 result_saved、candidate_applied、checks_saved、publish/report 边界杀进程，重启两次不重复计量/应用/完成 |
| P1 | 调用身份与预算 | 请求/结果绑定 invocation/attempt/context/seed；调用前预留预算，结束按 measured usage 结算；未知用量停止继续派发或持久等待明确政策；按根任务限制修复链 | 迟到/错 attempt 结果拒绝；failed/blocked/reviewer/cancel 不漏计、不重复；新增 task ID 不能重置预算 |
| P1 | 验证隔离实测 | 在真实 Linux container runtime 上检查宿主 sentinel、common metadata、网络与凭据；绑定镜像/策略/命令摘要到 evidence；确认 cleanup 失败时不能假定容器已退出 | 攻击脚本不能修改宿主或控制状态；runtime/daemon 中断后容器清理结果明确；真实工具链可构建 |
| P1 | 完成证明 | 冻结 spec/graph/config/runtime bundle/report/patch 引用及摘要；完成在受 fence 事务内发布；artifact/manual/review 都具 producer/type/check/environment 绑定 | 任一引用被篡改不能 finalize；缺 mandatory evidence 不能 COMPLETED；恢复报告与证书一致 |
| P1 | 实际协议与恢复集成 | 授权环境执行付费受限 Codex smoke、独立安装包内 prepared run/restore/export；增加 detached queued run 在 gateway 退出后的完整进程测试 | 真实 output schema/JSONL/profile 权限验证通过；安装不依赖开发 cwd 或 devDependencies |
| P2 | 协议和迁移 | 独立严格 DraftPlan 与 persisted state schema，限制大小/路径；显式版本迁移、备份和幂等；submodule/LFS 支持或明确预检拒绝 | 未知/越界字段不静默吞掉；空契约不能交付成功；旧完成状态重验后才可信 |
| P2 | 故障策略收敛 | 将 code/review/environment/protocol/policy 分成结构化 failure；根任务统一预算与去重；baseline 对实际内容取证并制定既有失败政策 | environment/protocol 不转代码修复；重复同根失败阻断并保留诊断；baseline 内容引用真实 |
| P2 | 查询与审计 | revision cursor/watch、事件增量有界读取、日志体积上限和流式脱敏；完整 requirement→AC→check→snapshot→evidence 报告 | 多客户端无执行副作用；大日志不耗尽内存；报告实际动作与 journal 一致 |
| P2 | finalization 目标与恢复 | 授权绑定具体 mode/ref/remote；intent/result 更新目录持久化；外部 ref 变化显式冲突；明确无跨远端原子事务保证 | 重复 commit/branch/push 不产生额外副作用；同名他人 ref 不覆盖；不明远端状态先查询 |

现有 revision 与文件锁不能等价替代 epoch fencing；finalization 的幂等 journal 也不能替代跨 Git 与远端的事务。当前取消会等待本 controller 的活动调用结束；跨进程命令返回与后台所有后代确实退出之间还需要持久化生命周期协议。POSIX 同进程组监督不能隔离主动 setsid 脱离的进程，容器或更强的执行边界仍必需。

当前 completion 证书是对本次 snapshot/config/graph/evidence/artifact 的摘要记录，尚未把全部上下文、执行环境及报告字节绑定成不可变证明。未知 token 已正确标识，但尚无按调用去重、预留和硬停派策略，不能宣称硬预算严格成立。baseline 的普通测试失败仍记录后继续执行，没有完整的既有失败隔离政策。

## 验证与产物

最终完整检查通过 **197/197 个测试**、Schema 一致性、类型检查、构建、10 个 Skill、独立生产依赖安装和 MCP stdio 9 工具握手；官方生产依赖 audit 为 0 项已报告漏洞。完整日志见 `2026-11-03-release-verification.log`；源码摘要与变更清单见 `2026-11-03-implementation-results.json`。最新结果以 [verification-report.md](../verification-report.md) 为准。发布检查在临时目录生成和验证包后删除，不发布、不替换 release/delivery-loop-0.1.0.tgz。

本地平台为 macOS，增加的 Linux/macOS CI 工作流尚未在远端运行。不能把“CI 配置存在”表述为 Linux 已通过。没有在本轮调用付费真实 Codex Worker；外部成熟框架官方资料检索未获得可引用正文，因此本报告只使用本地代码与测试证据，不声称做过框架兼容性认证。
