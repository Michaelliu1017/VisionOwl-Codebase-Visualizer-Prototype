#!/usr/bin/env bash
# ── Runner 执行步骤（spec §7.2）────────────────────────────────────────
#  1 浅克隆 + checkout 精确 SHA
#  2 阶段一：Fact Index v2 + graph.base.json（零 credit）
#  3 阶段二：模块 Agent 并行分析，独立输出模块结果
#  4 阶段三：全局 Agent 汇总并提交 graph-patch.json
#  5 Patch 校验、overlay 合并与语义质量门禁
#  6 产出 impact.json / meta.json / analysis-summary.json，容器退出即销毁
#
# 入参全部来自环境变量：REPO BRANCH COMMIT_SHA BASE_SHA JOB_TYPE PROJECT_ID MAX_TURNS
#                      GIT_TOKEN QODER_PERSONAL_ACCESS_TOKEN（运行时注入，不落盘）
set -euo pipefail

REPO_DIR="${REPO_DIR:-/workspace/repo}"
OUT_DIR=/workspace/out
export REPO_DIR OUT_DIR
mkdir -p "$OUT_DIR"

log() { echo "[runner] $*"; }
runner_stage() {
  printf '%s' "$1" > "$OUT_DIR/runner-stage"
}
chat_stage() {
  [ "${RUN_MODE:-analyze}" = "chat" ] || return 0
  printf '%s' "$1" > "$OUT_DIR/chat-stage"
}
cleanup_source() {
  if [ "${SOURCE_PREPARED:-0}" != "1" ] && [ "${EXPORT_SOURCE_CACHE:-0}" != "1" ]; then
    rm -rf "$REPO_DIR"
  fi
}
# 日志脱敏：任何 token 都不得出现在输出里
scrub() { sed -E 's#x-access-token:[^@]*@#x-access-token:***@#g; s#(gh[pousr]_)[A-Za-z0-9]{10,}#\1***#g'; }

: "${REPO:?缺少 REPO}"
: "${BRANCH:?缺少 BRANCH}"
JOB_TYPE="${JOB_TYPE:-full}"
MAX_TURNS="${MAX_TURNS:-50}"
PROJECT_ID="${PROJECT_ID:-unknown}"
REPOSITORY_ID="${REPOSITORY_ID:-${REPO}}"
COMMIT_SHA="${COMMIT_SHA:-}"
BASE_SHA="${BASE_SHA:-}"
SOURCE_PREPARED="${SOURCE_PREPARED:-0}"
EXPORT_SOURCE_CACHE="${EXPORT_SOURCE_CACHE:-0}"

[ "$SOURCE_PREPARED" != "1" ] || [ "$EXPORT_SOURCE_CACHE" != "1" ] || {
  log "SOURCE_PREPARED 与 EXPORT_SOURCE_CACHE 不能同时启用"
  exit 2
}

# ── 1 克隆 ────────────────────────────────────────────────────────────
if [ "$SOURCE_PREPARED" = "1" ]; then
  chat_stage "cache_hit"
  runner_stage "cache_hit"
  [ -d "$REPO_DIR" ] || { log "源码缓存目录不存在"; exit 2; }
  if [ -s "$REPO_DIR/.visionowl-commit" ]; then
    RESOLVED_SHA=$(cat "$REPO_DIR/.visionowl-commit")
  elif [ -d "$REPO_DIR/.git" ]; then
    RESOLVED_SHA=$(git -C "$REPO_DIR" rev-parse HEAD)
  else
    log "源码缓存缺少 commit 标记"
    exit 2
  fi
  log "复用源码缓存 github.com/${REPO} @ ${RESOLVED_SHA}"
