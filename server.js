const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { 
    SPECIES, 
    ConcentrationField, 
    DispersionModel, 
    ChemicalTransformation, 
    AirQualitySimulator 
} = require('./airQualityModel');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/node_modules', express.static(path.join(__dirname, 'node_modules')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const dbPath = path.join(__dirname, 'pollution.db');
const db = new sqlite3.Database(dbPath);

const THRESHOLDS = {
    SO2: { warning: 0.15, danger: 0.5, name: '二氧化硫' },
    SO4: { warning: 0.1, danger: 0.3, name: '硫酸盐气溶胶' },
    NO2: { warning: 0.04, danger: 0.1, name: '二氧化氮' },
    PM25: { warning: 15, danger: 35, name: '细颗粒物' },
    PM10: { warning: 35, danger: 70, name: '可吸入颗粒物' },
    O3: { warning: 0.03, danger: 0.07, name: '臭氧' },
    CO: { warning: 4, danger: 9, name: '一氧化碳' }
};

class SpatialIndex {
    constructor() {
        this.gridSize = 20;
        this.cells = new Map();
    }

    _getCellKey(x, y) {
        const cellX = Math.floor(x / this.gridSize);
        const cellY = Math.floor(y / this.gridSize);
        return `${cellX}_${cellY}`;
    }

    insert(x, y, data) {
        const key = this._getCellKey(x, y);
        if (!this.cells.has(key)) {
            this.cells.set(key, []);
        }
        this.cells.get(key).push({ x, y, data });
    }

    queryRange(minX, minY, maxX, maxY) {
        const results = [];
        const minCellX = Math.floor(minX / this.gridSize);
        const minCellY = Math.floor(minY / this.gridSize);
        const maxCellX = Math.floor(maxX / this.gridSize);
        const maxCellY = Math.floor(maxY / this.gridSize);

        for (let cx = minCellX; cx <= maxCellX; cx++) {
            for (let cy = minCellY; cy <= maxCellY; cy++) {
                const key = `${cx}_${cy}`;
                const cell = this.cells.get(key);
                if (cell) {
                    results.push(...cell.filter(p => 
                        p.x >= minX && p.x <= maxX && 
                        p.y >= minY && p.y <= maxY
                    ));
                }
            }
        }
        return results;
    }

    queryNearest(x, y, k = 1) {
        const centerKey = this._getCellKey(x, y);
        const allPoints = [];
        const [cx, cy] = centerKey.split('_').map(Number);

        for (let radius = 0; radius < 100; radius++) {
            for (let dx = -radius; dx <= radius; dx++) {
                for (let dy = -radius; dy <= radius; dy++) {
                    if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
                    const key = `${cx + dx}_${cy + dy}`;
                    const cell = this.cells.get(key);
                    if (cell) allPoints.push(...cell);
                }
            }
            if (allPoints.length >= k) break;
        }

        return allPoints
            .map(p => ({ ...p, distance: Math.sqrt((p.x - x) ** 2 + (p.y - y) ** 2) }))
            .sort((a, b) => a.distance - b.distance)
            .slice(0, k);
    }

    clear() {
        this.cells.clear();
    }
}

class AlertManager {
    constructor(wss) {
        this.wss = wss;
        this.activeAlerts = new Map();
        this.alertHistory = [];
        this.cooldownPeriod = 30000;
        this.lastAlertTime = new Map();
    }

    checkAndAlert(concentrationData, weatherData) {
        const newAlerts = [];

        Object.keys(concentrationData).forEach(species => {
            const stats = concentrationData[species];
            const threshold = THRESHOLDS[species];
            if (!threshold || !stats) return;

            const level = stats.max >= threshold.danger ? 'danger' : 
                         stats.max >= threshold.warning ? 'warning' : null;

            if (level) {
                const alertKey = `${species}_${level}`;
                const now = Date.now();
                const lastAlert = this.lastAlertTime.get(alertKey) || 0;

                if (now - lastAlert > this.cooldownPeriod) {
                    const alert = {
                        id: `alert_${now}_${Math.random().toString(36).substr(2, 9)}`,
                        species: species,
                        speciesName: threshold.name,
                        level: level,
                        concentration: stats.max,
                        warningThreshold: threshold.warning,
                        dangerThreshold: threshold.danger,
                        location: { x: stats.maxX, y: stats.maxY },
                        weather: weatherData,
                        timestamp: new Date().toISOString(),
                        message: `${threshold.name}浓度${level === 'danger' ? '严重' : '轻微'}超标: ${stats.max.toFixed(3)} ppm`
                    };

                    newAlerts.push(alert);
                    this.activeAlerts.set(alert.id, alert);
                    this.lastAlertTime.set(alertKey, now);
                    this.alertHistory.push(alert);

                    if (this.alertHistory.length > 1000) {
                        this.alertHistory = this.alertHistory.slice(-1000);
                    }
                }
            }
        });

        if (newAlerts.length > 0) {
            this.broadcast({
                type: 'alerts',
                alerts: newAlerts
            });
        }

        return newAlerts;
    }

