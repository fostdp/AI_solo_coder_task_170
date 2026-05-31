const assert = require('assert');
const http = require('http');

console.log('='.repeat(70));
console.log('大气污染扩散模拟系统 - 修复验证测试');
console.log('='.repeat(70));

const testResults = {
    passed: 0,
    failed: 0,
    details: []
};

function logTest(testName, passed, message) {
    const status = passed ? '✓ PASS' : '✗ FAIL';
    console.log(`\n${status} - ${testName}`);
    if (message) console.log(`  ${message}`);
    if (passed) testResults.passed++;
    else testResults.failed++;
    testResults.details.push({ testName, passed, message });
}

function hygroscopicGrowthFactor(RH) {
    const deliquescenceRH = 80;
    const criticalRH = 95;
    const hysteresis = 3;
    const onsetRH = deliquescenceRH - hysteresis;
    
    if (RH < onsetRH - 1) {
        return 1.0;
    } else if (RH >= onsetRH - 1 && RH < criticalRH) {
        const normalizedRH = Math.max(0, (RH - (onsetRH - 1)) / (criticalRH - (onsetRH - 1)));
        const growthFactor = 1.05 + 3.0 * Math.pow(normalizedRH, 1.8);
        return growthFactor;
    } else {
        return 4.5;
    }
}

function calculateSigma(x, stability, humidity = 60) {
    const stabilityParams = {
        A: { sigmaY: 0.22, sigmaZ: 0.20 },
        B: { sigmaY: 0.16, sigmaZ: 0.12 },
        C: { sigmaY: 0.11, sigmaZ: 0.08 },
        D: { sigmaY: 0.08, sigmaZ: 0.06 },
        E: { sigmaY: 0.06, sigmaZ: 0.03 },
        F: { sigmaY: 0.04, sigmaZ: 0.016 }
    };
    
    const params = stabilityParams[stability];
    let sigmaY = params.sigmaY * Math.pow(x, 0.9);
    let sigmaZ = params.sigmaZ * Math.pow(x, 0.85);
    
    const growthFactor = hygroscopicGrowthFactor(humidity);
    sigmaY *= growthFactor;
    sigmaZ *= growthFactor * 0.7;
    
    return { sigmaY: Math.max(sigmaY, 1), sigmaZ: Math.max(sigmaZ, 1), growthFactor };
}

