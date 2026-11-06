import history from "../data/zanngo-history.json";
import { RandomForestRegressor, type Sample } from "./forecast";

type HistoryItem = {
  item: string;
  desc: string;
  mega: string;
  cat: string;
  sub: string;
  unid: string;
  clientes: number;
  series: Record<string, [number, number][]>;
};

type HistoryClient = {
  nit: string;
  orders: number;
  units: number;
  first: string;
  last: string;
  avgInterval: number | null;
  distinctItems: number;
  top: [string, number][];
};

type History = {
  meta: {
    rows: number;
    from: string;
    to: string;
    byTipoDoc: Record<string, number>;
    items: number;
    clients: number;
  };
  dates: string[];
  items: HistoryItem[];
  clients: HistoryClient[];
};

const data = history as unknown as History;

export type CatalogProduct = {
  id: string;
  nombre: string;
  precioBase: number;
  tax: number;
  existencia: number;
  categoria: string | null;
  proveedor: string | null;
};

export type OperationParams = {
  leadTimeDays: number;
  moq: number;
  safetyDays: number;
  overrides?: Record<string, { leadTimeDays?: number; moq?: number; safetyDays?: number }>;
};

export type PlanFilters = {
  tipoDoc: "FAC" | "NET" | "ALL";
  mega?: string | null;
  cat?: string | null;
};

const HORIZON = 30;
const DAY = 86400000;

function norm(name: string): string {
  return name.trim().toUpperCase().replace(/\s+/g, " ");
}

function dayMs(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function tipoWeights(tipoDoc: PlanFilters["tipoDoc"]): Record<string, number> {
  if (tipoDoc === "FAC") return { FAC: 1 };
  if (tipoDoc === "NET") return { FAC: 1, NCR: -1, NDM: 1, CFE: 1 };
  return { FAC: 1, NCR: 1, NDM: 1, CFE: 1 };
}

/** Serie diaria (indexada por posición en data.dates) con los pesos por Tipo_Doc. */
function dailyOf(item: HistoryItem, weights: Record<string, number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const [tipo, w] of Object.entries(weights)) {
    for (const [idx, qty] of item.series[tipo] ?? []) {
      out.set(idx, (out.get(idx) ?? 0) + qty * w);
    }
  }
  return out;
}

function priceOf(p: CatalogProduct | undefined) {
  if (!p) return { sinIva: 0, conIva: 0, iva: 0, hasPrice: false };
  const ivaRate = p.tax > 1 ? p.tax / 100 : p.tax;
  return {
    sinIva: p.precioBase,
    conIva: p.precioBase * (1 + ivaRate),
    iva: ivaRate * 100,
    hasPrice: p.precioBase > 0,
  };
}

const cache = new Map<string, unknown>();

export function buildPlan(
  catalog: CatalogProduct[],
  params: OperationParams,
  filters: PlanFilters,
) {
  const key = JSON.stringify({
    c: catalog.map((p) => [p.id, p.precioBase, p.existencia]),
    params,
    filters,
  });
  const hit = cache.get(key);
  if (hit) return hit as ReturnType<typeof computePlan>;
  const result = computePlan(catalog, params, filters);
  if (cache.size > 8) cache.clear();
  cache.set(key, result);
  return result;
}

