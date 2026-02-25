/**
 * KILL SYSTEM CORE - app.js
 */

// --- STATE MANAGEMENT ---
var knownIds = new Set();
var agentPnL = {}; 
var lastBlock = 0;
var syncCounter = 2;
var stackRegistry = {}; 
var currentGlobalKillStacked = 0;
var isDragging = false, startX, startY, rotateX = 60, rotateZ = -45;

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    // Initialization: Setup UI Labels
    if (networkLabel) networkLabel.innerText = NETWORK.toUpperCase();
    document.querySelectorAll('.net-var').forEach(el => el.innerText = NETWORK);

    // Run initial boot sequence
    initBattlefield(); 
    syncData();

    // Start Main Interval
    setInterval(() => { 
        syncCounter--; 
        if(syncCounter < 0) { 
            syncCounter = 2; 
            syncData(); 
        } 
    }, 1000);
});

/**
 * CAMERA: 3D Battlefield Controls
 */
window.onmousedown = (e) => {
    const isUI = e.target.className === 'node' || 
                 e.target.closest('.panel') || 
                 e.target.closest('.modal-content') || 
                 e.target.closest('.layer-controls');
                 
    if (isUI) return;
    
    isDragging = true; 
    startX = e.clientX; 
    startY = e.clientY;
};

window.onmouseup = () => { isDragging = false; };

window.onmousemove = (e) => {
    if (!isDragging || !battleField) return;
    
    rotateZ += (e.clientX - startX) * 0.5; 
    rotateX -= (e.clientY - startY) * 0.5;
    
    battleField.style.transform = `rotateX(${rotateX}deg) rotateZ(${rotateZ}deg)`;
    
    startX = e.clientX; 
    startY = e.clientY;
};

window.addEventListener('click', (e) => { 
    if (e.target === agentModal) toggleModal(false); 
});

console.log(`KILL AGENT MODULE INITIALIZED: ${NETWORK}`);