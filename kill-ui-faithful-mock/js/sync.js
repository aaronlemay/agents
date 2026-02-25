/**
 * KILL SYSTEM CORE - sync.js
 */

// --- ETHER INTERFACE ---
const provider = new ethers.JsonRpcProvider(ALCHEMY_URL);

/**
 * UTILITY: Format numbers for UI display
 */
const formatValue = (val) => {
    const absVal = Math.abs(val);
    if (absVal >= 1000000000) return (val / 1000000000).toFixed(1) + 'B';
    if (absVal >= 1000000) return (val / 1000000).toFixed(1) + 'M';
    if (absVal >= 1000) return (val / 1000).toFixed(1) + 'K';
    return Math.floor(val).toLocaleString();
};

/**
 * HEARTBEAT: Synchronize with the latest blockchain block height
 */
async function updateHeartbeat() {
    try {
        const hexBlock = await provider.send("eth_blockNumber", []);
        const currentBlock = parseInt(hexBlock, 16);
        
        if (currentBlock !== lastBlock && lastBlock !== 0) {
            const displayKill = Math.floor(currentGlobalKillStacked).toLocaleString();
            addLog(currentBlock, `BLOCK SYNC: ${displayKill} KILL`, "log-network");
        }
        
        if (headerBlock) headerBlock.innerText = currentBlock;
        lastBlock = currentBlock;
    } catch (e) {
        if (headerBlock) headerBlock.innerText = "SYNCING...";
        console.error("Heartbeat sync failed:", e);
    }
}

/**
 * UI: Tooltip for Top Stacks list
 */
function showStackTooltip(e, id, units, reapers, bounty, totalKill) {
    if (!tooltip) return;
    
    // Calculate Base Power for the tooltip display
    const basePower = units + (reapers * 666);

    tooltip.style.opacity = 1;
    tooltip.style.left = (e.pageX + 15) + 'px';
    tooltip.style.top = (e.pageY + 15) + 'px';
    
    tooltip.innerHTML = `
        <div style="padding: 5px; min-width: 180px; font-family: 'Courier New', monospace;">
            <strong style="color:var(--pink); font-size: 0.7rem;">STACK_IDENTITY: ${id}</strong>
            <div style="border-bottom: 1px solid #333; margin: 4px 0;"></div>
            <div style="display:flex; justify-content:space-between; font-size:0.65rem;">
                <span>UNITS:</span> <span>${units.toLocaleString()}</span>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:0.65rem; color:var(--cyan)">
                <span>REAPER:</span> <span>${reapers}</span>
            </div>
             <div style="display:flex; justify-content:space-between; font-size:0.65rem; opacity:0.8;">
                <span>BASE_POWER:</span> <span>${basePower.toLocaleString()}</span>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:0.65rem; color:var(--cyan)">
                <span>BOUNTY:</span> <span>${bounty.toFixed(3)}x</span>
            </div>
            <div style="border-bottom: 1px solid #333; margin: 4px 0;"></div>
            <div style="display:flex; justify-content:space-between; font-weight:bold; color:var(--pink); font-size:0.75rem;">
                <span>VALUE:</span> <span>${Math.floor(totalKill).toLocaleString()} KILL</span>
            </div>
        </div>
    `;
}

/**
 * UI: Render the Top Stacks leaderboard rows
 */
