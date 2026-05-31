const http = require('http');
const WebSocket = require('ws');

console.log('='.repeat(80));
console.log('工程化版本功能验证测试');
console.log('='.repeat(80));

const results = { passed: 0, failed: 0 };

function logTest(name, passed, msg) {
    const status = passed ? '✓ PASS' : '✗ FAIL';
    console.log(`\n${status} ${name}`);
    if (msg) console.log(`  ${msg}`);
    passed ? results.passed++ : results.failed++;
}

function request(path, method = 'GET', data = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 3000,
            path,
            method,
            headers: data ? { 'Content-Type': 'application/json' } : {}
        };
        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch { resolve(body); }
            });
        });
        req.on('error', reject);
        if (data) req.write(JSON.stringify(data));
        req.end();
    });
}

async function runTests() {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('测试1: REST API 端点可用性');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
        const species = await request('/api/species');
        logTest('GET /api/species 返回组分列表', 
            Array.isArray(species) && species.length >= 5,
            `返回${species.length}个组分定义`);
    } catch (e) { logTest('GET /api/species', false, e.message); }

    try {
        const thresholds = await request('/api/thresholds');
        logTest('GET /api/thresholds 返回阈值配置',
            !!thresholds.SO2 && !!thresholds.PM25,
            `包含SO2、PM25等${Object.keys(thresholds).length}个组分阈值`);
    } catch (e) { logTest('GET /api/thresholds', false, e.message); }

    try {
        const alerts = await request('/api/alerts');
        logTest('GET /api/alerts 返回预警数据',
            alerts.active !== undefined && alerts.history !== undefined,
            `当前活跃预警: ${alerts.active?.length || 0} 条`);
    } catch (e) { logTest('GET /api/alerts', false, e.message); }

    try {
        const hygro = await request('/api/hygroscopic/curve?species=SO4');
        logTest('GET /api/hygroscopic/curve 返回吸湿曲线',
            !!hygro.curve && hygro.curve.length > 0,
            `返回${hygro.curve?.length}个数据点, SO4最大增长: ${hygro.curve?.[hygro.curve.length-1]?.growthFactor.toFixed(2)}x`);
    } catch (e) { logTest('GET /api/hygroscopic/curve', false, e.message); }

    try {
        const stats = await request('/api/statistics/summary');
        logTest('GET /api/statistics/summary 返回统计摘要',
            stats.total_snapshots !== undefined,
            `总快照数: ${stats.total_snapshots}, 最高SO2: ${stats.highest_so2?.toFixed(3) || 'N/A'}`);
    } catch (e) { logTest('GET /api/statistics/summary', false, e.message); }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('测试2: 模拟计算与空间数据');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
        const result = await request('/api/simulate/step', 'POST', {
            wind_speed: 5, emission_intensity: 80, stability_class: 'A', humidity: 85
        });
        logTest('POST /api/simulate/step 执行模拟',
            !!result.summary && !!result.summary.species,
            `模拟成功, SO2最大: ${result.summary?.species?.SO2?.max.toFixed(3) || 'N/A'} ppm`);
    } catch (e) { logTest('POST /api/simulate/step', false, e.message); }

    try {
        const snapResult = await request('/api/snapshots', 'POST', {
            wind_speed: 5, wind_direction: 90, emission_intensity: 100,
            temperature: 25, humidity: 70, stability_class: 'D',
            stack_height: 80, reaction_rate: 0.01, simulation_time: 10,
            concentration_data: {
                grid: {
                    SO2: [[0, 0.5, 1], [0.2, 1.5, 2], [0.1, 0.8, 0.3]],
                    SO4: [[0, 0.2, 0.5], [0.1, 0.8, 1], [0.05, 0.3, 0.1]]
                },
                statistics: { SO2: { max: 2 }, SO4: { max: 1 } }
            }
        });
        logTest('POST /api/snapshots 保存快照(含空间数据)',
            snapResult.id > 0,
            `快照ID: ${snapResult.id}, SO2最大: ${snapResult.speciesMaxValues?.so2 || 'N/A'}`);

        if (snapResult.id > 0) {
            const spatial = await request(`/api/snapshots/${snapResult.id}/spatial?species=SO2`);
            logTest('GET /api/snapshots/:id/spatial 查询空间数据',
                Array.isArray(spatial) && spatial.length > 0,
                `返回${spatial.length}个SO2空间数据点`);
        }
    } catch (e) { logTest('POST /api/snapshots', false, e.message); }

    try {
        const spatialQuery = await request('/api/spatial/query?species=SO2&minX=0&maxX=20');
        logTest('GET /api/spatial/query 空间范围查询',
            Array.isArray(spatialQuery),
            `查询返回${spatialQuery.length}条记录`);
    } catch (e) { logTest('GET /api/spatial/query', false, e.message); }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('测试3: WebSocket 实时预警推送');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
        const ws = new WebSocket('ws://localhost:3000/ws');
        
        await new Promise((resolve, reject) => {
            ws.on('open', () => {
                console.log('  WebSocket连接已建立');
                resolve();
            });
            ws.on('error', reject);
            setTimeout(() => reject(new Error('连接超时')), 5000);
        });

        let receivedMessage = false;
        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'connection') {
                receivedMessage = true;
                console.log(`  收到连接确认消息, 活跃预警: ${msg.activeAlerts?.length || 0}条`);
            }
        });

        await new Promise(r => setTimeout(r, 1000));
        ws.close();
        
        logTest('WebSocket 连接与消息接收', receivedMessage,
            'WebSocket正常工作, 可用于实时预警推送');
    } catch (e) {
        logTest('WebSocket 连接', false, e.message);
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('测试4: 数据库结构验证');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database('./pollution.db');

    try {
        const tables = await new Promise((resolve, reject) => {
            db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, rows) => {
                if (err) reject(err);
                else resolve(rows.map(r => r.name));
            });
        });
        
        const requiredTables = ['snapshots', 'spatial_data', 'species_definitions', 'weather_params'];
        const hasAllTables = requiredTables.every(t => tables.includes(t));
        logTest('数据库包含所有必需表', hasAllTables,
            `表: ${tables.join(', ')}`);

        const columns = await new Promise((resolve, reject) => {
            db.all("PRAGMA table_info(snapshots)", (err, rows) => {
                if (err) reject(err);
                else resolve(rows.map(r => r.name));
            });
        });
        
        const speciesCols = ['species_so2_max', 'species_so4_max', 'species_pm25_max'];
        const hasSpeciesCols = speciesCols.every(c => columns.includes(c));
        logTest('snapshots表包含多物种浓度字段', hasSpeciesCols,
            `组分字段: ${speciesCols.filter(c => columns.includes(c)).join(', ')}`);

        const indexes = await new Promise((resolve, reject) => {
            db.all("SELECT name FROM sqlite_master WHERE type='index'", (err, rows) => {
                if (err) reject(err);
                else resolve(rows.map(r => r.name));
            });
        });
        
        const spatialIndexes = indexes.filter(i => i.includes('spatial') || i.includes('idx_'));
        logTest('数据库包含空间索引', spatialIndexes.length >= 3,
            `索引: ${spatialIndexes.join(', ')}`);

    } catch (e) {
        logTest('数据库结构验证', false, e.message);
    } finally {
        db.close();
    }

    console.log('\n' + '='.repeat(80));
    console.log('测试结果汇总');
    console.log('='.repeat(80));
    console.log(`  通过: ${results.passed}`);
    console.log(`  失败: ${results.failed}`);
    console.log(`  通过率: ${((results.passed / (results.passed + results.failed)) * 100).toFixed(1)}%`);
    console.log('='.repeat(80));
}

runTests().catch(console.error);