else
  chat_stage "preparing_source"
  if [ -n "${GIT_TOKEN:-}" ]; then
    CLONE_URL="https://x-access-token:${GIT_TOKEN}@github.com/${REPO}.git"
  else
    CLONE_URL="https://github.com/${REPO}.git"
  fi

  # github.com:443 在部分 ECS Docker 出口被阻断；先快速尝试 Git，失败立即切换
  # GitHub 官方 codeload/API 通道，避免在容器内长时间等待。
  GIT_OPTS=(-c http.version=HTTP/1.1 -c http.postBuffer=524288000 -c core.compression=0 \
            -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=40)
  CLONED=""
  runner_stage "checking_repository"
  if timeout 8 git "${GIT_OPTS[@]}" ls-remote "$CLONE_URL" HEAD >/dev/null 2>&1; then
    rm -rf "$REPO_DIR"
    runner_stage "cloning_repository"
    log "Git 通道可用，克隆 github.com/${REPO} @ ${BRANCH}"
    if git "${GIT_OPTS[@]}" clone --depth=50 --single-branch --branch "$BRANCH" \
         --filter=blob:limit=2m "$CLONE_URL" "$REPO_DIR" 2>&1 | scrub; then
      CLONED=1
    fi
    if [ -z "$CLONED" ]; then
      rm -rf "$REPO_DIR"
      if git "${GIT_OPTS[@]}" clone --depth=50 --single-branch --branch "$BRANCH" \
           "$CLONE_URL" "$REPO_DIR" 2>&1 | scrub; then
        CLONED=1
      fi
    fi
  else
    log "Git 通道 8 秒内不可达，切换 GitHub 官方源码归档"
  fi

  if [ -n "$CLONED" ]; then
    git -C "$REPO_DIR" config --local --unset-all remote.origin.url || true
    git -C "$REPO_DIR" remote set-url origin "https://github.com/${REPO}.git"
    if [ -n "$COMMIT_SHA" ]; then
      if ! git -C "$REPO_DIR" checkout --detach "$COMMIT_SHA" 2>&1 | scrub; then
        log "目标 SHA 不在浅克隆内，尝试精确抓取 ${COMMIT_SHA}"
        git -C "$REPO_DIR" fetch --depth=1 origin "$COMMIT_SHA" 2>&1 | scrub
        git -C "$REPO_DIR" checkout --detach "$COMMIT_SHA" 2>&1 | scrub
      fi
    fi
    RESOLVED_SHA=$(git -C "$REPO_DIR" rev-parse HEAD)
    printf '%s' "$RESOLVED_SHA" > "$REPO_DIR/.visionowl-commit"
  else
    runner_stage "downloading_archive"
    if [ -z "$COMMIT_SHA" ]; then
      COMMIT_SHA=$(python3 - "$REPO" "$BRANCH" "${GIT_TOKEN:-}" <<'PY'
import json, sys, urllib.parse, urllib.request
repo, branch, token = sys.argv[1:]
url = f"https://api.github.com/repos/{repo}/commits/{urllib.parse.quote(branch, safe='')}"
request = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "VisionOwl-Runner"})
if token:
    request.add_header("Authorization", f"Bearer {token}")
with urllib.request.urlopen(request, timeout=15) as response:
    print(json.load(response)["sha"])
PY
      )
    fi
    ARCHIVE_READY=""
    for ATTEMPT in 1 2 3; do
      [ "$ATTEMPT" -eq 1 ] || { runner_stage "waiting_repository"; sleep 10; runner_stage "downloading_archive"; }
      rm -rf "$REPO_DIR"
      if python3 - "$REPO" "$COMMIT_SHA" "$REPO_DIR" "${GIT_TOKEN:-}" <<'PY'
import io, pathlib, shutil, sys, urllib.request, zipfile
repo, commit, destination, token = sys.argv[1:]
url = f"https://codeload.github.com/{repo}/zip/{commit}"
request = urllib.request.Request(url, headers={"User-Agent": "VisionOwl-Runner"})
if token:
    request.add_header("Authorization", f"Bearer {token}")
with urllib.request.urlopen(request, timeout=60) as response:
    archive = zipfile.ZipFile(io.BytesIO(response.read()))
root = pathlib.Path(destination).resolve()
root.mkdir(parents=True, exist_ok=True)
for member in archive.infolist():
    parts = pathlib.PurePosixPath(member.filename).parts[1:]
    if not parts:
        continue
    target = (root.joinpath(*parts)).resolve()
    if target != root and root not in target.parents:
        raise RuntimeError("archive contains unsafe path")
    if member.is_dir():
        target.mkdir(parents=True, exist_ok=True)
        continue
    target.parent.mkdir(parents=True, exist_ok=True)
    with archive.open(member) as source, target.open("wb") as output:
        shutil.copyfileobj(source, output)
(root / ".visionowl-commit").write_text(commit, encoding="utf8")
PY
      then
        ARCHIVE_READY=1
        break
      fi
      log "源码归档下载失败（${ATTEMPT}/3）"
    done
    [ -n "$ARCHIVE_READY" ] || { log "Git 与源码归档通道均不可用"; exit 2; }
    RESOLVED_SHA="$COMMIT_SHA"
    log "源码归档准备完成 github.com/${REPO} @ ${RESOLVED_SHA}"
  fi
fi

runner_stage "source_ready"

[ -z "$COMMIT_SHA" ] || [ "$RESOLVED_SHA" = "$COMMIT_SHA" ] || {
  log "精确 SHA 校验失败：期望 ${COMMIT_SHA}，实际 ${RESOLVED_SHA}"
  exit 3
}