function updateTopStacks(stacks, activeReaperMap) {
    if (!topStacksEl) return;
    let globalUnits = 0, globalReapers = 0, globalBountyKill = 0;

    const processed = stacks.map(s => {
        const u = parseInt(s.totalStandardUnits || 0);
        const r = activeReaperMap[s.id] || parseInt(s.totalBoostedUnits) || 0;
        const bBlock = parseInt(s.birthBlock || 0);
        
        // Calculate Bounty and Value using contract logic
        const age = (lastBlock > 0 && bBlock > 0) ? (lastBlock - bBlock) : 0;
        const displayBounty = (1 + (age / 1000));
        const basePower = u + (r * 666);
        const totalKillValue = basePower * displayBounty;

        globalUnits += u; 
        globalReapers += r; 
        globalBountyKill += totalKillValue;
        
        stackRegistry[s.id] = { 
            units: u, 
            reaper: r, 
            birthBlock: bBlock,
            bounty: displayBounty,
            totalKill: totalKillValue
        }; 
        
        updateNodeParticles(s.id, u, r);
        
        return { id: s.id, units: u, reapers: r, bounty: displayBounty, kill: totalKillValue };
    });

    currentGlobalKillStacked = globalBountyKill;
    if(totalUnitsActiveEl) totalUnitsActiveEl.innerText = globalUnits.toLocaleString();
    if(totalReapersActiveEl) totalReapersActiveEl.innerText = globalReapers.toLocaleString();
    if(totalKillBountyEl) totalKillBountyEl.innerText = `${Math.floor(globalBountyKill).toLocaleString()}`;

    const sorted = processed.filter(s => s.units > 0 || s.reapers > 0).sort((a, b) => b.kill - a.kill);
    if (sorted.length === 0) {
        topStacksEl.innerHTML = '<div style="font-size:0.7rem; color:#444; padding:10px;">ARENA EMPTY...</div>';
        return;
    }

    topStacksEl.innerHTML = sorted.map(item => `
        <div class="stack-row" 
             onmouseover="showStackTooltip(event, '${item.id}', ${item.units}, ${item.reapers}, ${item.bounty}, ${item.kill})" 
             onmouseout="if(tooltip) tooltip.style.opacity=0" 
             style="display: flex; justify-content: space-between; border-bottom: 1px solid #111; padding: 2px 0; cursor: crosshair;">
            <span style="width:10%; color:#555;">${item.id}</span>
            <span style="width:20%">${item.units >= 1000 ? (item.units / 1000).toFixed(1) + 'K' : item.units}</span>
            <span style="width:10%; color:var(--cyan)">${item.reapers}</span>
            <span style="width:25%; color:var(--cyan); opacity:0.8;">${item.bounty.toFixed(2)}x</span>
            <span style="width:35%; text-align:right; color:var(--pink); font-weight:bold;">${Math.floor(item.kill).toLocaleString()}</span>
        </div>
    `).join('');
}

/**
 * CORE: Main Data Synchronization Loop
 */
