const fs = require("fs");
const path = require("path");

const ROOT = "/Users/aaronlemay/agents/team-alpha/meta-controller";
const CONFIG_PATH = path.join(ROOT, "config.json");
const PLAYBOOKS_PATH = path.join(ROOT, "playbooks.json");

function readJson(p) {
    return JSON.parse(fs.readFileSync(p, "utf8"));
}

function extractNumber(line, key) {
    const m = line.match(new RegExp(`^-\\s*${key}:\\s*([^\\n]+)$`, "i"));
    return m ? m[1].trim() : null;
}

function parseIntelReport(reportPath) {
    const txt = fs.readFileSync(reportPath, "utf8");
    const lines = txt.split(/\r?\n/);

    let updated = null;
    let block = null;
    let wallet = null;
    let eth = null;
    let kill = null;
    let threatAddr = null;
    let threatStacks = 0;
    let topRoi = 0;
    let opportunities = 0;

    for (const line of lines) {
        if (line.startsWith("- Updated: ")) updated = line.replace("- Updated: ", "").trim();
        if (line.startsWith("- Block: ")) block = Number(line.replace("- Block: ", "").trim());
        if (line.startsWith("- Wallet: ")) wallet = line.replace("- Wallet: ", "").trim();
        if (line.startsWith("- ETH: ")) eth = Number(line.replace("- ETH: ", "").trim());
        if (line.startsWith("- KILL: ")) kill = Number(line.replace("- KILL: ", "").trim());
        if (line.startsWith("- Top threat: ")) {
            const raw = line.replace("- Top threat: ", "").trim();
            const m = raw.match(/^([0-9a-zA-Zx]+)\s+\((\d+)\s+stacks\)/);
            if (m) {
                threatAddr = m[1];
                threatStacks = Number(m[2]);
            }
        }
        if (line.startsWith("- Spawn+kill") || line.startsWith("- Direct kill")) {
            opportunities += 1;
            const rm = line.match(/roi\s+([0-9.]+)x/i) || line.match(/force\s+([0-9.]+)x/i);
            if (rm) topRoi = Math.max(topRoi, Number(rm[1]));
        }
    }

    return {
        updated,
        block,
        wallet,
        eth: Number.isFinite(eth) ? eth : 0,
        kill: Number.isFinite(kill) ? kill : 0,
        threatAddr,
        threatStacks,
        topRoi,
        opportunities
    };
}

function pickPlaybook(state, config) {
    const t = config.thresholds;
    const c = config.constraints;

    if (state.eth < t.min_live_eth) {
        return {
            id: "scout_hardening",
            reason: `ETH ${state.eth.toFixed(6)} below min_live_eth ${t.min_live_eth}`
        };
    }

    if (state.eth < t.min_compound_eth) {
        if (state.opportunities > 0 && state.topRoi >= t.min_viable_roi) {
            return {
                id: "parasite_compound",
                reason: `Low bankroll but viable opportunities (count=${state.opportunities}, topRoi=${state.topRoi.toFixed(2)}x)`
            };
        }
        return {
            id: "honeypot_lure",
            reason: `Low bankroll and sparse edge; use bait-style probing with strict spend cap ${c.max_eth_spend_per_tx}`
        };
    }

    if (state.threatStacks >= t.high_threat_stacks && state.topRoi >= t.min_viable_roi) {
        return {
            id: "sector_nuke_window",
            reason: `High threat density (${state.threatStacks} stacks) and enough edge for timed burst`
        };
    }

    return {
        id: "parasite_compound",
        reason: "Default compounding profile on stable bankroll"
    };
}

function getPlaybook(playbooks, id, fallback) {
    return playbooks.find((p) => p.id === id) || playbooks.find((p) => p.id === fallback);
}

