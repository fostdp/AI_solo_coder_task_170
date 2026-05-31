const CONFIG = {
    GRID_SIZE: 40,
    GRID_COLS: 20,
    GRID_ROWS: 15,
    CANVAS_WIDTH: 800,
    CANVAS_HEIGHT: 600,
    MAP_CENTER: [39.9042, 116.4074],
    MAP_ZOOM: 15,
    WIND_UPDATE_INTERVAL: 50,
    WS_URL: `ws://${window.location.host}/ws`
};

const SPECIES_DEFINITIONS = {
    SO2: { name: '二氧化硫', unit: 'ppm', color: '#78909c', safe: 0.15, danger: 0.5 },
    SO4: { name: '硫酸盐', unit: 'ppm', color: '#a1887f', safe: 0.1, danger: 0.3 },
    NO2: { name: '二氧化氮', unit: 'ppm', color: '#ef5350', safe: 0.04, danger: 0.1 },
    PM25: { name: 'PM2.5', unit: 'ppm', color: '#8d6e63', safe: 15, danger: 35 },
    PM10: { name: 'PM10', unit: 'ppm', color: '#6d4c41', safe: 35, danger: 70 }
};

const STABILITY_PARAMS = {
    A: { sigmaY: 0.22, sigmaZ: 0.20, name: '极不稳定' },
    B: { sigmaY: 0.16, sigmaZ: 0.12, name: '不稳定' },
    C: { sigmaY: 0.11, sigmaZ: 0.08, name: '弱不稳定' },
    D: { sigmaY: 0.08, sigmaZ: 0.06, name: '中性' },
    E: { sigmaY: 0.06, sigmaZ: 0.03, name: '弱稳定' },
    F: { sigmaY: 0.04, sigmaZ: 0.016, name: '稳定' }
};

class DispersionWorker {
    constructor() {
        this.worker = null;
        this.taskId = 0;
        this.callbacks = new Map();
        this.isReady = false;
        this.init();
    }

    init() {
        try {
            this.worker = new Worker('dispersion.worker.js');
            
            this.worker.onmessage = (e) => {
                const { type, taskId, data, error } = e.data;
                
                if (type === 'ready') {
                    this.isReady = true;
                    console.log('Web Worker ready');
                } else if (type === 'result' || type === 'hygroscopicCurve') {
                    const callback = this.callbacks.get(taskId);
                    if (callback) {
                        callback.resolve(data);
                        this.callbacks.delete(taskId);
                    }
                } else if (type === 'error') {
                    const callback = this.callbacks.get(taskId);
                    if (callback) {
                        callback.reject(new Error(error));
                        this.callbacks.delete(taskId);
                    }
                }
            };
        } catch (e) {
            console.error('Failed to init Web Worker:', e);
        }
    }

    simulate(config) {
        return new Promise((resolve, reject) => {
            if (!this.worker) {
                reject(new Error('Worker not initialized'));
                return;
            }
            
            const taskId = ++this.taskId;
            this.callbacks.set(taskId, { resolve, reject });
            
            this.worker.postMessage({
                type: 'simulate',
                taskId,
                config
            });
        });
    }

    getHygroscopicCurve(species, start = 30, end = 100, step = 5) {
        return new Promise((resolve, reject) => {
            if (!this.worker) {
                reject(new Error('Worker not initialized'));
                return;
            }
            
            const taskId = ++this.taskId;
            this.callbacks.set(taskId, { resolve, reject });
            
            this.worker.postMessage({
                type: 'hygroscopicCurve',
                taskId,
                config: { species, startRH: start, endRH: end, step }
            });
        });
    }
}

class WebSocketClient {
    constructor(url) {
        this.url = url;
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 3000;
        this.listeners = new Map();
        this.connect();
    }

    connect() {
        try {
            this.ws = new WebSocket(this.url);
            
            this.ws.onopen = () => {
                console.log('WebSocket connected');
                this.reconnectAttempts = 0;
                this.emit('connected');
            };

            this.ws.onmessage = (e) => {
                try {
                    const data = JSON.parse(e.data);
                    this.emit(data.type || 'message', data);
                } catch (err) {
                    console.error('WebSocket parse error:', err);
                }
            };

            this.ws.onerror = (err) => {
                console.error('WebSocket error:', err);
                this.emit('error', err);
            };

            this.ws.onclose = () => {
                console.log('WebSocket disconnected');
                this.emit('disconnected');
                this.scheduleReconnect();
            };
        } catch (e) {
            console.error('WebSocket connection failed:', e);
            this.scheduleReconnect();
        }
    }

    scheduleReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            setTimeout(() => {
                console.log(`Reconnecting... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
                this.connect();
            }, this.reconnectDelay);
        }
    }

    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    on(event, callback) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        this.listeners.get(event).push(callback);
    }

    emit(event, data) {
        if (this.listeners.has(event)) {
            this.listeners.get(event).forEach(cb => cb(data));
        }
    }
}

class AlertManager {
    constructor() {
        this.alerts = [];
        this.container = document.getElementById('alertContainer');
    }

    addAlert(alert) {
        const exists = this.alerts.find(a => a.id === alert.id);
        if (exists) return;

        this.alerts.unshift(alert);
        if (this.alerts.length > 20) this.alerts.pop();
        
        this.render();
        this.showNotification(alert);
    }

    render() {
        if (!this.container) return;
        
        if (this.alerts.length === 0) {
            this.container.innerHTML = '<div class="no-alerts">⚠️ 暂无预警信息</div>';
            return;
        }

        this.container.innerHTML = this.alerts.map(alert => {
            const levelClass = alert.level === 'danger' ? 'alert-danger' : 'alert-warning';
            return `
                <div class="alert-item ${levelClass}">
                    <div class="alert-header">
                        <span class="alert-title">${alert.speciesName}</span>
                        <span class="alert-level">${alert.level === 'danger' ? '危险' : '警告'}</span>
                    </div>
                    <div class="alert-content">
                        <p>${alert.message}</p>
                        <small>浓度: ${alert.concentration.toFixed(3)} ppm | 阈值: ${alert.dangerThreshold} ppm</small>
                        <small class="alert-time">${new Date(alert.timestamp).toLocaleTimeString()}</small>
                    </div>
                    <button class="alert-dismiss" onclick="app.alertManager.dismiss('${alert.id}')">×</button>
                </div>
            `;
        }).join('');
    }

    showNotification(alert) {
        const notification = document.getElementById('notification');
        if (notification) {
            notification.textContent = `⚠️ ${alert.message}`;
            notification.className = `notification show ${alert.level}`;
            setTimeout(() => notification.classList.remove('show'), 5000);
        }
    }

    dismiss(alertId) {
        this.alerts = this.alerts.filter(a => a.id !== alertId);
        this.render();
    }
}

class MapManager {
    constructor() {
        this.map = null;
        this.heatLayer = null;
        this.markers = [];
        this.init();
    }

    init() {
        if (!window.L) {
            console.log('Leaflet not loaded, skipping map initialization');
            return;
        }

        this.map = L.map('mapContainer', {
            zoomControl: true,
            attributionControl: false
        }).setView(CONFIG.MAP_CENTER, CONFIG.MAP_ZOOM);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19
        }).addTo(this.map);

        L.circleMarker(CONFIG.MAP_CENTER, {
            radius: 8,
            fillColor: '#ff0000',
            color: '#ff0000',
            weight: 2,
            opacity: 1,
            fillOpacity: 0.8
        }).addTo(this.map).bindPopup('🏭 工厂污染源');

        console.log('Map initialized');
    }

    updateHeatmap(concentrationGrid, species) {
        if (!this.map || !window.L || !window.L.heatLayer) return;

        const heatPoints = [];
        const [baseLat, baseLng] = CONFIG.MAP_CENTER;
        const latStep = 0.0008;
        const lngStep = 0.0008;

        for (let y = 0; y < concentrationGrid.length; y++) {
            for (let x = 0; x < concentrationGrid[y].length; x++) {
                const conc = concentrationGrid[y][x];
                if (conc > 0.001) {
                    const lat = baseLat + (y - 7) * latStep;
                    const lng = baseLng + (x - 10) * lngStep;
                    const intensity = Math.min(conc / 2, 1);
                    heatPoints.push([lat, lng, intensity]);
                }
            }
        }

        if (this.heatLayer) {
            this.map.removeLayer(this.heatLayer);
        }

        if (heatPoints.length > 0) {
            this.heatLayer = L.heatLayer(heatPoints, {
                radius: 25,
                blur: 15,
                maxZoom: 18,
                gradient: {
                    0.2: '#4CAF50',
                    0.4: '#FFC107',
                    0.6: '#FF9800',
                    0.8: '#FF5722',
                    1.0: '#F44336'
                }
            }).addTo(this.map);
        }
    }
}

class SimulationApp {
    constructor() {
        this.state = {
            running: false,
            paused: false,
            simulationTime: 0,
            windSpeed: 5.0,
            windDirection: 90,
            temperature: 25,
            humidity: 60,
            emissionIntensity: 50,
            stackHeight: 80,
            stabilityClass: 'D',
            reactionRate: 0.01,
            enableReaction: true,
            displaySpecies: 'SO2',
            sourceX: 200,
            sourceY: 300,
            particles: [],
            speciesData: {
                SO2: { grid: [], maxConc: 0 },
                SO4: { grid: [], maxConc: 0 },
                NO2: { grid: [], maxConc: 0 },
                PM25: { grid: [], maxConc: 0 },
                PM10: { grid: [], maxConc: 0 }
            }
        };

        this.worker = null;
        this.ws = null;
        this.alertManager = null;
        this.mapManager = null;
        this.canvas = null;
        this.ctx = null;
        this.lastUpdate = 0;
        this.buildings = [];
        this.roads = [];
        this.trees = [];
        
        this.init();
    }

    init() {
        this.canvas = document.getElementById('simulationCanvas');
        this.ctx = this.canvas.getContext('2d');
        
        this.initGrids();
        this.initCityMap();
        
        this.worker = new DispersionWorker();
        this.ws = new WebSocketClient(CONFIG.WS_URL);
        this.alertManager = new AlertManager();
        this.mapManager = new MapManager();
        
        this.setupEventListeners();
        this.setupWebSocketListeners();
        
        this.requestAnimationFrame();
    }

    initGrids() {
        Object.keys(this.state.speciesData).forEach(species => {
            this.state.speciesData[species].grid = [];
            for (let i = 0; i < CONFIG.GRID_ROWS; i++) {
                this.state.speciesData[species].grid[i] = [];
                for (let j = 0; j < CONFIG.GRID_COLS; j++) {
                    this.state.speciesData[species].grid[i][j] = 0;
                }
            }
        });
    }

    initCityMap() {
        this.buildings = [
            { x: 60, y: 150, w: 40, h: 50 }, { x: 60, y: 210, w: 35, h: 45 },
            { x: 110, y: 140, w: 50, h: 60 }, { x: 110, y: 210, w: 45, h: 40 },
            { x: 320, y: 120, w: 55, h: 70 }, { x: 380, y: 130, w: 40, h: 55 },
            { x: 320, y: 200, w: 45, h: 50 }, { x: 375, y: 195, w: 50, h: 60 },
            { x: 500, y: 100, w: 60, h: 80 }, { x: 500, y: 190, w: 55, h: 55 },
            { x: 570, y: 110, w: 45, h: 70 }, { x: 570, y: 190, w: 50, h: 55 },
            { x: 650, y: 130, w: 70, h: 60 }, { x: 650, y: 200, w: 55, h: 45 },
            { x: 100, y: 400, w: 50, h: 40 }, { x: 160, y: 410, w: 40, h: 45 },
            { x: 300, y: 420, w: 45, h: 50 }, { x: 355, y: 400, w: 55, h: 55 },
            { x: 500, y: 430, w: 40, h: 40 }, { x: 550, y: 410, w: 50, h: 50 },
            { x: 650, y: 420, w: 60, h: 45 }
        ];

        this.roads = [
            { x1: 0, y1: 350, x2: 800, y2: 350, width: 30 },
            { x1: 250, y1: 0, x2: 250, y2: 600, width: 25 },
            { x1: 450, y1: 0, x2: 450, y2: 600, width: 25 }
        ];

        this.trees = [
            { x: 50, y: 100 }, { x: 50, y: 300 }, { x: 50, y: 500 },
            { x: 280, y: 100 }, { x: 280, y: 300 }, { x: 280, y: 500 },
            { x: 480, y: 100 }, { x: 480, y: 300 }, { x: 480, y: 500 },
            { x: 680, y: 100 }, { x: 680, y: 300 }, { x: 680, y: 500 },
            { x: 150, y: 480 }, { x: 350, y: 480 }, { x: 550, y: 480 },
            { x: 750, y: 480 }, { x: 750, y: 150 }, { x: 750, y: 250 }
        ];
    }

    setupEventListeners() {
        document.getElementById('windSpeed').addEventListener('input', e => {
            this.state.windSpeed = parseFloat(e.target.value);
            document.getElementById('windSpeedValue').textContent = this.state.windSpeed.toFixed(1);
        });

        document.getElementById('windDirection').addEventListener('input', e => {
            this.state.windDirection = parseFloat(e.target.value);
            document.getElementById('windDirectionValue').textContent = this.state.windDirection;
            const arrow = document.getElementById('compassArrow');
            if (arrow) arrow.style.transform = `translateX(-50%) rotate(${this.state.windDirection - 180}deg)`;
        });

        document.getElementById('temperature').addEventListener('input', e => {
            this.state.temperature = parseFloat(e.target.value);
            document.getElementById('temperatureValue').textContent = this.state.temperature;
        });

        document.getElementById('humidity').addEventListener('input', e => {
            this.state.humidity = parseFloat(e.target.value);
            document.getElementById('humidityValue').textContent = this.state.humidity;
        });

        document.getElementById('emissionIntensity').addEventListener('input', e => {
            this.state.emissionIntensity = parseFloat(e.target.value);
            document.getElementById('emissionValue').textContent = this.state.emissionIntensity;
        });

        document.getElementById('stackHeight').addEventListener('input', e => {
            this.state.stackHeight = parseFloat(e.target.value);
            document.getElementById('stackHeightValue').textContent = this.state.stackHeight;
        });

        document.getElementById('stabilityClass').addEventListener('change', e => {
            this.state.stabilityClass = e.target.value;
        });

        document.getElementById('reactionRate').addEventListener('input', e => {
            this.state.reactionRate = parseFloat(e.target.value);
            document.getElementById('reactionRateValue').textContent = this.state.reactionRate.toFixed(3);
        });

        document.getElementById('enableReaction').addEventListener('change', e => {
            this.state.enableReaction = e.target.checked;
        });

        document.getElementById('startBtn').addEventListener('click', () => this.startSimulation());
        document.getElementById('pauseBtn').addEventListener('click', () => this.togglePause());
        document.getElementById('resetBtn').addEventListener('click', () => this.resetSimulation());
        document.getElementById('saveBtn').addEventListener('click', () => this.saveSnapshot());
        document.getElementById('loadBtn').addEventListener('click', () => this.loadHistory());

        document.getElementById('closeModal').addEventListener('click', () => this.closeHistoryModal());
        document.getElementById('historyModal').addEventListener('click', e => {
            if (e.target === document.getElementById('historyModal')) this.closeHistoryModal();
        });

        this.canvas.addEventListener('click', e => this.handleCanvasClick(e));
    }

    setupWebSocketListeners() {
        this.ws.on('alerts', data => {
            if (data.alerts) {
                data.alerts.forEach(alert => this.alertManager.addAlert(alert));
            }
        });

        this.ws.on('connected', () => {
            console.log('WebSocket connected to server');
        });
    }

    startSimulation() {
        this.state.running = true;
        this.state.paused = false;
        document.getElementById('canvasOverlay').classList.add('hidden');
        this.showNotification('模拟已启动', 'success');
    }

    togglePause() {
        this.state.paused = !this.state.paused;
        this.showNotification(this.state.paused ? '已暂停' : '继续模拟', 'info');
    }

    resetSimulation() {
        this.state.running = false;
        this.state.paused = false;
        this.state.simulationTime = 0;
        this.state.particles = [];
        this.initGrids();
        document.getElementById('canvasOverlay').classList.remove('hidden');
        this.showNotification('模拟已重置', 'info');
    }

    async runSimulationStep() {
        if (!this.worker.isReady) return;

        const previousConcentrations = {};
        Object.keys(this.state.speciesData).forEach(species => {
            previousConcentrations[species] = this.state.speciesData[species].grid;
        });

        try {
            const result = await this.worker.simulate({
                windSpeed: this.state.windSpeed,
                windDirection: this.state.windDirection,
                emissionIntensity: this.state.emissionIntensity,
                stackHeight: this.state.stackHeight,
                stabilityClass: this.state.stabilityClass,
                humidity: this.state.humidity,
                temperature: this.state.temperature,
                gridSize: CONFIG.GRID_SIZE,
                gridCols: CONFIG.GRID_COLS,
                gridRows: CONFIG.GRID_ROWS,
                sourceX: this.state.sourceX,
                sourceY: this.state.sourceY,
                enableReaction: this.state.enableReaction,
                reactionRate: this.state.reactionRate,
                speciesList: Object.keys(this.state.speciesData),
                previousConcentrations: previousConcentrations
            });

            Object.keys(result.concentrations).forEach(species => {
                if (this.state.speciesData[species]) {
                    this.state.speciesData[species].grid = result.concentrations[species];
                    this.state.speciesData[species].maxConc = result.statistics[species]?.max || 0;
                }
            });

            if (result.warnings && result.warnings.length > 0) {
                result.warnings.forEach(warning => {
                    this.alertManager.addAlert({
                        id: `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        species: warning.species,
                        speciesName: SPECIES_DEFINITIONS[warning.species]?.name || warning.species,
                        level: warning.maxConc > SPECIES_DEFINITIONS[warning.species]?.danger ? 'danger' : 'warning',
                        concentration: warning.maxConc,
                        dangerThreshold: SPECIES_DEFINITIONS[warning.species]?.danger || 0,
                        warningThreshold: SPECIES_DEFINITIONS[warning.species]?.safe || 0,
                        location: warning.location,
                        timestamp: new Date().toISOString(),
                        message: `${SPECIES_DEFINITIONS[warning.species]?.name || warning.species}浓度超标: ${warning.maxConc.toFixed(3)} ppm`
                    });
                });
            }

            if (this.mapManager && this.mapManager.heatLayer) {
                this.mapManager.updateHeatmap(
                    this.state.speciesData[this.state.displaySpecies].grid,
                    this.state.displaySpecies
                );
            }
        } catch (e) {
            console.error('Simulation step error:', e);
        }
    }

    updateParticles() {
        if (!this.state.running || this.state.paused || this.state.emissionIntensity <= 0) return;

        const emitRate = Math.min(Math.floor(this.state.emissionIntensity / 10), 5);
        const windRad = (this.state.windDirection - 90) * Math.PI / 180;
        const turbulence = STABILITY_PARAMS[this.state.stabilityClass].sigmaY * 10;

        for (let i = 0; i < emitRate; i++) {
            this.state.particles.push({
                x: this.state.sourceX,
                y: this.state.sourceY,
                vx: Math.cos(windRad) * this.state.windSpeed * 0.5 + (Math.random() - 0.5) * turbulence,
                vy: Math.sin(windRad) * this.state.windSpeed * 0.5 + (Math.random() - 0.5) * turbulence,
                life: 1.0,
                maxLife: 100 + Math.random() * 100,
                size: 2 + Math.random() * 4,
                species: ['SO2', 'NO2', 'PM25'][Math.floor(Math.random() * 3)]
            });
        }

        for (let i = this.state.particles.length - 1; i >= 0; i--) {
            const p = this.state.particles[i];
            p.vx += (Math.random() - 0.5) * turbulence * 0.5;
            p.vy += (Math.random() - 0.5) * turbulence * 0.3;
            p.x += p.vx * 0.5;
            p.y += p.vy * 0.5;
            p.life -= 1 / p.maxLife;

            if (p.life <= 0 || p.x < 0 || p.x > CONFIG.CANVAS_WIDTH || p.y < 0 || p.y > CONFIG.CANVAS_HEIGHT) {
                this.state.particles.splice(i, 1);
            }
        }
    }

    handleCanvasClick(e) {
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;

        const speciesButtons = [
            { species: 'SO2', y: 145 },
            { species: 'SO4', y: 175 },
            { species: 'NO2', y: 205 },
            { species: 'PM25', y: 235 },
            { species: 'PM10', y: 265 }
        ];

        for (const btn of speciesButtons) {
            if (x >= 15 && x <= 125 && y >= btn.y - 12 && y <= btn.y + 13) {
                this.state.displaySpecies = btn.species;
                document.getElementById('legendTitle').textContent = `浓度图例 - ${SPECIES_DEFINITIONS[btn.species].name}`;
                this.showNotification(`切换显示: ${SPECIES_DEFINITIONS[btn.species].name}`, 'info');
                return;
            }
        }
    }

    async saveSnapshot() {
        const snapshot = {
            wind_speed: this.state.windSpeed,
            wind_direction: this.state.windDirection,
            emission_intensity: this.state.emissionIntensity,
            temperature: this.state.temperature,
            humidity: this.state.humidity,
            stability_class: this.state.stabilityClass,
            stack_height: this.state.stackHeight,
            reaction_rate: this.state.reactionRate,
            simulation_time: this.state.simulationTime,
            concentration_data: {
                grid: {},
                statistics: {}
            }
        };

        Object.keys(this.state.speciesData).forEach(species => {
            snapshot.concentration_data.grid[species] = this.state.speciesData[species].grid;
            snapshot.concentration_data.statistics[species] = { 
                max: this.state.speciesData[species].maxConc 
            };
        });

        try {
            const response = await fetch('/api/snapshots', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(snapshot)
            });
            const result = await response.json();
            this.showNotification(result.message || '保存成功', 'success');
        } catch (error) {
            this.showNotification('保存失败: ' + error.message, 'error');
        }
    }

    async loadHistory() {
        try {
            const response = await fetch('/api/snapshots');
            const snapshots = await response.json();
            const tbody = document.getElementById('historyTableBody');

            if (snapshots.length === 0) {
                tbody.innerHTML = '<tr><td colspan="10" class="no-data">暂无历史数据</td></tr>';
            } else {
                tbody.innerHTML = snapshots.map(snap => {
                    const so2Color = snap.species_so2_max > 0.5 ? '#f44336' : snap.species_so2_max > 0.15 ? '#ff9800' : '#4caf50';
                    const so4Color = snap.species_so4_max > 0.3 ? '#f44336' : snap.species_so4_max > 0.1 ? '#ff9800' : '#4caf50';
                    const pm25Color = snap.species_pm25_max > 35 ? '#f44336' : snap.species_pm25_max > 15 ? '#ff9800' : '#4caf50';

                    return `
                        <tr>
                            <td>${snap.id}</td>
                            <td>${new Date(snap.timestamp).toLocaleString('zh-CN')}</td>
                            <td>${snap.wind_speed?.toFixed(1)} m/s</td>
                            <td>${snap.wind_direction}°</td>
                            <td>${snap.emission_intensity?.toFixed(0)}</td>
                            <td style="color: ${so2Color}">${snap.species_so2_max?.toFixed(3) || 'N/A'}</td>
                            <td style="color: ${so4Color}">${snap.species_so4_max?.toFixed(3) || 'N/A'}</td>
                            <td style="color: ${pm25Color}">${snap.species_pm25_max?.toFixed(2) || 'N/A'}</td>
                            <td>${snap.stability_class || 'N/A'}</td>
                            <td>
                                <button class="btn btn-success" style="padding:5px 8px;font-size:10px;" onclick="app.loadSnapshot(${snap.id})">加载</button>
                                <button class="btn btn-danger" style="padding:5px 8px;font-size:10px;" onclick="app.deleteSnapshot(${snap.id})">删除</button>
                            </td>
                        </tr>
                    `;
                }).join('');
            }
            document.getElementById('historyModal').classList.add('show');
        } catch (error) {
            this.showNotification('加载历史失败: ' + error.message, 'error');
        }
    }

    async loadSnapshot(id) {
        try {
            const response = await fetch(`/api/snapshots/${id}`);
            const snap = await response.json();

            this.state.windSpeed = snap.wind_speed || 5;
            this.state.windDirection = snap.wind_direction || 90;
            this.state.emissionIntensity = snap.emission_intensity || 50;
            this.state.temperature = snap.temperature || 25;
            this.state.humidity = snap.humidity || 60;
            this.state.stabilityClass = snap.stability_class || 'D';
            this.state.stackHeight = snap.stack_height || 80;
            this.state.reactionRate = snap.reaction_rate || 0.01;

            if (snap.concentrations?.grid) {
                Object.keys(snap.concentrations.grid).forEach(species => {
                    if (this.state.speciesData[species]) {
                        this.state.speciesData[species].grid = snap.concentrations.grid[species];
                        this.state.speciesData[species].maxConc = snap.concentrations.statistics?.[species]?.max || 0;
                    }
                });
            }

            ['windSpeed', 'windDirection', 'emissionIntensity', 'temperature', 'humidity', 'stackHeight'].forEach(id => {
                const el = document.getElementById(id.charAt(0).toLowerCase() + id.slice(1));
                if (el) el.value = this.state[id.charAt(0).toLowerCase() + id.slice(1)] || this.state[id];
            });
            document.getElementById('stabilityClass').value = this.state.stabilityClass;

            this.showNotification('快照加载成功', 'success');
            this.closeHistoryModal();
        } catch (error) {
            this.showNotification('加载失败: ' + error.message, 'error');
        }
    }

    async deleteSnapshot(id) {
        if (!confirm('确定删除此快照？')) return;
        try {
            const response = await fetch(`/api/snapshots/${id}`, { method: 'DELETE' });
            const result = await response.json();
            this.showNotification(result.message, 'success');
            this.loadHistory();
        } catch (error) {
            this.showNotification('删除失败: ' + error.message, 'error');
        }
    }

    closeHistoryModal() {
        document.getElementById('historyModal').classList.remove('show');
    }

    showNotification(message, type = 'info') {
        const notification = document.getElementById('notification');
        if (!notification) return;
        notification.textContent = message;
        notification.className = `notification show ${type}`;
        setTimeout(() => notification.classList.remove('show'), 3000);
    }

    render() {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, CONFIG.CANVAS_WIDTH, CONFIG.CANVAS_HEIGHT);

        const skyGradient = ctx.createLinearGradient(0, 0, 0, CONFIG.CANVAS_HEIGHT * 0.6);
        skyGradient.addColorStop(0, '#1a237e');
        skyGradient.addColorStop(1, '#1565c0');
        ctx.fillStyle = skyGradient;
        ctx.fillRect(0, 0, CONFIG.CANVAS_WIDTH, CONFIG.CANVAS_HEIGHT);

        const groundGradient = ctx.createLinearGradient(0, CONFIG.CANVAS_HEIGHT * 0.6, 0, CONFIG.CANVAS_HEIGHT);
        groundGradient.addColorStop(0, '#2e7d32');
        groundGradient.addColorStop(1, '#1b5e20');
        ctx.fillStyle = groundGradient;
        ctx.fillRect(0, CONFIG.CANVAS_HEIGHT * 0.6, CONFIG.CANVAS_WIDTH, CONFIG.CANVAS_HEIGHT * 0.4);

        this.roads.forEach(road => {
            ctx.strokeStyle = '#37474f';
            ctx.lineWidth = road.width;
            ctx.beginPath();
            ctx.moveTo(road.x1, road.y1);
            ctx.lineTo(road.x2, road.y2);
            ctx.stroke();
        });

        this.trees.forEach(tree => {
            ctx.fillStyle = '#5d4037';
            ctx.fillRect(tree.x - 3, tree.y + 10, 6, 15);
            ctx.fillStyle = '#388e3c';
            ctx.beginPath();
            ctx.moveTo(tree.x, tree.y - 15);
            ctx.lineTo(tree.x - 15, tree.y + 10);
            ctx.lineTo(tree.x + 15, tree.y + 10);
            ctx.closePath();
            ctx.fill();
        });

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= CONFIG.GRID_COLS; i++) {
            ctx.beginPath();
            ctx.moveTo(i * CONFIG.GRID_SIZE, 0);
            ctx.lineTo(i * CONFIG.GRID_SIZE, CONFIG.CANVAS_HEIGHT);
            ctx.stroke();
        }
        for (let i = 0; i <= CONFIG.GRID_ROWS; i++) {
            ctx.beginPath();
            ctx.moveTo(0, i * CONFIG.GRID_SIZE);
            ctx.lineTo(CONFIG.CANVAS_WIDTH, i * CONFIG.GRID_SIZE);
            ctx.stroke();
        }

        const species = this.state.displaySpecies;
        const grid = this.state.speciesData[species]?.grid;
        if (grid) {
            for (let i = 0; i < CONFIG.GRID_ROWS; i++) {
                for (let j = 0; j < CONFIG.GRID_COLS; j++) {
                    const conc = grid[i][j];
                    if (conc > 0.001) {
                        ctx.fillStyle = this.getColor(species, conc);
                        ctx.fillRect(j * CONFIG.GRID_SIZE, i * CONFIG.GRID_SIZE, CONFIG.GRID_SIZE, CONFIG.GRID_SIZE);
                    }
                }
            }
        }

        this.buildings.forEach(building => {
            ctx.fillStyle = '#3f51b5';
            ctx.fillRect(building.x, building.y, building.w, building.h);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
            ctx.fillRect(building.x, building.y, building.w, 3);
            
            const windowRows = Math.floor(building.h / 15);
            const windowCols = Math.floor(building.w / 12);
            ctx.fillStyle = 'rgba(255, 235, 59, 0.6)';
            for (let row = 1; row < windowRows; row++) {
                for (let col = 0; col < windowCols; col++) {
                    if (Math.random() > 0.3) {
                        ctx.fillRect(building.x + 4 + col * 12, building.y + 5 + row * 15, 6, 8);
                    }
                }
            }
        });

        const sx = this.state.sourceX, sy = this.state.sourceY;
        ctx.fillStyle = '#455a64';
        ctx.fillRect(sx - 25, sy, 50, 60);
        ctx.fillStyle = '#37474f';
        for (let i = 0; i < 3; i++) {
            ctx.fillRect(sx - 35 + i * 30, sy - 50, 12, 60);
        }
        if (this.state.emissionIntensity > 0) {
            const flicker = 0.8 + Math.sin(this.state.simulationTime * 10) * 0.2;
            ctx.fillStyle = `rgba(255, 87, 34, ${flicker * 0.8})`;
            for (let i = 0; i < 3; i++) {
                ctx.beginPath();
                ctx.arc(sx - 29 + i * 30, sy - 55, 6 * flicker, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.fillStyle = '#263238';
        ctx.font = 'bold 10px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('工厂', sx, sy + 75);

        this.state.particles.forEach(p => {
            const alpha = p.life * 0.6;
            const color = SPECIES_DEFINITIONS[p.species]?.color || '#888888';
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
            ctx.fillStyle = color.replace(')', `, ${alpha})`).replace('rgb', 'rgba');
            ctx.fill();
        });

        this.drawWindArrow();
        this.drawSpeciesSelector();
        this.drawInfoPanel();
    }

    getColor(species, conc) {
        const def = SPECIES_DEFINITIONS[species];
        const maxConc = def?.danger || 2;
        const normalized = Math.min(conc / maxConc, 1);

        let r, g, b;
        if (normalized < 0.2) {
            const t = normalized / 0.2;
            r = 76 + (139 - 76) * t;
            g = 175 + (195 - 175) * t;
            b = 80 + (74 - 80) * t;
        } else if (normalized < 0.4) {
            const t = (normalized - 0.2) / 0.2;
            r = 139 + (205 - 139) * t;
            g = 195 + (220 - 195) * t;
            b = 74 + (57 - 74) * t;
        } else if (normalized < 0.6) {
            const t = (normalized - 0.4) / 0.2;
            r = 205 + (255 - 205) * t;
            g = 220 + (193 - 220) * t;
            b = 57 + (7 - 57) * t;
        } else if (normalized < 0.8) {
            r = 255;
            g = 193 + (152 - 193) * ((normalized - 0.6) / 0.2);
            b = 7;
        } else {
            r = 255;
            g = 152 + (67 - 152) * ((normalized - 0.8) / 0.2);
            b = 0;
        }

        return `rgba(${Math.floor(r)}, ${Math.floor(g)}, ${Math.floor(b)}, ${0.3 + normalized * 0.4})`;
    }

    drawWindArrow() {
        const x = 60, y = 60, radius = 35;
        
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('N', x, y - radius - 5);

        const windRad = (this.state.windDirection - 90) * Math.PI / 180;
        const arrowLength = radius * 0.7;
        const endX = x + Math.cos(windRad) * arrowLength;
        const endY = y + Math.sin(windRad) * arrowLength;

        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(endX, endY);
        ctx.strokeStyle = '#667eea';
        ctx.lineWidth = 3;
        ctx.stroke();

        const headLen = 8;
        const angle = Math.atan2(endY - y, endX - x);
        ctx.beginPath();
        ctx.moveTo(endX, endY);
        ctx.lineTo(endX - headLen * Math.cos(angle - Math.PI / 6), endY - headLen * Math.sin(angle - Math.PI / 6));
        ctx.moveTo(endX, endY);
        ctx.lineTo(endX - headLen * Math.cos(angle + Math.PI / 6), endY - headLen * Math.sin(angle + Math.PI / 6));
        ctx.stroke();

        ctx.font = '10px Arial';
        ctx.fillText(`${this.state.windSpeed.toFixed(1)} m/s`, x, y + radius + 15);
    }

    drawSpeciesSelector() {
        const species = ['SO2', 'SO4', 'NO2', 'PM25', 'PM10'];
        const startY = 120;
        const spacing = 30;

        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(10, startY - 10, 120, species.length * spacing + 20);

        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px Arial';
        ctx.textAlign = 'left';
        ctx.fillText('显示组分:', 20, startY + 5);

        species.forEach((sp, i) => {
            const y = startY + 25 + i * spacing;
            const isSelected = this.state.displaySpecies === sp;
            
            ctx.fillStyle = isSelected ? 'rgba(102, 126, 234, 0.5)' : 'rgba(255, 255, 255, 0.1)';
            ctx.fillRect(15, y - 12, 110, 25);

            if (isSelected) {
                ctx.strokeStyle = '#667eea';
                ctx.lineWidth = 2;
                ctx.strokeRect(15, y - 12, 110, 25);
            }

            ctx.fillStyle = SPECIES_DEFINITIONS[sp]?.color || '#888';
            ctx.beginPath();
            ctx.arc(25, y, 5, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = '#fff';
            ctx.font = '11px Arial';
            ctx.fillText(SPECIES_DEFINITIONS[sp]?.name || sp, 35, y + 4);
        });
    }

    drawInfoPanel() {
        const panelWidth = 170;
        const panelHeight = 150;
        const panelX = CONFIG.CANVAS_WIDTH - panelWidth - 10;
        const panelY = 10;

        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(panelX, panelY, panelWidth, panelHeight);

        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px Arial';
        ctx.textAlign = 'left';
        ctx.fillText(`组分: ${SPECIES_DEFINITIONS[this.state.displaySpecies]?.name || 'SO2'}`, panelX + 10, panelY + 20);

        const speciesData = this.state.speciesData[this.state.displaySpecies];
        if (speciesData) {
            ctx.font = '10px Arial';
            ctx.fillStyle = '#aaa';
            ctx.fillText('最大浓度:', panelX + 10, panelY + 40);
            const def = SPECIES_DEFINITIONS[this.state.displaySpecies];
            const isDanger = speciesData.maxConc > (def?.danger || 2);
            const isWarning = speciesData.maxConc > (def?.safe || 0.5);
            ctx.fillStyle = isDanger ? '#f44336' : isWarning ? '#ff9800' : '#4caf50';
            ctx.font = 'bold 14px Arial';
            ctx.fillText(`${speciesData.maxConc.toFixed(3)} ppm`, panelX + 10, panelY + 55);
        }

        ctx.font = '10px Arial';
        ctx.fillStyle = '#aaa';
        ctx.fillText('模拟时间:', panelX + 10, panelY + 75);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px Arial';
        ctx.fillText(`${this.state.simulationTime.toFixed(1)} s`, panelX + 10, panelY + 90);

        const so2Growth = this.hygroscopicGrowthFactor(this.state.humidity, 'SO2');
        ctx.font = '10px Arial';
        ctx.fillStyle = '#aaa';
        ctx.fillText('吸湿因子:', panelX + 10, panelY + 108);
        ctx.fillStyle = so2Growth > 1.5 ? '#ff9800' : '#fff';
        ctx.font = 'bold 12px Arial';
        ctx.fillText(`${so2Growth.toFixed(2)}x`, panelX + 10, panelY + 123);

        ctx.font = '10px Arial';
        ctx.fillStyle = '#aaa';
        ctx.fillText('稳定度:', panelX + 80, panelY + 108);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px Arial';
        ctx.fillText(STABILITY_PARAMS[this.state.stabilityClass]?.name || 'D', panelX + 80, panelY + 123);

        ctx.font = '10px Arial';
        ctx.fillStyle = '#aaa';
        ctx.fillText('湿度:', panelX + 10, panelY + 138);
        ctx.fillStyle = this.state.humidity > 80 ? '#42a5f5' : '#fff';
        ctx.font = 'bold 12px Arial';
        ctx.fillText(`${this.state.humidity}%`, panelX + 10, panelY + 148);
    }

    hygroscopicGrowthFactor(RH, speciesId) {
        const configs = {
            SO2: { deliquescenceRH: 80, criticalRH: 95, hysteresis: 3, maxGrowth: 4.5, exponent: 1.8, onset: 1.05 },
            SO4: { deliquescenceRH: 75, criticalRH: 95, hysteresis: 5, maxGrowth: 5.0, exponent: 2.0, onset: 1.10 },
            NO2: { deliquescenceRH: 90, criticalRH: 98, hysteresis: 2, maxGrowth: 2.0, exponent: 1.5, onset: 1.02 },
            PM25: { deliquescenceRH: 70, criticalRH: 95, hysteresis: 5, maxGrowth: 3.5, exponent: 1.6, onset: 1.08 },
            PM10: { deliquescenceRH: 68, criticalRH: 95, hysteresis: 5, maxGrowth: 2.8, exponent: 1.5, onset: 1.07 }
        };
        const config = configs[speciesId] || configs.SO2;
        const onsetRH = config.deliquescenceRH - config.hysteresis;
        const effectiveOnset = onsetRH - 1;

        if (RH < effectiveOnset) return 1.0;
        if (RH >= config.criticalRH) return config.maxGrowth;
        
        const normalizedRH = Math.max(0, (RH - effectiveOnset) / (config.criticalRH - effectiveOnset));
        return config.onset + (config.maxGrowth - config.onset) * Math.pow(normalizedRH, config.exponent);
    }

    updateUI() {
        document.getElementById('so2Value').textContent = this.state.speciesData.SO2.maxConc.toFixed(3);
        document.getElementById('so4Value').textContent = this.state.speciesData.SO4.maxConc.toFixed(3);
        document.getElementById('no2Value').textContent = this.state.speciesData.NO2.maxConc.toFixed(3);
        document.getElementById('pm25Value').textContent = this.state.speciesData.PM25.maxConc.toFixed(3);
        document.getElementById('runTime').textContent = this.state.simulationTime.toFixed(1);

        const allMax = Math.max(...Object.values(this.state.speciesData).map(d => d.maxConc));
        document.getElementById('maxValue').textContent = allMax.toFixed(3);
    }

    async requestAnimationFrame() {
        const now = Date.now();
        if (this.state.running && !this.state.paused) {
            this.state.simulationTime += 0.016;
            
            if (now - this.lastUpdate > CONFIG.WIND_UPDATE_INTERVAL) {
                this.lastUpdate = now;
                await this.runSimulationStep();
            }
            
            this.updateParticles();
        }

        this.render();
        this.updateUI();

        window.requestAnimationFrame(() => this.requestAnimationFrame());
    }
}

function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    
    event.target.classList.add('active');
    document.getElementById(tabName + 'Tab').classList.add('active');
    
    if (tabName === 'map' && app.mapManager && app.mapManager.map) {
        setTimeout(() => app.mapManager.map.invalidateSize(), 100);
    }
}

const app = new SimulationApp();