    broadcast(data) {
        const message = JSON.stringify(data);
        this.wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    }

    getActiveAlerts() {
        return Array.from(this.activeAlerts.values());
    }

    getAlertHistory(limit = 100) {
        return this.alertHistory.slice(-limit);
    }

    dismissAlert(alertId) {
        this.activeAlerts.delete(alertId);
    }
}

const spatialIndex = new SpatialIndex();
const alertManager = new AlertManager(wss);

const simulator = new AirQualitySimulator({
    speciesList: ['SO2', 'SO4', 'NO2', 'PM25', 'PM10'],
    rows: 15,
    cols: 20
});

simulator.addSource({
    id: 'main_factory',
    location: { x: 200, y: 300 },
    emissions: {
        SO2: 50,
        NO2: 30,
        PM25: 20
    },
    height: 80
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        wind_speed REAL NOT NULL,
        wind_direction REAL NOT NULL,
        emission_intensity REAL NOT NULL,
        temperature REAL DEFAULT 25,
        humidity REAL DEFAULT 60,
        stability_class TEXT DEFAULT 'D',
        stack_height REAL DEFAULT 80,
        reaction_rate REAL DEFAULT 0.01,
        simulation_time REAL DEFAULT 0,
        max_concentration REAL DEFAULT 0,
        max_conc_x REAL DEFAULT 0,
        max_conc_y REAL DEFAULT 0,
        avg_concentration REAL DEFAULT 0,
        affected_area REAL DEFAULT 0,
        hygroscopic_growth REAL DEFAULT 1,
        species_so2_max REAL DEFAULT 0,
        species_so4_max REAL DEFAULT 0,
        species_no2_max REAL DEFAULT 0,
        species_pm25_max REAL DEFAULT 0,
        species_pm10_max REAL DEFAULT 0,
        concentration_data TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS weather_params (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        wind_speed REAL NOT NULL,
        wind_direction REAL NOT NULL,
        temperature REAL DEFAULT 25,
        humidity REAL DEFAULT 60,
        stability_class TEXT DEFAULT 'D'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS species_definitions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        molecular_weight REAL,
        gas_particle TEXT,
        solubility TEXT,
        default_rate REAL,
        hygroscopic_config TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS spatial_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id INTEGER,
        species TEXT NOT NULL,
        grid_x INTEGER NOT NULL,
        grid_y INTEGER NOT NULL,
        concentration REAL NOT NULL,
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id)
    )`);

    db.run(`CREATE INDEX IF NOT EXISTS idx_spatial_species ON spatial_data(species)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_spatial_concentration ON spatial_data(concentration)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_spatial_location ON spatial_data(grid_x, grid_y)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp ON snapshots(timestamp)`);

    Object.values(SPECIES).forEach(species => {
        db.run(
            `INSERT OR REPLACE INTO species_definitions 
             (id, name, molecular_weight, gas_particle, solubility, default_rate, hygroscopic_config)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                species.id,
                species.name,
                species.molecularWeight,
                species.gasParticle,
                species.solubility,
                species.defaultRate,
                JSON.stringify(species.hygroscopic)
            ]
        );
    });
});

wss.on('connection', (ws) => {
    console.log('WebSocket client connected');

    ws.send(JSON.stringify({
        type: 'connection',
        status: 'connected',
        activeAlerts: alertManager.getActiveAlerts()
    }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'subscribe') {
                console.log('Client subscribed to:', data.channels);
            } else if (data.type === 'getAlerts') {
                ws.send(JSON.stringify({
                    type: 'alerts',
                    active: alertManager.getActiveAlerts(),
                    history: alertManager.getAlertHistory(data.limit || 50)
                }));
            } else if (data.type === 'dismissAlert') {
                alertManager.dismissAlert(data.alertId);
            }
        } catch (e) {
            console.error('WebSocket message error:', e);
        }
    });

    ws.on('close', () => {
        console.log('WebSocket client disconnected');
    });
});

