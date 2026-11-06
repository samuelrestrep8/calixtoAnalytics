import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import Chart from "react-apexcharts";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { buildPlan } from "./engine/inventory-engine";
import "./analytics.css";

const callistoServerURL = "https://callistoserver.up.railway.app";

const PARAMS_KEY = "callisto_inv_params";
const DEFAULT_PARAMS = { leadTimeDays: 7, moq: 1, safetyDays: 7, overrides: {} };

const money = (n) =>
  new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 })
    .format(Number(n) || 0);
const num = (n) => new Intl.NumberFormat("es-CO").format(Math.round(Number(n) || 0));

function readParams() {
  try {
    const raw = localStorage.getItem(PARAMS_KEY);
    if (raw) return { ...DEFAULT_PARAMS, ...JSON.parse(raw) };
  } catch {
    /* noop */
  }
  return DEFAULT_PARAMS;
}

function ownerIdName() {
  try {
    const usr = JSON.parse(sessionStorage.getItem("AuthUsr") || "null");
    return usr?.owner?.idName || usr?.idName || "sfgroup";
  } catch {
    return "sfgroup";
  }
}

function Card({ title, value, sub, accent, pulse }) {
  return (
    <div
      className="relative overflow-hidden rounded-2xl border p-5 backdrop-blur-xl transition-transform duration-300 hover:-translate-y-1"
      style={{
        borderColor: `${accent}33`,
        background: "rgba(15,23,42,0.55)",
        boxShadow: `0 0 24px ${accent}1f`,
      }}
    >
      {pulse && (
        <span className="absolute right-4 top-4 flex h-3 w-3">
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
            style={{ backgroundColor: accent }}
          />
          <span className="relative inline-flex h-3 w-3 rounded-full" style={{ backgroundColor: accent }} />
        </span>
      )}
      <p className="text-[11px] uppercase tracking-[0.18em] text-slate-400">{title}</p>
      <p className="mt-2 text-3xl font-semibold" style={{ color: accent }}>
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-slate-400">{sub}</p>}
    </div>
  );
}

function Panel({ title, right, children }) {
  return (
    <section
      className="rounded-2xl border border-white/10 p-5 backdrop-blur-xl"
      style={{ background: "rgba(15,23,42,0.5)" }}
    >
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-300">{title}</h2>
        {right}
      </header>
      {children}
    </section>
  );
}

const chartTheme = {
  chart: { background: "transparent", toolbar: { show: false }, foreColor: "#94a3b8" },
  theme: { mode: "dark" },
  grid: { borderColor: "rgba(148,163,184,0.15)" },
  dataLabels: { enabled: false },
  stroke: { curve: "smooth", width: 3 },
  tooltip: { theme: "dark" },
};
const THEME_KEY = "callisto_analytics_theme";