if [ "$EXPORT_SOURCE_CACHE" = "1" ]; then
  CACHE_EXPORT_DIR=/workspace/source-cache
  rm -rf "$CACHE_EXPORT_DIR"
  mkdir -p "$CACHE_EXPORT_DIR"
  mv "$REPO_DIR" "$CACHE_EXPORT_DIR/repo"
  REPO_DIR="$CACHE_EXPORT_DIR/repo"
  export REPO_DIR RESOLVED_SHA
  node -e '
    const fs=require("fs"), path=require("path");
    fs.writeFileSync(path.join("/workspace/source-cache","cache.json"),JSON.stringify({
      commitSha:process.env.RESOLVED_SHA,
      createdAt:new Date().toISOString(),
      lastUsedAt:new Date().toISOString()
    }));
  '
  log "已暂存精确提交源码缓存"
fi
log "分析 commit ${RESOLVED_SHA}"

# ── chat 模式：在精确 commit 的真实源码目录中回答 ─────────────────────
if [ "${RUN_MODE:-analyze}" = "chat" ]; then
  : "${QODER_PERSONAL_ACCESS_TOKEN:?chat 模式必须提供 QODER_PERSONAL_ACCESS_TOKEN}"
  [ -s /workspace/input.json ] || { log "chat 模式缺少 input.json"; exit 3; }

  RESOLVED_SHA="$RESOLVED_SHA" node -e '
    const fs=require("fs"), path=require("path");
    const input=JSON.parse(fs.readFileSync("/workspace/input.json","utf8"));
    const selected=input.nodeName
      ? `当前选中节点：${input.nodeName}（id=${input.nodeId||"-"}，path=${input.nodePath||"-"}）`
      : "当前未选中节点，请按全仓库问题处理。";
    const repoRoot=path.resolve(process.env.REPO_DIR);
    const selectedRoot=path.resolve(repoRoot,String(input.nodePath||"."));
    const allowed=new Set([".cjs",".css",".go",".html",".java",".js",".json",".jsx",".kt",".md",".mjs",".php",".py",".rb",".rs",".sh",".sql",".swift",".toml",".ts",".tsx",".vue",".yaml",".yml"]);
    const skippedDirs=new Set([".git",".next","build","coverage","dist","node_modules","out","target","vendor"]);
    const files=[];
    const add=(file)=>{
      const relative=path.relative(repoRoot,file).replaceAll(path.sep,"/");
      if(!relative||relative.startsWith("../")||/(^|\/)(\.env[^/]*|[^/]+\.(pem|key|p12|pfx|crt))$/i.test(relative))return;
      if(/(^|\/)(package-lock|pnpm-lock|yarn\.lock)(\.|$)/i.test(relative))return;
      const extension=path.extname(file).toLowerCase();
      if(!allowed.has(extension)&&!new Set(["Dockerfile","Makefile"]).has(path.basename(file)))return;
      const stat=fs.statSync(file,{throwIfNoEntry:false});
      if(stat?.isFile()&&stat.size<=200000)files.push({file,relative});
    };
    const walk=(directory)=>{
      if(files.length>=200)return;
      for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
        if(files.length>=200)break;
        const file=path.join(directory,entry.name);
        if(entry.isDirectory()&&!skippedDirs.has(entry.name))walk(file);
        else if(entry.isFile())add(file);
      }
    };
    if((selectedRoot===repoRoot||selectedRoot.startsWith(repoRoot+path.sep))&&fs.existsSync(selectedRoot)){
      const stat=fs.statSync(selectedRoot);
      if(stat.isDirectory())walk(selectedRoot); else if(stat.isFile())add(selectedRoot);
    }
    const questionWords=String(input.question||"").toLowerCase().split(/[^a-z0-9_/-]+/).filter(word=>word.length>=3);
    const score=(item)=>{
      const base=path.basename(item.relative).toLowerCase();
      let value=Math.max(0,20-item.relative.split("/").length);
      if(base==="package.json")value+=140;
      else if(/^app\.[^.]+$/.test(base))value+=130;
      else if(/^main\.[^.]+$/.test(base))value+=120;
      else if(/^index\.[^.]+$/.test(base))value+=110;
      else if(/^readme(\.|$)/.test(base))value+=90;
      if(/(^|\/)(__tests__|test|tests)(\/|$)|\.(spec|test)\./.test(item.relative))value-=50;
      for(const word of questionWords)if(item.relative.toLowerCase().includes(word))value+=60;
      return value;
    };
    files.sort((left,right)=>score(right)-score(left)||left.relative.localeCompare(right.relative));
    const fileTree=files.map(item=>item.relative).sort().slice(0,160).join("\n");
    let remaining=24000;
    const sourceBlocks=[];
    for(const item of files.slice(0,24)){
      if(remaining<=0)break;
      const raw=fs.readFileSync(item.file,"utf8");
      if(raw.includes("\u0000"))continue;
      const numbered=raw.split("\n").map((line,index)=>`${index+1}| ${line}`).join("\n");
      const block=`<source file="${item.relative}">\n${numbered.slice(0,remaining)}\n</source>`;
      sourceBlocks.push(block);
      remaining-=block.length;
    }
    const preloaded=sourceBlocks.length
      ? `Runner 已从当前 commit 精确预读取选中模块的 ${sourceBlocks.length} 个入口/高相关源码文件并附真实行号。请直接基于这些源码回答，不需要再次遍历仓库。\n\n模块文件树：\n${fileTree}\n\n${sourceBlocks.join("\n\n")}`
      : "未能预读取选中模块源码，必须主动搜索仓库后再回答。";
    if(sourceBlocks.length)fs.writeFileSync("/workspace/chat-direct","1");
    const modeInstruction=sourceBlocks.length
      ? "你是 VisionOwl 的源码问答 Agent。Runner 已提供真实源码上下文，当前模式没有可用工具；禁止输出工具调用、工具计划或分析过程，必须立即给出最终中文 Markdown 答案。"
      : "执行 repository-understanding skill。你是 VisionOwl 的源码问答 Agent，当前工作目录就是目标仓库的真实源码。";
    const prompt=[
      modeInstruction,
      `仓库已精确 checkout 到 commit ${process.env.RESOLVED_SHA}。不能只复述图谱摘要。`,
      "源码是最终事实来源；图谱草稿只用于定位。如果源码与图谱冲突，请明确指出图谱可能过期。",
      "硬性要求：直接用中文回答；使用简洁 Markdown，首行必须是 ## 二级标题，并用小标题与列表组织内容；具体结论必须引用源码路径与行号；无法从源码证实的内容标注【推断】；禁止修改任何文件；不要输出 JSON 或分析过程；除非用户明确要求长文，回答控制在 800 个中文字符以内。",
      selected,
      `用户问题：${input.question}`,
      preloaded,
      "已有图谱事实草稿（仅作线索）：",
      String(input.groundedDraft||"").slice(0,sourceBlocks.length?6000:24000),
    ].join("\n\n");
    fs.writeFileSync("/workspace/chat-prompt.txt",prompt);
  '

  CHAT_PROMPT=$(cat /workspace/chat-prompt.txt)
  chat_stage "reading_source"
  CHAT_TURNS="${MAX_TURNS:-5}"
  CHAT_TOOL_ARGS=()
  if [ -s /workspace/chat-direct ]; then
    CHAT_TURNS=1
    CHAT_TOOL_ARGS=(--tools "")
    log "chat：使用预检索源码单轮回答（model=${CHAT_MODEL:-DeepSeek-V4-Flash}）"
  else
    log "chat：搜索真实源码回答（max-turns=${CHAT_TURNS}）"
  fi
  set +e
  qodercli "${CHAT_TOOL_ARGS[@]}" -p "$CHAT_PROMPT" \
    -m "${CHAT_MODEL:-DeepSeek-V4-Flash}" \
    --output-format json \
    --permission-mode accept_edits \
    --max-turns "$CHAT_TURNS" \
    --max-output-tokens "${MAX_OUTPUT_TOKENS:-1200}" \
    --no-session-persistence \
    -w "$REPO_DIR" > "$OUT_DIR/agent.json" 2> "$OUT_DIR/agent.err"
  CHAT_RC=$?
  set -e
  chat_stage "finalizing"
  export CHAT_RC
  node -e '
    const fs=require("fs");
    const file=process.env.OUT_DIR+"/agent.json";
    let raw;
    try{ raw=JSON.parse(fs.readFileSync(file,"utf8")); }catch{ process.exit(2); }
    const pickText=(value)=>{
      if(typeof value==="string"&&value.trim())return value;
      if(!value||typeof value!=="object")return null;
      for(const key of ["result","answer","response","text","content","message","output"]){
        const candidate=value[key];
        if(typeof candidate==="string"&&candidate.trim())return candidate;
        if(Array.isArray(candidate)){
          const parts=candidate.map(pickText).filter(Boolean);
          if(parts.length)return parts.join("\n");
        }
      }
      for(const nested of Object.values(value)){const text=pickText(nested);if(text)return text;}
      return null;
    };
    const pickCredits=(value)=>{
      if(!value||typeof value!=="object")return 0;
      for(const key of ["credits","total_credits","usage_credits"]){
        if(typeof value[key]==="number")return value[key];
      }
      for(const nested of Object.values(value)){const credits=pickCredits(nested);if(credits>0)return credits;}
      return 0;
    };
    const text=pickText(raw);
    if(!text||/<tool_call>|<\/tool_call>|\"name\"\s*:\s*\"Read\"/i.test(text))process.exit(3);
    fs.writeFileSync(process.env.OUT_DIR+"/chat.json",JSON.stringify({text:text.trim(),credits:pickCredits(raw)},null,2));
  ' || true
  if [ ! -s "$OUT_DIR/chat.json" ]; then
    log "chat 失败：未产出回答（agent 退出码 $CHAT_RC）"
    tail -c 1200 "$OUT_DIR/agent.err" | scrub || true
    exit 3
  fi
  cleanup_source
  log "chat 完成"
  exit 0
fi

# ── docgen 模式：单模块代码文档生成 ────────────────────────────────────
if [ "${RUN_MODE:-analyze}" = "docgen" ]; then
  : "${DOC_NODE_ID:?docgen 模式缺少 DOC_NODE_ID}"
  : "${QODER_PERSONAL_ACCESS_TOKEN:?docgen 模式必须提供 QODER_PERSONAL_ACCESS_TOKEN}"
  MOD_PATH="${DOC_NODE_PATH:-${DOC_NODE_ID#module:}}"
  if [ -z "${DOC_NODE_PATH:-}" ] && [ "$MOD_PATH" = "$(basename "$REPO_DIR")" ]; then
    MOD_PATH="."
  fi
  case "$MOD_PATH" in
    /*|../*|*/../*|*/..) log "模块源码路径非法：$MOD_PATH"; exit 3 ;;
  esac
  MODULE_SOURCE="$REPO_DIR/$MOD_PATH"
  [ -e "$MODULE_SOURCE" ] || { log "模块源码不存在：$MOD_PATH"; exit 3; }

  DOC_PROMPT="执行 repository-understanding 与 docs-sync skill，阅读 $MODULE_SOURCE 的源码（目录则递归阅读），\
为该模块生成中文代码文档并写入 /workspace/out/moduledoc.md。结构要求：\
# {模块名} 代码文档 / ## 模块职责 / ## 对外接口（注明文件路径与行号）/ \
## 内部实现要点 / ## 依赖与被依赖 / ## 风险与注意事项。\
硬性要求：结论必须引用源码文件路径；无法证实的标注【推断】；不超过 300 行；\
文档顶部写明 commit ${RESOLVED_SHA}。"

  log "docgen：$DOC_NODE_ID @ ${RESOLVED_SHA}（max-turns=${MAX_TURNS:-25}）"
  set +e
  qodercli -p "$DOC_PROMPT" \
    --output-format json \
    --permission-mode accept_edits \
    --max-turns "${MAX_TURNS:-25}" \
    -w /workspace > "$OUT_DIR/agent.json" 2> "$OUT_DIR/agent.err"
  DOC_RC=$?
  set -e
  export DOC_RC
  node -e '
    const fs=require("fs");
    let credits=0;
    try{
      const raw=JSON.parse(fs.readFileSync(process.env.OUT_DIR+"/agent.json","utf8"));
      const pick=(o)=>{ if(!o||typeof o!=="object")return undefined;
        for(const k of ["credits","total_credits","usage_credits"]) if(typeof o[k]==="number")return o[k];
        for(const v of Object.values(o)){const r=pick(v); if(r!==undefined)return r;} return undefined; };
      credits=pick(raw)??0;
    }catch{}
    fs.writeFileSync(process.env.OUT_DIR+"/meta.json", JSON.stringify({credits,semanticEnhanced:process.env.DOC_RC==="0"},null,2));
  ' || echo '{"credits":0,"semanticEnhanced":false}' > "$OUT_DIR/meta.json"
  if [ ! -s "$OUT_DIR/moduledoc.md" ]; then
    log "docgen 失败：未产出 moduledoc.md（agent 退出码 $DOC_RC）"
    tail -c 1000 "$OUT_DIR/agent.err" | scrub || true
    exit 3
  fi
  cleanup_source
  log "docgen 完成：$(wc -l < "$OUT_DIR/moduledoc.md") 行"
  exit 0
