const { 
    SPECIES, 
    ConcentrationField, 
    DispersionModel, 
    ChemicalTransformation, 
    AirQualitySimulator 
} = require('./airQualityModel');

const http = require('http');

console.log('='.repeat(80));
console.log('空气质量模拟框架 - 重构验证测试');
console.log('='.repeat(80));

const results = {
    passed: 0,
    failed: 0,
    details: []
};

function logTest(name, passed, message) {
    const status = passed ? '✓' : '✗';
    console.log(`\n${status} ${name}`);
    if (message) console.log(`  ${message}`);
    if (passed) results.passed++;
    else results.failed++;
    results.details.push({ name, passed, message });
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('模块1: 污染物组分定义');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

logTest('SO2组分存在', SPECIES.SO2 !== undefined, 
    `SO2: ${SPECIES.SO2.name}, 分子量: ${SPECIES.SO2.molecularWeight}`);

logTest('SO4组分存在', SPECIES.SO4 !== undefined, 
    `SO4: ${SPECIES.SO4.name}, 类型: ${SPECIES.SO4.gasParticle}`);

logTest('PM25组分存在', SPECIES.PM25 !== undefined, 
    `PM25: ${SPECIES.PM25.name}, 吸湿: ${SPECIES.PM25.hygroscopic ? '是' : '否'}`);

logTest('O3组分无吸湿特性', SPECIES.O3.hygroscopic === null, 
    'O3为气体，无吸湿特性配置');

logTest('各组分潮解点不同', 
    SPECIES.SO2.hygroscopic.deliquescenceRH !== SPECIES.SO4.hygroscopic.deliquescenceRH &&
    SPECIES.SO4.hygroscopic.deliquescenceRH !== SPECIES.PM25.hygroscopic.deliquescenceRH,
    `SO2:${SPECIES.SO2.hygroscopic.deliquescenceRH}% SO4:${SPECIES.SO4.hygroscopic.deliquescenceRH}% PM25:${SPECIES.PM25.hygroscopic.deliquescenceRH}%`);

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('模块2: ConcentrationField 结构化存储');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const field = new ConcentrationField(15, 20, ['SO2', 'SO4', 'NO2']);

logTest('多物种网格初始化', 
    field.grid.SO2 && field.grid.SO4 && field.grid.NO2,
    `SO2网格: ${field.grid.SO2.length}x${field.grid.SO2[0]?.length}`);

logTest('统计信息初始化', 
    field.statistics.SO2 && field.statistics.SO4,
    `SO2统计: ${JSON.stringify(field.statistics.SO2).substring(0, 50)}`);

field.setValue('SO2', 7, 10, 1.5);
field.setValue('SO4', 8, 10, 0.8);
field.updateStatistics();

logTest('统计计算正确', 
    field.statistics.SO2.max === 1.5 && field.statistics.SO4.max === 0.8,
    `SO2最大: ${field.statistics.SO2.max}, SO4最大: ${field.statistics.SO4.max}`);

logTest('总浓度计算', field.getTotalConcentration(7, 10) === 1.5,
    `位置(7,10)总浓度: ${field.getTotalConcentration(7, 10)}`);

const json = field.toJSON();
logTest('JSON序列化', 
    json.rows === 15 && json.cols === 20 && json.speciesList.length === 3,
    `JSON包含: rows, cols, grid, statistics`);

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('模块3: 组分相关的吸湿增长模型');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const dispersion = new DispersionModel();

const testRH = [40, 60, 75, 80, 85, 90, 95];
const speciesList = ['SO2', 'SO4', 'NO2', 'PM25', 'PM10', 'O3'];

console.log('\n各组分吸湿因子对比:');
testRH.forEach(rh => {
    const factors = speciesList.map(sp => {
        const f = dispersion.calculateHygroscopicGrowth(rh, sp);
        return `${sp}:${f.toFixed(2)}`;
    }).join(' | ');
    console.log(`  RH=${rh}%: ${factors}`);
});

const growthSO2at85 = dispersion.calculateHygroscopicGrowth(85, 'SO2');
const growthSO4at85 = dispersion.calculateHygroscopicGrowth(85, 'SO4');
const growthPM25at85 = dispersion.calculateHygroscopicGrowth(85, 'PM25');

logTest('SO4吸湿因子高于SO2', growthSO4at85 > growthSO2at85,
    `SO2:${growthSO2at85.toFixed(2)} SO4:${growthSO4at85.toFixed(2)}`);

logTest('PM25吸湿因子介于SO2和SO4之间', 
    growthPM25at85 > growthSO2at85 && growthPM25at85 < growthSO4at85,
    `PM25:${growthPM25at85.toFixed(2)}`);

const growthO3 = dispersion.calculateHygroscopicGrowth(95, 'O3');
logTest('O3无吸湿效应', growthO3 === 1.0, `O3在95%RH下因子: ${growthO3}`);

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('模块4: 高斯扩散与稳定度关联');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const stabilityOrder = ['A', 'B', 'C', 'D', 'E', 'F'];
const sigmaValues = stabilityOrder.map(stability => {
    const { sigmaY } = dispersion.calculateSigma(100, stability, 60, 'SO2');
    return { stability, sigmaY };
});

let sigmaDecreasing = true;
for (let i = 1; i < sigmaValues.length; i++) {
    if (sigmaValues[i].sigmaY >= sigmaValues[i-1].sigmaY) {
        sigmaDecreasing = false;
        break;
    }
}

logTest('稳定度A→F扩散递减', sigmaDecreasing,
    sigmaValues.map(v => `${v.stability}:${v.sigmaY.toFixed(2)}`).join(' → '));

const sigmaWithHygro = dispersion.calculateSigma(100, 'D', 90, 'SO4');
const sigmaWithoutHygro = dispersion.calculateSigma(100, 'D', 40, 'SO4');

logTest('高湿度扩散更宽', sigmaWithHygro.sigmaY > sigmaWithoutHygro.sigmaY,
    `90%RH:${sigmaWithHygro.sigmaY.toFixed(2)} 40%RH:${sigmaWithoutHygro.sigmaY.toFixed(2)}`);

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('模块5: 化学反应与温度依赖');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const chemistry = new ChemicalTransformation({ so2ToSo4Rate: 0.01, temperature: 25 });

const testField = new ConcentrationField(5, 5, ['SO2', 'SO4']);
testField.setValue('SO2', 2, 2, 10);
chemistry.transform(testField, 1.0);

logTest('SO2浓度减少', testField.getValue('SO2', 2, 2) < 10,
    `转化前:10, 转化后:${testField.getValue('SO2', 2, 2).toFixed(2)}`);

logTest('SO4浓度增加', testField.getValue('SO4', 2, 2) > 0,
    `SO4生成:${testField.getValue('SO4', 2, 2).toFixed(4)}`);

const rateAt25 = chemistry.getTemperatureCorrectedRate(0.01, 25);
const rateAt35 = chemistry.getTemperatureCorrectedRate(0.01, 35);
logTest('高温加速反应', rateAt35 > rateAt25,
    `25°C:${rateAt25.toFixed(4)} 35°C:${rateAt35.toFixed(4)}`);

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('模块6: AirQualitySimulator 集成测试');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const simulator = new AirQualitySimulator({
    speciesList: ['SO2', 'SO4', 'NO2', 'PM25', 'PM10'],
    rows: 10,
    cols: 10
});

simulator.addSource({
    id: 'factory',
    location: { x: 200, y: 300 },
    emissions: { SO2: 50, NO2: 30, PM25: 20 },
    height: 80
});

simulator.setWeather({
    windSpeed: 5,
    windDirection: 90,
    temperature: 25,
    stabilityClass: 'D'
});

for (let i = 0; i < 10; i++) {
    simulator.step(0.1);
}

const state = simulator.getState();
const summary = simulator.getSummary();

logTest('模拟时间累积', state.time > 0, `模拟时间: ${state.time.toFixed(1)}s`);

logTest('多物种浓度计算', 
    summary.species.SO2 && summary.species.NO2 && summary.species.PM25,
    `SO2最大:${summary.species.SO2.max.toFixed(3)} NO2最大:${summary.species.NO2.max.toFixed(3)} PM25最大:${summary.species.PM25.max.toFixed(3)}`);

const hygroInfo = simulator.getHygroscopicInfo('PM25', 85);
logTest('吸湿信息查询', hygroInfo && hygroInfo.hygroscopic.isHygroscopic,
    `PM25潮解点:${hygroInfo.hygroscopic.deliquescenceRH}% 当前因子:${hygroInfo.hygroscopic.currentGrowthFactor.toFixed(2)}`);

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('模块7: 后端API测试');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

function makeRequest(options, postData = null) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { resolve(data); }
            });
        });
        req.on('error', reject);
        if (postData) req.write(postData);
        req.end();
    });
}

