# VisionOwl Skill Lab

Skill Lab 是 VisionOwl 的独立 Skill 评估与优化模块。当前已实现确定性评测地基、真实 Qoder 执行层、DeepEval/百炼语义评估和 Microsoft SkillOpt/百炼优化，包括版本化契约、实验状态机、可替换 Adapter、工作区隔离、质量门禁、版本库和端到端测试。

## 当前能力

- 接收候选 Skill 和冻结的开发集、验证集。
- 使用 Fake Adapter 做零模型成本回归，并使用真实 Qoder、DeepEval/百炼和 SkillOpt/百炼运行生产优化循环。
- 使用真实 Qoder Runner 在固定 Commit 的一次性工作区完成代码任务。
- 真实 Qoder 实验通过 DeepEval 调用百炼千问完成语义评估。
- 通过 Microsoft SkillOpt 调用独立的百炼 Optimizer，根据失败轨迹提出受限 Skill Patch。
- 每轮限制 Skill 修改数量，并记录修改原因和证据。
- 使用关键测试、综合分数和独立验证集决定是否发布。
- 保存 Skill 版本、实验报告、Diff 和本地 Artifact。
- 根据 Git base SHA 导出不包含 .git 历史的隔离源码。
- 在 Knowledge Generator 未完成时通过 Mock Producer 独立验收。

## 本地测试

在 skill-lab 目录执行：

PYTHONPATH=src python3 -m unittest discover -s tests -v

## Mock 闭环

在 skill-lab 目录执行：

PYTHONPATH=src python3 scripts/run_mock_experiment.py

命令会在本地临时目录运行候选 Skill 的基线评估、两轮优化和隐藏验证，并输出最终版本、分数、修改内容和报告位置。

## 模块边界

Skill Lab 是独立模块，通过版本化 Contract、Core 内部 API 与 Redis Stream 接入 VisionOwl。Knowledge Generator 只负责产出候选 Skills Bundle 和评测数据；Core 冻结候选版本、源码 Commit 与策略并投递命令；Skill Lab 消费命令、完成评测优化后回传状态、报告、Diff 与可选的新 Skills Bundle。Skill Lab 不直接访问 Core 数据库，也不修改 Knowledge Generator 内部状态。

## 真实 Qoder Runner

先用单任务冒烟验证真实 Qoder、隔离工作区和隐藏测试链路：

```bash
PYTHONPATH=src python3 scripts/run_qoder_smoke.py \
  --repository /path/to/VisionOwl-Codebase-Visualizer-Prototype \
  --hidden-tests-root tests/hidden/visionowl \
  --state-dir .skill-lab-state/qoder-smoke
```

该命令只执行开发集第一道任务。它适合先确认 Runner 基础设施正常，不会一上来启动完整基线、候选和验证循环。

当前已提供开发阶段的 `LocalQoderRunner`：Qoder 负责真实修改代码，DeepEval 通过百炼 Judge 负责语义评估，Microsoft SkillOpt 通过独立的百炼 Optimizer 生成有限 Patch。每次任务都会从固定 `baseSha` 导出不含 `.git` 的独立工作区；候选 Skill 和开发需求通过只读附件交给 Qoder；Qoder 退出后才把隐藏测试注入工作区；完成 Diff、范围和测试检查后销毁工作区。

`DockerQoderRunner` 保留给具备独立容器调度面的强隔离环境。当前 ECS 生产闭环使用常驻 Redis Worker 加 `LocalQoderRunner`：控制器从 Core 下载冻结 Commit 的源码归档，在自身临时目录重建一次性仓库，并通过 `setpriv` 将 Qoder 与隐藏检查降权到 `10001:10001`。该模式不挂载宿主 Docker Socket，不接触原始 Git checkout，任务结束后删除临时工作区。

## Docker Qoder Runner

生产执行器使用两个相互隔离的一次性容器：Qoder 容器只挂载固定 Commit 的工作区、只读任务附件和空配置目录；它退出并被强制删除后，控制器才注入隐藏测试，再启动 `network=none` 的检查容器。两类容器均启用只读根文件系统、非 root 用户、`cap-drop=ALL`、`no-new-privileges`、CPU/内存/PID/超时限制和最终强制清理。宿主机仓库、Git 历史、隐藏测试目录和 Docker Socket 均不挂入 Agent 容器。

真实运行默认要求镜像使用 `repository@sha256:digest` 或本机不可变的 `sha256:image-id` 固定版本，并通过环境变量注入 `QODER_PERSONAL_ACCESS_TOKEN`。Token 值不会进入 Docker argv、命令摘要或运行时元数据；Qoder 与测试输出在写入 Artifact 前还会执行二次脱敏。

```bash
PYTHONPATH=src python3 scripts/run_docker_qoder_experiment.py \
  --repository /path/to/repository \
  --hidden-tests-root tests/hidden/visionowl \
  --docker-image 'registry/visionowl-skill-lab-runner@sha256:...' \
  --state-dir .skill-lab-state/docker-experiment
```

本地临时镜像可显式增加 `--allow-unpinned-docker-image`，该选项不得用于生产环境。控制器与 Runner 推荐统一使用 UID/GID `10001:10001`；开发机不一致时可通过 `--docker-container-user "$(id -u):$(id -g)"` 指定当前用户。