fi

# ── 增量：算变更文件 ──────────────────────────────────────────────────
CHANGED=""
if [ "$JOB_TYPE" = "incremental" ] && [ -n "$BASE_SHA" ]; then
  if [ -d "$REPO_DIR/.git" ]; then
    CHANGED=$(git -C "$REPO_DIR" diff --name-only "${BASE_SHA}..${RESOLVED_SHA}" 2>/dev/null | paste -sd, - || true)
  else
    CHANGED=$(python3 - "$REPO" "$BASE_SHA" "$RESOLVED_SHA" "${GIT_TOKEN:-}" <<'PY' || true
import json, sys, urllib.request
repo, base, head, token = sys.argv[1:]
url = f"https://api.github.com/repos/{repo}/compare/{base}...{head}"
request = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "VisionOwl-Runner"})
if token:
    request.add_header("Authorization", f"Bearer {token}")
with urllib.request.urlopen(request, timeout=20) as response:
    print(",".join(item["filename"] for item in json.load(response).get("files", [])))
PY
    )
  fi
  log "变更文件：${CHANGED:-（无法计算，退化为全量）}"
fi

# ── 2 阶段一：确定性扫描（零 credit）──────────────────────────────────
runner_stage "fact_indexing"
log "阶段一 Fact Index v2 与确定性图谱"
node /opt/scanner/dist/scanner/cli.js \
  --repo "$REPO_DIR" --out "$OUT_DIR" \
  --project-id "$PROJECT_ID" --repository-id "$REPOSITORY_ID" --sha "$RESOLVED_SHA" \
  ${BASE_SHA:+--base "$BASE_SHA"} \
  ${CHANGED:+--changed-files "$CHANGED"}
