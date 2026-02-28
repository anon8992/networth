let _pendingZoneUpdate = null;
let _zoneRafId = null;
let _pendingPointerHover = null;
let _pointerHoverRafId = null;
let _lastFallbackHoverIndex = null;
let _lastPointerState = null;
const ZONE_SPLIT_STEP_PX = 8;
const SERIES_ANIMATION_DURATION_MS = 860;
let _suppressAutoHeaderResetUntilMs = 0;
const MOUNTAIN_TIME_ZONE = 'America/Denver';
const INTERVAL_MS_BY_STOCK_INTERVAL = {
    fivemin: 5 * 60 * 1000,
    quarterhourly: 15 * 60 * 1000,
    semihourly: 30 * 60 * 1000,
    hourly: 60 * 60 * 1000
};

function tightenMeridiem(text) {
    return String(text).replace(/\s+(AM|PM)$/i, '$1');
}

function formatMountainDateTime(epochMs) {
    return tightenMeridiem(new Intl.DateTimeFormat('en-US', {
        timeZone: MOUNTAIN_TIME_ZONE,
        month: 'short',
        day: '2-digit',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    }).format(epochMs));
}

function formatMountainTime(epochMs) {
    return tightenMeridiem(new Intl.DateTimeFormat('en-US', {
        timeZone: MOUNTAIN_TIME_ZONE,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    }).format(epochMs));
}

function formatMountainDay(epochMs) {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: MOUNTAIN_TIME_ZONE,
        month: 'short',
        day: 'numeric'
    }).format(epochMs);
}

function getMountainDayKey(epochMs) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: MOUNTAIN_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(epochMs);
    const map = {};
    for (const part of parts) {
        if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
            map[part.type] = part.value;
        }
    }
    return `${map.year}-${map.month}-${map.day}`;
}

function buildIntradayDayTickPositions(dataPoints) {
    if (!Array.isArray(dataPoints) || dataPoints.length === 0) return [];
    const ticks = [];
    let lastDayKey = '';

    for (let i = 0; i < dataPoints.length; i++) {
        const ms = dataPoints[i]?.date;
        if (!Number.isFinite(ms)) continue;
        const dayKey = getMountainDayKey(ms);
        if (dayKey !== lastDayKey) {
            ticks.push(ms);
            lastDayKey = dayKey;
        }
    }
    return ticks;
}

function downsampleTickPositions(ticks, maxTickCount) {
    if (!Array.isArray(ticks) || ticks.length <= maxTickCount) return ticks || [];
    if (!Number.isFinite(maxTickCount) || maxTickCount < 2) return [ticks[0], ticks[ticks.length - 1]];

    const picked = [];
    const seen = new Set();
    const lastIndex = ticks.length - 1;

    for (let i = 0; i < maxTickCount; i++) {
        const idx = Math.round((i * lastIndex) / (maxTickCount - 1));
        const value = ticks[idx];
        if (!seen.has(value)) {
            picked.push(value);
            seen.add(value);
        }
    }

    if (!seen.has(ticks[lastIndex])) picked.push(ticks[lastIndex]);
    return picked;
}

function buildIntradayAxisBreaks(dataPoints, intervalKey) {
    if (!Array.isArray(dataPoints) || dataPoints.length < 2) return [];
    const expectedIntervalMs = INTERVAL_MS_BY_STOCK_INTERVAL[intervalKey];
    if (!Number.isFinite(expectedIntervalMs) || expectedIntervalMs <= 0) return [];

    const breaks = [];
    for (let i = 1; i < dataPoints.length; i++) {
        const prev = dataPoints[i - 1]?.date;
        const curr = dataPoints[i]?.date;
        if (!Number.isFinite(prev) || !Number.isFinite(curr) || curr <= prev) continue;

        if ((curr - prev) > (expectedIntervalMs * 1.5)) {
            const from = prev + 1;
            const to = curr - 1;
            if (to > from) breaks.push({ from, to, breakSize: 0 });
        }
    }
    return breaks;
}