控制器镜像定义在 `docker/controller`。它内置 Skill Lab、DeepEval、固定 Commit 的 Microsoft SkillOpt、Qoder CLI 与 Redis Worker。生产中它作为常驻消费进程读取 `skilllab:tasks`，每条消息只在 Core 收到合法终态后 ACK；进程异常时可通过 Consumer Group 和 `XAUTOCLAIM` 恢复未完成消息。构建与运行要求见 `docker/controller/README.md`。

运行环境需要安装并认证 `qodercli`。在 `skill-lab` 目录执行：

```bash
python3 -m pip install -e '.[evaluation]'
```

真实完整实验还需要通过环境变量注入百炼配置：

```bash
export DASHSCOPE_API_KEY='由 Secret Provider 注入的百炼 API Key'
export BAILIAN_BASE_URL='https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1'
export BAILIAN_JUDGE_MODEL='qwen-plus'
export BAILIAN_OPTIMIZER_MODEL='qwen-plus'
```

`DASHSCOPE_API_KEY` 也可以替换为 `BAILIAN_API_KEY`。Judge 与 Optimizer 可使用不同 API Key、端点和模型。凭证不得写入仓库、Fixture、Prompt 或实验产物。缺少依赖或百炼配置时，真实实验会明确失败，不会回退到 FakeJudge 或 FakeOptimizer。

然后在 `skill-lab` 目录执行：

```bash
PYTHONPATH=src python3 scripts/run_qoder_experiment.py \
  --candidate tests/fixtures/visionowl/candidate-qoder.json \
  --skill tests/fixtures/visionowl/initial-skill.md \
  --dataset tests/fixtures/visionowl/dataset-qoder.json \
  --repository /path/to/VisionOwl-Codebase-Visualizer-Prototype \
  --hidden-tests-root tests/hidden/visionowl \
  --state-dir .skill-lab-state/qoder-smoke \
  --max-rounds 2
```

真实模式会消耗 Qoder credit。`--repository` 指向本地 Git checkout，但 Runner 不会直接修改它，只使用 `git archive` 导出任务指定的历史 Commit。运行证据保存在 `state-dir/runner-artifacts`，包括 Prompt、Qoder 标准输出、标准错误、代码 Diff 和隐藏测试结果。

当前真实实验顺序为：初始 Skill 基线执行、确定性检查、DeepEval/百炼语义评分、有限 Skill Patch、全新工作区重做开发任务、独立验证任务、质量门禁。通过门禁的版本仍是候选版本，不应未经人工确认直接覆盖生产 Skill。

2026-08-09 已在 ECS 上完成第一道真实冒烟任务：Qoder 正常退出并创建 4 个模块文件，未修改允许范围外文件；3 项后置隐藏检查中，输入不可变通过，稳定顺序与结构化错误失败。该结果符合故意不完善的初始 Skill 预期，并证明失败规则能够被送入下一轮 Skill 优化。一次性容器与工作区均已清理，Prompt、Diff、Qoder 输出和检查日志已保留在独立 Artifact 目录。

同日已完成第一次完整真实优化闭环。系统先执行开发集与独立验证集基线，再根据开发集失败生成 2 条有限 Patch，分别用全新 Qoder 工作区重做开发任务和独立验证任务。候选版本 `0.1.0-opt.1` 通过门禁：开发集 `62.19 → 99.59`，验证集 `62.14 → 99.69`，关键失败均降为 0。四次 Qoder 调用合计约 132.08 credits，完整实验耗时约 6 分 57 秒。

同日已完成 Microsoft SkillOpt 与百炼 Optimizer 的真实冒烟验收。官方 SkillOpt 固定在 commit `47fe269d75d3def79ffd90236261d26d84868ae5`；它根据一条虚构失败轨迹提出“稳定排序”和“结构化错误”两条通用规则，VisionOwl Adapter 成功将其转换为带原因、证据引用和签名的受限 Patch。调用耗时约 6.9 秒，未使用 FakeOptimizer，也未上传本地仓库源码。

2026-08-10 已在 ECS 完成 Knowledge Generator → Core → Skill Lab → Core 的生产闭环验收：

- 部署目录为 `/opt/vo/skill-lab`，常驻进程为 `skill-lab-skill-lab-worker-1`。
- Knowledge Generator 运行 `437a46b7-0bf8-4aac-911b-e63095230730` 成功生成 Wiki、Skills、Manifest 与评测数据。
- Core 自动冻结候选 Skill 版本及 4 个历史 Commit 源码归档，并创建 Skill Lab 运行 `49a7a24d-7fd2-4758-9090-5ff61e71f2ad`。
- Skill Lab 对 3 个候选 Skill 执行真实 Qoder、DeepEval/百炼 Judge、Microsoft SkillOpt/百炼 Optimizer 和独立验证。
- 三个候选均未超过基线，质量门禁给出 `rejected`，旧版本保持不变；这证明系统不会把低质量优化结果自动发布。
- Core 收到完整终态，报告与 Diff 均已写入 Artifact Storage；报告可解析且不包含百炼、Qoder 或 Core 凭证字段。
- Redis Consumer Group 最终 `pending=0`、`lag=0`，没有遗留任务。
- 当前控制器镜像内 36 项测试全部通过。