cp "$OUT_DIR/graph-patch.json" "$OUT_DIR/graph-patch.empty.json"

# ── 3 Agent 编排：默认 adaptive，旧多 Agent 流程保留为开关 ───────────
ORCHESTRATION_MODE="${AGENT_ORCHESTRATION_MODE:-adaptive}"
case "$ORCHESTRATION_MODE" in
  adaptive|legacy_multi) ;;
  *) log "未知 AGENT_ORCHESTRATION_MODE=$ORCHESTRATION_MODE"; exit 6 ;;
esac
printf '{"credits":0,"semanticEnhanced":false,"orchestrationMode":"%s"}\n' \
  "$ORCHESTRATION_MODE" > "$OUT_DIR/meta.json"

if [ -n "${QODER_PERSONAL_ACCESS_TOKEN:-}" ] && [ "$ORCHESTRATION_MODE" = "adaptive" ]; then
  runner_stage "adaptive_analysis"
  log "自适应 Agent 编排：普通仓库单 Agent，大仓库最多 ${ADAPTIVE_MAX_AGENTS:-4} 个 Agent；跳过重型全局汇总"
  if ! node /opt/scanner/dist/scanner/v2/agentOrchestrator.js --phase adaptive; then
    log "自适应 Agent 编排失败，保留确定性骨架并继续质量门禁"
  fi
