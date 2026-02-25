const state = {
  block: 3178624,
  walletEth: 0.0,
  agentLive: false,
  earned: 52.4,
  spent: 48.9,
  gasPerKill: 0.0011,
  losingStreak: 0,
  bestTarget: 128420,
  estEdge: -12.4,
  risk: "VOLATILE",
  stacks: []
};

const ui = {
  blockHeight: document.getElementById("blockHeight"),
  bestTargetValue: document.getElementById("bestTargetValue"),
  netEdge: document.getElementById("netEdge"),
  riskState: document.getElementById("riskState"),
  totalEarned: document.getElementById("totalEarned"),
  totalSpent: document.getElementById("totalSpent"),
  netProfit: document.getElementById("netProfit"),
  gasPerKill: document.getElementById("gasPerKill"),
  walletEth: document.getElementById("walletEth"),
  agentMode: document.getElementById("agentMode"),
  checkWallet: document.getElementById("checkWallet"),
  checkRunning: document.getElementById("checkRunning"),
  checkProfit: document.getElementById("checkProfit"),
  checkGas: document.getElementById("checkGas"),
  battleGrid: document.getElementById("battleGrid"),
  stackInspector: document.getElementById("stackInspector"),
  logFeed: document.getElementById("logFeed"),
  modal: document.getElementById("deployModal"),
  openModal: document.getElementById("openDeployModal"),
  closeModal: document.getElementById("closeDeployModal"),
  copyCmdBtn: document.getElementById("copyCmdBtn"),
  installCmd: document.getElementById("installCmd"),
  fundBtn: document.getElementById("fundBtn"),
  toggleAgentBtn: document.getElementById("toggleAgentBtn"),
  winCycleBtn: document.getElementById("winCycleBtn"),
  lossCycleBtn: document.getElementById("lossCycleBtn")
};

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function formatKill(val) {
  return `${Math.round(val).toLocaleString()} KILL`;
}

function seedStacks() {
  state.stacks = Array.from({ length: 36 }, (_, id) => ({
    id,
    units: Math.floor(rand(2000, 180000)),
    reapers: Math.floor(rand(0, 7)),
    bounty: rand(1.05, 3.7)
  }));
}

function calcStackValue(stack) {
  return (stack.units + stack.reapers * 666) * stack.bounty;
}

function renderGrid() {
  ui.battleGrid.innerHTML = "";
  let maxValue = 0;
  let bestId = 0;

  state.stacks.forEach((stack) => {
    const value = calcStackValue(stack);
    if (value > maxValue) {
      maxValue = value;
      bestId = stack.id;
    }
  });

  state.bestTarget = maxValue;

  state.stacks.forEach((stack) => {
    const value = calcStackValue(stack);
    const cell = document.createElement("button");
    cell.className = "stack-cell";
    cell.type = "button";
    cell.textContent = `#${stack.id}`;
    if (stack.id === bestId) cell.classList.add("hot");
    cell.addEventListener("click", () => inspectStack(stack, value));
    ui.battleGrid.appendChild(cell);
  });
}

function inspectStack(stack, value) {
  const estGasCost = state.gasPerKill * 100000;
  const estNet = value - estGasCost;
  ui.stackInspector.innerHTML = [
    `STACK_${stack.id}`,
    `UNITS: ${stack.units.toLocaleString()} | REAPERS: ${stack.reapers}`,
    `BOUNTY: ${stack.bounty.toFixed(2)}x`,
    `EXPECTED VALUE: ${formatKill(value)}`,
    `EST. NET EDGE: ${Math.round(estNet).toLocaleString()} KILL`
  ].join("<br>");
}

function setChip(el, ok) {
  el.textContent = ok ? "Done" : "Needs Action";
  el.classList.toggle("chip-on", ok);
  el.classList.toggle("chip-off", !ok);
}

function evaluateRisk() {
  const net = state.earned - state.spent;
  if (state.losingStreak >= 3) return "AUTO-PAUSE RECOMMENDED";
  if (net < 0 || state.gasPerKill > 0.0012) return "CRITICAL";
  if (state.gasPerKill > 0.001 || state.estEdge < 0) return "VOLATILE";
  return "STABLE";
}

function appendLog(line) {
  const item = document.createElement("div");
  item.className = "log-item";
  item.textContent = `[${state.block}] ${line}`;
  ui.logFeed.prepend(item);
  while (ui.logFeed.children.length > 30) {
    ui.logFeed.removeChild(ui.logFeed.lastChild);
  }
}