function resetZoneRuntimeState() {
    if (_zoneRafId) {
        cancelAnimationFrame(_zoneRafId);
        _zoneRafId = null;
    }
    _pendingZoneUpdate = null;
    AppState.lastNetWorthSeriesStyleKey = null;
}

function resetPointerHoverRuntimeState() {
    if (_pointerHoverRafId) {
        cancelAnimationFrame(_pointerHoverRafId);
        _pointerHoverRafId = null;
    }
    _pendingPointerHover = null;
    _lastFallbackHoverIndex = null;
    _lastPointerState = null;
}

function findClosestDataPointIndex(targetDateMs) {
    const points = AppState.dataPoints;
    if (!Array.isArray(points) || !points.length || !Number.isFinite(targetDateMs)) return -1;

    let lo = 0;
    let hi = points.length - 1;

    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (points[mid].date < targetDateMs) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }

    if (lo <= 0) return 0;
    const prevIdx = lo - 1;
    const currIdx = lo;
    const prevDist = Math.abs(points[prevIdx].date - targetDateMs);
    const currDist = Math.abs(points[currIdx].date - targetDateMs);
    return currDist < prevDist ? currIdx : prevIdx;
}

function syncHoverFromPointerPosition(pointerState) {
    if (!pointerState || !AppState.chart || !AppState.dataPoints.length) return;

    const chartRef = AppState.chart;
    if (chartRef.hoverPoint) {
        _lastFallbackHoverIndex = chartRef.hoverPoint.index;
        return;
    }
    const xAxis = chartRef.xAxis?.[0];
    if (!xAxis || !chartRef.pointer) return;

    const normalized = chartRef.pointer.normalize({
        pageX: pointerState.pageX,
        pageY: pointerState.pageY,
        target: pointerState.target || chartRef.container
    });

    if (!normalized) return;

    const inPlotX = normalized.chartX >= chartRef.plotLeft && normalized.chartX <= (chartRef.plotLeft + chartRef.plotWidth);
    const inPlotY = normalized.chartY >= chartRef.plotTop && normalized.chartY <= (chartRef.plotTop + chartRef.plotHeight);
    if (!inPlotX || !inPlotY) return;

    const nearestPoint = AppState.netWorthSeries?.searchPoint?.(normalized, true);
    if (nearestPoint) {
        const samePointHovered =
            chartRef.hoverPoint &&
            chartRef.hoverPoint.series === nearestPoint.series &&
            chartRef.hoverPoint.index === nearestPoint.index;

        if (!samePointHovered && typeof nearestPoint.onMouseOver === 'function') {
            nearestPoint.onMouseOver();
        }
        _lastFallbackHoverIndex = nearestPoint.index;
        return;
    }

    const hoveredDateMs = xAxis.toValue(normalized.chartX, true);
    const fallbackIndex = findClosestDataPointIndex(hoveredDateMs);
    if (fallbackIndex < 0 || fallbackIndex === _lastFallbackHoverIndex) return;
    _lastFallbackHoverIndex = fallbackIndex;

    const fallbackPoint = AppState.netWorthSeries?.points?.find?.((p) => p?.index === fallbackIndex);
    if (fallbackPoint && typeof fallbackPoint.onMouseOver === 'function') {
        fallbackPoint.onMouseOver();
        return;
    }

    if (typeof updateHeader === 'function') {
        const defaultSeriesName = typeof getDefaultHeaderSeriesName === 'function'
            ? getDefaultHeaderSeriesName()
            : 'Net worth';
        updateHeader(fallbackIndex, defaultSeriesName);
    }

    if (AppState.currentView !== 'portfolio' && typeof window.updateSelectedHoldingMetricsByDateStr === 'function') {
        const dateStr = AppState.dataPoints[fallbackIndex]?.dateStr;
        window.updateSelectedHoldingMetricsByDateStr(dateStr);
    }
}

