# Delivery Loop 项目审查（2026-10-28）

## 结论

项目选择确定性控制器、隔离 worktree、独立 Worker 和持久化验证证据，整体方向合理。但当前实现仍有影响默认交付、自动修复、崩溃恢复、验收收敛和安全隔离的严重问题，暂不适合宣称可在真实仓库中可靠无人值守交付。

这次发现的主要问题是模块间契约没有闭合：评审任务被当作代码补丁集成，失败代码没有交给修复任务，快照身份受 Git 索引变化影响，证据失效后没有相应的重验计划，恢复逻辑只恢复状态而没有恢复执行资源。

审查覆盖 `src/` 全部核心模块、配置与 Schema、现有测试、插件入口、设计与运维文档。当前目录没有 `.git`，因此这是文件快照审查，不能给出相对某个提交的差异结论。

## 验证范围和证据

本次实际执行：

- `npm test`：94 passed，0 failed。
- `npm run typecheck`：退出码 0。
- `npm run build`：退出码 0。
- `npm run verify:skills`：10 个 vendored Skills 通过检查。
- 在临时 Git 仓库中执行真实 worktree、diff、apply、snapshot 操作，Worker 使用确定性替身，复现脚本共覆盖 10 个场景。
- 核对发行包中的 controller、run-manager、worktree-manager 编译文件和 agent-result Schema，与本次构建结果一致；下述问题并非仅存在于未打包源码。

没有调用付费的真实 Codex Worker，没有执行远程 push、merge、部署，没有修改业务源码。新增文件仅为本审查报告、复现脚本和结果记录。构建命令更新了本地 `dist/`；抽查文件与现有发行包一致。

复现脚本：`docs/reviews/2026-10-28-audit-reproduce.mts`。

结果记录：`docs/reviews/2026-10-28-audit-results.json`。

从项目根目录运行：

```sh
./node_modules/.bin/tsx docs/reviews/2026-10-28-audit-reproduce.mts
```

脚本仅在系统临时目录创建 Git 仓库、测试文件和运行状态，不调用真实 Codex。为保留调查证据，临时仓库不会自动删除。

## 必须优先修复的 P1 问题

### P1-01：默认最终评审会因空补丁失败

位置：`src/controller/delivery-controller.ts:519`、`src/workspace/patch-integration-adapter.ts:61`、`src/workspace/patch-integrator.ts:79`。

所有角色都进入同一集成路径。`FINAL-REVIEW` 使用只读 reviewer，worktree 的继承内容已被 `git add -A` 放入索引，因此评审完成后 `git diff` 生成空的任务增量。代码仍调用 `git apply`，Git 拒绝空补丁，随后把成功的评审转换为 `test_failure` 修复任务。

真实 Git 复现：第一轮 `TASK-1=DONE / FINAL-REVIEW=READY`；第二轮 `FINAL-REVIEW=FIX_REQUIRED`，新增 debugger 修复任务。`review.final_review` 默认开启，因此普通成功实现也会触发此问题。无需改代码的分析、评审任务同样受影响。

建议：明确区分代码变更任务与只读证据任务。只读任务绑定被评审内容快照，产生评审证据，不进入补丁应用流程；合法空增量应有独立处理路径。不要用关闭默认评审来掩盖问题。

### P1-02：修复任务丢失了真正需要修复的代码

位置：`src/controller/delivery-controller.ts:313`、`:686`、`:718`，以及 `createFixTask`。

任务在集成前验证失败时，其实现只存在于失败 worktree 中。`applyFix` 虽接收 `workspace`，却不保存或使用它；新修复任务仍从 integration worktree 或原始 baseline 创建。测试和评审的问题描述也被压缩成指纹或 finding ID，没有成为修复请求的上下文。

真实 Git 复现：implementer 创建 `src/feature.txt` 后验证失败，下一轮 debugger 的 worktree 中没有该文件；debugger 的 objective 仍为原任务标题。

影响：自动修复实际上可能在修复旧版本，无法针对失败实现复现问题；连续“修复”消耗预算，却不使失败代码收敛。

