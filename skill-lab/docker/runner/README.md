# Skill Lab Runner Image

该镜像只承担一次性 Qoder 开发任务和无网络隐藏检查，不运行长期服务，也不保存凭证。

构建：

docker build --pull=false -t visionowl-skill-lab-runner:0.1.0 docker/runner

基础验收：

docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true --network none visionowl-skill-lab-runner:0.1.0

正式实验由 `DockerQoderRunner` 启动镜像。不得把 Qoder PAT、百炼 API Key、仓库 Token 或隐藏测试复制进镜像层。
