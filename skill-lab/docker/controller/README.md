# Skill Lab Controller Image

该镜像基于已验收的 `visionowl-skill-lab-runner:0.1.0` 基础层构建，是 Skill Lab 的常驻 Redis Worker，不对外暴露业务 API。它负责：

- 从 Core 获取冻结的候选 Skill、评测数据和源码归档。
- 在一次性工作区中以降权用户执行 Qoder。
- 在 Qoder 退出后注入并运行隐藏检查。
- 调用 DeepEval/百炼 Judge 与 Microsoft SkillOpt/百炼 Optimizer。
- 将阶段状态、报告、Diff 和可选的新 Skills Bundle 回传 Core。
- 通过 Redis Consumer Group 恢复未 ACK 的任务。

镜像内不包含仓库源码、Qoder PAT、百炼 API Key 或 Docker Socket。运行时只挂载 Skill Lab 状态卷，并通过 Secret/环境变量注入服务凭证。当前 ECS 部署不挂宿主 Docker Socket。

## 构建

在 `skill-lab` 根目录执行：

```bash
docker build \
  -f docker/controller/Dockerfile \
  -t visionowl-skill-lab-controller:0.1.0 \
  .
```

第三方依赖与本地源码分层安装，因此普通源码修改会复用包含固定 SkillOpt Commit 的依赖层。构建完成后应记录 `docker image inspect` 返回的不可变镜像 ID。

## 运行要求

- 控制器需要以 root 启动，仅用于通过 `setpriv` 将 Qoder 与隐藏检查降权到 `10001:10001`；模型执行过程不具有 root 权限。
- 不挂载 `/var/run/docker.sock`、宿主源码仓库或隐藏测试目录。
- 源码由 Core 以固定 Commit 归档提供，控制器只在任务临时目录中重建评测仓库。
- 百炼与 Qoder 凭证仅以环境变量名传入，不写入命令参数或文件。
- Redis Stream 为 `skilllab:tasks`，Consumer Group 为 `skill-lab-workers`；仅在 Core 接收终态后 ACK。
- 生产部署入口为 `deploy/compose.ecs.yaml`，状态保存在命名卷 `skill-lab-data`。