建议：保存失败 attempt 的内容快照/增量及结构化 FailureRecord，修复任务明确引用该失败快照、失败命令、退出码、stdout/stderr、完整 finding 和目标验收条件。修复前先复现同一失败。

### P1-03：崩溃恢复和人工决策恢复会撞上已有 worktree

位置：`src/controller/recovery.ts:9`、`src/workspace/worktree-manager.ts:70`、`src/controller/delivery-controller.ts:964`。

恢复把任务改回 READY，却保留同一个 attempt。`prepare` 每次无条件执行 `git worktree add`，路径仍为 `<task>-attempt-<attempt>`，实际中断时该目录已经存在。人工 blocker 的 `respond` 也直接恢复 READY，存在同一问题。

真实 Git 复现：RUNNING 任务恢复后为 READY、attempt=0，下一次 prepare 报 `fatal: ...TASK-1-attempt-0 already exists`。另一个复现中，回答人工问题后第二次 Worker 根本没启动，同样先在 worktree 创建处失败。

建议：恢复应协调状态、attempt、现有目录、Git worktree 登记、子进程和集成结果。选择验证后复用原 attempt，或分配新的 attempt 并保留旧证据；若集成已发生，应先核对是否已应用，避免重复执行。

### P1-04：导出补丁会改变已发布的快照身份

位置：`src/workspace/patch-integration-adapter.ts:75`、`src/workspace/patch-integrator.ts:33`、`src/workspace/repository-context.ts:81`。

集成逻辑先计算 snapshot，然后导出累计 patch。导出为纳入新增文件执行 `git add -N`，改变 Git index/status，而 snapshot 的哈希包含原始 porcelain status。即使文件字节没有变化，刚刚存储的 integration snapshot 也已不再对应当前工作区。

真实 Git 复现：新增文件的任务在关闭最终评审以隔离问题后进入 COMPLETED，但 `persistedSnapshot != actualSnapshot`。`delivery_finalize` 又会重算快照，所以正常交付也可能被判为代码发生变化。seed 中的 `git add -A` 同样会让相同代码因暂存状态不同而产生不同身份。

建议：使用稳定的内容树摘要，覆盖路径、类型、模式和字节；将 Git 索引布局与被验证代码身份分开。补丁导出应无副作用，或在任何必要索引变更之后重新捕获和发布快照。验证及最终交付必须绑定同一内容身份。

### P1-05：任务验收证据失效后，没有生成正确的最终重验

位置：`src/controller/delivery-controller.ts:790`、`:833`、`:868`。

最终验证仅运行 `config.verification.commands`，不从 mandatory acceptance 中编译待执行命令。后续任务改变 integration snapshot 后，早期任务的证据会按设计失效；若对应验收命令只写在 task/acceptance 中，它不会自动重跑。随后 acceptance-gap 又从最后一个任务复制修复任务，可能复制完全无关的 acceptance IDs 和 verification commands。

真实 Git 复现：TASK-1 执行验收命令并集成，TASK-2 随后集成；账本只有 TASK-1 在旧快照上的证据。系统没有在最终快照重跑该命令，而是生成 `acceptance_ids=[] / verification_commands=[]` 的修复任务。

建议：单独建立确定性 VerificationPlan，按“最终内容快照 × mandatory acceptance”求缺失证据，先在最终集成树上重验。只有实际失败才创建代码修复；修复的 scope 和上下文应由具体失败决定，不能直接复制最后一个任务。

### P1-06：Worker 没有完整规格与人工决策上下文

位置：`src/controller/delivery-controller.ts:629`、`:655`、`:335`、`:981`。

run-factory 已保存 spec.md 和 requirements.json，但 AgentRequest 只包含任务标题、需求/验收 ID，`context_files` 固定为 `['AGENTS.md']`。没有规格路径、需求描述、验收描述、决策记录、完整评审发现。blocker 只保存 ID 与受影响任务，问题和选项未持久化；用户回答只写到事件中，下次 Worker 请求没有带入回答。

复现中，implementer 和 debugger 的 context_files 都仅为 AGENTS.md，冻结规格中有明确行为约束，但请求中没有该内容或其文件路径。