app.get('/api/species', (req, res) => {
    db.all("SELECT * FROM species_definitions ORDER BY id", (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            const species = rows.map(row => ({
                ...row,
                hygroscopic_config: JSON.parse(row.hygroscopic_config),
                thresholds: THRESHOLDS[row.id] || null
            }));
            res.json(species);
        }
    });
});

app.get('/api/species/:id/hygroscopic', (req, res) => {
    const speciesId = req.params.id;
    const humidity = parseFloat(req.query.humidity) || 60;
    
    const growthFactor = simulator.getHygroscopicInfo(speciesId, humidity);
    if (growthFactor) {
        res.json(growthFactor);
    } else {
        res.status(404).json({ error: `Species ${speciesId} not found` });
    }
});

app.get('/api/thresholds', (req, res) => {
    res.json(THRESHOLDS);
});

app.post('/api/simulate/step', (req, res) => {
    const { 
        wind_speed, wind_direction, temperature, humidity, 
        stability_class, emission_intensity, stack_height,
        reaction_rate, enable_reaction, dt
    } = req.body;

    simulator.setWeather({
        windSpeed: wind_speed !== undefined ? wind_speed : 5,
        windDirection: wind_direction !== undefined ? wind_direction : 90,
        temperature: temperature !== undefined ? temperature : 25,
        stabilityClass: stability_class || 'D'
    });

    if (simulator.emissionSources.length > 0) {
        simulator.emissionSources[0].emissions = {
            SO2: emission_intensity !== undefined ? emission_intensity : 50,
            NO2: (emission_intensity || 50) * 0.6,
            PM25: (emission_intensity || 50) * 0.4
        };
        simulator.emissionSources[0].height = stack_height || 80;
    }

    simulator.chemistry.setConfig({
        so2ToSo4Rate: reaction_rate !== undefined ? reaction_rate : 0.01,
        enableReactions: enable_reaction !== false,
        temperature: temperature || 25
    });

    const state = simulator.step(dt || 0.1);
    const summary = simulator.getSummary();

    const statsForAlerts = {};
    Object.keys(summary.species).forEach(species => {
        statsForAlerts[species] = {
            max: summary.species[species].max,
            maxX: summary.species[species].maxLocation?.col || 0,
            maxY: summary.species[species].maxLocation?.row || 0
        };
    });

    const newAlerts = alertManager.checkAndAlert(statsForAlerts, {
        windSpeed: wind_speed,
        windDirection: wind_direction,
        temperature: temperature,
        humidity: humidity,
        stabilityClass: stability_class
    });

    res.json({
        state,
        summary,
        hygroscopicInfo: {
            SO2: simulator.getHygroscopicInfo('SO2', humidity || 60),
            SO4: simulator.getHygroscopicInfo('SO4', humidity || 60),
            PM25: simulator.getHygroscopicInfo('PM25', humidity || 60)
        },
        alerts: newAlerts
    });
});

app.post('/api/simulate/reset', (req, res) => {
    simulator.reset();
    alertManager.activeAlerts.clear();
    res.json({ message: 'Simulator reset', state: simulator.getState() });
});

app.get('/api/simulate/state', (req, res) => {
    res.json({
        state: simulator.getState(),
        summary: simulator.getSummary(),
        activeAlerts: alertManager.getActiveAlerts()
    });
});

app.get('/api/alerts', (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit) : 100;
    res.json({
        active: alertManager.getActiveAlerts(),
        history: alertManager.getAlertHistory(limit)
    });
});

app.post('/api/alerts/:id/dismiss', (req, res) => {
    alertManager.dismissAlert(req.params.id);
    res.json({ message: 'Alert dismissed' });
});

