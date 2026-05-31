const SPECIES = {
    SO2: {
        id: 'SO2',
        name: '二氧化硫',
        molecularWeight: 64.07,
        gasParticle: 'gas',
        solubility: 'high',
        defaultRate: 0.01,
        hygroscopic: {
            deliquescenceRH: 80,
            criticalRH: 95,
            hysteresis: 3,
            maxGrowthFactor: 4.5,
            growthExponent: 1.8,
            onsetFactor: 1.05
        }
    },
    SO4: {
        id: 'SO4',
        name: '硫酸盐气溶胶',
        molecularWeight: 96.06,
        gasParticle: 'particle',
        solubility: 'very_high',
        defaultRate: 0,
        hygroscopic: {
            deliquescenceRH: 75,
            criticalRH: 95,
            hysteresis: 5,
            maxGrowthFactor: 5.0,
            growthExponent: 2.0,
            onsetFactor: 1.10
        }
    },
    NO2: {
        id: 'NO2',
        name: '二氧化氮',
        molecularWeight: 46.01,
        gasParticle: 'gas',
        solubility: 'low',
        defaultRate: 0.005,
        hygroscopic: {
            deliquescenceRH: 90,
            criticalRH: 98,
            hysteresis: 2,
            maxGrowthFactor: 2.0,
            growthExponent: 1.5,
            onsetFactor: 1.02
        }
    },
    O3: {
        id: 'O3',
        name: '臭氧',
        molecularWeight: 48.00,
        gasParticle: 'gas',
        solubility: 'low',
        defaultRate: 0.002,
        hygroscopic: null
    },
    PM25: {
        id: 'PM25',
        name: '细颗粒物',
        molecularWeight: null,
        gasParticle: 'particle',
        solubility: 'moderate',
        defaultRate: 0,
        hygroscopic: {
            deliquescenceRH: 70,
            criticalRH: 95,
            hysteresis: 5,
            maxGrowthFactor: 3.5,
            growthExponent: 1.6,
            onsetFactor: 1.08
        }
    },
    PM10: {
        id: 'PM10',
        name: '可吸入颗粒物',
        molecularWeight: null,
        gasParticle: 'particle',
        solubility: 'moderate',
        defaultRate: 0,
        hygroscopic: {
            deliquescenceRH: 68,
            criticalRH: 95,
            hysteresis: 5,
            maxGrowthFactor: 2.8,
            growthExponent: 1.5,
            onsetFactor: 1.07
        }
    },
    CO: {
        id: 'CO',
        name: '一氧化碳',
        molecularWeight: 28.01,
        gasParticle: 'gas',
        solubility: 'very_low',
        defaultRate: 0.001,
        hygroscopic: null
    }
};

class ConcentrationField {
    constructor(rows, cols, speciesList = ['SO2', 'SO4']) {
        this.rows = rows;
        this.cols = cols;
        this.speciesList = speciesList;
        this.grid = {};
        this.metadata = {
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            spatialResolution: null,
            coordinateSystem: 'local'
        };

        speciesList.forEach(species => {
            this.grid[species] = this._createEmptyGrid();
        });

        this.statistics = this._initStatistics();
    }

    _createEmptyGrid() {
        const grid = [];
        for (let i = 0; i < this.rows; i++) {
            grid[i] = [];
            for (let j = 0; j < this.cols; j++) {
                grid[i][j] = 0;
            }
        }
        return grid;
    }

    _initStatistics() {
        const stats = {};
        this.speciesList.forEach(species => {
            stats[species] = {
                max: 0,
                min: 0,
                mean: 0,
                total: 0,
                maxLocation: { row: 0, col: 0 },
                affectedCells: 0
            };
        });
        return stats;
    }

    setValue(species, row, col, value) {
        if (this.grid[species] && row >= 0 && row < this.rows && col >= 0 && col < this.cols) {
            this.grid[species][row][col] = value;
        }
    }

    getValue(species, row, col) {
        if (this.grid[species] && row >= 0 && row < this.rows && col >= 0 && col < this.cols) {
            return this.grid[species][row][col];
        }
        return 0;
    }

