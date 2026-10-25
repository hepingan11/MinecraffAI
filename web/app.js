const state = { messages: [], windows: [], selectedWindowId: null, demo: false, automationInitialized: false, automation: null, knowledgeEntries: [], experiences: [], mining: null, follow: null };
const $ = (selector) => document.querySelector(selector);
let dataLoading = false;

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2800);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function renderMessages(messages) {
  const feed = $("#chatFeed");
  if (!messages.length) {
    feed.innerHTML = '<div class="loading-state">还没有读取到聊天记录</div>';
    return;
  }
  feed.innerHTML = messages.map((message, index) => {
    const mine = /^(我|机器人|Minecraft AI)/u.test(message.text ?? "") || message.mine;
    return `<div class="chat-message ${mine ? "me" : ""}">
      <div class="chat-avatar">${mine ? "AI" : "MC"}</div>
      <div class="bubble-wrap"><div class="bubble">${escapeHtml(message.text ?? "")}</div><div class="message-meta">${escapeHtml(message.time ?? "刚刚")} · ${mine ? "Minecraft AI" : "游戏聊天"}</div></div>
    </div>`;
  }).join("");
  feed.scrollTop = feed.scrollHeight;
  $("#messageCount").textContent = String(messages.length).padStart(2, "0");
}

function renderWindowSelector(windows) {
  state.windows = Array.isArray(windows) ? windows : [];
  const wrapper = $("#windowSelector");
  const select = $("#windowSelect");
  const savedId = localStorage.getItem("minecraft-ai-window-id");
  select.innerHTML = '<option value="">请选择窗口</option>';
  state.windows.forEach((window) => {
    const option = document.createElement("option");
    option.value = String(window.id);
    option.textContent = `${window.title || "Minecraft"} · #${option.value}`;
    select.appendChild(option);
  });
  if (state.windows.length === 1) {
    state.selectedWindowId = String(state.windows[0].id);
    select.value = state.selectedWindowId;
    localStorage.setItem("minecraft-ai-window-id", state.selectedWindowId);
    wrapper.hidden = true;
  } else if (state.windows.length > 1) {
    state.selectedWindowId = state.windows.some((window) => String(window.id) === savedId) ? savedId : null;
    select.value = state.selectedWindowId ?? "";
    wrapper.hidden = false;
  } else {
    state.selectedWindowId = null;
    wrapper.hidden = true;
  }
}

function renderAutomationWindows() {
  const select = $("#automationWindowId");
  if (!select) return;
  const selected = select.value;
  select.innerHTML = '<option value="">单窗口时自动选择</option>';
  state.windows.forEach((window) => {
    const option = document.createElement("option");
    option.value = String(window.id);
    option.textContent = `${window.title || "Minecraft"} #${option.value}`;
    select.appendChild(option);
  });
  const configured = state.automation?.config?.windowId ?? selected;
  if (configured && state.windows.some((window) => String(window.id) === configured)) select.value = configured;
}