function queuePointerHoverSync(event) {
    if (!event || !Number.isFinite(event.pageX) || !Number.isFinite(event.pageY)) return;
    if (!AppState.chart) return;

    _lastPointerState = {
        pageX: event.pageX,
        pageY: event.pageY,
        target: event.target
    };

    if (AppState.chart.hoverPoint) {
        _lastFallbackHoverIndex = AppState.chart.hoverPoint.index;
        _pendingPointerHover = null;
        return;
    }

    _pendingPointerHover = _lastPointerState;

    if (_pointerHoverRafId) return;
    _pointerHoverRafId = requestAnimationFrame(() => {
        _pointerHoverRafId = null;
        const pending = _pendingPointerHover;
        _pendingPointerHover = null;
        syncHoverFromPointerPosition(pending);
    });
}

function queueHoverResyncFromLastPointer() {
    if (!AppState.chart || !_lastPointerState || AppState.chart.hoverPoint) return;

    _pendingPointerHover = _lastPointerState;
    if (_pointerHoverRafId) return;

    _pointerHoverRafId = requestAnimationFrame(() => {
        _pointerHoverRafId = null;
        const pending = _pendingPointerHover;
        _pendingPointerHover = null;
        syncHoverFromPointerPosition(pending);
    });
}

function isAutoHeaderResetSuppressed() {
    return Date.now() < _suppressAutoHeaderResetUntilMs;
}

function setNetWorthSeriesZones(splitLocation, firstColor, secondColor) {
    if (!AppState.chart || !AppState.netWorthSeries) return;
    if (isAutoHeaderResetSuppressed()) return;

    let effectiveSplitLocation = splitLocation;
    const axis = AppState.chart.xAxis?.[0];
    if (effectiveSplitLocation != null && axis) {
        const splitPx = axis.toPixels(effectiveSplitLocation, true);
        if (Number.isFinite(splitPx)) {
            const snappedPx = Math.round(splitPx / ZONE_SPLIT_STEP_PX) * ZONE_SPLIT_STEP_PX;
            const snappedValue = axis.toValue(snappedPx, true);
            if (Number.isFinite(snappedValue)) effectiveSplitLocation = snappedValue;
        }
    }

    const splitPart = effectiveSplitLocation == null ? 'all' : Math.round(effectiveSplitLocation);
    const styleKey = splitPart + '|' + firstColor + '|' + secondColor;

    if (AppState.lastNetWorthSeriesStyleKey === styleKey) return;
    AppState.lastNetWorthSeriesStyleKey = styleKey;

    _pendingZoneUpdate = { splitLocation: effectiveSplitLocation, firstColor, secondColor };

    if (!_zoneRafId) {
        _zoneRafId = requestAnimationFrame(flushZoneUpdate);
    }
}

function flushZoneUpdate() {
    _zoneRafId = null;
    const pending = _pendingZoneUpdate;
    if (!pending || !AppState.chart || !AppState.netWorthSeries) return;
    _pendingZoneUpdate = null;

    const { splitLocation, firstColor, secondColor } = pending;

    let zones;
    if (splitLocation == null) {
        zones = [{ color: secondColor }];
    } else {
        zones = [
            { value: splitLocation, color: firstColor },
            { color: secondColor }
        ];
    }

    AppState.netWorthSeries.update({
        animation: false,
        zoneAxis: 'x',
        zones: zones,
        color: secondColor
    }, false);

    AppState.chart.redraw(false);
    queueHoverResyncFromLastPointer();
}

function setLockednetWorthSeriesColor(color) {
    AppState.lockednetWorthSeriesColor = color;
    setNetWorthSeriesZones(null, color, color);
}

function clearNetWorthSeriesSplit() {
    setNetWorthSeriesZones(null, AppState.lockednetWorthSeriesColor, AppState.lockednetWorthSeriesColor);
}