影响：fresh-context Worker 无法可靠知道被批准的具体需求；人工回答不能可靠改变下一次执行；重启后调用方也难以从 status 获得完整待决问题。

建议：构建冻结、可追溯的 TaskContextBundle，包含规格、当前任务细节、关联需求/验收、依赖产物、失败记录及已答决策。完整保存 WorkerResult、DecisionBlocker、DecisionResponse，并提供给后续请求与状态工具。

### P1-07：仓库队列可能永久互相阻塞

位置：`src/runtime/run-manager.ts:23`、`:53`、`:130`。

`activeStatus` 把 QUEUED 算作占用执行名额。若两个 run 都在排队，wake 任意一个都会发现另一个“active”，又把自己放回队列。完成已有运行后，也没有仓库队列调度器自动唤醒下一项。start 在获取仓库锁之前已创建 PLANNING 状态，两个并发 start 还可能同时看见彼此而都进入 QUEUED。

复现：run-1 已 COMPLETED，run-2/run-3 均 QUEUED，依次执行 wake 后两者仍 QUEUED，仓库没有实际运行者。

建议：区分“等待者”与持有仓库执行租约的运行；在同一仓库锁事务中完成选取、占位和出队。完成、取消、阻塞等释放租约事件需要触发队列推进；恢复也要走同一准入规则。

### P1-08：验证命令仍可越过 Worker 的安全边界

位置：`src/verification/command-runner.ts:31`、`:63`。

验证命令直接由宿主 `/bin/sh` 执行，只有环境变量过滤，没有独立操作系统隔离。Worker 能修改被测试脚本，控制器随后用更宽权限执行这些脚本。允许环境中还包含 HOME、配置目录等，过滤任意 secret 环境变量不能限制文件读取和网络访问。

安全复现只使用无害标记文件：cwd 在临时测试仓库，验证命令成功写入了仓库外的另一个临时目录。

这是已有文档承认的残余风险，本次确认仍然存在。对于“允许模型生成代码后自动运行”的产品，这属于实际执行信任边界。

建议：让验证在不高于 Worker 的沙箱/容器中运行，明确挂载、可写路径、凭据和网络权限；控制状态与证据存储应在被执行代码不可写的边界外。可信配置命令与不可信仓库脚本须分别建模。

### P1-09：失败和部分评审调用绕过 token 预算

位置：`src/controller/delivery-controller.ts:349`、`:389`、`:463`，`src/workers/codex-exec-adapter.ts:166`。

controller 在 failed/blocked 和 scope/output 违规等分支提前返回，之后才计费；独立 task reviewer 的 token_usage 没有计入。真实适配器在进程失败时又返回 token_usage=0，没有从已产生的事件恢复使用量。即使 Worker 已报告使用量，预算仍可能完全看不到。

复现：预算 50，两个失败 Worker 分别报告 100 tokens；两轮后累计报告 200，但持久化使用量仍为 0，run 仍为 RUNNING。

建议：调用结果进入任何业务分支前统一持久化计量，包含成功、失败、阻塞、评审和取消。预算在派发前核查，并尽可能对在途并发调用保留额度；不可测量时明确标记未知，不能把未知视为零。

## P2 问题及尽快优化项

1. **新 run 输入可预置 DONE，验收可在无证据时通过。** `src/domain/schemas.ts:235` 仅检查一般图结构，未限制新运行的初始状态；`src/controller/acceptance.ts:15` 在没有 acceptance 时用 DONE 任务代替证据。复现中，预置 DONE 的任务图校验成功，空 evidence 得到 PASSED。建议区分初始计划输入和可信恢复状态的 Schema；有交付需求时要求明确的验收覆盖和证据。此项影响最终完成语义，修复验证模型时应一并处理。

2. **若干配置项没有接入运行路径。** `src/runtime/runtime-factory.ts:133` 创建适配器只传 schemaPath，未传入 `config.workers.*_profile`；SkillResolver 也未使用配置中的 profiles_file/role_skills_file；任务 max_attempts 没有受 runtime.max_task_attempts 约束。配置看似生效会误导模型选择、预算和能力策略。建议逐字段建立可验证的生效表；未实现的选项拒绝或移除。