fi

# legacy_multi 完整保留原来的模块并行 + 全局 Agent 汇总链路。
if [ -n "${QODER_PERSONAL_ACCESS_TOKEN:-}" ] && [ "$ORCHESTRATION_MODE" = "legacy_multi" ]; then
  runner_stage "module_analysis"
  log "阶段二模块 Agent 编排（model=${MODULE_MODEL:-Performance} concurrency=${MODULE_AGENT_CONCURRENCY:-3}）"
  if ! node /opt/scanner/dist/scanner/v2/agentOrchestrator.js --phase modules; then
    log "模块 Agent 编排失败，保留确定性骨架并继续全局汇总"
  fi
fi

# ── 4 阶段三：全局 Agent 汇总（消耗 credit，受 max-turns 硬顶）────────
PROMPT="执行 visionowl-module-analysis skill，并遵守 visionowl-graph 的 Patch 契约：优先读取 /workspace/out/module-analysis-report.json 与 /workspace/out/module-results/ 中的并行模块分析结果；再读取 /workspace/out/analysis-packets.json、facts.v2.json、symbol-index.json、\
interface-catalog.json、resource-catalog.json、diagnostics.json 与 graph.base.json，\
仅在核验冲突或补齐跨模块链路时读取 $REPO_DIR 中 Fact Index 精确指向的源码，不得重新遍历整个仓库。你负责消解局部结论冲突、串联跨模块流程并形成全局架构。只允许把最终修正提案写入 /workspace/out/graph-patch.json。硬性要求：\
(1) 禁止直接修改 graph.base.json 或 graph.json；\
(2) graph-patch.json 必须保留现有 baseGraphVersion、repositoryId 与 commitSha；\
(3) operations 中的类型字段名必须写成 op，禁止写 operation；op 仅可使用 add_node/add_edge/replace_edge/suppress_edge/update_summary/set_architecture/add_view；update_summary 与 set_architecture 必须使用 nodeId，禁止写 targetId；\
(4) 每个 operation 必须携带 reason、confidence 和可定位到真实源码的 evidence；\
(5) 无法从源码证实的内容不要提交 Patch，只在 ARCHITECTURE.md 标注【推断】；\
(6) 单条 evidence 不超过 40 行，不得包含密钥样本；\
(7) 若 /workspace/out/impact.json 存在，只深入读取 affectedNodeIds 对应模块及一层邻接。\
(8) 必须检查默认 overview 的主次层级：运行入口、前后端、Worker、调度器、执行器和关键数据组件应优先展示；测试、示例、工具脚本和低价值叶子模块应使用 set_architecture 标为 detail。不得仅凭目录名判断，必须结合入口、调用关系、资源访问和部署证据。\
另外同步产出 /workspace/out/ARCHITECTURE.md：面向新成员的中文架构总览，\
含系统分层、模块职责、关键数据流、基础设施依赖和风险点；结论引用源码路径，推断标【推断】，不超过 400 行。"