    updateStatistics() {
        this.speciesList.forEach(species => {
            const grid = this.grid[species];
            if (!grid) return;

            let sum = 0;
            let maxVal = -Infinity;
            let minVal = Infinity;
            let maxRow = 0, maxCol = 0;
            let affectedCells = 0;

            for (let i = 0; i < this.rows; i++) {
                for (let j = 0; j < this.cols; j++) {
                    const val = grid[i][j];
                    sum += val;
                    if (val > maxVal) {
                        maxVal = val;
                        maxRow = i;
                        maxCol = j;
                    }
                    if (val < minVal) minVal = val;
                    if (val > 0.001) affectedCells++;
                }
            }

            this.statistics[species] = {
                max: maxVal === -Infinity ? 0 : maxVal,
                min: minVal === Infinity ? 0 : minVal,
                mean: sum / (this.rows * this.cols),
                total: sum,
                maxLocation: { row: maxRow, col: maxCol },
                affectedCells: affectedCells
            };
        });

        this.metadata.updatedAt = new Date().toISOString();
    }

    getTotalConcentration(row, col) {
        let total = 0;
        this.speciesList.forEach(species => {
            total += this.getValue(species, row, col);
        });
        return total;
    }

    toJSON() {
        return {
            rows: this.rows,
            cols: this.cols,
            speciesList: this.speciesList,
            grid: this.grid,
            metadata: this.metadata,
            statistics: this.statistics
        };
    }

    fromJSON(data) {
        this.rows = data.rows;
        this.cols = data.cols;
        this.speciesList = data.speciesList;
        this.grid = data.grid;
        this.metadata = data.metadata || this.metadata;
        this.statistics = data.statistics || this._initStatistics();
    }

    clone() {
        const clone = new ConcentrationField(this.rows, this.cols, [...this.speciesList]);
        clone.fromJSON(JSON.parse(JSON.stringify(this.toJSON())));
        return clone;
    }
}

class DispersionModel {
    constructor(config = {}) {
        this.stabilityParams = {
            A: { sigmaY: 0.22, sigmaZ: 0.20, name: '极不稳定' },
            B: { sigmaY: 0.16, sigmaZ: 0.12, name: '不稳定' },
            C: { sigmaY: 0.11, sigmaZ: 0.08, name: '弱不稳定' },
            D: { sigmaY: 0.08, sigmaZ: 0.06, name: '中性' },
            E: { sigmaY: 0.06, sigmaZ: 0.03, name: '弱稳定' },
            F: { sigmaY: 0.04, sigmaZ: 0.016, name: '稳定' }
        };

        this.config = {
            stabilityClass: config.stabilityClass || 'D',
            windSpeed: config.windSpeed || 5,
            windDirection: config.windDirection || 90,
            sourceLocation: config.sourceLocation || { x: 200, y: 300 },
            stackHeight: config.stackHeight || 80,
            temperature: config.temperature || 25,
            pressure: config.pressure || 1013.25
        };
    }

    setConfig(config) {
        Object.assign(this.config, config);
    }

    calculateSigma(distance, stabilityClass = this.config.stabilityClass, humidity = 60, species = null) {
        const params = this.stabilityParams[stabilityClass];
        if (!params) return { sigmaY: 1, sigmaZ: 1, growthFactor: 1 };

        let sigmaY = params.sigmaY * Math.pow(Math.max(distance, 1), 0.9);
        let sigmaZ = params.sigmaZ * Math.pow(Math.max(distance, 1), 0.85);

        let growthFactor = 1;
        if (species && SPECIES[species] && SPECIES[species].hygroscopic) {
            growthFactor = this.calculateHygroscopicGrowth(humidity, species);
            sigmaY *= growthFactor;
            sigmaZ *= growthFactor * 0.7;
        }

        return {
            sigmaY: Math.max(sigmaY, 1),
            sigmaZ: Math.max(sigmaZ, 1),
            growthFactor: growthFactor
        };
    }

    calculateHygroscopicGrowth(relativeHumidity, speciesId) {
        const species = SPECIES[speciesId];
        if (!species || !species.hygroscopic) return 1.0;

        const h = species.hygroscopic;
        const onsetRH = h.deliquescenceRH - h.hysteresis;
        const effectiveOnset = onsetRH - 1;

        if (relativeHumidity < effectiveOnset) {
            return 1.0;
        } else if (relativeHumidity >= effectiveOnset && relativeHumidity < h.criticalRH) {
            const normalizedRH = Math.max(0, 
                (relativeHumidity - effectiveOnset) / (h.criticalRH - effectiveOnset)
            );
            return h.onsetFactor + (h.maxGrowthFactor - h.onsetFactor) * Math.pow(normalizedRH, h.growthExponent);
        } else {
            return h.maxGrowthFactor;
        }
    }

