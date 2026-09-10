# Skill Lab 开发与落地方案

## 1. 模块定位

Skill Lab 是 VisionOwl 的 Skill 评估与优化模块。它不负责生成初始知识，而是回答两个问题：

- 候选 Skill 能否让 Agent 更好地完成真实代码任务。
- 优化后的 Skill 是否稳定优于当前版本，值得发布。

只有开发集、独立验证集和质量门禁全部通过，系统才发布新版本；否则保留原版本。

## 2. 最终架构

系统由三个独立模块组成：

| 模块 | 职责 |
| --- | --- |
| Core | 保存项目、知识资产和版本；冻结运行输入；投递任务；接收状态与产物 |
| Knowledge Generator | 从 Evidence 生成 Wiki、候选 Skills、Manifest 和评测数据集 |
| Skill Lab | 执行代码任务、评分、优化、独立验证和发布门禁 |

模块间不共享内部数据库表：

1. Knowledge Generator 将知识资产上传给 Core。
2. Core 固定候选 Skill 版本、策略及历史 Commit，并向 Redis Stream skilllab:tasks 投递命令。
3. Skill Lab Worker 通过 Consumer Group 消费命令，从 Core 下载输入。
4. Skill Lab 将进度、报告、Diff 和可选的新 Skills Bundle 回传 Core。
5. Core 持久化结果并通知应用端刷新。

## 3. Skill Lab 内部流程

一次运行包含以下步骤：

1. 校验 Core 下发的命令、候选 Bundle、checksum 和评测数据集。
2. 下载各任务对应的固定 Commit 源码归档。
3. 重建不含 Git 历史的一次性评测仓库。
4. 使用当前 Skill 驱动 Qoder 完成开发集任务，形成基线。
5. 收集代码 Diff、变更范围、命令、耗时和确定性检查结果。
6. 使用 DeepEval 调用百炼 Judge，评价需求符合度、实现质量和 Skill 指导效果。
7. 使用 Microsoft SkillOpt 调用百炼 Optimizer，根据失败轨迹提出有限 Patch。
8. 用新 Skill 在全新工作区重做开发任务，并执行未参与优化的验证集。
9. Quality Gate 比较基线与候选分数、关键检查和越界修改。
10. 通过则上传新 Skills Bundle；未提升则返回 rejected，绝不覆盖原版本。

## 4. 核心实现

| 组件 | 实现 |
| --- | --- |
| Worker | Redis Stream Consumer Group、XAUTOCLAIM、终态后 ACK |
| Core Client | 下载冻结输入，上报进度，上传 Artifact，提交终态 |
| Bundle Adapter | 解析和重新构建 Wiki/Skills ZIP，防止路径穿越 |
| Repository Fixture | 根据源码归档重建历史 Commit 和隐藏验收条件 |
| Qoder Runner | 一次性工作区、进程组超时、Diff 与范围采集 |
| Deterministic Evaluator | 编译、测试、隐藏检查、允许目录和禁止目录校验 |
| Semantic Judge | DeepEval G-Eval 加百炼千问，输出分数、原因和证据 |
| Optimizer | 固定 Commit 的 Microsoft SkillOpt 加百炼千问 |
| Patch Validator | 每轮最多修改 2 至 3 处，拒绝删除、重复和无证据修改 |
| Quality Gate | 独立验证集、关键检查、回归和综合分数门禁 |
| Artifact Publisher | 输出报告、Skill Diff 和通过门禁后的完整 Skills Bundle |

## 5. 安全边界

- Core 只提供固定 Commit 的源码归档，不提供整个 Git 历史。
- Qoder 和隐藏检查通过 setpriv 降权为 10001:10001 执行。
- Qoder 退出后才注入隐藏检查，避免根据测试答案写死实现。
- 生产 Worker 不挂载宿主 Docker Socket，也不读取宿主代码目录。
- Qoder、百炼和 Core 凭证只在运行时注入，不进入 Prompt、argv 或 Artifact。
- 输出写入前进行凭证与本机路径脱敏。
- Skill Lab 不直连 Core PostgreSQL，只通过内部 API 交互。
- Redis 消息只在 Core 接收合法终态后 ACK；进程异常可恢复 pending 消息。

## 6. 实际开发中的关键修正

### 从独立 Demo 改为生产 Worker

早期方案把 Controller 设计为一次性作业。实际组装后改为常驻 Redis Worker，原因是它需要可靠消费、断点恢复、状态回调和统一部署，而不是由 Core 临时启动进程。

### 生产配置必须进入测试

execution_user 只在 ECS 启用，首次联调暴露 re 未导入。修复后增加合法与非法 UID:GID 回归测试，避免只测试默认配置。

### 只使用 DeepEval 公开 API

DeepEval 4.1.6 删除了旧内部参数 _log_metric_to_confident。Judge 改为只调用公开的 measure(test_case)，并增加签名兼容测试。

### 依赖层与源码层分离

原 Dockerfile 在安装依赖前复制 src，任何源码修改都会重新从 GitHub 下载 SkillOpt。现已先安装固定第三方依赖，再单独安装本地包，使源码重建能够复用依赖层。

### rejected 是正常结果

优化器运行成功不等于必须发布。候选分数下降或未通过验证时，正确行为是生成报告并拒绝升级，而不是强行产出“优化版”。

## 7. 部署形态

ECS 部署目录：

- Core：/opt/vo/cloud-backend
- Knowledge Generator：/opt/vo/knowledge-generator
- Skill Lab：/opt/vo/skill-lab

常驻容器：

- infra-cloud-1
- infra-worker-1
- infra-postgres-1
- infra-redis-1
- knowledge-generator-knowledge-generator-1
- skill-lab-skill-lab-worker-1

Skill Lab 使用独立状态卷，不暴露公网端口。Core 是三个模块之间唯一的控制面与数据入口。

## 8. 最终验收

2026-08-10 已完成真实 Knowledge Generator → Core → Skill Lab → Core 闭环：

- Knowledge Generator 成功生成 Wiki、3 个候选 Skill、Manifest 和开发/验证数据集。
- Core 成功冻结 4 个历史 Commit 源码归档并自动创建 Skill Lab 任务。
- Skill Lab 使用真实 Qoder、DeepEval/百炼和 SkillOpt/百炼完成 3 个 Skill 实验。
- 基线平均分为 27.67，候选最终平均分为 26.33，三个候选均为 no_improvement。
- Quality Gate 正确返回 rejected，没有创建输出 SkillVersion，也没有覆盖当前版本。
- Report 与 Diff 已写入 Artifact Storage，且未发现 Qoder、百炼或 Core 凭证字段。
- Redis 最终 pending=0、lag=0。
- 任务结束后无 Qoder 进程、一次性工作区或任务容器残留。
- Knowledge Generator 12 项测试、Core 4 项集成测试、Skill Lab 镜像内 36 项测试通过。

## 9. 完成标准

- 已支持 B 自动触发 C，并由 Core 统一维护状态。
- 已支持真实 Qoder 执行、DeepEval Judge 和 SkillOpt 优化。
- 已支持开发集、独立验证集和发布门禁。
- 已支持 accepted 与 rejected 两类终态协议。
- 已支持报告、Diff、版本引用和失败原因追溯。
- 已完成 ECS 部署、真实任务验收和运行时清理检查。

后续增强不阻塞当前模块使用：扩大历史评测集、将大产物切换到 OSS、增加 Skill 版本对比与人工审批界面。