app.post('/api/snapshots', (req, res) => {
    const state = req.body;
    
    let speciesMaxValues = {};
    if (state.concentrations && state.concentrations.statistics) {
        const stats = state.concentrations.statistics;
        speciesMaxValues = {
            so2: stats.SO2 ? stats.SO2.max : 0,
            so4: stats.SO4 ? stats.SO4.max : 0,
            no2: stats.NO2 ? stats.NO2.max : 0,
            pm25: stats.PM25 ? stats.PM25.max : 0,
            pm10: stats.PM10 ? stats.PM10.max : 0
        };
    }

    db.serialize(() => {
        const stmt = db.prepare(`INSERT INTO snapshots (
            wind_speed, wind_direction, emission_intensity, temperature, humidity,
            stability_class, stack_height, reaction_rate, simulation_time,
            max_concentration, max_conc_x, max_conc_y, avg_concentration,
            affected_area, hygroscopic_growth,
            species_so2_max, species_so4_max, species_no2_max, 
            species_pm25_max, species_pm10_max, concentration_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

        stmt.run(
            state.wind_speed || 5,
            state.wind_direction || 90,
            state.emission_intensity || 50,
            state.temperature || 25,
            state.humidity || 60,
            state.stability_class || 'D',
            state.stack_height || 80,
            state.reaction_rate || 0.01,
            state.simulation_time || 0,
            state.max_concentration || speciesMaxValues.so2 || 0,
            state.max_conc_x || 0,
            state.max_conc_y || 0,
            state.avg_concentration || 0,
            state.affected_area || 0,
            state.hygroscopic_growth || 1,
            speciesMaxValues.so2 || 0,
            speciesMaxValues.so4 || 0,
            speciesMaxValues.no2 || 0,
            speciesMaxValues.pm25 || 0,
            speciesMaxValues.pm10 || 0,
            JSON.stringify(state.concentrations || state.concentration_data || {})
        );

        stmt.finalize(err => {
            if (err) {
                res.status(500).json({ error: err.message });
            } else {
                db.get("SELECT last_insert_rowid() as id", (err, row) => {
                    if (err) {
                        res.json({ id: -1, message: 'Snapshot saved', speciesMaxValues });
                    } else {
                        const snapshotId = row.id;
                        
                        const concData = state.concentrations || state.concentration_data;
                        if (concData?.grid?.SO2 || concData?.grid?.so2) {
                            const spatialStmt = db.prepare(
                                `INSERT INTO spatial_data (snapshot_id, species, grid_x, grid_y, concentration)
                                 VALUES (?, ?, ?, ?, ?)`
                            );

                            Object.keys(concData.grid).forEach(species => {
                                const grid = concData.grid[species];
                                if (grid) {
                                    for (let y = 0; y < grid.length; y++) {
                                        for (let x = 0; x < grid[y].length; x++) {
                                            const conc = grid[y][x];
                                            if (conc > 0.001) {
                                                spatialStmt.run(snapshotId, species, x, y, conc);
                                            }
                                        }
                                    }
                                }
                            });

                            spatialStmt.finalize();
                        }

                        res.json({ id: snapshotId, message: 'Snapshot saved', speciesMaxValues });
                    }
                });
            }
        });
    });
});

app.get('/api/snapshots', (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit) : 50;
    db.all(
        `SELECT id, timestamp, wind_speed, wind_direction, emission_intensity, 
                temperature, humidity, stability_class, stack_height,
                max_concentration, avg_concentration, affected_area,
                species_so2_max, species_so4_max, species_no2_max,
                species_pm25_max, species_pm10_max
         FROM snapshots ORDER BY timestamp DESC LIMIT ?`,
        [limit],
        (err, rows) => {
            if (err) {
                res.status(500).json({ error: err.message });
            } else {
                res.json(rows);
            }
        }
    );
});

app.get('/api/snapshots/:id', (req, res) => {
    db.get(
        `SELECT * FROM snapshots WHERE id = ?`,
        [req.params.id],
        (err, row) => {
            if (err) {
                res.status(500).json({ error: err.message });
            } else if (!row) {
                res.status(404).json({ error: 'Snapshot not found' });
            } else {
                try {
                    row.concentrations = JSON.parse(row.concentration_data);
                } catch (e) {
                    row.concentrations = { grid: {}, statistics: {} };
                }
                delete row.concentration_data;
                res.json(row);
            }
        }
    );
});

app.get('/api/snapshots/:id/spatial', (req, res) => {
    const species = req.query.species || 'SO2';
    db.all(
        `SELECT grid_x, grid_y, concentration 
         FROM spatial_data 
         WHERE snapshot_id = ? AND species = ? AND concentration > 0.001
         ORDER BY concentration DESC`,
        [req.params.id, species],
        (err, rows) => {
            if (err) {
                res.status(500).json({ error: err.message });
            } else {
                res.json(rows);
            }
        }
    );
});

app.get('/api/spatial/query', (req, res) => {
    const { minX, minY, maxX, maxY, species, snapshot_id } = req.query;
    
    let sql = `SELECT grid_x, grid_y, concentration, snapshot_id FROM spatial_data WHERE 1=1`;
    const params = [];

    if (snapshot_id) {
        sql += ` AND snapshot_id = ?`;
        params.push(snapshot_id);
    }
    if (species) {
        sql += ` AND species = ?`;
        params.push(species);
    }
    if (minX !== undefined) {
        sql += ` AND grid_x >= ?`;
        params.push(parseFloat(minX));
    }
    if (maxX !== undefined) {
        sql += ` AND grid_x <= ?`;
        params.push(parseFloat(maxX));
    }
    if (minY !== undefined) {
        sql += ` AND grid_y >= ?`;
        params.push(parseFloat(minY));
    }
    if (maxY !== undefined) {
        sql += ` AND grid_y <= ?`;
        params.push(parseFloat(maxY));
    }

    sql += ` ORDER BY concentration DESC LIMIT 1000`;

    db.all(sql, params, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json(rows);
        }
    });
});

app.delete('/api/snapshots/:id', (req, res) => {
    db.serialize(() => {
        db.run(`DELETE FROM spatial_data WHERE snapshot_id = ?`, [req.params.id]);
        db.run(`DELETE FROM snapshots WHERE id = ?`, [req.params.id], function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
            } else {
                res.json({ message: 'Deleted', deleted: this.changes });
            }
        });
    });
});

app.get('/api/stats', (req, res) => {
    db.get(`SELECT COUNT(*) as count FROM snapshots`, (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json({ total_snapshots: row.count });
        }
    });
});

app.get('/api/statistics/summary', (req, res) => {
    db.get(
        `SELECT 
            COUNT(*) as total_snapshots,
            AVG(max_concentration) as avg_max_concentration,
            MAX(max_concentration) as highest_concentration,
            AVG(affected_area) as avg_affected_area,
            AVG(wind_speed) as avg_wind_speed,
            AVG(emission_intensity) as avg_emission,
            AVG(species_so2_max) as avg_so2_max,
            MAX(species_so2_max) as highest_so2,
            AVG(species_so4_max) as avg_so4_max,
            MAX(species_so4_max) as highest_so4
         FROM snapshots`,
        (err, row) => {
            if (err) {
                res.status(500).json({ error: err.message });
            } else {
                res.json(row);
            }
        }
    );
});

app.get('/api/statistics/max-concentration', (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit) : 10;
    db.all(
        `SELECT id, timestamp, max_concentration, avg_concentration, affected_area,
                species_so2_max, species_so4_max, species_no2_max,
                species_pm25_max, species_pm10_max,
                wind_speed, wind_direction, emission_intensity, stability_class, humidity
         FROM snapshots 
         WHERE max_concentration > 0
         ORDER BY max_concentration DESC 
         LIMIT ?`,
        [limit],
        (err, rows) => {
            if (err) {
                res.status(500).json({ error: err.message });
            } else {
                res.json(rows);
            }
        }
    );
});

app.get('/api/hygroscopic/curve', (req, res) => {
    const speciesId = req.query.species || 'SO2';
    const species = SPECIES[speciesId];
    
    if (!species) {
        return res.status(404).json({ error: `Species ${speciesId} not found` });
    }

    const curve = [];
    for (let rh = 30; rh <= 100; rh += 5) {
        const growthFactor = simulator.dispersion.calculateHygroscopicGrowth(rh, speciesId);
        curve.push({
            humidity: rh,
            growthFactor: growthFactor,
            isHygroscopic: !!species.hygroscopic
        });
    }

    res.json({
        species: speciesId,
        name: species.name,
        hygroscopicConfig: species.hygroscopic,
        curve: curve
    });
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        websocketClients: wss.clients.size,
        activeAlerts: alertManager.activeAlerts.size,
        totalSnapshots: -1
    });
});

server.listen(PORT, () => {
    console.log(`Air Quality Simulation Server running on http://localhost:${PORT}`);
    console.log(`WebSocket server: ws://localhost:${PORT}/ws`);
    console.log(`\nAvailable endpoints:`);
    console.log(`  GET  /api/species - List all pollutant species`);
    console.log(`  GET  /api/thresholds - Get concentration thresholds`);
    console.log(`  GET  /api/alerts - Get active alerts and history`);
    console.log(`  POST /api/simulate/step - Run simulation step`);
    console.log(`  POST /api/snapshots - Save snapshot with spatial data`);
    console.log(`  GET  /api/snapshots/:id/spatial - Get spatial data for snapshot`);
    console.log(`  GET  /api/spatial/query - Query spatial data`);
    console.log(`  GET  /api/hygroscopic/curve - Get hygroscopic growth curve`);
});
