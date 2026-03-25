// Static index constituent lists — fallback when IBKR scanner is unavailable.

export const DAX40_SYMBOLS = [
  "ADS", "AIR", "ALV", "BAS", "BAYN", "BEI", "BMW", "BNR", "CBK", "CON",
  "1COV", "DB1", "DBK", "DHL", "DTE", "DTG", "ENR", "FRE", "HEI", "HEN3",
  "HNR1", "IFX", "MBG", "MRK", "MTX", "MUV2", "P911", "PAH3", "QIA", "RHM",
  "RWE", "SAP", "SHL", "SIE", "SRT3", "SY1", "VNA", "VOW3", "ZAL", "HFG",
];

export const MDAX_SYMBOLS = [
  "AAD", "ACX", "AFX", "AM3D", "BC8", "BOSS", "COP", "DEQ", "EVD", "EVK",
  "EVT", "FPE3", "GBF", "GXI", "HAB", "HBH", "HLE", "HOT", "JEN", "KGX",
  "LEG", "LXS", "NDA", "NEM", "PBB", "PNE", "RAA", "SDF", "SHA", "SMHN",
  "SNH", "SOW", "SZG", "TEG", "TKA", "TLX", "UN01", "WAF", "WCH", "ZIL2",
];

export const SP500_TOP100 = [
  "AAPL", "ABBV", "ABT", "ACN", "ADBE", "AIG", "AMD", "AMGN", "AMZN", "AVGO",
  "AXP", "BA", "BAC", "BLK", "BMY", "BRK.B", "C", "CAT", "CHTR", "CL",
  "CMCSA", "COF", "COP", "COST", "CRM", "CSCO", "CVS", "CVX", "DE", "DHR",
  "DIS", "DUK", "EMR", "EXC", "F", "FDX", "GD", "GE", "GILD", "GM",
  "GOOG", "GOOGL", "GS", "HD", "HON", "IBM", "INTC", "INTU", "ISRG", "JNJ",
  "JPM", "KO", "LIN", "LLY", "LMT", "LOW", "MA", "MCD", "MDLZ", "MDT",
  "MET", "META", "MMM", "MO", "MRK", "MS", "MSFT", "NEE", "NFLX", "NKE",
  "NOW", "NVDA", "ORCL", "PEP", "PFE", "PG", "PM", "PYPL", "QCOM", "RTX",
  "SBUX", "SCHW", "SO", "SPG", "T", "TGT", "TMO", "TMUS", "TXN", "UNH",
  "UNP", "UPS", "USB", "V", "VZ", "WBA", "WFC", "WMT", "XOM", "ZTS",
];

export const NASDAQ100_TOP50 = [
  "AAPL", "ABNB", "ADBE", "ADI", "ADP", "ADSK", "AEP", "AMAT", "AMD", "AMGN",
  "AMZN", "ANSS", "ARM", "ASML", "AVGO", "AZN", "BIIB", "BKNG", "BKR", "CDNS",
  "CEG", "CHTR", "CMCSA", "COST", "CPRT", "CRWD", "CSCO", "CTAS", "CTSH", "DDOG",
  "DLTR", "DXCM", "EA", "EXC", "FANG", "FAST", "FTNT", "GEHC", "GFS", "GILD",
  "GOOG", "GOOGL", "HON", "IDXX", "ILMN", "INTC", "INTU", "ISRG", "KDP", "KHC",
];

export const CONSTITUENT_MAP: Record<string, string[]> = {
  DAX40: DAX40_SYMBOLS,
  MDAX: MDAX_SYMBOLS,
  SP500: SP500_TOP100,
  NASDAQ100: NASDAQ100_TOP50,
};