function renderAutomation(value) {
  if (!value || !value.config) return;
  state.automation = value;
  renderAutomationWindows();
  const config = value.config;
  if (!state.automationInitialized) {
    $("#automationEnabled").checked = Boolean(config.enabled);
    $("#voiceReplyEnabled").checked = Boolean(config.voiceReplyEnabled);
    $("#triggerName").value = config.triggerName ?? "";
    $("#aiBaseUrl").value = config.baseUrl ?? "";
    $("#aiModel").value = config.model ?? "";
    $("#voiceProvider").value = config.voiceProvider ?? "openai";
    $("#voiceOutput").value = config.voiceOutput ?? "local";
    $("#voiceBaseUrl").value = config.voiceBaseUrl ?? "";
    $("#voiceModel").value = config.voiceModel ?? "";
    $("#voiceName").value = config.voice ?? "";
    $("#voiceLanguage").value = config.voiceLanguage ?? "zh-cn";
    $("#voiceRate").value = config.voiceRate ?? 0;
    $("#aiTemperature").value = config.temperature ?? 0.7;
    $("#aiMaxTokens").value = config.maxTokens ?? 256;
    $("#aiSystemPrompt").value = config.systemPrompt ?? "";
    state.automationInitialized = true;
  }
  $("#automationState").textContent = config.enabled ? "已启用" : "未启用";
  $("#apiKeyHint").textContent = config.apiKeySet ? "（已保存，留空保持不变）" : "（未设置）";
  $("#voiceApiKeyHint").textContent = config.voiceApiKeySet ? "（已保存，留空保持不变）" : "（未设置）";
  updateVoiceProviderFields();
  const status = value.status ?? {};
  $("#automationMonitor").textContent = status.lastError
    ? `错误：${status.lastError}`
    : `已处理 ${status.processed ?? 0} 条聊天，已回复 ${status.replied ?? 0} 条${status.lastSkills?.length ? `，最近技能 ${status.lastSkills.join("、")}` : ""}${status.lastReplyAt ? `，最近回复 ${status.lastReplyAt}` : ""}${config.voiceReplyEnabled ? `，语音播放 ${status.voicePlayed ?? 0} 条` : ""}${status.lastVoiceError ? `，语音错误：${status.lastVoiceError}` : ""}`;
}

function updateVoiceProviderFields() {
  const provider = $("#voiceProvider")?.value;
  const voice = $("#voiceName");
  const base = $("#voiceBaseUrl");
  const model = $("#voiceModel");
  if (!provider || !voice) return;
  if (provider === "voicerss") {
    if (!voice.value || voice.value === "alloy") voice.value = "Luli";
    if (base) base.disabled = true;
    if (model) model.disabled = true;
  } else {
    if (voice.value === "Luli" || voice.value === "Shu" || voice.value === "Chow") voice.value = "alloy";
    if (base) base.disabled = false;
    if (model) model.disabled = false;
  }
}