function createChart(options = {}) {
    resetZoneRuntimeState();
    resetPointerHoverRuntimeState();
    const animateSeries = options?.animateSeries !== false;
    const initialXAxisMin = Number.isFinite(options?.initialXAxisMin) ? options.initialXAxisMin : undefined;
    const initialXAxisMax = Number.isFinite(options?.initialXAxisMax) ? options.initialXAxisMax : undefined;
    _suppressAutoHeaderResetUntilMs = animateSeries ? (Date.now() + SERIES_ANIMATION_DURATION_MS + 40) : 0;

    const netData = AppState.dataPoints.map(point => [point.date, point.netWorth]);
    const contributionsData = AppState.dataPoints.map(point => [point.date, point.contribution]);
    const forceYAxisZero = globalThis.FolioScoutConfig?.chartYAxisStartsAtZero === true;
    const yAxisConfig = {
        gridLineWidth: 0,
        labels: { style: { color: '#999' } },
        lineColor: '#999',
        title: { text: null }
    };
    if (forceYAxisZero) yAxisConfig.min = 0;

    const isStock = AppState.currentView !== 'portfolio';
    const mainSeriesName = isStock ? AppState.currentView : 'Net worth';
    const initialNetWorthColor = AppState.lockednetWorthSeriesColor || COLORS.GREEN;
    const isIntradayInterval = ['fivemin', 'quarterhourly', 'semihourly', 'hourly'].includes(AppState.activeStockInterval);
    const shouldShowIntradayTime = isStock && isIntradayInterval;
    const shouldUseIntradayDayTicks = shouldShowIntradayTime && ['1w', '1m', '3m'].includes(AppState.activeRange);
    const intradayAxisBreaks = shouldShowIntradayTime
        ? buildIntradayAxisBreaks(AppState.dataPoints, AppState.activeStockInterval)
        : [];
    const intradayDayTickPositions = shouldUseIntradayDayTicks
        ? buildIntradayDayTickPositions(AppState.dataPoints)
        : [];
    const xAxisDateTimeLabelFormats = shouldShowIntradayTime
        ? {
            minute: '%I:%M %p',
            hour: '%I:%M %p',
            day: '%b %d',
            month: '%b \'%y',
            year: '%Y'
        }
        : {
            month: '%b \'%y',
            year: '%Y'
        };
    const xAxisUnits = shouldShowIntradayTime
        ? [
            ['minute', [5, 15, 30]],
            ['hour', [1, 2, 4, 8, 12, 24, 48]]
        ]
        : [
            ['month', [1, 3, 6]],
            ['year', [1]]
        ];

    AppState.chart = Highcharts.chart('container', {
        chart: {
            type: 'line',
            zooming: {
                type: 'x',
                mouseWheel: { enabled: false }
            },
            animation: false,
            events: {
                selection: function (event) {
                    if (event?.resetSelection) {
                        // Keep visual floor from config when user hits "Reset zoom".
                        setTimeout(() => {
                            void setRange('all');
                            resetHeader();
                        }, 0);
                        return false;
                    }
                    if (event?.xAxis?.[0]) {
                        calculateAndShowZoomStats(event.xAxis[0].min, event.xAxis[0].max);
                    }
                    return true;
                }
            },
            resetZoomButton: {
                position: {
                    align: 'right',
                    verticalAlign: 'top',
                    x: 6,
                    y: -8
                },
                theme: {
                    fill: '#ffffff',
                    r: 12,
                    width: 70,
                    height: 10,
                    stroke: '#cccccc',
                    strokeWidth: 1,
                    style: {
                        lineHeight: '40px',
                    }
                }
            },
        },
        title: { text: '' },
        credits: { enabled: false },
        xAxis: {
            type: 'datetime',
            minRange: 1,
            min: initialXAxisMin,
            max: initialXAxisMax,
            tickAmount: shouldUseIntradayDayTicks ? undefined : 5,
            labels: shouldShowIntradayTime
                ? {
                    style: { color: '#999' },
                    formatter: function () {
                        if (shouldUseIntradayDayTicks) return formatMountainDay(this.value);
                        return formatMountainTime(this.value);
                    }
                }
                : {
                    style: { color: '#999' },
                },
            events: {
                afterSetExtremes: function () {
                    setTimeout(() => {
                        if (isAutoHeaderResetSuppressed()) return;
                        if (!this?.chart?.hoverPoint) resetHeader();
                    }, 0);
                }
            },
            dateTimeLabelFormats: xAxisDateTimeLabelFormats,
            units: xAxisUnits,
            breaks: intradayAxisBreaks,
            tickPositioner: shouldUseIntradayDayTicks
                ? function (min, max) {
                    const ticks = [];
                    for (let i = 0; i < intradayDayTickPositions.length; i++) {
                        const tick = intradayDayTickPositions[i];
                        if (tick >= min && tick <= max) ticks.push(tick);
                    }
                    const cappedTicks = downsampleTickPositions(ticks, 7);
                    if (cappedTicks.length) return cappedTicks;
                    if (!ticks.length) {
                        if (Number.isFinite(min)) ticks.push(min);
                        if (Number.isFinite(max) && max !== min) ticks.push(max);
                    }
                    return ticks;
                }
                : undefined,
            lineColor: '#999',
            crosshair: {
                width: 1.5,
                color: COLORS.CROSSHAIR,
                label: {
                    enabled: true,
                    backgroundColor: '#525252ff',
                    style: {
                        color: 'white',
                        fontWeight: 'bold'
                    },
                    formatter: function (value) {
                        if (shouldShowIntradayTime) return formatMountainDateTime(value);
                        return Highcharts.dateFormat('%b %d, %Y', value);
                    }
                },
            }
        },
        yAxis: yAxisConfig,
        legend: { layout: 'horizontal', align: 'right', verticalAlign: 'top' },
        tooltip: {
            enabled: false
        },
        plotOptions: {
            series: {
                animation: animateSeries ? { duration: SERIES_ANIMATION_DURATION_MS } : false,
                findNearestPointBy: 'x',
                marker: {
                    enabled: false,
                    states: { hover: { enabled: true, radius: 4 } }
                },
                states: {
                    hover: { lineWidthPlus: 0 },
                    inactive: { opacity: 0.4 }
                },
                events: {
                    legendItemClick: function() {
                        setTimeout(resetHeader, 0);
                        return true;
                    }
                },
                point: {
                    events: {
                        mouseOver: function() {
                            if (resetHeadlineTimeoutId) {
                                clearTimeout(resetHeadlineTimeoutId);
                                resetHeadlineTimeoutId = null;
                            }
                            _lastFallbackHoverIndex = this.index;
                            updateHeader(this.index, this.series.name);
                            if (AppState.currentView !== 'portfolio' && typeof window.updateSelectedHoldingMetricsByDateStr === 'function') {
                                const dateStr = AppState.dataPoints[this.index]?.dateStr;
                                window.updateSelectedHoldingMetricsByDateStr(dateStr);
                            }
                        },
                        mouseOut: function() {
                            resetHeadlineTimeoutId = setTimeout(() => {
                                const chartRef = this.series?.chart;
                                if (!chartRef?.hoverPoint) {
                                    resetHeader();
                                    if (AppState.currentView !== 'portfolio' && typeof window.resetSelectedHoldingMetricsToLatest === 'function') {
                                        window.resetSelectedHoldingMetricsToLatest();
                                    }
                                }
                            }, 24);
                        }
                    }
                }
            }
        },
        series: isStock
            ? [{ name: mainSeriesName, data: netData, color: initialNetWorthColor, lineWidth: 2, zIndex: 2 }]
            : [
                { name: mainSeriesName, data: netData, color: initialNetWorthColor, lineWidth: 2, zIndex: 2 },
                { name: 'Contributions', data: contributionsData, color: COLORS.GOLD, lineWidth: 1.5, zIndex: 1, visible: false }
            ],
        responsive: {
            rules: [{
                condition: { maxWidth: 500 },
                chartOptions: {
                    legend: { align: 'center', verticalAlign: 'bottom' }
                }
            }]
        }
    });

    AppState.netWorthSeries = AppState.chart.series[0];

    AppState.chart.container.addEventListener('mousemove', queuePointerHoverSync);

    AppState.chart.container.addEventListener('mouseleave', resetHeader);
    AppState.chart.container.addEventListener('mouseleave', () => {
        resetPointerHoverRuntimeState();
        if (AppState.currentView !== 'portfolio' && typeof window.resetSelectedHoldingMetricsToLatest === 'function') {
            window.resetSelectedHoldingMetricsToLatest();
        }
    });

    const chartRef = AppState.chart;
    if (animateSeries) {
        setTimeout(() => {
            if (AppState.chart !== chartRef) return;
            _suppressAutoHeaderResetUntilMs = 0;
            resetHeader();
        }, SERIES_ANIMATION_DURATION_MS + 40);
    } else {
        _suppressAutoHeaderResetUntilMs = 0;
        resetHeader();
    }
    initRangeSelector();
    updateRangeButtons(AppState.activeRange || 'all');
}