async function syncData() {
    await updateHeartbeat();
    
    try {
        const query = `{
            globalStat(id: "current") { 
                totalUnitsKilled 
                totalReaperKilled 
                killBurned 
            }
            stacks(orderBy: totalStandardUnits, orderDirection: desc, first: 100) { 
                id 
                totalStandardUnits 
                totalBoostedUnits 
                birthBlock
                currentBounty
            }
            killeds(first: 50, orderBy: block_number, orderDirection: desc) { 
                id 
                attacker 
                target
                stackId 
                attackerUnitsSent
                attackerReaperSent
                attackerUnitsLost
                attackerReaperLost
                targetUnitsLost 
                targetReaperLost
                attackerBounty
                defenderBounty
                initialDefenderUnits
                initialDefenderReaper
                block_number 
            }
            spawneds(first: 50, orderBy: block_number, orderDirection: desc) { 
                id 
                agent 
                stackId 
                units
                reapers
                block_number 
            }
            moveds(first: 50, orderBy: block_number, orderDirection: desc) { 
                id 
                agent 
                fromStack 
                toStack 
                units 
                reaper
                block_number 
            }
            agents(first: 100, orderBy: netPnL, orderDirection: desc) {
                id
                totalSpent
                totalEarned
                netPnL
            }
        }`;

        const resp = await fetch(SUBGRAPH_URL, { 
            method: "POST", 
            headers: { "Content-Type": "application/json" }, 
            body: JSON.stringify({ query }) 
        });

        const result = await resp.json();
        if (!result || !result.data) return;

        const { globalStat, killeds = [], spawneds = [], moveds = [], stacks = [], agents = [] } = result.data;
        
        const activeReaperMap = {};
        stacks.forEach(s => activeReaperMap[s.id] = parseInt(s.totalBoostedUnits || "0"));

        // --- Updated System Status Logic ---
        if (statusEl) {
            let statusText = "OPERATIONAL";
            const totalStacked = currentGlobalKillStacked;

            if (totalStacked >= 20000000) statusText = "LETHAL";
            else if (totalStacked >= 15000000) statusText = "CRITICAL";
            else if (totalStacked >= 10000000) statusText = "VOLATILE";
            else if (totalStacked >= 5000000)  statusText = "ACTIVE";
            else if (totalStacked > 0)        statusText = "STABLE";

            statusEl.innerHTML = totalStacked >= 20000000 ? 
                `<span class="lethal-dot"></span>SYSTEM STATUS: ${statusText}` : 
                `SYSTEM STATUS: ${statusText}`;
        }

        updateTopStacks(stacks, activeReaperMap);
        
        // RESTORED: Global Metrics Math
        let totalEarned = 0;
        let totalSpent = 0;
        agents.forEach(a => {
            totalEarned += parseFloat(ethers.formatEther(a.totalEarned || "0"));
            totalSpent += parseFloat(ethers.formatEther(a.totalSpent || "0"));
        });
        const totalNet = totalEarned - totalSpent;

        if (gameProfitEl) gameProfitEl.innerText = formatValue(totalEarned);
        if (gameCostEl) gameCostEl.innerText = formatValue(totalSpent);
        if (gamePnlEl) {
            gamePnlEl.innerText = (totalNet > 0 ? "+" : "") + formatValue(totalNet);
            gamePnlEl.style.color = totalNet >= 0 ? "var(--cyan)" : "var(--pink)";
        }

        // --- Updated Burned & Supply Logic ---
        if (globalStat) {
            if (unitsKilledEl) unitsKilledEl.innerText = parseInt(globalStat.totalUnitsKilled).toLocaleString();
            if (reaperKilledEl) reaperKilledEl.innerText = parseInt(globalStat.totalReaperKilled).toLocaleString();
            
            const burned = parseFloat(ethers.formatEther(globalStat.killBurned || "0"));
            const initialSupply = 6666666666;
            const circulating = initialSupply - burned;

            if (killBurnedEl) killBurnedEl.innerText = `${burned.toLocaleString(undefined, {minimumFractionDigits: 3})} KILL`;
            
            // Target the new circulating ID
            const circulatingEl = document.getElementById('stat-kill-circulating');
            if (circulatingEl) circulatingEl.innerText = Math.floor(circulating).toLocaleString();
        }

        // RESTORED: Event Logging Logic
        const events = [
            ...spawneds.map(s => ({...s, type: 'spawn'})), 
            ...killeds.map(k => ({...k, type: 'kill'})), 
            ...moveds.map(m => ({...m, type: 'move'}))
        ].sort((a, b) => Number(a.block_number) - Number(b.block_number));

        events.forEach(evt => {
            if (!knownIds.has(evt.id)) {
                if (evt.type === 'spawn') {
                    const logMsg = `[SPAWN] ${evt.agent.substring(0, 8)} to STACK_${evt.stackId}`;
                    const subMsg = `UNITS: ${parseInt(evt.units).toLocaleString()}\nREAPER: ${evt.reapers}`;
                    addLog(evt.block_number, logMsg, 'log-spawn', subMsg);
                    triggerPulse(evt.stackId, 'spawn');
                } else if (evt.type === 'kill') {
                    const atkUnitsSent = parseInt(evt.attackerUnitsSent || 0);
                    const atkReaperSent = parseInt(evt.attackerReaperSent || 0);
                    const defUnitsInit = parseInt(evt.initialDefenderUnits || 0);
                    const defReaperInit = parseInt(evt.initialDefenderReaper || 0);
                    const atkUnitsLost = parseInt(evt.attackerUnitsLost || 0);
                    const atkReaperLost = parseInt(evt.attackerReaperLost || 0);
                    const defUnitsLost = parseInt(evt.targetUnitsLost || 0);
                    const defReaperLost = parseInt(evt.targetReaperLost || 0);
                    const atkBounty = parseFloat(ethers.formatEther(evt.attackerBounty || "0"));
                    const defBounty = parseFloat(ethers.formatEther(evt.defenderBounty || "0"));

                    const logMsg = `[KILL] ${evt.attacker.substring(0,6)} raided STACK_${evt.stackId}`;
                    const line1 = `BATTLE OFFENSE: ${atkUnitsSent} units, ${atkReaperSent} reaper | DEFENSE: ${defUnitsInit} units, ${defReaperInit} reaper`;
                    const line2 = `KILL OFFENSE: ${atkUnitsLost} units, ${atkReaperLost} reaper | DEFENSE: ${defUnitsLost} units, ${defReaperLost} reaper`;
                    const line3 = `ECONOMY OFFENSE: +${formatValue(atkBounty)} KILL | DEFENSE: +${formatValue(defBounty)} KILL`;

                    addLog(evt.block_number, logMsg, 'log-kill', `${line1}\n${line2}\n${line3}`);
                    triggerPulse(evt.stackId, 'kill');
                } else if (evt.type === 'move') {
                    addLog(evt.block_number, `[MOVE] ${evt.agent.substring(0,6)} shifted ${evt.units} to STACK_${evt.toStack}`, 'log-move');
                    triggerPulse(evt.toStack, 'spawn'); 
                }
                knownIds.add(evt.id);
            }
        });

        renderPnL(agents.slice(0, 10));

    } catch (e) { console.error("Sync fail", e); }
}