function render() {
  state.block += 1;
  state.estEdge = state.bestTarget - state.gasPerKill * 100000 - 110000;
  state.risk = evaluateRisk();

  ui.blockHeight.textContent = state.block.toLocaleString();
  ui.bestTargetValue.textContent = formatKill(state.bestTarget);
  ui.netEdge.textContent = `${Math.round(state.estEdge).toLocaleString()} KILL`;
  ui.netEdge.style.color = state.estEdge >= 0 ? "var(--good)" : "var(--hot)";
  ui.riskState.textContent = state.risk;
  ui.riskState.style.color = state.risk === "STABLE" ? "var(--good)" : (state.risk.includes("AUTO") ? "var(--hot)" : "var(--warn)");

  const netProfit = state.earned - state.spent;
  ui.totalEarned.textContent = `${state.earned.toFixed(2)} KILL`;
  ui.totalSpent.textContent = `${state.spent.toFixed(2)} KILL`;
  ui.netProfit.textContent = `${netProfit >= 0 ? "+" : ""}${netProfit.toFixed(2)} KILL`;
  ui.netProfit.style.color = netProfit >= 0 ? "var(--good)" : "var(--hot)";
  ui.gasPerKill.textContent = `${state.gasPerKill.toFixed(4)} ETH`;
  ui.walletEth.textContent = `${state.walletEth.toFixed(3)} ETH`;
  ui.agentMode.textContent = state.agentLive ? "LIVE" : "DRY_RUN";
  ui.agentMode.style.color = state.agentLive ? "var(--good)" : "var(--warn)";

  setChip(ui.checkWallet, state.walletEth >= 0.02);
  setChip(ui.checkRunning, state.agentLive);
  setChip(ui.checkProfit, netProfit > 0);
  setChip(ui.checkGas, state.gasPerKill <= 0.001);
}

function wireEvents() {
  ui.openModal.addEventListener("click", () => ui.modal.classList.remove("hidden"));
  ui.closeModal.addEventListener("click", () => ui.modal.classList.add("hidden"));
  ui.modal.addEventListener("click", (e) => {
    if (e.target === ui.modal) ui.modal.classList.add("hidden");
  });

  ui.copyCmdBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(ui.installCmd.textContent);
      ui.copyCmdBtn.textContent = "Copied";
      setTimeout(() => { ui.copyCmdBtn.textContent = "Copy"; }, 1400);
    } catch (err) {
      appendLog("Clipboard copy failed in this browser.");
    }
  });

  ui.fundBtn.addEventListener("click", () => {
    state.walletEth += 0.02;
    appendLog("Wallet funded +0.02 ETH.");
    render();
  });

  ui.toggleAgentBtn.addEventListener("click", () => {
    state.agentLive = !state.agentLive;
    appendLog(`Agent mode switched to ${state.agentLive ? "LIVE" : "DRY_RUN"}.`);
    render();
  });

  ui.winCycleBtn.addEventListener("click", () => {
    const gain = rand(3.0, 12.0);
    state.earned += gain;
    state.gasPerKill = Math.max(0.0007, state.gasPerKill - 0.00008);
    state.losingStreak = 0;
    appendLog(`Profitable cycle +${gain.toFixed(2)} KILL.`);
    perturbStacks();
    renderGrid();
    render();
  });

  ui.lossCycleBtn.addEventListener("click", () => {
    const loss = rand(2.0, 9.0);
    state.spent += loss;
    state.gasPerKill = Math.min(0.0016, state.gasPerKill + 0.00009);
    state.losingStreak += 1;
    appendLog(`Losing cycle -${loss.toFixed(2)} KILL.`);
    perturbStacks();
    renderGrid();
    render();
  });
}

function perturbStacks() {
  state.stacks = state.stacks.map((stack) => ({
    ...stack,
    units: Math.max(500, Math.floor(stack.units + rand(-5000, 7000))),
    reapers: Math.max(0, Math.min(9, Math.floor(stack.reapers + rand(-1, 2)))),
    bounty: Math.max(1.01, Math.min(4.25, stack.bounty + rand(-0.18, 0.24)))
  }));
}

function boot() {
  seedStacks();
  renderGrid();
  wireEvents();
  render();
  appendLog("Mock console initialized. Begin with funding and DRY_RUN.");
  setInterval(() => {
    if (Math.random() > 0.65) perturbStacks();
    renderGrid();
    render();
  }, 2500);
}

boot();
