const SPECIES_CONFIG = {
    SO2: { deliquescenceRH: 80, criticalRH: 95, hysteresis: 3, maxGrowth: 4.5, exponent: 1.8, onset: 1.05 },
    SO4: { deliquescenceRH: 75, criticalRH: 95, hysteresis: 5, maxGrowth: 5.0, exponent: 2.0, onset: 1.10 },
    NO2: { deliquescenceRH: 90, criticalRH: 98, hysteresis: 2, maxGrowth: 2.0, exponent: 1.5, onset: 1.02 },
    PM25: { deliquescenceRH: 70, criticalRH: 95, hysteresis: 5, maxGrowth: 3.5, exponent: 1.6, onset: 1.08 },
    PM10: { deliquescenceRH: 68, criticalRH: 95, hysteresis: 5, maxGrowth: 2.8, exponent: 1.5, onset: 1.07 },
    O3: null,
    CO: null
};

const STABILITY_PARAMS = {
    A: { sigmaY: 0.22, sigmaZ: 0.20, name: '极不稳定' },
    B: { sigmaY: 0.16, sigmaZ: 0.12, name: '不稳定' },
    C: { sigmaY: 0.11, sigmaZ: 0.08, name: '弱不稳定' },
    D: { sigmaY: 0.08, sigmaZ: 0.06, name: '中性' },
    E: { sigmaY: 0.06, sigmaZ: 0.03, name: '弱稳定' },
    F: { sigmaY: 0.04, sigmaZ: 0.016, name: '稳定' }
};

function hygroscopicGrowthFactor(RH, speciesId) {
    const config = SPECIES_CONFIG[speciesId];
    if (!config) return 1.0;
    
    const onsetRH = config.deliquescenceRH - config.hysteresis;
    const effectiveOnset = onsetRH - 1;

    if (RH < effectiveOnset) return 1.0;
    if (RH >= config.criticalRH) return config.maxGrowth;
    
    const normalizedRH = Math.max(0, (RH - effectiveOnset) / (config.criticalRH - effectiveOnset));
    return config.onset + (config.maxGrowth - config.onset) * Math.pow(normalizedRH, config.exponent);
}

function calculateSigma(x, stability, humidity, species) {
    const params = STABILITY_PARAMS[stability];
    let sigmaY = params.sigmaY * Math.pow(Math.max(x, 1), 0.9);
    let sigmaZ = params.sigmaZ * Math.pow(Math.max(x, 1), 0.85);

    let growthFactor = 1;
    if (species && SPECIES_CONFIG[species]) {
        growthFactor = hygroscopicGrowthFactor(humidity, species);
        sigmaY *= growthFactor;
        sigmaZ *= growthFactor * 0.7;
    }

    return { sigmaY: Math.max(sigmaY, 1), sigmaZ: Math.max(sigmaZ, 1), growthFactor };
}

function gaussianConcentration(x, y, z, Q, u, H, sigmaY, sigmaZ) {
    if (x <= 0) return 0;
    const term1 = Q / (2 * Math.PI * Math.max(u, 0.1) * sigmaY * sigmaZ);
    const yTerm = Math.exp(-Math.pow(y, 2) / (2 * Math.pow(sigmaY, 2)));
    const zTerm = Math.exp(-Math.pow(z - H, 2) / (2 * Math.pow(sigmaZ, 2))) +
                  Math.exp(-Math.pow(z + H, 2) / (2 * Math.pow(sigmaZ, 2)));
    return term1 * yTerm * zTerm;
}

