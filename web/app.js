const state = { messages: [], windows: [], selectedWindowId: null, demo: false, automationInitialized: false, automation: null, knowledgeEntries: [], mining: null };
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
    $("#triggerName").value = config.triggerName ?? "";
    $("#aiBaseUrl").value = config.baseUrl ?? "";
    $("#aiModel").value = config.model ?? "";
    $("#aiTemperature").value = config.temperature ?? 0.7;
    $("#aiMaxTokens").value = config.maxTokens ?? 256;
    $("#aiSystemPrompt").value = config.systemPrompt ?? "";
    state.automationInitialized = true;
  }
  $("#automationState").textContent = config.enabled ? "已启用" : "未启用";
  $("#apiKeyHint").textContent = config.apiKeySet ? "（已保存，留空保持不变）" : "（未设置）";
  const status = value.status ?? {};
  $("#automationMonitor").textContent = status.lastError
    ? `错误：${status.lastError}`
    : `已处理 ${status.processed ?? 0} 条聊天，已回复 ${status.replied ?? 0} 条${status.lastSkills?.length ? `，最近技能 ${status.lastSkills.join("、")}` : ""}${status.lastReplyAt ? `，最近回复 ${status.lastReplyAt}` : ""}`;
}

async function saveAutomation(event) {
  event.preventDefault();
  const payload = {
    enabled: $("#automationEnabled").checked,
    triggerName: $("#triggerName").value,
    windowId: $("#automationWindowId").value,
    baseUrl: $("#aiBaseUrl").value,
    model: $("#aiModel").value,
    temperature: Number($("#aiTemperature").value),
    maxTokens: Number($("#aiMaxTokens").value),
    systemPrompt: $("#aiSystemPrompt").value,
  };
  const apiKey = $("#aiApiKey").value;
  if (apiKey) payload.apiKey = apiKey;
  const status = $("#automationSaveStatus");
  status.textContent = "保存中...";
  try {
    const response = await fetch("/api/automation/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "保存失败");
    $("#aiApiKey").value = "";
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

function renderMiningStatus(data) {
  state.mining = data?.result?.mining ?? null;
  const status = data?.result?.status ?? "idle";
  const stateLabel = ({ idle: "空闲", running: "运行中", breaking: "挖掘中", waiting_target: "等待目标", completed: "已完成", timeout: "已超时", stopped: "已停止", safety_stop: "安全停止", inventory_full: "背包已满", limit_reached: "达到上限", error: "错误" })[status] ?? status;
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
  $("#miningForm")?.addEventListener("submit", startMining);
  $("#miningStopButton")?.addEventListener("click", stopMining);
  $("#knowledgeForm").addEventListener("submit", saveKnowledge);
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
    const miningPanel = $("#miningPanel");
    const isAutomation = item.dataset.section === "automation";
    const isKnowledge = item.dataset.section === "knowledge";
    const isMining = item.dataset.section === "world";
    if (settingsPanel) settingsPanel.hidden = item.dataset.section !== "settings" && !isAutomation;
    if (knowledgePanel) knowledgePanel.hidden = !isKnowledge;
    if (miningPanel) miningPanel.hidden = !isMining;
    if (item.dataset.section === "settings" || isAutomation) {
      settingsPanel?.scrollIntoView({ behavior: "smooth", block: "start" });
      if (!state.automationInitialized) loadData({ silent: true });
    } else if (isKnowledge) {
      knowledgePanel?.scrollIntoView({ behavior: "smooth", block: "start" });
      loadKnowledgeBase();
    } else if (isMining) {
      miningPanel?.scrollIntoView({ behavior: "smooth", block: "start" });
      loadMiningStatus();
    } else if (item.dataset.section !== "overview" && item.dataset.section !== "chat") showToast("这个模块已经预留，接下来可以继续扩展");
  }));
});