    gaussianConcentration(downwindX, crosswindY, height, emissionRate, 
                          windSpeed, stackHeight, sigmaY, sigmaZ) {
        if (downwindX <= 0 || windSpeed <= 0) return 0;

        const u = Math.max(windSpeed, 0.1);
        const term1 = emissionRate / (2 * Math.PI * u * sigmaY * sigmaZ);
        const yTerm = Math.exp(-Math.pow(crosswindY, 2) / (2 * Math.pow(sigmaY, 2)));
        const zTerm = Math.exp(-Math.pow(height - stackHeight, 2) / (2 * Math.pow(sigmaZ, 2))) +
                      Math.exp(-Math.pow(height + stackHeight, 2) / (2 * Math.pow(sigmaZ, 2)));

        return term1 * yTerm * zTerm;
    }

    simulatePointSource(concentrationField, species, emissionRate, dt = 0.1) {
        const { windSpeed, windDirection, sourceLocation, stackHeight, stabilityClass } = this.config;
        const windRad = (windDirection - 90) * Math.PI / 180;
        const cosTheta = Math.cos(windRad);
        const sinTheta = Math.sin(windRad);

        for (let i = 0; i < concentrationField.rows; i++) {
            for (let j = 0; j < concentrationField.cols; j++) {
                const gridX = (j + 0.5) * 40;
                const gridY = (i + 0.5) * 40;

                const dx = gridX - sourceLocation.x;
                const dy = gridY - sourceLocation.y;

                const downwindX = dx * cosTheta + dy * sinTheta;
                const crosswindY = -dx * sinTheta + dy * cosTheta;

                if (downwindX > 0) {
                    const { sigmaY, sigmaZ, growthFactor } = this.calculateSigma(
                        downwindX / 10, stabilityClass, 60, species
                    );
                    const conc = this.gaussianConcentration(
                        downwindX / 10, crosswindY / 10, 0,
                        emissionRate, windSpeed, stackHeight / 10,
                        sigmaY, sigmaZ
                    );
                    const adjustedConc = conc * 100 / Math.max(growthFactor, 1);
                    concentrationField.setValue(species, i, j, adjustedConc);
                } else {
                    concentrationField.setValue(species, i, j, 
                        concentrationField.getValue(species, i, j) * 0.98);
                }
            }
        }
    }
}

class ChemicalTransformation {
    constructor(config = {}) {
        this.reactions = {
            'SO2→SO4': {
                reactant: 'SO2',
                product: 'SO4',
                rate: config.so2ToSo4Rate || 0.01,
                conversionEfficiency: 0.8,
                activationEnergy: 20,
                temperatureCoefficient: 0.05
            },
            'NO2→O3': {
                reactant: 'NO2',
                product: 'O3',
                rate: config.no2ToO3Rate || 0.005,
                conversionEfficiency: 0.6,
                lightDependent: true
            }
        };
        this.config = {
            enableReactions: config.enableReactions !== false,
            temperature: config.temperature || 25,
            lightIntensity: config.lightIntensity || 1
        };
    }

    setConfig(config) {
        Object.assign(this.config, config);
        if (config.so2ToSo4Rate !== undefined) {
            this.reactions['SO2→SO4'].rate = config.so2ToSo4Rate;
        }
        if (config.no2ToO3Rate !== undefined) {
            this.reactions['NO2→O3'].rate = config.no2ToO3Rate;
        }
    }

    getTemperatureCorrectedRate(baseRate, temperature) {
        const T = temperature || this.config.temperature;
        const dT = T - 25;
        return baseRate * (1 + dT * 0.02);
    }

