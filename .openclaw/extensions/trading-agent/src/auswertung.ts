/**
 * auswertung — Ergebnis je Abschluss aus den echten IBKR-Ausführungen und
 * Monatsauswertung (Option B, Owner-Entscheidung 27.10.2026).
 *
 * Quelle sind die Fill-Events in `orders-v2.jsonl` (IBKR execDetails, je
 * Ausführung mit execId), nicht Schätzungen. Korrekturen von IBKR (gleiche
 * execIdBase, höherer Suffix) ersetzen die ältere Ausführung. Nur wenn eine
 * Position ohne Agenten-Exit verschwand (Glattstellung in der TWS), wird das
 * `position_closed`-Event verwendet — dann als „geschätzt“ gekennzeichnet.
 *
 * Zinsanteil: Die NLV ändert sich auch ohne Position (Zins auf rund 970.000 $
 * Cash). Getrennt ausgewiesen wird die Summe der NLV-Änderungen an Tagen, an
 * denen weder am Vortag noch am Tag eine Position offen war. „Offen“ ergibt
 * sich aus den Haltezeiten der Abschlüsse (Einstieg bis Ausstieg), nicht aus
 * `unrealizedPnl` — das blieb bis 24.10.2026 ohne Position stehen. Vor dem
 * letzten Ausstieg einer Altposition (vor orders-v2) ist nichts belegbar; ein
 * Einstieg ohne Ausstieg im Log gilt bis zum ersten Tag mit `unrealizedPnl` 0
 * als offen (vorsichtig: lieber Tage weglassen als Kursbewegung als Zins zählen).
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface Abschluss {
  tradeIntentId: string;
  symbol: string;
  currency: string;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPercent: number;
  entryTime: string;
  exitTime: string;
  /** stop | tp | fbclose | manuell | glattgestellt */
  exitReason: string;
  levelSource: "ki" | "standard" | "unbekannt";
  estimated: boolean;
}

export interface MonatsWerte {
  monat: string;
  abschluesse: number;
  gewinner: number;
  verlierer: number;
  trefferquote: number | null;
  /** je Währung */
  realisiert: Record<string, number>;
  durchschnittGewinn: Record<string, number>;
  durchschnittVerlust: Record<string, number>;
  groessterGewinn: { symbol: string; pnl: number; currency: string } | null;
  groessterVerlust: { symbol: string; pnl: number; currency: string } | null;
  jeLevelquelle: Record<string, { abschluesse: number; gewinner: number; realisiertUsd: number }>;
  jeAusstieg: Record<string, number>;
  nlvAenderung: number | null;
  ohnePositionNlv: number;
  ohnePositionTage: number;
}

export interface Auswertung {
  stand: string;
  abschluesse: Abschluss[];
  /** Einstieg ohne Ausstieg im Log; `beiIbkr` = Position laut IBKR noch vorhanden (wenn bekannt). */
  offen: Array<{ tradeIntentId: string; symbol: string; quantity: number; entryPrice: number; currency: string; entryTime: string; beiIbkr?: boolean }>;
  ohneEinstand: number;
  monate: MonatsWerte[];
  hinweise: string[];
}

interface Ereignis {
  type: string;
  timestamp: string;
  orderRef?: string;
  [k: string]: unknown;
}

interface PerfTag {
  date: string;
  unrealizedPnl: number;
  netLiquidation: number;
}

interface IntentZeile {
  tradeIntentId: string;
  levelSource: "ki" | "standard";
}

function teile(orderRef: string | undefined): { intent: string; leg: string } | null {
  const p = String(orderRef ?? "").split("|");
  if (p[0] !== "OCAGENT" || p.length < 6) return null;
  return { intent: p[2], leg: p[4] };
}

const runde = (x: number) => Math.round(x * 100) / 100;