async function saveAutomation(event) {
  event.preventDefault();
  const payload = {
    enabled: $("#automationEnabled").checked,
    voiceReplyEnabled: $("#voiceReplyEnabled").checked,
    triggerName: $("#triggerName").value,
    windowId: $("#automationWindowId").value,
    baseUrl: $("#aiBaseUrl").value,
    model: $("#aiModel").value,
    voiceProvider: $("#voiceProvider").value,
    voiceOutput: $("#voiceOutput").value,
    voiceBaseUrl: $("#voiceBaseUrl").value,
    voiceLanguage: $("#voiceLanguage").value,
    voiceRate: Number($("#voiceRate").value),
    voiceModel: $("#voiceModel").value,
    voice: $("#voiceName").value,
    temperature: Number($("#aiTemperature").value),
    maxTokens: Number($("#aiMaxTokens").value),
    systemPrompt: $("#aiSystemPrompt").value,
  };
  const apiKey = $("#aiApiKey").value;
  if (apiKey) payload.apiKey = apiKey;
  const voiceApiKey = $("#voiceApiKey").value;
  if (voiceApiKey) payload.voiceApiKey = voiceApiKey;
  const status = $("#automationSaveStatus");
  status.textContent = "保存中...";
  try {
    const response = await fetch("/api/automation/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "保存失败");
    $("#aiApiKey").value = "";
    $("#voiceApiKey").value = "";
    renderAutomation(result);
    status.textContent = "已保存";
    showToast("自动回复设置已保存");
  } catch (error) {
    status.textContent = error.message || "保存失败";
    showToast(status.textContent);
  }
}

function resetKnowledgeForm() {
  $("#knowledgeId").value = "";
  $("#knowledgeTitle").value = "";
  $("#knowledgeKeywords").value = "";
  $("#knowledgeContent").value = "";
  $("#knowledgeEnabled").checked = true;
  $("#knowledgeForm").hidden = true;
}

function editKnowledge(entry) {
  $("#knowledgeId").value = entry.id;
  $("#knowledgeTitle").value = entry.title;
  $("#knowledgeKeywords").value = entry.keywords.join(", ");
  $("#knowledgeContent").value = entry.content;
  $("#knowledgeEnabled").checked = entry.enabled;
  $("#knowledgeForm").hidden = false;
  $("#knowledgeTitle").focus();
}

function renderKnowledge(data) {
  state.knowledgeEntries = Array.isArray(data?.entries) ? data.entries : [];
  $("#knowledgeCount").textContent = `${data?.enabled ?? state.knowledgeEntries.filter((entry) => entry.enabled).length} 条启用 / ${data?.total ?? state.knowledgeEntries.length} 条知识`;
  const list = $("#knowledgeList");
  if (!state.knowledgeEntries.length) {
    list.innerHTML = '<div class="loading-state">知识库还是空的，先新增一条知识</div>';
    return;
  }
  list.innerHTML = state.knowledgeEntries.map((entry) => `<article class="knowledge-entry ${entry.enabled ? "" : "disabled"}">
    <div class="knowledge-entry-main"><div class="knowledge-entry-title">${escapeHtml(entry.title)}<span>${entry.enabled ? "已启用" : "已停用"}</span></div><div class="knowledge-entry-keywords">${escapeHtml(entry.keywords.join(" · ") || "未设置关键词")}</div><p>${escapeHtml(entry.content)}</p></div>
    <div class="knowledge-entry-actions"><button type="button" data-knowledge-edit="${escapeHtml(entry.id)}">编辑</button><button type="button" data-knowledge-delete="${escapeHtml(entry.id)}">删除</button></div>
  </article>`).join("");
  list.querySelectorAll("[data-knowledge-edit]").forEach((button) => button.addEventListener("click", () => {
    const entry = state.knowledgeEntries.find((item) => item.id === button.dataset.knowledgeEdit);
    if (entry) editKnowledge(entry);
  }));
  list.querySelectorAll("[data-knowledge-delete]").forEach((button) => button.addEventListener("click", () => deleteKnowledge(button.dataset.knowledgeDelete)));
}

async function loadKnowledgeBase() {
  try {
    const response = await fetch("/api/knowledge-base", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "知识库读取失败");
    renderKnowledge(data);
  } catch (error) {
    $("#knowledgeList").innerHTML = `<div class="loading-state">${escapeHtml(error.message)}</div>`;
  }
}

async function saveKnowledge(event) {
  event.preventDefault();
  const status = $("#knowledgeSaveStatus");
  status.textContent = "保存中...";
  const payload = {
    id: $("#knowledgeId").value || undefined,
    title: $("#knowledgeTitle").value,
    keywords: $("#knowledgeKeywords").value,
    content: $("#knowledgeContent").value,
    enabled: $("#knowledgeEnabled").checked,
  };
  try {
    const response = await fetch("/api/knowledge-base", { method: payload.id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "知识条目保存失败");
    renderKnowledge(data);
    resetKnowledgeForm();
    status.textContent = "已保存";
    showToast("知识条目已保存");
  } catch (error) {
    status.textContent = error.message;
    showToast(error.message);
  }
}

async function deleteKnowledge(id) {
  if (!window.confirm("确定删除这条知识吗？")) return;
  try {
    const response = await fetch(`/api/knowledge-base?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "知识条目删除失败");
    renderKnowledge(data);
    showToast("知识条目已删除");
  } catch (error) {
    showToast(error.message);
  }
}

function renderExperiences(data) {
  state.experiences = Array.isArray(data?.entries) ? data.entries : [];
  const pending = data?.pending ?? state.experiences.filter((entry) => entry.status === "pending").length;
  const approved = data?.approved ?? state.experiences.filter((entry) => entry.status === "approved").length;
  $("#experienceCount").textContent = `${approved} 条已启用 / ${pending} 条待审核 / ${data?.total ?? state.experiences.length} 条经验`;
  const list = $("#experienceList");
  if (!state.experiences.length) {
    list.innerHTML = '<div class="loading-state">还没有经验。自动回复成功后会自动生成待审核经验。</div>';
    return;
  }
  const labels = { pending: "待审核", approved: "已启用", disabled: "已停用" };
  list.innerHTML = state.experiences.map((entry) => `<article class="knowledge-entry ${entry.status === "disabled" ? "disabled" : ""}">
    <div class="knowledge-entry-main"><div class="knowledge-entry-title">${escapeHtml(entry.userMessage)}<span>${labels[entry.status] || entry.status}</span></div><div class="knowledge-entry-keywords">${escapeHtml(entry.source)} · 置信度 ${Math.round((entry.confidence || 0) * 100)}% · 使用 ${entry.uses || 0} 次</div><p><b>规则：</b>${escapeHtml(entry.lesson || "待补充") }<br /><b>回答：</b>${escapeHtml(entry.assistantReply)}</p></div>
    <div class="knowledge-entry-actions">${entry.status === "pending" ? `<button type="button" data-experience-approve="${escapeHtml(entry.id)}">启用</button>` : ""}${entry.status === "approved" ? `<button type="button" data-experience-reject="${escapeHtml(entry.id)}">停用</button>` : ""}<button type="button" data-experience-delete="${escapeHtml(entry.id)}">删除</button></div>
  </article>`).join("");
  list.querySelectorAll("[data-experience-approve]").forEach((button) => button.addEventListener("click", () => updateExperienceStatus(button.dataset.experienceApprove, "approve")));
  list.querySelectorAll("[data-experience-reject]").forEach((button) => button.addEventListener("click", () => updateExperienceStatus(button.dataset.experienceReject, "reject")));
  list.querySelectorAll("[data-experience-delete]").forEach((button) => button.addEventListener("click", () => deleteExperience(button.dataset.experienceDelete)));
}

async function loadExperiences() {
  try {
    const response = await fetch("/api/experiences?limit=200", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "经验库读取失败");
    renderExperiences(data);
  } catch (error) { $("#experienceList").innerHTML = `<div class="loading-state">${escapeHtml(error.message)}</div>`; }
}

async function saveExperience(event) {
  event.preventDefault();
  const status = $("#experienceSaveStatus");
  status.textContent = "保存中...";
  try {
    const response = await fetch("/api/experiences", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userMessage: $("#experienceUserMessage").value, lesson: $("#experienceLesson").value, assistantReply: $("#experienceReply").value }) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "经验保存失败");
    renderExperiences(data);
    event.target.reset();
    status.textContent = "已提交待审核";
    showToast("经验已提交，审核通过后才会影响回答");
  } catch (error) { status.textContent = error.message; showToast(error.message); }
}

async function updateExperienceStatus(id, action) {
  try {
    const response = await fetch(`/api/experiences/${encodeURIComponent(id)}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "经验状态更新失败");
    await loadExperiences();
    showToast(action === "approve" ? "经验已启用" : "经验已停用");
  } catch (error) { showToast(error.message); }
}

async function deleteExperience(id) {
  if (!window.confirm("确定删除这条经验吗？")) return;
  try {
    const response = await fetch(`/api/experiences?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "经验删除失败");
    renderExperiences(data); showToast("经验已删除");
  } catch (error) { showToast(error.message); }
}

function renderMiningStatus(data) {
  state.mining = data?.result?.mining ?? null;
  const status = data?.result?.status ?? "idle";
  const stateLabel = ({ idle: "空闲", running: "运行中", equipping: "切换镐子中", moving: "靠近目标", breaking: "挖掘中", waiting_target: "等待目标", completed: "已完成", timeout: "已超时", stopped: "已停止", safety_stop: "安全停止", inventory_full: "背包已满", limit_reached: "达到上限", error: "错误" })[status] ?? status;
  const stateNode = $("#miningState");
  const monitor = $("#miningMonitor");
  if (stateNode) stateNode.textContent = stateLabel;
  if (monitor) monitor.textContent = data?.result?.mining ? JSON.stringify(data.result.mining, null, 2) : `状态：${stateLabel}`;
}

async function loadMiningStatus() {
  if (!state.selectedWindowId || !$("#miningPanel")) return;
  try {
    const response = await fetch(`/api/skills/minecraft_mining?windowId=${encodeURIComponent(state.selectedWindowId)}`, { cache: "no-store" });
    const data = await response.json();
    if (response.ok && data.ok) renderMiningStatus(data);
  } catch { /* backend status remains authoritative */ }
}

async function startMining(event) {
  event.preventDefault();
  if (!state.selectedWindowId) return showToast("请先选择 Minecraft 窗口");
  const payload = {
    windowId: state.selectedWindowId,
    strategy: $("#miningStrategy").value,
    targetBlocks: $("#miningTargets").value.split(",").map((item) => item.trim()).filter(Boolean),
    quantity: Number($("#miningQuantity").value),
    maxMinutes: Number($("#miningMinutes").value),
    maxBlocks: Number($("#miningMaxBlocks").value),
    returnWhenFull: $("#miningReturnWhenFull").checked,
  };
  $("#miningStartButton").disabled = true;
  try {
    const response = await fetch("/api/skills/minecraft_mining", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "挖矿任务启动失败");
    renderMiningStatus(data);
    showToast("挖矿任务已启动");
  } catch (error) { showToast(error.message); }
  finally { $("#miningStartButton").disabled = false; }
}

async function stopMining() {
  if (!state.selectedWindowId) return showToast("请先选择 Minecraft 窗口");
  try {
    const response = await fetch("/api/skills/minecraft_mining/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ windowId: state.selectedWindowId }) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "挖矿任务停止失败");
    renderMiningStatus(data);
    showToast("挖矿任务已停止");
  } catch (error) { showToast(error.message); }
}

function renderFollowStatus(data) {
  state.follow = data?.result?.follow ?? null;
  const status = data?.result?.status ?? "idle";
  const labels = { idle: "空闲", following: "跟随中", holding: "保持距离", pathfinding: "寻找路线", paused: "已暂停", stopped: "已停止", target_lost: "目标丢失", stuck: "已卡住", safety_stop: "安全停止", timeout: "已超时", error: "错误" };
  const stateNode = $("#followState");
  const monitor = $("#followMonitor");
  const button = $("#followSafetyButton");
  if (stateNode) stateNode.textContent = labels[status] ?? status;
  if (monitor) monitor.textContent = data?.result?.follow ? JSON.stringify(data.result.follow, null, 2) : `状态：${labels[status] ?? status}`;
  if (button) {
    const unsafe = Boolean(data?.result?.follow?.ignoreSafety ?? data?.result?.ignoreSafety);
    button.textContent = unsafe ? "恢复安全模式" : "启用";
    button.dataset.ignoreSafety = unsafe ? "false" : "true";
    button.classList.toggle("danger-mode", unsafe);
  }
}

async function loadFollowStatus() {
  if (!state.selectedWindowId || !$("#followPanel")) return;
  try {
    const response = await fetch(`/api/skills/minecraft_follow?windowId=${encodeURIComponent(state.selectedWindowId)}`, { cache: "no-store" });
    const data = await response.json();
    if (response.ok && data.ok) renderFollowStatus(data);
  } catch { /* backend remains authoritative */ }
}

async function toggleFollowSafety() {
  if (!state.selectedWindowId) return showToast("请先选择 Minecraft 窗口");
  const ignoreSafety = $("#followSafetyButton").dataset.ignoreSafety === "true";
  try {
    const response = await fetch("/api/skills/minecraft_follow/safety", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ windowId: state.selectedWindowId, ignoreSafety }) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "安全行走模式切换失败");
    renderFollowStatus(data);
    showToast(ignoreSafety ? "已启用无视周围安全行走" : "已恢复安全行走模式");
  } catch (error) { showToast(error.message); }
}

async function stopFollow() {
  if (!state.selectedWindowId) return showToast("请先选择 Minecraft 窗口");
  try {
    const response = await fetch("/api/skills/minecraft_follow/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ windowId: state.selectedWindowId }) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "跟随任务停止失败");
    renderFollowStatus(data); showToast("跟随任务已停止");
  } catch (error) { showToast(error.message); }
}

function setConnection(connected, text) {
  $("#connectionText").textContent = text;
  $("#runtimeStatus").textContent = state.windows.length > 1 && !state.selectedWindowId ? "待选择" : connected ? "运行中" : "待连接";
  $("#logStatus").textContent = connected ? "日志已同步" : "等待游戏日志";
  $("#connectionChip").classList.toggle("offline", !connected);
}

async function loadData({ silent = false } = {}) {
  if (dataLoading) return;
  dataLoading = true;
  try {
    const statusResponse = await fetch("/api/status", { cache: "no-store" });
    const status = await statusResponse.json();
    renderWindowSelector(status.windows);
    renderAutomation(status.automation);
    await loadMiningStatus();
    await loadFollowStatus();
    const bridgeReady = status.ok && (status.directApiAvailable ?? status.bridgeAvailable);
    const connectionText = status.windowError
      ? "Mod API 不可用"
      : state.windows.length > 1
        ? `检测到 ${state.windows.length} 个窗口`
        : state.windows.length === 1 && status.logAvailable
          ? "Minecraft 已连接"
            : "等待 Minecraft Mod";
    setConnection(bridgeReady && status.logAvailable && state.windows.length > 0, connectionText);
    const chatResponse = await fetch("/api/chat?limit=20", { cache: "no-store" });
    const chat = await chatResponse.json();
    if (!chat.ok) throw new Error(chat.error);
    state.messages = chat.messages;
    state.demo = false;
    renderMessages(state.messages);
  } catch (error) {
    state.demo = true;
    setConnection(false, "演示模式");
    state.messages = [
      { time: "21:42:08", text: "欢迎回来，AI 助手。", mine: true },
      { time: "21:42:14", text: "今天的世界看起来很平静。", mine: false },
      { time: "21:42:19", text: "随时可以在这里发送消息。", mine: true },
    ];
    renderMessages(state.messages);
    if (!silent) showToast("暂时无法连接日志，已切换到演示模式");
  } finally {
    dataLoading = false;
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const input = $("#messageInput");
  const message = input.value.trim();
  if (!message) return;
  if (message.length > 256 || /[\r\n]/u.test(message)) {
    showToast("消息需要是 1～256 个字符，且不能换行");
    return;
  }
  if (state.windows.length === 0) {
    showToast("当前没有可操作的 Minecraft 窗口");
    return;
  }
  if (state.windows.length > 1 && !state.selectedWindowId) {
    showToast("检测到多个 Minecraft 窗口，请先选择操作窗口");
    $("#windowSelect").focus();
    return;
  }
  const button = $(".send-button");
  button.disabled = true;
  try {
    const response = await fetch("/api/message", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, windowId: state.selectedWindowId }) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "发送失败");
    state.messages.push({ time: new Date().toLocaleTimeString("zh-CN", { hour12: false }), text: message, mine: true });
    renderMessages(state.messages.slice(-20));
    input.value = "";
    showToast("消息已发送到 Minecraft");
  } catch (error) {
    showToast(error.message || "发送失败");
  } finally {
    button.disabled = false;
  }
}

function focusChat() { $("#messageInput").focus(); $("#chatPanel").scrollIntoView({ behavior: "smooth", block: "center" }); }

document.addEventListener("DOMContentLoaded", () => {
  const today = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date()).toUpperCase();
  $("#todayLabel").textContent = today;
  loadData();
  window.setInterval(() => loadData({ silent: true }), 3000);
  $("#messageForm").addEventListener("submit", sendMessage);
  $("#automationForm").addEventListener("submit", saveAutomation);
  $("#voiceProvider")?.addEventListener("change", updateVoiceProviderFields);
  $("#miningForm")?.addEventListener("submit", startMining);
  $("#miningStopButton")?.addEventListener("click", stopMining);
  $("#followSafetyButton")?.addEventListener("click", toggleFollowSafety);
  $("#followRefreshButton")?.addEventListener("click", loadFollowStatus);
  $("#followStopButton")?.addEventListener("click", stopFollow);
  $("#knowledgeForm").addEventListener("submit", saveKnowledge);
  $("#experienceForm").addEventListener("submit", saveExperience);
  $("#newKnowledgeButton").addEventListener("click", () => { resetKnowledgeForm(); $("#knowledgeForm").hidden = false; $("#knowledgeTitle").focus(); });
  $("#cancelKnowledgeButton").addEventListener("click", resetKnowledgeForm);
  renderAutomationWindows();
  $("#windowSelect").addEventListener("change", (event) => {
    state.selectedWindowId = event.target.value || null;
    if (state.selectedWindowId) localStorage.setItem("minecraft-ai-window-id", state.selectedWindowId);
    setConnection(state.windows.length > 0, state.windows.length > 1 ? `已选择窗口 ${state.selectedWindowId}` : "Minecraft 已连接");
    if (state.selectedWindowId) showToast("已切换操作窗口");
  });
  $("#refreshButton").addEventListener("click", () => { loadData(); showToast("正在同步最新数据"); });
  $("#openChatButton").addEventListener("click", focusChat);
  $("#heroChatButton").addEventListener("click", focusChat);
  $("#viewAllButton").addEventListener("click", focusChat);
  document.querySelectorAll(".quick-action:not(.disabled)").forEach((button) => button.addEventListener("click", () => button.dataset.action === "refresh" ? loadData() : focusChat()));
  document.querySelectorAll(".nav-item").forEach((item) => item.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((nav) => nav.classList.remove("active"));
    item.classList.add("active");
    if (item.dataset.section === "chat") focusChat();
    const settingsPanel = $("#settingsPanel");
    const knowledgePanel = $("#knowledgePanel");
    const experiencePanel = $("#experiencePanel");
    const miningPanel = $("#miningPanel");
    const followPanel = $("#followPanel");
    const isAutomation = item.dataset.section === "automation";
    const isKnowledge = item.dataset.section === "knowledge";
    const isExperiences = item.dataset.section === "experiences";
    const isMining = item.dataset.section === "world";
    if (settingsPanel) settingsPanel.hidden = item.dataset.section !== "settings" && !isAutomation;
    if (knowledgePanel) knowledgePanel.hidden = !isKnowledge;
    if (experiencePanel) experiencePanel.hidden = !isExperiences;
    if (miningPanel) miningPanel.hidden = !isMining;
    if (followPanel) followPanel.hidden = !isMining;
    if (item.dataset.section === "settings" || isAutomation) {
      settingsPanel?.scrollIntoView({ behavior: "smooth", block: "start" });
      if (!state.automationInitialized) loadData({ silent: true });
    } else if (isKnowledge) {
      knowledgePanel?.scrollIntoView({ behavior: "smooth", block: "start" });
      loadKnowledgeBase();
    } else if (isExperiences) {
      experiencePanel?.scrollIntoView({ behavior: "smooth", block: "start" });
      loadExperiences();
    } else if (isMining) {
      miningPanel?.scrollIntoView({ behavior: "smooth", block: "start" });
      loadMiningStatus();
    } else if (item.dataset.section !== "overview" && item.dataset.section !== "chat") showToast("这个模块已经预留，接下来可以继续扩展");
  }));
});