if [ -n "${QODER_PERSONAL_ACCESS_TOKEN:-}" ] && [ "$ORCHESTRATION_MODE" = "legacy_multi" ]; then
  runner_stage "global_synthesis"
  SYNTHESIS_TURNS="${SYNTHESIS_MAX_TURNS:-12}"
  log "阶段三全局汇总 Agent（model=${SYNTHESIS_MODEL:-Performance} max-turns=${SYNTHESIS_TURNS}）"
  SKELETON_BYTES=$(stat -c%s "$OUT_DIR/graph.base.json" 2>/dev/null || echo 0)
  set +e
  qodercli -p "$PROMPT" \
    -m "${SYNTHESIS_MODEL:-Performance}" \
    --output-format json \
    --permission-mode accept_edits \
    --max-turns "$SYNTHESIS_TURNS" \
    -w /workspace > "$OUT_DIR/agent.json" 2> "$OUT_DIR/agent.err"
  AGENT_RC=$?
  set -e
  export AGENT_RC
  if [ $AGENT_RC -ne 0 ]; then
    log "Agent 退出码 $AGENT_RC，保留阶段一骨架继续（不影响可复现的结构事实）"
    tail -c 2000 "$OUT_DIR/agent.err" | scrub || true
  fi
  PATCH_BYTES=$(stat -c%s "$OUT_DIR/graph-patch.json" 2>/dev/null || echo 0)
  log "产物尺寸：骨架 ${SKELETON_BYTES}B / Patch ${PATCH_BYTES}B"
  # 全局汇总 credits：模块 Agent 的 credits 在后面统一累加。
  node -e '
    const fs=require("fs");
    let credits=0;
    try{
      const raw=JSON.parse(fs.readFileSync(process.env.OUT_DIR+"/agent.json","utf8"));
      const pick=(o)=>{ if(!o||typeof o!=="object")return undefined;
        for(const k of ["credits","total_credits","usage_credits"]) if(typeof o[k]==="number")return o[k];
        for(const v of Object.values(o)){const r=pick(v); if(r!==undefined)return r;} return undefined; };
      credits=pick(raw)??0;
    }catch{}
    fs.writeFileSync(process.env.OUT_DIR+"/meta.json", JSON.stringify({credits,semanticEnhanced:process.env.AGENT_RC==="0"},null,2));
  ' || echo '{"credits":0,"semanticEnhanced":false}' > "$OUT_DIR/meta.json"
elif [ -z "${QODER_PERSONAL_ACCESS_TOKEN:-}" ]; then
  log "未提供 QODER_PERSONAL_ACCESS_TOKEN，跳过 Agent 编排（仅输出确定性骨架）"
else
  log "自适应 Agent 编排完成，不启动 legacy_multi 的重型全局汇总"
fi

# 模型复核直接跳过；最终结果仍必须通过确定性 Patch 校验与质量门禁。
log "跳过模型复核，直接进入确定性 Patch 校验"