async function testAPI() {
    console.log('  测试后端API...');
    
    try {
        const species = await makeRequest({
            hostname: 'localhost', port: 3000, path: '/api/species', method: 'GET'
        });
        logTest('GET /api/species 返回组分列表', 
            Array.isArray(species) && species.length >= 5,
            `返回${species.length}个组分定义`);

        const hygroCurve = await makeRequest({
            hostname: 'localhost', port: 3000, 
            path: '/api/hygroscopic/curve?species=SO4', method: 'GET'
        });
        logTest('GET /api/hygroscopic/curve 返回吸湿曲线', 
            hygroCurve.curve && hygroCurve.curve.length > 0,
            `SO4吸湿曲线: ${hygroCurve.curve.length}个数据点`);

        const simulateResult = await makeRequest({
            hostname: 'localhost', port: 3000, path: '/api/simulate/step', method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify({
            wind_speed: 5, emission_intensity: 50, stability_class: 'D', humidity: 85
        }));
        logTest('POST /api/simulate/step 执行模拟', 
            simulateResult.summary && simulateResult.summary.species,
            `模拟摘要包含${Object.keys(simulateResult.summary.species).length}个物种`);

        const testSnapshot = {
            wind_speed: 5, wind_direction: 90, emission_intensity: 50,
            temperature: 25, humidity: 85, stability_class: 'D',
            stack_height: 80, reaction_rate: 0.01, simulation_time: 5,
            species_so2_max: 1.234, species_so4_max: 0.567,
            species_no2_max: 0.890, species_pm25_max: 2.345, species_pm10_max: 1.678,
            concentration_data: { grid: { SO2: [[0]] }, statistics: {} }
        };

        const saveResult = await makeRequest({
            hostname: 'localhost', port: 3000, path: '/api/snapshots', method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify(testSnapshot));

        logTest('快照保存包含多物种数据', 
            saveResult.speciesMaxValues && saveResult.speciesMaxValues.so4 > 0,
            `保存数据: SO2=${saveResult.speciesMaxValues?.so2} SO4=${saveResult.speciesMaxValues?.so4}`);

        const snapshots = await makeRequest({
            hostname: 'localhost', port: 3000, path: '/api/snapshots', method: 'GET'
        });
        logTest('快照列表包含组分浓度', 
            snapshots.length > 0 && snapshots[0].species_so2_max !== undefined,
            `列表字段: species_so2_max, species_so4_max, species_pm25_max`);

        const speciesStats = await makeRequest({
            hostname: 'localhost', port: 3000, path: '/api/statistics/species', method: 'GET'
        });
        logTest('GET /api/statistics/species 返回组分统计', 
            Array.isArray(speciesStats) && speciesStats.length > 0,
            `返回${speciesStats.length}条记录`);

        const summaryStats = await makeRequest({
            hostname: 'localhost', port: 3000, path: '/api/statistics/summary', method: 'GET'
        });
        logTest('统计摘要包含多物种', 
            summaryStats.avg_so2_max !== undefined && summaryStats.avg_so4_max !== undefined,
            `SO2平均最大:${summaryStats.avg_so2_max?.toFixed(3)} SO4平均最大:${summaryStats.avg_so4_max?.toFixed(3)}`);

    } catch (error) {
        console.log(`  后端连接失败: ${error.message}`);
        logTest('后端API连接', false, error.message);
    }
}

testAPI().then(() => {
    console.log('\n' + '='.repeat(80));
    console.log('测试结果汇总');
    console.log('='.repeat(80));
    console.log(`  ✓ 通过: ${results.passed}`);
    console.log(`  ✗ 失败: ${results.failed}`);
    console.log(`  总计: ${results.passed + results.failed}`);
    console.log(`  通过率: ${((results.passed / (results.passed + results.failed)) * 100).toFixed(1)}%`);
    
    if (results.failed > 0) {
        console.log('\n  失败用例:');
        results.details.filter(t => !t.passed).forEach((t, i) => 
            console.log(`    ${i+1}. ${t.name}: ${t.message}`)
        );
    }
    
    console.log('\n  通过用例:');
    results.details.filter(t => t.passed).slice(0, 10).forEach((t, i) => 
        console.log(`    ${i+1}. ${t.name}`)
    );
    
    console.log('\n' + '='.repeat(80));
    process.exit(results.failed > 0 ? 1 : 0);
});