function processSimulationStep(config) {
    const { 
        windSpeed, windDirection, emissionIntensity, stackHeight,
        stabilityClass, humidity, temperature, gridSize, gridCols, gridRows,
        sourceX, sourceY, enableReaction, reactionRate, speciesList,
        previousConcentrations
    } = config;

    const windRad = (windDirection - 90) * Math.PI / 180;
    const cosTheta = Math.cos(windRad);
    const sinTheta = Math.sin(windRad);
    const H = stackHeight / 10;
    const u = Math.max(windSpeed, 0.1);

    const speciesEmissionRatio = {
        SO2: 1.0, SO4: 0.0, NO2: 0.6, PM25: 0.4, PM10: 0.2, O3: 0.0, CO: 0.5
    };

    const result = {
        concentrations: {},
        statistics: {},
        warnings: []
    };

    const THRESHOLDS = {
        SO2: 0.5, SO4: 0.3, NO2: 0.1, PM25: 35, PM10: 70, O3: 0.07, CO: 9
    };

    speciesList.forEach(species => {
        const grid = [];
        const ratio = speciesEmissionRatio[species] || 0;
        const emission = emissionIntensity * ratio;
        const growthFactor = hygroscopicGrowthFactor(humidity, species);
        
        let maxConc = 0;
        let maxX = 0, maxY = 0;
        let totalConc = 0;
        let aboveThreshold = false;

        for (let i = 0; i < gridRows; i++) {
            grid[i] = [];
            for (let j = 0; j < gridCols; j++) {
                const gridX = (j + 0.5) * gridSize;
                const gridY = (i + 0.5) * gridSize;

                const dx = gridX - sourceX;
                const dy = gridY - sourceY;

                const downwindX = dx * cosTheta + dy * sinTheta;
                const crosswindY = -dx * sinTheta + dy * cosTheta;

                let conc = 0;
                if (downwindX > 0 && emission > 0) {
                    const { sigmaY, sigmaZ } = calculateSigma(downwindX / 10, stabilityClass, humidity, species);
                    conc = gaussianConcentration(downwindX / 10, crosswindY / 10, 0, emission, u, H, sigmaY, sigmaZ);
                    conc = conc * 100 / Math.max(growthFactor, 1);

                    if (previousConcentrations && previousConcentrations[species]) {
                        const prevConc = previousConcentrations[species][i]?.[j] || 0;
                        conc = prevConc * 0.3 + conc * 0.7;
                    }

                    if (enableReaction && species === 'SO2') {
                        const dt = 0.1;
                        const converted = conc * reactionRate * dt;
                        conc -= converted;
                    }
                } else if (previousConcentrations && previousConcentrations[species]) {
                    conc = (previousConcentrations[species][i]?.[j] || 0) * 0.98;
                }

                grid[i][j] = Math.max(conc, 0);
                totalConc += grid[i][j];
                
                if (grid[i][j] > maxConc) {
                    maxConc = grid[i][j];
                    maxX = j;
                    maxY = i;
                }
                
                if (THRESHOLDS[species] && grid[i][j] > THRESHOLDS[species]) {
                    aboveThreshold = true;
                }
            }
        }

        result.concentrations[species] = grid;
        result.statistics[species] = {
            max: maxConc,
            maxX: maxX,
            maxY: maxY,
            average: totalConc / (gridRows * gridCols),
            aboveThreshold: aboveThreshold,
            growthFactor: growthFactor
        };

        if (aboveThreshold) {
            result.warnings.push({
                species: species,
                maxConc: maxConc,
                threshold: THRESHOLDS[species],
                location: { x: maxX, y: maxY }
            });
        }
    });

    if (enableReaction && speciesList.includes('SO2') && speciesList.includes('SO4')) {
        result.concentrations.SO4 = result.concentrations.SO4 || [];
        for (let i = 0; i < gridRows; i++) {
            result.concentrations.SO4[i] = result.concentrations.SO4[i] || [];
            for (let j = 0; j < gridCols; j++) {
                const so2Conc = result.concentrations.SO2?.[i]?.[j] || 0;
                const converted = so2Conc * reactionRate * 0.1 * 0.8;
                result.concentrations.SO4[i][j] = (result.concentrations.SO4[i][j] || 0) + converted;
            }
        }
    }

    return result;
}

self.onmessage = function(e) {
    const { type, config, taskId } = e.data;
    
    if (type === 'simulate') {
        try {
            const result = processSimulationStep(config);
            self.postMessage({
                type: 'result',
                taskId: taskId,
                data: result
            });
        } catch (error) {
            self.postMessage({
                type: 'error',
                taskId: taskId,
                error: error.message
            });
        }
    } else if (type === 'hygroscopicCurve') {
        const { species, startRH, endRH, step } = config;
        const curve = [];
        for (let rh = startRH; rh <= endRH; rh += step) {
            curve.push({
                humidity: rh,
                factor: hygroscopicGrowthFactor(rh, species)
            });
        }
        self.postMessage({ type: 'hygroscopicCurve', taskId, data: curve });
    }
};

self.postMessage({ type: 'ready' });