/**
 * UI: Render Agent P&L Leaderboard
 */
function renderPnL(agents) {
    if (!pnlEl) return;
    
    pnlEl.innerHTML = agents.map(a => {
        const spent = parseFloat(ethers.formatEther(a.totalSpent || "0"));
        const earned = parseFloat(ethers.formatEther(a.totalEarned || "0"));
        const net = earned - spent;
        return `
            <div class="stack-row" onmouseover="showLeaderboardTooltip(event, '${a.id}', ${earned}, ${spent}, ${net})" onmouseout="if(tooltip) tooltip.style.opacity=0" style="display: flex; justify-content: space-between; padding: 2px 0;">
                <span style="width:25%; font-family:monospace;">
                    <a href="${BLOCK_EXPLORER}/address/${a.id}" target="_blank" style="color:#888; text-decoration:none;">${a.id.substring(0, 8)}</a>
                </span>
                <span style="width:25%; text-align:right; color:${earned > 0 ? 'var(--cyan)' : '#eee'}; font-weight:bold;">${formatValue(earned)}</span>
                <span style="width:20%; text-align:right; opacity:0.6;">${formatValue(spent)}</span>
                <span style="width:30%; text-align:right; color:${net > 0 ? 'var(--cyan)' : 'var(--pink)'}; font-weight:bold;">${net > 0 ? '+' : ''}${formatValue(net)}</span>
            </div>
        `;
    }).join('');
}

/**
 * UI: Enhanced Tooltip for Leaderboard Rows
 */
function showLeaderboardTooltip(e, addr, earned, spent, net) {
    if (!tooltip) return;
    const pnlColor = net > 0 ? 'var(--cyan)' : 'var(--pink)';
    tooltip.style.opacity = 1;
    tooltip.style.left = (e.pageX + 15) + 'px';
    tooltip.style.top = (e.pageY + 15) + 'px';
    tooltip.innerHTML = `
        <div style="padding: 2px; min-width: 200px; font-family: 'Courier New', monospace;">
            <strong style="color:var(--pink); font-size: 0.65rem;">AGENT_IDENTITY</strong><br>
            <span style="font-size:0.7rem; color:var(--cyan); word-break:break-all;">${addr}</span>
            <hr style="border:0; border-top:1px solid #333; margin:8px 0;">
            <div style="display:flex; justify-content:space-between; font-size:0.7rem;"><span>EARNED:</span> <span>${formatValue(earned)}</span></div>
            <div style="display:flex; justify-content:space-between; font-size:0.7rem;"><span>SPENT:</span> <span>${formatValue(spent)}</span></div>
            <div style="display:flex; justify-content:space-between; margin-top:4px; font-weight:bold; color:${pnlColor}; font-size:0.75rem;">
                <span>NET P/L:</span> <span>${net > 0 ? '+' : ''}${formatValue(net)}</span>
            </div>
        </div>
    `;
}