# 汇总模块分析与全局汇总两个 Agent 阶段的 credits。
node -e '
  const fs=require("fs"), path=require("path");
  const read=(name)=>{try{return JSON.parse(fs.readFileSync(path.join(process.env.OUT_DIR,name),"utf8"));}catch{return {};}};
  const meta=read("meta.json"), modules=read("module-agent-meta.json"), adaptive=read("adaptive-orchestration.json");
  const credits=[meta.credits,modules.credits].reduce((sum,value)=>sum+(Number(value)||0),0);
  fs.writeFileSync(path.join(process.env.OUT_DIR,"meta.json"),JSON.stringify({
    ...meta,
    credits,
    moduleAgentCredits:Number(modules.credits)||0,
    reviewAgentCredits:0,
    semanticEnhanced:Boolean(meta.semanticEnhanced||modules.semanticEnhanced),
    orchestrationMode:process.env.AGENT_ORCHESTRATION_MODE||"adaptive",
    orchestrationStrategy:adaptive.strategy||modules.strategy||null,
    orchestrationTaskCount:Number(adaptive.taskCount??modules.taskCount)||0,
    skippedHeavyGlobalSynthesis:Boolean(adaptive.skippedHeavyGlobalSynthesis)
  },null,2));
' || true

# ── 5 Patch 校验、overlay 与质量门禁 ─────────────────────────────────
runner_stage "patch_validation"
log "校验 Agent Patch 并生成最终图谱"
set +e
node /opt/scanner/dist/scanner/v2/postprocess.js --repo "$REPO_DIR" --out "$OUT_DIR"
POSTPROCESS_RC=$?
set -e
if [ $POSTPROCESS_RC -ne 0 ]; then
  log "Agent Patch 未通过校验，保留审计副本并回退确定性骨架"
  cp "$OUT_DIR/graph-patch.json" "$OUT_DIR/agent-patch.rejected.json" || true
  cp "$OUT_DIR/patch-validation.json" "$OUT_DIR/agent-patch-validation.rejected.json" || true
  cp "$OUT_DIR/rejected-patches.json" "$OUT_DIR/agent-rejected-patches.json" || true
  cp "$OUT_DIR/conflicting-patches.json" "$OUT_DIR/agent-conflicting-patches.json" || true
  cp "$OUT_DIR/graph-patch.empty.json" "$OUT_DIR/graph-patch.json"
  node /opt/scanner/dist/scanner/v2/postprocess.js --repo "$REPO_DIR" --out "$OUT_DIR"
  node -e '
    const fs=require("fs"), file=process.env.OUT_DIR+"/meta.json";
    const meta=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{};
    fs.writeFileSync(file,JSON.stringify({...meta,semanticEnhanced:false,patchFallback:true},null,2));
  '
fi
rm -f "$OUT_DIR/graph-patch.empty.json"
runner_stage "quality_review"
node -e '
  const fs=require("fs");
  const report=JSON.parse(fs.readFileSync(process.env.OUT_DIR+"/quality-report.json","utf8"));
  console.log(`[runner] 质量门禁 ${report.disposition}，publishable=${report.publishable}`);
  if(!report.publishable)process.exit(5);
'
# 汇总可审计信息，供 Worker 持久化和后续扫描质量对比使用。
node -e '
  const fs=require("fs"), path=require("path"), out=process.env.OUT_DIR;
  const read=(name)=>{try{return JSON.parse(fs.readFileSync(path.join(out,name),"utf8"));}catch{return null;}};
  const modules=read("module-analysis-report.json");
  const adaptive=read("adaptive-orchestration.json");
  const patch=read("patch-validation.json"), quality=read("quality-report.json"), meta=read("meta.json")||{};
  fs.writeFileSync(path.join(out,"analysis-summary.json"),JSON.stringify({
    schemaVersion:"1.0",
    generatedAt:new Date().toISOString(),
    orchestration:{
      mode:process.env.AGENT_ORCHESTRATION_MODE||"adaptive",
      strategy:adaptive?.strategy||meta.orchestrationStrategy||null,
      taskCount:Number(adaptive?.taskCount??meta.orchestrationTaskCount)||0,
      skippedHeavyGlobalSynthesis:Boolean(adaptive?.skippedHeavyGlobalSynthesis)
    },
    models:{
      module:process.env.MODULE_MODEL||"Performance",
      synthesis:process.env.SYNTHESIS_MODEL||"Performance",
      review:null
    },
    modules:modules?{
      packetCount:modules.packetCount||0,
      assignmentCount:modules.assignmentCount||0,
      succeeded:modules.succeeded||0,
      failed:modules.failed||0
    }:null,
    review:null,
    patchValidation:patch,
    quality,
    usage:meta
  },null,2));
'
# ── 6 源码不留存（spec §12-2）：仅保留 out 产物供 Worker 回收 ───────────
cleanup_source
runner_stage "completed"
log "完成"