function toMarkdown(decision) {
    const lines = [];
    lines.push("# Team Alpha Meta-Controller Decision");
    lines.push(`- Generated: ${new Date().toISOString()}`);
    lines.push(`- Playbook: ${decision.playbook.id}`);
    lines.push(`- Reason: ${decision.reason}`);
    lines.push(``);
    lines.push("## Market State");
    lines.push(`- Intel updated: ${decision.state.updated || "unknown"}`);
    lines.push(`- Block: ${decision.state.block || "unknown"}`);
    lines.push(`- Wallet: ${decision.state.wallet || "unknown"}`);
    lines.push(`- ETH: ${decision.state.eth}`);
    lines.push(`- KILL: ${decision.state.kill}`);
    lines.push(`- Top threat: ${decision.state.threatAddr || "none"} (${decision.state.threatStacks} stacks)`);
    lines.push(`- Opportunity count: ${decision.state.opportunities}`);
    lines.push(`- Top ROI observed: ${decision.state.topRoi.toFixed(2)}x`);
    lines.push(``);
    lines.push("## Agent Modes");
    for (const [agent, mode] of Object.entries(decision.playbook.agent_modes)) {
        lines.push(`- ${agent}: ${mode}`);
    }
    lines.push(``);
    lines.push("## Notes");
    lines.push("- This decision report does not modify live configs unless apply mode is explicitly implemented.");
    lines.push("- Use this as a control-plane artifact for manual ops or future auto-apply wiring.");
    if (decision.applyResult) {
        lines.push(``);
        lines.push("## Apply Result");
        lines.push(`- Apply mode: ${decision.applyResult.applyMode ? "enabled" : "disabled"}`);
        lines.push(`- Updated: ${decision.applyResult.updated}`);
        lines.push(`- Skipped: ${decision.applyResult.skipped}`);
        lines.push(`- Failed: ${decision.applyResult.failed}`);
        for (const d of decision.applyResult.details) {
            lines.push(`- ${d.agent}: ${d.status}${d.note ? ` (${d.note})` : ""}`);
        }
    }
    return `${lines.join("\n")}\n`;
}

function setDryRunModeForAgent(agent, mode, configPath) {
    if (!fs.existsSync(configPath)) {
        return { agent, status: "skipped", note: "config missing" };
    }
    const raw = readJson(configPath);
    if (!raw.settings) raw.settings = {};
    if (mode !== "dry_run" && mode !== "live") {
        return { agent, status: "skipped", note: `unsupported mode ${mode}` };
    }
    raw.settings.DRY_RUN = (mode === "dry_run");
    fs.writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    return { agent, status: "updated", note: `DRY_RUN=${raw.settings.DRY_RUN}` };
}

function applyPlaybook(playbook, cfg, applyMode) {
    const details = [];
    if (!applyMode) {
        return { applyMode: false, updated: 0, skipped: Object.keys(playbook.agent_modes).length, failed: 0, details };
    }
    const configMap = (cfg.paths && cfg.paths.agent_configs) || {};
    for (const [agent, mode] of Object.entries(playbook.agent_modes)) {
        try {
            const p = configMap[agent];
            if (!p) {
                details.push({ agent, status: "skipped", note: "path not configured" });
                continue;
            }
            details.push(setDryRunModeForAgent(agent, mode, p));
        } catch (err) {
            details.push({ agent, status: "failed", note: err.message });
        }
    }
    const updated = details.filter((d) => d.status === "updated").length;
    const skipped = details.filter((d) => d.status === "skipped").length;
    const failed = details.filter((d) => d.status === "failed").length;
    return { applyMode: true, updated, skipped, failed, details };
}

function main() {
    const cfg = readJson(CONFIG_PATH);
    const pb = readJson(PLAYBOOKS_PATH);
    const applyMode = process.argv.includes("--apply") || cfg.defaults.apply_changes === true;
    const state = parseIntelReport(cfg.paths.intel_report);
    const chosen = pickPlaybook(state, cfg);
    const playbook = getPlaybook(pb.playbooks, chosen.id, cfg.defaults.base_playbook);
    const applyResult = applyPlaybook(playbook, cfg, applyMode);

    const decision = {
        generatedAt: new Date().toISOString(),
        playbook,
        reason: chosen.reason,
        state,
        thresholds: cfg.thresholds,
        constraints: cfg.constraints,
        applyResult
    };

    fs.writeFileSync(cfg.paths.decision_json, JSON.stringify(decision, null, 2), "utf8");
    fs.writeFileSync(cfg.paths.decision_md, toMarkdown(decision), "utf8");

    process.stdout.write(`[META] Playbook selected: ${playbook.id}\n`);
    process.stdout.write(`[META] Reason: ${chosen.reason}\n`);
    process.stdout.write(`[META] Apply mode: ${applyResult.applyMode ? "enabled" : "disabled"}\n`);
    process.stdout.write(`[META] Updated: ${applyResult.updated}, Skipped: ${applyResult.skipped}, Failed: ${applyResult.failed}\n`);
    process.stdout.write(`[META] Decision JSON: ${cfg.paths.decision_json}\n`);
    process.stdout.write(`[META] Decision MD: ${cfg.paths.decision_md}\n`);
}

main();