export function auswerten(events: Ereignis[], perf: PerfTag[], intents: IntentZeile[], stand = new Date().toISOString(),
  gehalteneSymbole?: string[]): Auswertung {
  const hinweise: string[] = [];
  const levelQuelle = new Map(intents.map((i) => [i.tradeIntentId, i.levelSource]));

  // 1 Ausführungen: je execIdBase die jüngste Korrektur.
  const fills = new Map<string, Ereignis>();
  for (const e of events) {
    if (e.type !== "order_filled") continue;
    const base = String(e.execIdBase ?? e.execId ?? "");
    const alt = fills.get(base);
    if (!alt || String(e.execId) > String(alt.execId)) fills.set(base, e);
  }

  // 2 Stammdaten je Intent aus den platzierten Orders.
  const meta = new Map<string, { symbol: string; currency: string }>();
  for (const e of events) {
    if (e.type !== "order_submitted") continue;
    const t = teile(e.orderRef);
    if (t && !meta.has(t.intent)) meta.set(t.intent, { symbol: String(e.symbol ?? t.intent.split("-")[0]), currency: String(e.currency ?? "USD") });
  }

  // 3 Je Intent Einstieg und Ausstieg sammeln.
  type Lauf = { ein: number; einWert: number; einZeit: string; aus: number; ausWert: number; ausZeit: string; ausLegs: Set<string> };
  const laeufe = new Map<string, Lauf>();
  for (const f of [...fills.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    const t = teile(f.orderRef);
    if (!t) continue;
    const l = laeufe.get(t.intent) ?? { ein: 0, einWert: 0, einZeit: "", aus: 0, ausWert: 0, ausZeit: "", ausLegs: new Set<string>() };
    const menge = Number(f.shares) || 0;
    const kurs = Number(f.price) || 0;
    if (t.leg === "entry") {
      l.ein += menge; l.einWert += menge * kurs; l.einZeit ||= f.timestamp;
    } else {
      l.aus += menge; l.ausWert += menge * kurs; l.ausZeit = f.timestamp; l.ausLegs.add(t.leg);
    }
    laeufe.set(t.intent, l);
  }

  /* Ausstiege unter fremder Kennung: Die Guardian-Nachrüstung kann die Exits
     einer Position unter der Kennung einer älteren Position desselben Symbols
     platzieren (AIG, 08.10.2026). Solche Ausstiege ohne eigenen Einstieg werden
     dem offenen Einstieg desselben Symbols zugeordnet, der davor lag. */
  const symbolVon = (intent: string) => meta.get(intent)?.symbol ?? intent.split("-")[0];
  for (const [waise, w] of laeufe) {
    if (w.ein > 0 || w.aus === 0) continue;
    const kurs = w.ausWert / w.aus;
    for (const [ziel, z] of [...laeufe].sort((a, b) => a[1].einZeit.localeCompare(b[1].einZeit))) {
      if (w.aus <= 0) break;
      if (ziel === waise || z.ein === 0 || symbolVon(ziel) !== symbolVon(waise) || z.einZeit > w.ausZeit) continue;
      const menge = Math.min(z.ein - z.aus, w.aus);
      if (menge <= 0) continue;
      z.aus += menge; z.ausWert += menge * kurs; z.ausZeit = w.ausZeit > z.ausZeit ? w.ausZeit : z.ausZeit;
      for (const leg of w.ausLegs) z.ausLegs.add(leg);
      w.aus -= menge; w.ausWert -= menge * kurs;
    }
    if (w.aus <= 0) laeufe.delete(waise);
  }

  // Glattstellungen außerhalb des Agenten (position_closed), je Symbol chronologisch.
  const glatt = events.filter((e) => e.type === "position_closed").sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const verbraucht = new Set<Ereignis>();

  const abschluesse: Abschluss[] = [];
  const offen: Auswertung["offen"] = [];
  let ohneEinstand = 0;
  let letzterAltAusstieg = "";
  for (const [intent, l] of laeufe) {
    const m = meta.get(intent) ?? { symbol: intent.split("-")[0], currency: "USD" };
    if (l.ein === 0) { ohneEinstand++; if (l.ausZeit > letzterAltAusstieg) letzterAltAusstieg = l.ausZeit; continue; }
    const einstand = l.einWert / l.ein;
    const quelle = levelQuelle.get(intent) ?? "unbekannt";
    if (l.aus >= l.ein) {
      const ausKurs = l.ausWert / l.aus;
      const pnl = (ausKurs - einstand) * l.ein;
      const grund = l.ausLegs.has("stop") ? "stop" : l.ausLegs.has("tp") ? "tp" : l.ausLegs.has("fbclose") ? "fbclose" : [...l.ausLegs][0] ?? "?";
      abschluesse.push({ tradeIntentId: intent, symbol: m.symbol, currency: m.currency, quantity: l.ein, entryPrice: runde(einstand),
        exitPrice: runde(ausKurs), pnl: runde(pnl), pnlPercent: runde(((ausKurs - einstand) / einstand) * 100), entryTime: l.einZeit,
        exitTime: l.ausZeit, exitReason: grund, levelSource: quelle, estimated: false });
      continue;
    }
    // Rest ohne Agenten-Exit: wurde er außerhalb glattgestellt?
    const rest = l.ein - l.aus;
    const g = glatt.find((e) => !verbraucht.has(e) && e.symbol === m.symbol && e.timestamp >= l.einZeit);
    if (g) {
      verbraucht.add(g);
      const gKurs = Number(g.exitPrice) || 0;
      const ausWert = l.ausWert + rest * gKurs;
      const ausKurs = ausWert / l.ein;
      const pnl = (ausKurs - einstand) * l.ein;
      abschluesse.push({ tradeIntentId: intent, symbol: m.symbol, currency: m.currency, quantity: l.ein, entryPrice: runde(einstand),
        exitPrice: runde(ausKurs), pnl: runde(pnl), pnlPercent: runde(((ausKurs - einstand) / einstand) * 100), entryTime: l.einZeit,
        exitTime: g.timestamp, exitReason: g.source === "manual" ? "manuell" : "glattgestellt", levelSource: quelle,
        /* Kurs aus IBKR-Ausführung nur, wenn das Event ihn nicht als geschätzt markiert. */
        estimated: g.estimated === true || g.source === "sentinel" && g.estimated !== false });
      continue;
    }
    offen.push({ tradeIntentId: intent, symbol: m.symbol, quantity: rest, entryPrice: runde(einstand), currency: m.currency, entryTime: l.einZeit,
      ...(gehalteneSymbole ? { beiIbkr: gehalteneSymbole.includes(m.symbol) } : {}) });
  }
  const verschwunden = offen.filter((o) => o.beiIbkr === false);
  if (verschwunden.length) {
    hinweise.push(`${verschwunden.length} Position(en) ohne Ausstieg im Log, bei IBKR nicht mehr vorhanden (${verschwunden.map((o) => o.symbol).join(", ")}) — Ergebnis unbekannt, nicht gewertet`);
  }
  if (ohneEinstand) hinweise.push(`${ohneEinstand} Ausstieg(e) ohne Einstieg im Log (Positionen aus der Zeit vor orders-v2, 12.06.2026) — nicht gewertet`);
  abschluesse.sort((a, b) => a.exitTime.localeCompare(b.exitTime));

  // 4 Monate.
  const fillTage = new Set([...fills.values()].map((f) => f.timestamp.slice(0, 10)));
  const tage = [...perf].sort((a, b) => a.date.localeCompare(b.date));
  const monate = new Map<string, MonatsWerte>();
  const monat = (k: string): MonatsWerte => {
    let w = monate.get(k);
    if (!w) {
      w = { monat: k, abschluesse: 0, gewinner: 0, verlierer: 0, trefferquote: null, realisiert: {}, durchschnittGewinn: {}, durchschnittVerlust: {},
        groessterGewinn: null, groessterVerlust: null, jeLevelquelle: {}, jeAusstieg: {}, nlvAenderung: null, ohnePositionNlv: 0, ohnePositionTage: 0 };
      monate.set(k, w);
    }
    return w;
  };
  const summen = new Map<string, { gew: Record<string, number[]>; ver: Record<string, number[]> }>();
  for (const a of abschluesse) {
    const w = monat(a.exitTime.slice(0, 7));
    const s = summen.get(w.monat) ?? { gew: {}, ver: {} };
    w.abschluesse++;
    if (a.pnl > 0) { w.gewinner++; (s.gew[a.currency] ??= []).push(a.pnl); } else { w.verlierer++; (s.ver[a.currency] ??= []).push(a.pnl); }
    w.realisiert[a.currency] = runde((w.realisiert[a.currency] ?? 0) + a.pnl);
    if (!w.groessterGewinn || a.pnl > w.groessterGewinn.pnl) w.groessterGewinn = { symbol: a.symbol, pnl: a.pnl, currency: a.currency };
    if (!w.groessterVerlust || a.pnl < w.groessterVerlust.pnl) w.groessterVerlust = { symbol: a.symbol, pnl: a.pnl, currency: a.currency };
    const q = (w.jeLevelquelle[a.levelSource] ??= { abschluesse: 0, gewinner: 0, realisiertUsd: 0 });
    q.abschluesse++; if (a.pnl > 0) q.gewinner++; if (a.currency === "USD") q.realisiertUsd = runde(q.realisiertUsd + a.pnl);
    w.jeAusstieg[a.exitReason] = (w.jeAusstieg[a.exitReason] ?? 0) + 1;
    summen.set(w.monat, s);
  }
  for (const [k, s] of summen) {
    const w = monate.get(k)!;
    w.trefferquote = w.abschluesse ? runde((w.gewinner / w.abschluesse) * 100) : null;
    for (const [c, xs] of Object.entries(s.gew)) w.durchschnittGewinn[c] = runde(xs.reduce((x, y) => x + y, 0) / xs.length);
    for (const [c, xs] of Object.entries(s.ver)) w.durchschnittVerlust[c] = runde(xs.reduce((x, y) => x + y, 0) / xs.length);
  }
  // Haltezeiten: Tage mit offener Position (Datum JJJJ-MM-TT, beide Enden eingeschlossen).
  const belegt: Array<[string, string]> = abschluesse.map((a) => [a.entryTime.slice(0, 10), a.exitTime.slice(0, 10)]);
  for (const o of offen) {
    const ab = o.entryTime.slice(0, 10);
    const ende = o.beiIbkr === true ? "9999-12-31" : tage.find((t) => t.date > ab && t.unrealizedPnl === 0)?.date ?? "9999-12-31";
    belegt.push([ab, ende]);
  }
  const frei = (d: string) => d > letzterAltAusstieg.slice(0, 10) && !belegt.some(([von, bis]) => d >= von && d <= bis);
  const beginn = events.length ? events.map((e) => e.timestamp).sort()[0].slice(0, 10) : "9999-12-31";
  for (let i = 1; i < tage.length; i++) {
    const vor = tage[i - 1]; const tag = tage[i];
    if (vor.date < beginn) continue;
    const w = monat(tag.date.slice(0, 7));
    if (frei(vor.date) && frei(tag.date) && !fillTage.has(tag.date) && vor.netLiquidation > 0 && tag.netLiquidation > 0) {
      w.ohnePositionNlv = runde(w.ohnePositionNlv + (tag.netLiquidation - vor.netLiquidation));
      w.ohnePositionTage++;
    }
  }
  // NLV-Änderung je Monat: letzter Tag des Monats gegen letzten Tag davor.
  const letzter = new Map<string, PerfTag>();
  for (const t of tage) if (t.netLiquidation > 0) letzter.set(t.date.slice(0, 7), t);
  const keys = [...letzter.keys()].sort();
  for (let i = 1; i < keys.length; i++) monat(keys[i]).nlvAenderung = runde(letzter.get(keys[i])!.netLiquidation - letzter.get(keys[i - 1])!.netLiquidation);

  return { stand, abschluesse, offen, ohneEinstand, monate: [...monate.values()].sort((a, b) => a.monat.localeCompare(b.monat)), hinweise };
}

function jsonl(pfad: string): any[] {
  if (!existsSync(pfad)) return [];
  return readFileSync(pfad, "utf8").split("\n").filter(Boolean).map((z) => { try { return JSON.parse(z); } catch { return null; } }).filter(Boolean);
}

/** Liest orders-v2.jsonl, performance/*.json und trade-intents.jsonl aus dem Datenordner. */
export function ladeAuswertung(base: string, gehalteneSymbole?: string[]): Auswertung {
  const perfDir = join(base, "performance");
  const perf: PerfTag[] = existsSync(perfDir)
    ? readdirSync(perfDir).filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
      .flatMap((f) => { try { return JSON.parse(readFileSync(join(perfDir, f), "utf8")); } catch { return []; } })
    : [];
  return auswerten(jsonl(join(base, "orders-v2.jsonl")), perf, jsonl(join(base, "trade-intents.jsonl")), new Date().toISOString(), gehalteneSymbole);
}