function computePlan(catalog: CatalogProduct[], params: OperationParams, filters: PlanFilters) {
  const byName = new Map<string, CatalogProduct>();
  for (const p of catalog) byName.set(norm(p.nombre), p);

  const weights = tipoWeights(filters.tipoDoc);
  const lastDayMs = dayMs(data.dates[data.dates.length - 1]!);
  const dayMsOfIndex = data.dates.map(dayMs);

  const items = data.items.filter(
    (it) =>
      it.cat && it.cat !== "nan" && !/SERVICIO/i.test(it.mega || "") &&
      (!filters.mega || it.mega === filters.mega) && (!filters.cat || it.cat === filters.cat),
  );

  const rows: {
    item: string;
    desc: string;
    mega: string;
    cat: string;
    sub: string;
    unid: string;
    clientes: number;
    unidadesHistoricas: number;
    demandaDiaria: number;
    demanda30: number;
    stockActual: number;
    stockSeguridad: number;
    sugerido: number;
    precioSinIva: number;
    precioConIva: number;
    valorSugerido: number;
    valorSugeridoConIva: number;
    facturacionHistorica: number;
    alerta: "CRITICO" | "NORMAL";
    confianza: number;
    leadTimeDays: number;
    moq: number;
    proveedor: string | null;
    enCatalogo: boolean;
    forecast: number[];
  }[] = [];

  const aggForecast = new Array<number>(HORIZON).fill(0);
  const monthly = new Map<string, number>();

  for (const it of items) {
    const product = byName.get(norm(it.desc));
    const price = priceOf(product);
    const daily = dailyOf(it, weights);

    let unidades = 0;
    let firstIdx = data.dates.length;
    for (const [idx, qty] of daily) {
      unidades += qty;
      if (idx < firstIdx) firstIdx = idx;
      const month = data.dates[idx]!.slice(0, 7);
      monthly.set(month, (monthly.get(month) ?? 0) + qty);
    }

    // Muestras diarias: se incluyen los días sin venta desde la primera venta del SKU
    const samples: Sample[] = [];
    const startIdx = Math.max(firstIdx, data.dates.length - 365);
    for (let idx = startIdx; idx < data.dates.length; idx++) {
      const ms = dayMsOfIndex[idx]!;
      const d = new Date(ms);
      samples.push({
        x: [
          d.getUTCMonth() + 1,
          d.getUTCDay(),
          price.sinIva,
          price.conIva,
          it.clientes,
        ],
        y: daily.get(idx) ?? 0,
      });
    }

    let demandaDiaria = 0;
    let confianza = 0;
    const forecast: number[] = [];

    if (samples.length >= 20) {
      const model = new RandomForestRegressor(10, 5, 2, 42).fit(samples);
      confianza = model.score(samples);
      for (let h = 1; h <= HORIZON; h++) {
        const d = new Date(lastDayMs + h * DAY);
        const yhat = Math.max(
          0,
          model.predict([
            d.getUTCMonth() + 1,
            d.getUTCDay(),
            price.sinIva,
            price.conIva,
            it.clientes,
          ]),
        );
        forecast.push(yhat);
      }
    } else {
      const avg = samples.length ? unidades / samples.length : 0;
      for (let h = 0; h < HORIZON; h++) forecast.push(Math.max(0, avg));
    }

    const demanda30 = forecast.reduce((a, b) => a + b, 0);
    demandaDiaria = demanda30 / HORIZON;
    for (let h = 0; h < HORIZON; h++) aggForecast[h]! += forecast[h]!;

    const override =
      params.overrides?.[it.cat] ?? params.overrides?.[product?.proveedor ?? ""] ?? {};
    const leadTimeDays = override.leadTimeDays ?? params.leadTimeDays;
    const moq = Math.max(1, override.moq ?? params.moq);
    const safetyDays = override.safetyDays ?? params.safetyDays ?? leadTimeDays;

    const stockActual = product?.existencia ?? 0;
    const stockSeguridad = demandaDiaria * safetyDays;
    let sugerido = Math.max(0, demanda30 + stockSeguridad - stockActual);
    if (sugerido > 0) sugerido = Math.ceil(sugerido / moq) * moq;

    rows.push({
      item: it.item,
      desc: it.desc,
      mega: it.mega,
      cat: it.cat,
      sub: it.sub,
      unid: it.unid,
      clientes: it.clientes,
      unidadesHistoricas: Math.round(unidades),
      demandaDiaria: Number(demandaDiaria.toFixed(2)),
      demanda30: Math.round(demanda30),
      stockActual,
      stockSeguridad: Math.round(stockSeguridad),
      sugerido: Math.round(sugerido),
      precioSinIva: Number(price.sinIva.toFixed(2)),
      precioConIva: Number(price.conIva.toFixed(2)),
      valorSugerido: Number((sugerido * price.sinIva).toFixed(2)),
      valorSugeridoConIva: Number((sugerido * price.conIva).toFixed(2)),
      facturacionHistorica: Number((unidades * price.sinIva).toFixed(2)),
      alerta: stockActual < 0.25 * demanda30 ? "CRITICO" : "NORMAL",
      confianza: Number(confianza.toFixed(3)),
      leadTimeDays,
      moq,
      proveedor: product?.proveedor ?? null,
      enCatalogo: Boolean(product) && price.hasPrice,
      forecast: forecast.map((v) => Number(v.toFixed(1))),
    });
  }

  // Clasificación ABC por facturación y por volumen
  const abc = (field: "facturacionHistorica" | "unidadesHistoricas") => {
    const total = rows.reduce((a, r) => a + r[field], 0) || 1;
    const sorted = [...rows].sort((a, b) => b[field] - a[field]);
    const classOf = new Map<string, "A" | "B" | "C">();
    let acc = 0;
    for (const r of sorted) {
      acc += r[field];
      const share = acc / total;
      classOf.set(r.item, share <= 0.8 ? "A" : share <= 0.95 ? "B" : "C");
    }
    return classOf;
  };
  const abcValor = abc("facturacionHistorica");
  const abcVolumen = abc("unidadesHistoricas");
  const rowsWithAbc = rows.map((r) => ({
    ...r,
    abcValor: abcValor.get(r.item) ?? "C",
    abcVolumen: abcVolumen.get(r.item) ?? "C",
  }));

  const abcResumen = (which: "abcValor" | "abcVolumen") =>
    (["A", "B", "C"] as const).map((clase) => {
      const group = rowsWithAbc.filter((r) => r[which] === clase);
      return {
        clase,
        skus: group.length,
        unidades: Math.round(group.reduce((a, r) => a + r.unidadesHistoricas, 0)),
        valor: Math.round(group.reduce((a, r) => a + r.facturacionHistorica, 0)),
      };
    });

  // Recurrencia de clientes (Concatenar_nit)
  const priceByItem = new Map<string, number>();
  for (const r of rowsWithAbc) priceByItem.set(r.item, r.precioSinIva);
  const clientes = data.clients
    .map((c) => {
      const topPrices = c.top
        .map(([item]) => priceByItem.get(item) ?? 0)
        .filter((p) => p > 0);
      const avgPrice = topPrices.length
        ? topPrices.reduce((a, b) => a + b, 0) / topPrices.length
        : 0;
      return {
        nit: c.nit,
        orders: c.orders,
        units: Math.round(c.units),
        avgInterval: c.avgInterval,
        last: c.last,
        distinctItems: c.distinctItems,
        ticketUnidades: Math.round(c.units / Math.max(1, c.orders)),
        ticketValor: Math.round((c.units * avgPrice) / Math.max(1, c.orders)),
      };
    })
    .sort((a, b) => b.orders - a.orders);

  const intervals = clientes.map((c) => c.avgInterval).filter((v): v is number => v != null);
  const monthlySeries = [...monthly.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([mes, unidades]) => ({ mes, unidades: Math.round(unidades) }));

  const forecastSeries: { fecha: string; unidades: number }[] = [];
  for (let h = 1; h <= HORIZON; h++) {
    forecastSeries.push({
      fecha: isoOf(lastDayMs + h * DAY),
      unidades: Number(aggForecast[h - 1]!.toFixed(1)),
    });
  }

  const criticos = rowsWithAbc.filter((r) => r.alerta === "CRITICO");

  return {
    meta: {
      ...data.meta,
      generado: new Date().toISOString(),
      itemsAnalizados: rowsWithAbc.length,
      sinCatalogo: rowsWithAbc.filter((r) => !r.enCatalogo).length,
      megacategorias: [...new Set(data.items.map((i) => i.mega))]
        .filter((v) => v && v !== "nan" && !/SERVICIO/i.test(v))
        .sort(),
      categorias: [...new Set(data.items.map((i) => i.cat))]
        .filter((v) => v && v !== "nan")
        .sort(),
      categoriasPorMega: categoriasPorMega(),
    },
    kpis: {
      stockTotal: rowsWithAbc.reduce((a, r) => a + r.stockActual, 0),
      demanda30: Math.round(rowsWithAbc.reduce((a, r) => a + r.demanda30, 0)),
      sugeridoUnidades: Math.round(rowsWithAbc.reduce((a, r) => a + r.sugerido, 0)),
      sugeridoValor: Math.round(rowsWithAbc.reduce((a, r) => a + r.valorSugerido, 0)),
      sugeridoValorConIva: Math.round(
        rowsWithAbc.reduce((a, r) => a + r.valorSugeridoConIva, 0),
      ),
      criticos: criticos.length,
      confianzaPromedio: Number(
        (
          rowsWithAbc.reduce((a, r) => a + r.confianza, 0) / Math.max(1, rowsWithAbc.length)
        ).toFixed(3),
      ),
    },
    series: { historico: monthlySeries, pronostico: forecastSeries },
    abc: { valor: abcResumen("abcValor"), volumen: abcResumen("abcVolumen") },
    recurrencia: {
      clientesActivos: clientes.length,
      intervaloPromedio: intervals.length
        ? Number((intervals.reduce((a, b) => a + b, 0) / intervals.length).toFixed(1))
        : null,
      ticketUnidadesPromedio: Math.round(
        clientes.reduce((a, c) => a + c.ticketUnidades, 0) / Math.max(1, clientes.length),
      ),
      ticketValorPromedio: Math.round(
        clientes.reduce((a, c) => a + c.ticketValor, 0) / Math.max(1, clientes.length),
      ),
      top: clientes.slice(0, 15),
    },
    rows: rowsWithAbc.sort((a, b) => b.valorSugerido - a.valorSugerido),
  };
}

// Cada categoría pertenece a la megacategoría donde está la mayoría de sus SKUs;
// así un ítem mal clasificado en el ERP no cruza categorías entre megacategorías.
function categoriasPorMega(): Record<string, string[]> {
  const counts = new Map<string, Map<string, number>>();
  for (const i of data.items) {
    if (!i.mega || !i.cat || i.cat === "nan" || /SERVICIO/i.test(i.mega)) continue;
    const m = counts.get(i.cat) ?? new Map<string, number>();
    m.set(i.mega, (m.get(i.mega) ?? 0) + 1);
    counts.set(i.cat, m);
  }
  const out: Record<string, string[]> = {};
  for (const [cat, megas] of counts) {
    const mega = [...megas.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    (out[mega] ??= []).push(cat);
  }
  for (const k in out) out[k]!.sort();
  return out;
}
