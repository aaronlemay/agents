/**
 * Faithful mock overlay for operator onboarding and human actions.
 * This file augments the existing viewer UI without replacing core behavior.
 */
(function () {
    const state = {
        walletEth: 0.0,
        liveMode: false,
        gasPerKill: 0.0011,
        losingStreak: 0
    };

    const el = {
        bestTarget: document.getElementById('op-best-target'),
        netEdge: document.getElementById('op-net-edge'),
        riskState: document.getElementById('op-risk-state'),
        wallet: document.getElementById('op-wallet-eth'),
        mode: document.getElementById('op-mode'),
        gas: document.getElementById('op-gas-kill'),
        cWallet: document.getElementById('ck-wallet'),
        cAgent: document.getElementById('ck-agent'),
        cProfit: document.getElementById('ck-profit'),
        cGas: document.getElementById('ck-gas'),
        fundBtn: document.getElementById('btn-fund'),
        toggleBtn: document.getElementById('btn-toggle-agent'),
        winBtn: document.getElementById('btn-win-cycle'),
        lossBtn: document.getElementById('btn-loss-cycle')
    };

    function toNumber(text) {
        if (!text) return 0;
        const clean = String(text).replace(/[^0-9.+-]/g, '');
        const parsed = parseFloat(clean);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function setPill(node, ok) {
        if (!node) return;
        node.textContent = ok ? 'DONE' : 'NEEDS ACTION';
        node.classList.toggle('on', ok);
        node.classList.toggle('off', !ok);
    }

    function getTopStackKillValue() {
        const topRows = document.querySelectorAll('#ripe-stacks .stack-row');
        if (!topRows.length) return 0;
        const first = topRows[0].querySelector('span:last-child');
        return toNumber(first ? first.textContent : '0');
    }

    function computeRisk(estEdge, netProfit) {
        if (state.losingStreak >= 3) return 'AUTO-PAUSE';
        if (netProfit < 0 || state.gasPerKill > 0.0013) return 'CRITICAL';
        if (estEdge < 0 || state.gasPerKill > 0.0010) return 'VOLATILE';
        return 'STABLE';
    }

    function refreshOperatorUI() {
        const bestTarget = getTopStackKillValue();
        const netProfit = toNumber(document.getElementById('stat-game-pnl')?.textContent || '0');
        const estEdge = bestTarget - Math.floor(state.gasPerKill * 100000) - 100000;
        const risk = computeRisk(estEdge, netProfit);

        if (el.bestTarget) el.bestTarget.textContent = `${Math.floor(bestTarget).toLocaleString()} KILL`;
        if (el.netEdge) {
            el.netEdge.textContent = `${estEdge >= 0 ? '+' : ''}${Math.floor(estEdge).toLocaleString()} KILL`;
            el.netEdge.style.color = estEdge >= 0 ? 'var(--cyan)' : '#ffb86b';
        }
        if (el.riskState) {
            el.riskState.textContent = risk;
            el.riskState.style.color = risk === 'STABLE' ? 'var(--cyan)' : 'var(--pink)';
        }

        if (el.wallet) el.wallet.textContent = state.walletEth.toFixed(3);
        if (el.mode) {
            el.mode.textContent = state.liveMode ? 'LIVE' : 'DRY_RUN';
            el.mode.style.color = state.liveMode ? 'var(--cyan)' : '#ffb86b';
        }
        if (el.gas) el.gas.textContent = state.gasPerKill.toFixed(4);

        setPill(el.cWallet, state.walletEth >= 0.02);
        setPill(el.cAgent, state.liveMode);
        setPill(el.cProfit, netProfit > 0);
        setPill(el.cGas, state.gasPerKill <= 0.0010);
    }

    function appendLocalLog(msg) {
        if (typeof addLog === 'function') {
            const block = (typeof lastBlock === 'number' && lastBlock > 0) ? lastBlock : 'SIM';
            addLog(block, `[OPERATOR] ${msg}`, 'log-network');
        }
    }

    function wireControls() {
        if (el.fundBtn) {
            el.fundBtn.addEventListener('click', () => {
                state.walletEth += 0.02;
                appendLocalLog('Wallet funded +0.02 ETH');
                refreshOperatorUI();
            });
        }

        if (el.toggleBtn) {
            el.toggleBtn.addEventListener('click', () => {
                state.liveMode = !state.liveMode;
                appendLocalLog(`Mode switched to ${state.liveMode ? 'LIVE' : 'DRY_RUN'}`);
                refreshOperatorUI();
            });
        }

        if (el.winBtn) {
            el.winBtn.addEventListener('click', () => {
                state.gasPerKill = Math.max(0.0007, state.gasPerKill - 0.00008);
                state.losingStreak = 0;
                appendLocalLog('Simulated profit cycle');
                refreshOperatorUI();
            });
        }

        if (el.lossBtn) {
            el.lossBtn.addEventListener('click', () => {
                state.gasPerKill = Math.min(0.0018, state.gasPerKill + 0.0001);
                state.losingStreak += 1;
                appendLocalLog('Simulated loss cycle');
                refreshOperatorUI();
            });
        }
    }

    wireControls();
    refreshOperatorUI();
    setInterval(refreshOperatorUI, 2500);
})();