    transform(concentrationField, dt = 0.1) {
        if (!this.config.enableReactions) return;

        const T = this.config.temperature;

        Object.values(this.reactions).forEach(reaction => {
            const { reactant, product, rate, conversionEfficiency, lightDependent } = reaction;
            
            if (!concentrationField.grid[reactant] || !concentrationField.grid[product]) return;

            const correctedRate = this.getTemperatureCorrectedRate(rate, T);
            const effectiveRate = lightDependent ? correctedRate * this.config.lightIntensity : correctedRate;

            for (let i = 0; i < concentrationField.rows; i++) {
                for (let j = 0; j < concentrationField.cols; j++) {
                    const reactantConc = concentrationField.getValue(reactant, i, j);
                    const productConc = concentrationField.getValue(product, i, j);

                    if (reactantConc > 0.001) {
                        const converted = reactantConc * effectiveRate * dt;
                        concentrationField.setValue(reactant, i, j, reactantConc - converted);
                        const newProduct = productConc + converted * conversionEfficiency;
                        concentrationField.setValue(product, i, j, newProduct * 0.995);
                    }
                }
            }
        });
    }
}

class AirQualitySimulator {
    constructor(config = {}) {
        this.speciesList = config.speciesList || ['SO2', 'SO4', 'NO2', 'PM25'];
        
        this.concentrationField = new ConcentrationField(
            config.rows || 15,
            config.cols || 20,
            this.speciesList
        );

        this.dispersion = new DispersionModel(config);
        this.chemistry = new ChemicalTransformation(config);

        this.emissionSources = config.emissionSources || [];
        this.simulationTime = 0;
        this.history = [];

        this.config = {
            gridSize: config.gridSize || 40,
            ...config
        };
    }

    addSource(source) {
        this.emissionSources.push({
            id: source.id || `source_${Date.now()}`,
            location: source.location || { x: 200, y: 300 },
            emissions: source.emissions || {},
            height: source.height || 80,
            active: source.active !== false
        });
    }

    removeSource(sourceId) {
        this.emissionSources = this.emissionSources.filter(s => s.id !== sourceId);
    }

    setWeather(weather) {
        this.dispersion.setConfig(weather);
        this.chemistry.setConfig({ temperature: weather.temperature });
    }

    step(dt = 0.1) {
        this.simulationTime += dt;

        this.dispersion.setConfig({
            sourceLocation: this.emissionSources.length > 0 
                ? this.emissionSources[0].location 
                : { x: 200, y: 300 },
            stackHeight: this.emissionSources.length > 0 
                ? this.emissionSources[0].height 
                : 80
        });

        this.speciesList.forEach(species => {
            const source = this.emissionSources.find(s => s.active && s.emissions[species]);
            if (source) {
                this.dispersion.simulatePointSource(
                    this.concentrationField, 
                    species, 
                    source.emissions[species],
                    dt
                );
            }
        });

        this.chemistry.transform(this.concentrationField, dt);
        this.concentrationField.updateStatistics();

        return this.getState();
    }

    getState() {
        return {
            time: this.simulationTime,
            weather: this.dispersion.config,
            concentrations: this.concentrationField.toJSON(),
            sources: this.emissionSources
        };
    }

    getSummary() {
        const summary = {
            time: this.simulationTime,
            weather: {
                windSpeed: this.dispersion.config.windSpeed,
                windDirection: this.dispersion.config.windDirection,
                stabilityClass: this.dispersion.config.stabilityClass,
                temperature: this.dispersion.config.temperature
            },
            species: {}
        };

        this.speciesList.forEach(species => {
            const stats = this.concentrationField.statistics[species];
            if (stats) {
                summary.species[species] = {
                    max: stats.max,
                    mean: stats.mean,
                    total: stats.total,
                    maxLocation: stats.maxLocation,
                    affectedCells: stats.affectedCells
                };
            }
        });

        return summary;
    }

    getHygroscopicInfo(speciesId, humidity) {
        const species = SPECIES[speciesId];
        if (!species) return null;

        const growthFactor = this.dispersion.calculateHygroscopicGrowth(humidity, speciesId);
        
        return {
            species: speciesId,
            name: species.name,
            type: species.gasParticle,
            hygroscopic: species.hygroscopic ? {
                deliquescenceRH: species.hygroscopic.deliquescenceRH,
                criticalRH: species.hygroscopic.criticalRH,
                currentGrowthFactor: growthFactor,
                isHygroscopic: true
            } : {
                isHygroscopic: false
            }
        };
    }

    reset() {
        this.simulationTime = 0;
        this.concentrationField = new ConcentrationField(
            this.config.rows || 15,
            this.config.cols || 20,
            this.speciesList
        );
        this.history = [];
    }
}

module.exports = {
    SPECIES,
    ConcentrationField,
    DispersionModel,
    ChemicalTransformation,
    AirQualitySimulator
};