3. **运行恢复仍依赖当前安装的 Skill 定义。** `src/runtime/runtime-factory.ts:50` 每次 create 都从当前插件解析角色映射和 hash，重写 runtime-bundle.json；`src/capabilities/skill-resolver.ts:220` 对已存在快照不覆盖。升级后可能出现新 hash 与旧快照冲突，或角色映射变化导致行为漂移。resources 也只验证路径，未验证资源内容摘要。建议从创建时冻结的 bundle 恢复，完整锁定资源和映射；升级另走显式迁移。

4. **Worker 故障证据默认丢失。** `src/workers/codex-exec-adapter.ts:166` 非零退出仅返回退出码；finally 默认删除 stderr/JSONL。controller 没有完整持久化 AgentResult，status 也不包含 last_error。认证、Schema、配额、沙箱、CLI 故障会退化为无法诊断的重复重试。建议持久化脱敏后的 WorkerResult、事件、退出原因与证据路径，区分环境故障、产品决策和可自动修复的代码失败。

5. **长任务日志缺少资源上限。** `src/verification/command-runner.ts:70` 把 stdout/stderr 持续拼接到内存，`src/state/state-store.ts:146` 每次 readEvents 读取并解析完整事件文件后才取最后 N 条。预算中的长时间运行会放大内存、磁盘和状态查询成本。建议流式日志写入、输出配额/截断策略、增量事件游标和定期归档。

另外，Codex 适配器 abort 目前发送 SIGTERM 后立即返回，并没有等待进程退出，取消分支也没有立即安排同超时路径一致的升级终止；不响应 SIGTERM 的进程可能继续存活到原始 timeout。建议在进程适配器专项中加入真实子进程测试，本次未用真实进程复现该分支，不计入已动态确认的 P1 数量。

## 测试为何没有检出这些问题

`tests/runtime/run-manager-e2e.test.ts:65` 的 Git 替身把所有 apply 当作成功，diff 固定为空；Worker 也不产生真实代码。这验证了控制流的理想路径，但无法验证 worktree 创建冲突、空 patch、Git index 与内容快照关系。大部分控制器测试也固定返回同一个 snapshot ID，使证据失效场景无法出现。

建议保留现有单元测试，同时增加少量高价值的真实边界测试：

- 真实 Git + 确定性 Worker：默认最终评审、无变更任务、新增/删除/二进制文件、顺序与并行任务。
- 在 RUNNING、VERIFYING、REVIEWING、INTEGRATING 各阶段中断，重启后验证代码、状态与证据一致。
- 失败实现进入 debugger 后先复现同一失败；人工回答在下一次请求可见。
- 早期验收证据在后续集成后失效，最终重验正确执行。
- 两个以上排队运行出队、取消、恢复与并发 start。
- 成功/失败/阻塞/评审调用的统一预算核算。
- 少量真实 Codex smoke：结果 Schema、CLI 事件和计量格式、角色权限、故障日志。

## 建议的实施顺序

1. **先形成真实可完成的纵向闭环。** 修复 P1-01/02/03/04，加入真实 Git 的“实现 → 失败 → 修复 → 评审 → 完成 → 恢复”测试。默认行为必须先稳定。
2. **补齐任务上下文和最终验收模型。** 处理 P1-05/06 与无证据完成语义，使 Worker 知道要做什么，控制器知道拿什么证明完成。
3. **收紧调度、预算与执行边界。** 处理 P1-07/08/09；明确单仓库执行租约、验证隔离和所有调用的资源计量。
4. **再改善维护性和扩展性。** 从 1089 行 controller 中逐步抽出 AttemptExecutor、RepairPlanner、AcceptanceVerifier、DecisionStore，保留状态机为唯一业务状态入口。先用边界测试约束行为，再拆模块，避免一次性重写。

不建议此时增加更多角色、Provider 或远程调度功能。先把内容快照、attempt、证据、决策和预算这五个基础契约变成可独立验证、可恢复的对象，现有架构才有可靠扩展的基础。