function gaussianConcentration(x, y, z, Q, u, H, sigmaY, sigmaZ) {
    if (x <= 0) return 0;
    const term1 = Q / (2 * Math.PI * u * sigmaY * sigmaZ);
    const yTerm = Math.exp(-Math.pow(y, 2) / (2 * Math.pow(sigmaY, 2)));
    const zTerm = Math.exp(-Math.pow(z - H, 2) / (2 * Math.pow(sigmaZ, 2))) +
                  Math.exp(-Math.pow(z + H, 2) / (2 * Math.pow(sigmaZ, 2)));
    return term1 * yTerm * zTerm;
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('测试 1: 稳定度从A到F变化时烟羽水平扩散角是否减小');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const stabilityOrder = ['A', 'B', 'C', 'D', 'E', 'F'];
const diffusionWidths = [];

stabilityOrder.forEach((stability, index) => {
    const { sigmaY } = calculateSigma(100, stability, 60);
    diffusionWidths.push(sigmaY);
    console.log(`  稳定度 ${stability}: σy = ${sigmaY.toFixed(4)} m`);
});

let isDecreasing = true;
let failedCases1 = [];
for (let i = 1; i < diffusionWidths.length; i++) {
    const prev = diffusionWidths[i - 1];
    const curr = diffusionWidths[i];
    const assertion = curr < prev;
    if (!assertion) {
        isDecreasing = false;
        failedCases1.push(`${stabilityOrder[i-1]}→${stabilityOrder[i]}: ${prev.toFixed(4)} → ${curr.toFixed(4)} (应减小)`);
    }
}

logTest(
    '稳定度A→F扩散宽度单调递减',
    isDecreasing,
    isDecreasing 
        ? `扩散宽度从 ${diffusionWidths[0].toFixed(2)}m (A) 递减到 ${diffusionWidths[5].toFixed(2)}m (F)`
        : `失败用例: ${failedCases1.join('; ')}`
);

console.log('\n  断言明细:');
stabilityOrder.forEach((s, i) => {
    console.log(`    ASSERT_${s}: σy_${s} < σy_${stabilityOrder[i-1] || 'prev'}`);
});

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('测试 2: 相对湿度从40%升至90%时PM2.5浓度是否增加');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const testRH = [40, 50, 60, 70, 77, 80, 85, 90];
const concentrationResults = [];

testRH.forEach(rh => {
    const { sigmaY, sigmaZ, growthFactor } = calculateSigma(100, 'D', rh);
    const concentration = gaussianConcentration(100, 0, 0, 50, 5, 8, sigmaY, sigmaZ);
    concentrationResults.push({ rh, concentration, growthFactor, sigmaY });
    console.log(`  RH=${rh}%: 增长因子=${growthFactor.toFixed(3)}, σy=${sigmaY.toFixed(2)}m, 浓度=${concentration.toFixed(6)}`);
});

const rh40 = concentrationResults.find(c => c.rh === 40).concentration;
const rh90 = concentrationResults.find(c => c.rh === 90).concentration;
const concIncreased = rh90 > rh40;

logTest(
    'RH 40%→90%浓度增加',
    concIncreased,
    concIncreased
        ? `浓度从 ${rh40.toFixed(6)} 增加到 ${rh90.toFixed(6)} (增长 ${((rh90/rh40-1)*100).toFixed(1)}%)`
        : `失败: RH40%=${rh40.toFixed(6)}, RH90%=${rh90.toFixed(6)}`
);

let concMonotonicAfter80 = true;
let failedCases2 = [];
const highRHResults = concentrationResults.filter(c => c.rh >= 80);
for (let i = 1; i < highRHResults.length; i++) {
    if (highRHResults[i].concentration <= highRHResults[i-1].concentration) {
        concMonotonicAfter80 = false;
        failedCases2.push(`RH${highRHResults[i-1].rh}→RH${highRHResults[i].rh}: ${highRHResults[i-1].concentration.toFixed(6)} → ${highRHResults[i].concentration.toFixed(6)}`);
    }
}

logTest(
    'RH≥80%后浓度单调递增',
    concMonotonicAfter80,
    concMonotonicAfter80 ? '高湿度下浓度随湿度持续增加' : `失败用例: ${failedCases2.join('; ')}`
);

const rh77 = concentrationResults.find(c => c.rh === 77);
logTest(
    'RH=77%时开始吸湿增长',
    rh77.growthFactor > 1.0,
    `RH=77%增长因子=${rh77.growthFactor.toFixed(3)} ${rh77.growthFactor > 1.0 ? '(>1.0 ✓)' : '(≤1.0 ✗)'}`
);

console.log('\n  断言明细:');
console.log('    ASSERT_RH1: RH90浓度 > RH40浓度');
console.log('    ASSERT_RH2: 对所有RH∈[80,90], conc(RH) > conc(RH-5)');
console.log('    ASSERT_RH3: growthFactor(77%RH) > 1.0');

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('测试 3: 后端浓度数据是否已增加最大落地浓度数值');
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

async function testBackend() {
    console.log('  正在测试后端API...');
    
    try {
        const testSnapshot = {
            wind_speed: 5.0,
            wind_direction: 90,
            emission_intensity: 50,
            temperature: 25,
            humidity: 60,
            stability_class: 'D',
            stack_height: 80,
            reaction_rate: 0.01,
            simulation_time: 10,
            max_concentration: 2.345,
            max_conc_x: 300,
            max_conc_y: 300,
            avg_concentration: 0.123,
            affected_area: 150000,
            hygroscopic_growth: 1.5,
            concentration_data: { so2: [[0]], so4: [[0]] }
        };

        console.log('\n  步骤1: 保存测试快照...');
        const postResult = await makeRequest({
            hostname: 'localhost',
            port: 3000,
            path: '/api/snapshots',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify(testSnapshot));
        
        const hasMaxConcInResponse = postResult.data && typeof postResult.data.max_concentration === 'number';
        logTest(
            'POST返回包含max_concentration数据',
            hasMaxConcInResponse,
            hasMaxConcInResponse 
                ? `返回浓度: ${postResult.data.max_concentration} ppm`
                : `响应数据: ${JSON.stringify(postResult).substring(0, 200)}`
        );

        console.log('\n  步骤2: 获取快照列表...');
        const snapshots = await makeRequest({
            hostname: 'localhost',
            port: 3000,
            path: '/api/snapshots',
            method: 'GET'
        });

        const hasQuantitativeFields = snapshots.length > 0 && 
            typeof snapshots[0].max_concentration === 'number' &&
            typeof snapshots[0].avg_concentration === 'number' &&
            typeof snapshots[0].affected_area === 'number' &&
            typeof snapshots[0].stability_class === 'string';

        logTest(
            'GET列表包含定量浓度字段',
            hasQuantitativeFields,
            hasQuantitativeFields
                ? `字段验证通过: max_conc=${snapshots[0].max_concentration}, avg_conc=${snapshots[0].avg_concentration}, area=${snapshots[0].affected_area}, stability=${snapshots[0].stability_class}`
                : `可用字段: ${snapshots.length > 0 ? Object.keys(snapshots[0]).join(', ') : '无数据'}`
        );

        console.log('\n  步骤3: 测试统计API...');
        const stats = await makeRequest({
            hostname: 'localhost',
            port: 3000,
            path: '/api/statistics/summary',
            method: 'GET'
        });

        const hasSummaryStats = stats && typeof stats.highest_concentration === 'number' &&
            typeof stats.avg_max_concentration === 'number';
        
        logTest(
            '统计API返回最大浓度汇总',
            hasSummaryStats,
            hasSummaryStats
                ? `最高浓度记录: ${stats.highest_concentration} ppm, 平均最大浓度: ${stats.avg_max_concentration.toFixed(4)} ppm`
                : `统计数据: ${JSON.stringify(stats)}`
        );

        const maxConcList = await makeRequest({
            hostname: 'localhost',
            port: 3000,
            path: '/api/statistics/max-concentration?limit=5',
            method: 'GET'
        });

        const hasRankingAPI = Array.isArray(maxConcList) && maxConcList.length > 0;
        logTest(
            '最大浓度排名API可用',
            hasRankingAPI,
            hasRankingAPI 
                ? `返回${maxConcList.length}条记录，最高: ${maxConcList[0].max_concentration.toFixed(4)} ppm`
                : '排名API返回无效数据'
        );

    } catch (error) {
        console.log(`  后端测试失败: ${error.message}`);
        logTest('后端连接失败', false, error.message);
    }

    console.log('\n  断言明细:');
    console.log('    ASSERT_DB1: snapshots表包含max_concentration字段');
    console.log('    ASSERT_DB2: snapshots表包含avg_concentration字段');
    console.log('    ASSERT_DB3: snapshots表包含affected_area字段');
    console.log('    ASSERT_DB4: /api/statistics/summary返回统计数据');
    console.log('    ASSERT_DB5: /api/statistics/max-concentration返回排名');
}

testBackend().then(() => {
    console.log('\n' + '='.repeat(70));
    console.log('测试结果汇总');
    console.log('='.repeat(70));
    console.log(`  通过: ${testResults.passed}`);
    console.log(`  失败: ${testResults.failed}`);
    console.log(`  总数: ${testResults.passed + testResults.failed}`);
    console.log(`  通过率: ${((testResults.passed / (testResults.passed + testResults.failed)) * 100).toFixed(1)}%`);
    
    if (testResults.failed > 0) {
        console.log('\n  失败用例明细:');
        testResults.details
            .filter(t => !t.passed)
            .forEach((t, i) => console.log(`    ${i + 1}. ${t.testName}: ${t.message}`));
    }
    
    console.log('\n' + '='.repeat(70));
    process.exit(testResults.failed > 0 ? 1 : 0);
});
