const wealthsimpleTradeDataSrc = 'activities_export';
const chartStartDate = '2021-02-22';
const chartYAxisStartsAtZero = false;
const useIntraday = false;

const blackBoxLogos = ['ASML', 'QQQ', 'PLTR', 'AMZN', 'SOXL', 'TQQQ', 'CURE', 'INTC', 'TMF', 'UBER', 'TSLL'];

const useAlphaVantageTickers = ['NA', 'XBAL', 'VFV', 'QQU', 'HUG', 'XEQT', 'ENB', 'RY', 'CDZ', 'XIU', 'ZFL', 'ZCS', 'ZEA', 'CASH', 'ZTL', 'XHD', 'XEF', 'QCN', 'ZHY', 'ZAG', 'ZCB', 'ZUAG', 'QUU', 'GLOV', 'GSWO'];

const alphaVantageSymbolByTicker = {
  NA: 'NA.TRT',
  XBAL: 'XBAL.TRT',
  VFV: 'VFV.TRT',
  QQU: 'QQU.TRT',
  HUG: 'HUG.TRT',
  XEQT: 'XEQT.TRT',
  ENB: 'ENB.TRT',
  RY: 'RY.TRT',
  CDZ: 'CDZ.TRT',
  XIU: 'XIU.TRT',
  ZFL: 'ZFL.TRT',
  ZCS: 'ZCS.TRT',
  ZEA: 'ZEA.TRT',
  CASH: 'CASH.TRT',
  ZTL: 'ZTL.TRT',
  XHD: 'XHD.TRT',
  XEF: 'XEF.TRT',
  QCN: 'QCN.TRT',
  ZHY: 'ZHY.TRT',
  ZAG: 'ZAG.TRT',
  ZCB: 'ZCB.TRT',
  ZUAG: 'ZUAG.TRT',
  QUU: 'QUU.TRT',
  GLOV: 'GLOV.TRT',
  GSWO: 'GSWO.TRT',
  AMZN: 'AMZN.TRT',
};

const yfinanceSymbolByTicker = {
  ZTL: 'ZTL-F.NE',
  GLOV: 'GSWO',
  GSWO: 'GWSO',
};

globalThis.FolioScoutConfig = {
  wealthsimpleTradeDataSrc,
  chartStartDate,
  chartYAxisStartsAtZero,
  useIntraday,
  blackBoxLogos,
  useAlphaVantageTickers,
  alphaVantageSymbolByTicker,
  yfinanceSymbolByTicker,
};

// Keep existing browser globals intact for older non-module scripts.
globalThis.blackBoxLogos = blackBoxLogos;