export default function Analytics() {
  const [catalog, setCatalog] = useState([]);
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [params, setParams] = useState(() =>
    typeof window === "undefined" ? DEFAULT_PARAMS : readParams(),
  );
  const [filters, setFilters] = useState({ tipoDoc: "FAC", mega: "", cat: "" });
  const [search, setSearch] = useState("");
  const [onlyCritical, setOnlyCritical] = useState(false);
  const [forecastSku, setForecastSku] = useState("");
  const [theme, setTheme] = useState(() =>
    typeof window === "undefined" ? "dark" : localStorage.getItem(THEME_KEY) || "dark",
  );
  const isLight = theme === "light";
  const toggleTheme = () => {
    const next = isLight ? "dark" : "light";
    setTheme(next);
    localStorage.setItem(THEME_KEY, next);
  };
  const ct = {
    ...chartTheme,
    chart: { ...chartTheme.chart, foreColor: isLight ? "#475569" : "#94a3b8" },
    theme: { mode: isLight ? "light" : "dark" },
    grid: { borderColor: isLight ? "rgba(71,85,105,0.15)" : "rgba(148,163,184,0.15)" },
    tooltip: { theme: isLight ? "light" : "dark" },
  };

  useEffect(() => {
    document.documentElement.classList.add("an-hide-page-scrollbar");
    return () => document.documentElement.classList.remove("an-hide-page-scrollbar");
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const stored = JSON.parse(sessionStorage.getItem("allProducts") || "null");
        let prods = Array.isArray(stored) && stored.length ? stored : null;
        if (!prods) {
          prods = (await axios.get(`${callistoServerURL}/prodsowner/${ownerIdName()}`)).data;
        }
        if (!alive) return;
        setCatalog(
          (prods || []).map((p) => ({
            id: String(p.id),
            nombre: p.nombre || "",
            precioBase: Number(p.precioBase || 0),
            tax: Number(p.tax || 0),
            existencia: Number(p.existencia || 0),
            categoria: p.category?.name ?? null,
            proveedor: p.provider?.name ?? null,
          })),
        );
      } catch (e) {
        if (alive) setError("No se pudo leer el catálogo (precios y existencias) del servidor.");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const compute = async (nextParams = params, nextFilters = filters) => {
    if (!catalog.length) return;
    setLoading(true);
    setError(null);
    try {
      await new Promise((r) => setTimeout(r, 0));
      const planData = buildPlan(
        catalog.map((p) => ({
          id: String(p.id),
          nombre: String(p.nombre ?? ""),
          precioBase: Number(p.precioBase ?? 0),
          tax: Number(p.tax ?? 0),
          existencia: Number(p.existencia ?? 0),
          categoria: p.categoria ?? null,
          proveedor: p.proveedor ?? null,
        })),
        {
          leadTimeDays: Number(nextParams.leadTimeDays) || 7,
          moq: Number(nextParams.moq) || 1,
          safetyDays: Number(nextParams.safetyDays) || 7,
          overrides: nextParams.overrides ?? {},
        },
        {
          tipoDoc: nextFilters.tipoDoc ?? "FAC",
          mega: nextFilters.mega || null,
          cat: nextFilters.cat || null,
        }
      );
      setPlan(planData);
    } catch (e) {
      setError(e?.message || "Falló el cálculo de la predicción.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (catalog.length) compute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, filters.tipoDoc, filters.mega, filters.cat]);

  const saveParams = (next) => {
    setParams(next);
    localStorage.setItem(PARAMS_KEY, JSON.stringify(next));
  };

  const setOverride = (cat, field, value) => {
    const next = {
      ...params,
      overrides: {
        ...params.overrides,
        [cat]: { ...(params.overrides?.[cat] || {}), [field]: Number(value) || 0 },
      },
    };
    saveParams(next);
  };

  const rows = useMemo(() => {
    if (!plan) return [];
    const q = search.trim().toUpperCase();
    return plan.rows
      .filter(
        (r) =>
          (!onlyCritical || r.alerta === "CRITICO") &&
          (!q || r.desc.toUpperCase().includes(q) || r.item.includes(q)),
      )
      .sort((a, b) => a.desc.localeCompare(b.desc, "es"));
  }, [plan, search, onlyCritical]);

  const grupos = useMemo(() => {
    if (!plan) return [];
    return [...new Set(plan.rows.map((r) => r.proveedor).filter((v) => v && v !== "nan"))].sort();
  }, [plan]);

  const [pdfMenuOpen, setPdfMenuOpen] = useState(false);

  const downloadPdf = (pdfGroup = "") => {
    if (!plan) return;
    const grupo = pdfGroup || "TODOS";
    const detalle = plan.rows.filter(
      (r) => r.alerta === "CRITICO" && (!pdfGroup || r.proveedor === pdfGroup),
    );
    const totalValor = detalle.reduce((a, r) => a + r.valorSugerido, 0);
    const totalUnidades = detalle.reduce((a, r) => a + r.sugerido, 0);

    const doc = new jsPDF({ unit: "pt", margin: 50 });
    doc.setFontSize(18);
    doc.text("CALLiSTO AI - ORDEN SUGERIDA DE COMPRA", 50, 55);
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Proveedor / Categoría: ${grupo}`, 50, 75);
    doc.text(`Generado: ${new Date().toLocaleString("es-CO")}`, 50, 90);
    doc.text(`Histórico analizado: ${plan.meta.from} a ${plan.meta.to}`, 50, 105);

    doc.setTextColor(20);
    doc.setFontSize(12);
    doc.text("Resumen ejecutivo", 50, 135);
    doc.setFontSize(10);
    doc.text(`SKUs en alerta crítica: ${detalle.length}`, 50, 153);
    doc.text(`Unidades sugeridas: ${num(totalUnidades)}`, 50, 168);
    doc.text(`Monto total sugerido (sin IVA): ${money(totalValor)}`, 50, 183);

    autoTable(doc, {
      startY: 205,
      head: [["Item", "Descripción", "Stock", "Demanda 30d", "Pedir", "Valor"]],
      body: detalle.map((r) => [
        r.item,
        r.desc,
        num(r.stockActual),
        num(r.demanda30),
        num(r.sugerido),
        money(r.valorSugerido),
      ]),
      styles: { fontSize: 8 },
      headStyles: { fillColor: [56, 189, 248] },
    });

    doc.save(`Orden_Sugerida_Compra_${grupo.replace(/[^\w-]+/g, "_")}.pdf`);
  };

  const serieHistorica = plan?.series.historico ?? [];
  const seriePronostico = plan?.series.pronostico ?? [];
  const skuSel = forecastSku ? plan?.rows.find((r) => r.item === forecastSku) : null;
  const pronosticoData = skuSel?.forecast ?? seriePronostico.map((p) => p.unidades);

  return (
    <div className={`${isLight ? "an-light" : ""} min-h-screen bg-slate-900 px-4 py-6 text-slate-100 sm:px-8`}>
      <div
        className="pointer-events-none fixed inset-0 opacity-60"
        style={{
          background:
            "radial-gradient(circle at 15% 10%, rgba(56,189,248,0.12), transparent 45%), radial-gradient(circle at 85% 0%, rgba(168,85,247,0.12), transparent 40%)",
        }}
      />
      <div className="relative mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.3em] text-cyan-300/80">
              CALLiSTO Analytics
            </p>
            <h1 className="text-2xl font-semibold sm:text-3xl">
              AI Engine · Planeación de Inventario
            </h1>
            <p className="mt-1 text-xs text-slate-400">
              {plan
                ? `${num(plan.meta.rows)} transacciones · ${plan.meta.from} a ${plan.meta.to} · ${plan.meta.itemsAnalizados} SKUs · ${plan.meta.clients} clientes`
                : "Cargando histórico y catálogo…"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={filters.tipoDoc}
              onChange={(e) => setFilters((f) => ({ ...f, tipoDoc: e.target.value }))}
              className="rounded-lg border border-white/10 bg-slate-800/70 px-3 py-2 text-xs"
            >
              <option value="FAC">Solo ventas efectivas (FAC)</option>
              <option value="NET">Netas (FAC − NCR)</option>
              <option value="ALL">Todos los documentos</option>
            </select>
            <select
              value={filters.mega}
              onChange={(e) => setFilters((f) => ({ ...f, mega: e.target.value, cat: "" }))}
              className="rounded-lg border border-white/10 bg-slate-800/70 px-3 py-2 text-xs"
            >
              <option value="">Todas las megacategorías</option>
              {(plan?.meta.megacategorias ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <select
              value={filters.cat}
              onChange={(e) => setFilters((f) => ({ ...f, cat: e.target.value }))}
              className="rounded-lg border border-white/10 bg-slate-800/70 px-3 py-2 text-xs"
            >
              <option value="">Todas las categorías</option>
              {((filters.mega && plan?.meta.categoriasPorMega?.[filters.mega]) || plan?.meta.categorias || []).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <button
              onClick={toggleTheme}
              aria-label={isLight ? "Cambiar a modo oscuro" : "Cambiar a modo claro"}
              title={isLight ? "Modo oscuro" : "Modo claro"}
              className="rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-xs font-semibold text-cyan-200 transition hover:bg-cyan-400/20"
            >
              {isLight ? "☾ Modo oscuro" : "☀ Modo claro"}
            </button>
          </div>
        </header>

        {error && (
          <div className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Card
            title="Stock total en bodega"
            value={plan ? num(plan.kpis.stockTotal) : "—"}
            sub="unidades disponibles"
            accent="#38BDF8"
          />
          <Card
            title="Demanda proyectada (30d)"
            value={plan ? num(plan.kpis.demanda30) : "—"}
            sub={plan ? `Confianza media del modelo ${(plan.kpis.confianzaPromedio * 100).toFixed(0)}%` : ""}
            accent="#10B981"
          />
          <Card
            title="Sugerencia de abastecimiento"
            value={plan ? num(plan.kpis.sugeridoUnidades) : "—"}
            sub={plan ? `${money(plan.kpis.sugeridoValor)} sin IVA · ${money(plan.kpis.sugeridoValorConIva)} con IVA` : ""}
            accent="#F59E0B"
          />
          <Card
            title="SKUs en alerta crítica"
            value={plan ? num(plan.kpis.criticos) : "—"}
            sub="stock < 25% de la demanda proyectada"
            accent="#F43F5E"
            pulse={Boolean(plan?.kpis.criticos)}
          />
        </div>

        <div className="grid gap-4">
          <Panel title="Histórico mensual de demanda">
            <Chart
              type="area"
              height={280}
              series={[{ name: "Unidades", data: serieHistorica.map((p) => p.unidades) }]}
              options={{
                ...ct,
                colors: ["#38BDF8"],
                fill: { type: "gradient", gradient: { opacityFrom: 0.45, opacityTo: 0.05 } },
                xaxis: { categories: serieHistorica.map((p) => p.mes.slice(2)) },
              }}
            />
          </Panel>
          <Panel
            title="Pronóstico IA próximos 30 días"
            right={
              <div className="flex flex-wrap items-center gap-2">
                {skuSel && (
                  <span className="text-xs text-slate-400">
                    {num(skuSel.demanda30)} und · confianza {(skuSel.confianza * 100).toFixed(0)}%
                  </span>
                )}
                <select
                  value={forecastSku}
                  onChange={(e) => setForecastSku(e.target.value)}
                  className="max-w-[260px] rounded-lg border border-white/10 bg-slate-800/70 px-3 py-2 text-xs"
                >
                  <option value="">Pronóstico general</option>
                  {[...(plan?.rows ?? [])]
                    .sort((a, b) => a.desc.localeCompare(b.desc))
                    .map((r) => (
                      <option key={r.item} value={r.item}>
                        {r.desc}
                      </option>
                    ))}
                </select>
              </div>
            }
          >
            <Chart
              type="area"
              height={280}
              series={[{ name: "Unidades proyectadas", data: pronosticoData }]}
              options={{
                ...ct,
                colors: ["#10B981"],
                fill: { type: "gradient", gradient: { opacityFrom: 0.45, opacityTo: 0.05 } },
                xaxis: { categories: seriePronostico.map((p) => p.fecha.slice(5)) },
              }}
            />
          </Panel>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="grid gap-4">
            <Panel title="Clasificación ABC por facturación">
              <AbcTable data={plan?.abc.valor ?? []} />
            </Panel>
            <Panel title="Clasificación ABC por volumen">
              <AbcTable data={plan?.abc.volumen ?? []} />
            </Panel>
          </div>
          <div className="lg:col-span-2">
          <Panel title="Recurrencia de clientes">
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Mini label="Clientes activos" value={plan ? num(plan.recurrencia.clientesActivos) : "—"} />
              <Mini
                label="Intervalo promedio"
                value={plan?.recurrencia.intervaloPromedio ? `${plan.recurrencia.intervaloPromedio} días` : "—"}
              />
              <Mini label="Ticket (unidades)" value={plan ? num(plan.recurrencia.ticketUnidadesPromedio) : "—"} />
              <Mini label="Ticket (valor)" value={plan ? money(plan.recurrencia.ticketValorPromedio) : "—"} />
            </div>
            <div className="mt-4 max-h-[300px] overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-slate-400">
                  <tr>
                    <th className="pb-2">NIT</th>
                    <th className="pb-2">Compras</th>
                    <th className="pb-2">Intervalo</th>
                    <th className="pb-2">Ticket</th>
                  </tr>
                </thead>
                <tbody>
                  {(plan?.recurrencia.top ?? []).map((c) => (
                    <tr key={c.nit} className="border-t border-white/5 hover:bg-white/5">
                      <td className="py-1.5">{c.nit}</td>
                      <td className="py-1.5">{c.orders}</td>
                      <td className="py-1.5">{c.avgInterval ? `${c.avgInterval} d` : "—"}</td>
                      <td className="py-1.5 text-amber-300">{money(c.ticketValor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          </div>
        </div>

        <Panel
          title="Sugerido de compra por SKU"
          right={
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar SKU…"
                className="rounded-lg border border-white/10 bg-slate-800/70 px-3 py-2 text-xs outline-none focus:border-cyan-400/60"
              />
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={onlyCritical}
                  onChange={(e) => setOnlyCritical(e.target.checked)}
                />
                Solo críticos
              </label>
            </div>
          }
        >
          <div className="max-h-[520px] overflow-auto rounded-xl border border-white/5">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-800/95 text-slate-400">
                <tr>
                  <th className="p-2">Item</th>
                  <th className="p-2">Descripción</th>
                  <th className="p-2">ABC</th>
                  <th className="p-2 text-right">Stock</th>
                  <th className="p-2 text-right">Demanda 30d</th>
                  <th className="p-2 text-right">Seguridad</th>
                  <th className="p-2 text-right">Pedir</th>
                  <th className="p-2 text-right">Valor sin IVA</th>
                  <th className="p-2 text-right">Valor con IVA</th>
                  <th className="p-2 text-right">Confianza</th>
                  <th className="p-2">Alerta</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.item} className="border-t border-white/5 transition hover:bg-cyan-400/5">
                    <td className="p-2 font-mono text-slate-300">{r.item}</td>
                    <td className="p-2">
                      {r.desc}
                      {!r.enCatalogo && (
                        <span className="ml-2 rounded bg-slate-700/70 px-1.5 py-0.5 text-[10px] text-slate-300">
                          sin precio/stock
                        </span>
                      )}
                    </td>
                    <td className="p-2">{r.abcValor}</td>
                    <td className="p-2 text-right">{num(r.stockActual)}</td>
                    <td className="p-2 text-right text-emerald-300">{num(r.demanda30)}</td>
                    <td className="p-2 text-right">{num(r.stockSeguridad)}</td>
                    <td className="p-2 text-right font-semibold text-amber-300">{num(r.sugerido)}</td>
                    <td className="p-2 text-right text-violet-300">{money(r.valorSugerido)}</td>
                    <td className="p-2 text-right text-orange-300">{money(r.valorSugeridoConIva)}</td>
                    <td className="p-2 text-right">{(r.confianza * 100).toFixed(0)}%</td>
                    <td className="p-2">
                      {r.alerta === "CRITICO" ? (
                        <span className="relative inline-flex items-center gap-2 rounded-full bg-rose-500/15 px-2 py-0.5 text-rose-300">
                          <span className="relative flex h-2 w-2">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
                            <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-400" />
                          </span>
                          CRÍTICO
                        </span>
                      ) : (
                        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-300">NORMAL</span>
                      )}
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={11} className="p-6 text-center text-slate-400">
                      {loading ? "Entrenando el modelo y proyectando la demanda…" : "Sin resultados."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="relative mt-4 flex justify-center">
            <button
              onClick={() => setPdfMenuOpen((o) => !o)}
              className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs font-semibold text-amber-200 transition hover:bg-amber-400/20"
            >
              Descargar orden PDF
            </button>
            {pdfMenuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setPdfMenuOpen(false)} />
                <div className="absolute bottom-full z-20 mb-2 max-h-72 w-72 overflow-auto rounded-xl border border-white/10 bg-slate-800/95 p-1 text-xs shadow-xl backdrop-blur">
                  <p className="px-3 py-2 text-[10px] uppercase tracking-widest text-slate-400">
                    Elige el proveedor
                  </p>
                  {["", ...grupos].map((g) => (
                    <button
                      key={g || "__all"}
                      onClick={() => {
                        setPdfMenuOpen(false);
                        downloadPdf(g);
                      }}
                      className="block w-full rounded-lg px-3 py-2 text-left text-slate-200 hover:bg-amber-400/15"
                    >
                      {g || "Todos los proveedores"}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </Panel>

        <Panel
          title="Parámetros de operación"
          right={
              <button
                onClick={() => compute()}
                className="rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-xs font-semibold text-cyan-200 transition hover:bg-cyan-400/20"
              >
                {loading ? "Calculando…" : "Recalcular IA"}
              </button>
          }
        >
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <Field
              label="Lead time (días)"
              value={params.leadTimeDays}
              onChange={(v) => saveParams({ ...params, leadTimeDays: Number(v) || 0 })}
            />
            <Field
              label="MOQ (unidades)"
              value={params.moq}
              onChange={(v) => saveParams({ ...params, moq: Number(v) || 1 })}
            />
            <Field
              label="Stock de seguridad (días)"
              value={params.safetyDays}
              onChange={(v) => saveParams({ ...params, safetyDays: Number(v) || 0 })}
            />
          </div>
          <div className="max-h-56 overflow-auto rounded-xl border border-white/5">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-800/90 text-slate-400">
                <tr>
                  <th className="p-2">Categoría proveedor</th>
                  <th className="p-2">Lead time</th>
                  <th className="p-2">MOQ</th>
                  <th className="p-2">Stock seguridad</th>
                </tr>
              </thead>
              <tbody>
                {(plan?.meta.categorias ?? []).map((cat) => {
                  const o = params.overrides?.[cat] || {};
                  return (
                    <tr key={cat} className="border-t border-white/5 hover:bg-white/5">
                      <td className="p-2">{cat}</td>
                      <td className="p-2">
                        <Num value={o.leadTimeDays ?? params.leadTimeDays} onChange={(v) => setOverride(cat, "leadTimeDays", v)} />
                      </td>
                      <td className="p-2">
                        <Num value={o.moq ?? params.moq} onChange={(v) => setOverride(cat, "moq", v)} />
                      </td>
                      <td className="p-2">
                        <Num value={o.safetyDays ?? params.safetyDays} onChange={(v) => setOverride(cat, "safetyDays", v)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-slate-400">
            Los parámetros se guardan en este navegador. Presiona “Recalcular IA” para aplicarlos.
          </p>
        </Panel>
      </div>
    </div>
  );
}

function AbcTable({ data }) {
  const colors = { A: "#10B981", B: "#38BDF8", C: "#F59E0B" };
  return (
    <table className="w-full text-left text-xs">
      <thead className="text-slate-400">
        <tr>
          <th className="pb-2">Clase</th>
          <th className="pb-2 text-right">SKUs</th>
          <th className="pb-2 text-right">Unidades</th>
          <th className="pb-2 text-right">Valor</th>
        </tr>
      </thead>
      <tbody>
        {data.map((r) => (
          <tr key={r.clase} className="border-t border-white/5">
            <td className="py-2 font-semibold" style={{ color: colors[r.clase] }}>
              {r.clase}
            </td>
            <td className="py-2 text-right">{num(r.skus)}</td>
            <td className="py-2 text-right">{num(r.unidades)}</td>
            <td className="py-2 text-right">{money(r.valor)}</td>
          </tr>
        ))}
        {!data.length && (
          <tr>
            <td colSpan={4} className="py-6 text-center text-slate-400">
              —
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function Mini({ label, value }) {
  return (
    <div className="rounded-xl border border-white/5 bg-slate-800/40 p-3">
      <p className="text-[10px] uppercase tracking-wider text-slate-400">{label}</p>
      <p className="mt-1 text-base font-semibold text-slate-100">{value}</p>
    </div>
  );
}

function Field({ label, value, onChange }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-slate-400">{label}</span>
      <input
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-white/10 bg-slate-800/70 px-3 py-2 text-sm outline-none focus:border-cyan-400/60"
      />
    </label>
  );
}

function Num({ value, onChange }) {
  return (
    <input
      type="number"
      min={0}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-20 rounded border border-white/10 bg-slate-800/70 px-2 py-1 text-xs outline-none focus:border-cyan-400/60"
    />
  );
}