function initHoldingsPanelPlotSync(chartRef) {
    const holdingsPanel = document.getElementById('holdingsPanel');
    if (!holdingsPanel || !chartRef) return;

    let lastTop = null;
    let lastHeight = null;

    const update = () => {
        const plotTop = Math.max(0, Math.round(chartRef.plotTop || 0));
        const plotHeight = Math.max(0, Math.round(chartRef.plotHeight || 0));

        if (plotTop === lastTop && plotHeight === lastHeight) return;
        lastTop = plotTop;
        lastHeight = plotHeight;

        holdingsPanel.style.setProperty('--chart-plot-top', `${plotTop}px`);
        holdingsPanel.style.setProperty('--chart-plot-height', `${plotHeight}px`);

        document.documentElement.style.setProperty('--chart-plot-top', `${plotTop}px`);
        document.documentElement.style.setProperty('--chart-plot-height', `${plotHeight}px`);
    };

    update();

    if (typeof ResizeObserver === 'undefined') {
        window.addEventListener('resize', () => requestAnimationFrame(update), { passive: true });
        return;
    }

    const observer = new ResizeObserver(() => requestAnimationFrame(update));
    observer.observe(chartRef.renderTo);
}

function calculateAndShowZoomStats(minDate, maxDate) {
    let startIndex = AppState.dataPoints.findIndex(p => p.date >= minDate);
    let endIndex = -1;

    for(let i = AppState.dataPoints.length - 1; i >= 0; i--) {
        if (AppState.dataPoints[i].date <= maxDate) {
            endIndex = i;
            break;
        }
    }

    if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) return;

    const startPoint = AppState.dataPoints[startIndex];
    const endPoint = AppState.dataPoints[endIndex];

    const rangeTWRR = calculateTWRR(startIndex, endIndex);

    const valChange = endPoint.netWorth - startPoint.netWorth;
    const contributionsChange = endPoint.contribution - startPoint.contribution;
    const rangeGain = valChange - contributionsChange;

    const gainSign = rangeGain >= 0 ? '+' : '-';
    const twrrSign = rangeTWRR >= 0 ? '+' : '';
    const safeTwrr = Number.isFinite(rangeTWRR) ? rangeTWRR : 0;
    const color = safeTwrr < 0 ? COLORS.RED : COLORS.GREEN;

    UI.headline.style.color = color;
    setLockednetWorthSeriesColor(color);

    animateDisplay(`$${formatNumber(endPoint.netWorth)}`);
    UI.gain.textContent = `${gainSign}$${formatNumber(Math.abs(rangeGain))} (${twrrSign}${rangeTWRR.toFixed(2)}%)`;
}
