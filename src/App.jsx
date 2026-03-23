import React, { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext } from "react";
import { db } from "./firebase";
import {
  collection, doc, getDoc, setDoc, deleteDoc,
  onSnapshot, writeBatch, getDocs
} from "firebase/firestore";

const STORAGE_KEY = "fantasmas-v4-data";

// ── Firestore references ──────────────────────────────────────────
const fantasmasCol = () => collection(db, "fantasmas");
const configDoc   = (key) => doc(db, "config", key);

// ── Load all data once (initial load) ────────────────────────────
async function loadAll() {
  try {
    const [
      fantasmasSnap,
      metaSnap, finanzasSnap, colchonSnap,
      cuentasSnap, fondosSnap, enviosSnap, bitacoraSnap
    ] = await Promise.all([
      getDocs(fantasmasCol()),
      getDoc(configDoc("meta")),
      getDoc(configDoc("finanzas")),
      getDoc(configDoc("colchon")),
      getDoc(configDoc("cuentas")),
      getDoc(configDoc("fondos")),
      getDoc(configDoc("envios")),
      getDoc(configDoc("bitacora")),
    ]);

    const hasNewData = metaSnap.exists() || fantasmasSnap.docs.length > 0;

    // No new structure yet — try reading from old app/data document
    if (!hasNewData) {
      try {
        const oldSnap = await getDoc(doc(db, "app", "data"));
        if (oldSnap.exists() && oldSnap.data().payload) {
          const old = JSON.parse(oldSnap.data().payload);
          console.log("Migrating from old format:", old.fantasmas?.length, "pedidos");
          return old;
        }
      } catch(e) { console.warn("Old format not found:", e); }
      try { const s = localStorage.getItem(STORAGE_KEY); if (s) return JSON.parse(s); } catch {}
      return init();
    }

    const fantasmas = fantasmasSnap.docs.map(d => d.data());
    const meta      = metaSnap.exists()     ? metaSnap.data()     : {};
    const finanzas  = finanzasSnap.exists() ? finanzasSnap.data() : {};
    const colchon   = colchonSnap.exists()  ? colchonSnap.data()  : {};
    const cuentas   = cuentasSnap.exists()  ? cuentasSnap.data()  : {};
    const fondos    = fondosSnap.exists()   ? fondosSnap.data()   : {};
    const envios    = enviosSnap.exists()   ? enviosSnap.data()   : {};
    const bitacora  = bitacoraSnap.exists() ? bitacoraSnap.data() : {};

    return {
      fantasmas,
      nextId:              meta.nextId              ?? 2800,
      _appVersion:         meta._appVersion         ?? 0,
      vendedores:          meta.vendedores           ?? [],
      clientes:            meta.clientes             ?? [],
      proveedoresList:     meta.proveedoresList      ?? [],
      provUbicaciones:     meta.provUbicaciones      ?? {},
      proveedoresInfo:     meta.proveedoresInfo      ?? {},
      gastosAdmin:         finanzas.gastosAdmin      ?? [],
      gastosUSA:           finanzas.gastosUSA        ?? [],
      gastosBodega:        finanzas.gastosBodega     ?? [],
      transferencias:      finanzas.transferencias   ?? [],
      adelantosAdmin:      finanzas.adelantosAdmin   ?? [],
      colchon:             colchon.data              ?? { montoOriginal: 0, saldoActual: 0, movimientos: [] },
      cuentasPorPagar:     cuentas.cuentasPorPagar   ?? [],
      cuentasPorCobrarEmp: cuentas.cuentasPorCobrarEmp ?? [],
      fondos:              fondos.fondos             ?? {},
      fondosCustom:        fondos.fondosCustom       ?? [],
      fondosMovs:          fondos.fondosMovs         ?? [],
      envios:              envios.list               ?? [],
      bitacoraGanancias:   bitacora.list             ?? [],
    };
  } catch(e) {
    console.error("Firebase loadAll error:", e);
    try { const s = localStorage.getItem(STORAGE_KEY); if (s) return JSON.parse(s); } catch {}
    return init();
  }
}

// ── Save changed parts (smart diff save) ─────────────────────────
async function saveAll(nd, prev) {
  try {
    const batch = writeBatch(db);

    // 1. Fantasmas — save only changed/added pedidos, delete removed ones
    if (nd.fantasmas !== prev?.fantasmas) {
      const prevIds = new Set((prev?.fantasmas || []).map(f => f.id));
      const newIds  = new Set(nd.fantasmas.map(f => f.id));

      // Deleted pedidos
      for (const id of prevIds) {
        if (!newIds.has(id)) batch.delete(doc(db, "fantasmas", id));
      }
      // New or changed pedidos
      for (const f of nd.fantasmas) {
        const prev_f = (prev?.fantasmas || []).find(x => x.id === f.id);
        if (!prev_f || JSON.stringify(prev_f) !== JSON.stringify(f)) {
          batch.set(doc(db, "fantasmas", f.id), f);
        }
      }
    }

    // 2. Meta config
    const metaChanged = !prev ||
      nd.nextId !== prev.nextId ||
      nd._appVersion !== prev._appVersion ||
      JSON.stringify(nd.vendedores) !== JSON.stringify(prev.vendedores) ||
      JSON.stringify(nd.clientes) !== JSON.stringify(prev.clientes) ||
      JSON.stringify(nd.proveedoresList) !== JSON.stringify(prev.proveedoresList) ||
      JSON.stringify(nd.provUbicaciones) !== JSON.stringify(prev.provUbicaciones) ||
      JSON.stringify(nd.proveedoresInfo) !== JSON.stringify(prev.proveedoresInfo);
    if (metaChanged) {
      batch.set(configDoc("meta"), {
        nextId: nd.nextId,
        _appVersion: nd._appVersion ?? 3,
        vendedores: nd.vendedores ?? [],
        clientes: nd.clientes ?? [],
        proveedoresList: nd.proveedoresList ?? [],
        provUbicaciones: nd.provUbicaciones ?? {},
        proveedoresInfo: nd.proveedoresInfo ?? {},
      });
    }

    // 3. Finanzas
    const finChanged = !prev ||
      JSON.stringify(nd.gastosAdmin) !== JSON.stringify(prev.gastosAdmin) ||
      JSON.stringify(nd.gastosUSA) !== JSON.stringify(prev.gastosUSA) ||
      JSON.stringify(nd.gastosBodega) !== JSON.stringify(prev.gastosBodega) ||
      JSON.stringify(nd.transferencias) !== JSON.stringify(prev.transferencias) ||
      JSON.stringify(nd.adelantosAdmin) !== JSON.stringify(prev.adelantosAdmin);
    if (finChanged) {
      batch.set(configDoc("finanzas"), {
        gastosAdmin: nd.gastosAdmin ?? [],
        gastosUSA: nd.gastosUSA ?? [],
        gastosBodega: nd.gastosBodega ?? [],
        transferencias: nd.transferencias ?? [],
        adelantosAdmin: nd.adelantosAdmin ?? [],
      });
    }

    // 4. Colchon
    if (!prev || JSON.stringify(nd.colchon) !== JSON.stringify(prev.colchon)) {
      batch.set(configDoc("colchon"), { data: nd.colchon ?? { montoOriginal: 0, saldoActual: 0, movimientos: [] } });
    }

    // 5. Cuentas
    if (!prev ||
      JSON.stringify(nd.cuentasPorPagar) !== JSON.stringify(prev.cuentasPorPagar) ||
      JSON.stringify(nd.cuentasPorCobrarEmp) !== JSON.stringify(prev.cuentasPorCobrarEmp)) {
      batch.set(configDoc("cuentas"), {
        cuentasPorPagar: nd.cuentasPorPagar ?? [],
        cuentasPorCobrarEmp: nd.cuentasPorCobrarEmp ?? [],
      });
    }

    // 6. Fondos
    if (!prev ||
      JSON.stringify(nd.fondos) !== JSON.stringify(prev.fondos) ||
      JSON.stringify(nd.fondosCustom) !== JSON.stringify(prev.fondosCustom) ||
      JSON.stringify(nd.fondosMovs) !== JSON.stringify(prev.fondosMovs)) {
      batch.set(configDoc("fondos"), {
        fondos: nd.fondos ?? {},
        fondosCustom: nd.fondosCustom ?? [],
        fondosMovs: nd.fondosMovs ?? [],
      });
    }

    // 7. Envios
    if (!prev || JSON.stringify(nd.envios) !== JSON.stringify(prev.envios)) {
      batch.set(configDoc("envios"), { list: nd.envios ?? [] });
    }

    // 8. Bitacora
    if (!prev || JSON.stringify(nd.bitacoraGanancias) !== JSON.stringify(prev.bitacoraGanancias)) {
      batch.set(configDoc("bitacora"), { list: nd.bitacoraGanancias ?? [] });
    }

    await batch.commit();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nd));
    return true;
  } catch(e) {
    console.error("Firebase saveAll error:", e.code, e.message);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(nd)); return "local"; } catch {}
    return false;
  }
}


const ESTADOS = { PEDIDO: "Pedido generado", RECOLECTADO: "Recolectado — en camino", BODEGA_TJ: "En bodega TJ", ENTREGADO: "Entregado", CERRADO: "Cerrado" };
const ESTADO_KEYS = Object.keys(ESTADOS);
const ESTADO_COLORS = { PEDIDO: { bg: "#FEF3C7", text: "#92400E", dot: "#F59E0B" }, RECOLECTADO: { bg: "#E0E7FF", text: "#3730A3", dot: "#6366F1" }, BODEGA_TJ: { bg: "#A7F3D0", text: "#065F46", dot: "#34D399" }, ENTREGADO: { bg: "#BBF7D0", text: "#166534", dot: "#22C55E" }, CERRADO: { bg: "#E5E7EB", text: "#374151", dot: "#6B7280" } };
const ESTADO_RESP = { PEDIDO: "Alejandra", RECOLECTADO: "Jordi", BODEGA_TJ: "Adolfo", ENTREGADO: "Adolfo", CERRADO: "Admin" };
const DINERO_STATUS = { SIN_FONDOS: "Sin fondos aún", SOBRE_LISTO: "Sobre listo en TJ", DINERO_CAMINO: "Dinero en camino a USA", DINERO_USA: "Dinero recibido en USA", COLCHON_USADO: "Colchón usado (pendiente)", COLCHON_REPUESTO: "Colchón repuesto", TRANS_PENDIENTE: "🏦 Transferencia por confirmar", FANTASMA_PAGADO: "👻 Fantasma pagado", FLETE_PAGADO: "🚛 Flete pagado", TODO_PAGADO: "✅ Fantasma y flete pagado", NO_APLICA: "Pagado / No aplica" };
const DINERO_KEYS = Object.keys(DINERO_STATUS);
const DINERO_COLORS = { SIN_FONDOS: { bg: "#FEE2E2", text: "#991B1B", dot: "#DC2626" }, SOBRE_LISTO: { bg: "#DBEAFE", text: "#1E40AF", dot: "#3B82F6" }, DINERO_CAMINO: { bg: "#E0E7FF", text: "#3730A3", dot: "#6366F1" }, DINERO_USA: { bg: "#D1FAE5", text: "#065F46", dot: "#10B981" }, COLCHON_USADO: { bg: "#FEF3C7", text: "#92400E", dot: "#F59E0B" }, COLCHON_REPUESTO: { bg: "#D1FAE5", text: "#065F46", dot: "#059669" }, TRANS_PENDIENTE: { bg: "#F3E8FF", text: "#6B21A8", dot: "#9333EA" }, FANTASMA_PAGADO: { bg: "#FCE7F3", text: "#9D174D", dot: "#EC4899" }, FLETE_PAGADO: { bg: "#DBEAFE", text: "#1E40AF", dot: "#2563EB" }, TODO_PAGADO: { bg: "#D1FAE5", text: "#065F46", dot: "#059669" }, NO_APLICA: { bg: "#F3F4F6", text: "#6B7280", dot: "#9CA3AF" } };

// Which estados each role sees
const USA_ESTADOS = ["PEDIDO", "RECOLECTADO", "BODEGA_TJ"];
const USA_DINERO = ["DINERO_USA", "COLCHON_USADO", "COLCHON_REPUESTO", "NO_APLICA"];
const TJ_ESTADOS = ["PEDIDO", "RECOLECTADO", "BODEGA_TJ", "ENTREGADO"];

function fmt(n) { if (n == null || isNaN(n)) return "$0"; return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtD(d) { if (!d) return "—"; return new Date(d + "T12:00:00").toLocaleDateString("es-MX", { day: "numeric", month: "short" }); }
function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function genId(n) { return `F-${String(n).padStart(4, "0")}`; }
function diasHabiles(fechaStr) {
  if (!fechaStr) return 0;
  const start = new Date(fechaStr + "T12:00:00");
  const end = new Date();
  let count = 0;
  const cur = new Date(start);
  while (cur < end) {
    cur.setDate(cur.getDate() + 1);
    if (cur.getDay() !== 0) count++; // skip Sunday
  }
  return count;
}
const init = () => ({ fantasmas: [], nextId: 2800, colchon: { montoOriginal: 0, saldoActual: 0, movimientos: [] }, vendedores: [], clientes: [], proveedoresList: [], provUbicaciones: {}, proveedoresInfo: {}, gastosAdmin: [], gastosUSA: [], gastosBodega: [], transferencias: [], adelantosAdmin: [], cuentasPorPagar: [], cuentasPorCobrarEmp: [], fondos: {}, fondosCustom: [], fondosMovs: [], envios: [], bitacoraGanancias: [] });


const I = {
  Plus: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>,
  Search: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>,
  X: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>,
  Left: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="m15 18-6-6 6-6"/></svg>,
  Right: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="m9 18 6-6-6-6"/></svg>,
  Back: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>,
  Edit: () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  Trash: () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>,
  Shield: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  Users: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>,
  Store: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>,
  List: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/></svg>,
  Dl: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>,
  Box: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>,
  Truck: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M1 3h15v13H1zM16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>,
  Alert: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01"/></svg>,
  Dollar: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>,
  Home: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>,
};

function Badge({ estado }) { const c = ESTADO_COLORS[estado] || ESTADO_COLORS.PEDIDO; return <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 5, fontSize: 10, fontWeight: 600, background: c.bg, color: c.text, whiteSpace: "nowrap" }}><span style={{ width: 5, height: 5, borderRadius: "50%", background: c.dot }} />{ESTADOS[estado] || estado}</span>; }
function DBadge({ status }) { const c = DINERO_COLORS[status] || DINERO_COLORS.SIN_FONDOS; return <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 5, fontSize: 10, fontWeight: 600, background: c.bg, color: c.text, whiteSpace: "nowrap" }}><span style={{ width: 5, height: 5, borderRadius: "50%", background: c.dot }} />💵 {DINERO_STATUS[status]}</span>; }
function Btn({ children, v = "primary", sz = "md", ...p }) { const s = { primary: { bg: "#1A2744", c: "#fff", b: "none" }, secondary: { bg: "#fff", c: "#374151", b: "1px solid #D1D5DB" }, danger: { bg: "#FEE2E2", c: "#991B1B", b: "1px solid #FECACA" }, warning: { bg: "#FEF3C7", c: "#92400E", b: "1px solid #FDE68A" }, ghost: { bg: "transparent", c: "#6B7280", b: "none" }, success: { bg: "#D1FAE5", c: "#065F46", b: "1px solid #A7F3D0" } }[v] || { bg: "#1A2744", c: "#fff", b: "none" }; return <button {...p} style={{ padding: sz === "sm" ? "4px 9px" : "7px 13px", borderRadius: 7, fontSize: sz === "sm" ? 11 : 12, fontWeight: 600, background: s.bg, color: s.c, border: s.b, cursor: p.disabled ? "not-allowed" : "pointer", opacity: p.disabled ? 0.5 : 1, display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "inherit", transition: "all .15s", whiteSpace: "nowrap", ...p.style }}>{children}</button>; }
function Inp(p) { return <input {...p} style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 12, outline: "none", boxSizing: "border-box", fontFamily: "inherit", background: "#FAFAFA", ...p.style }} />; }
function AutoInp({ value, onChange, options, placeholder, style, strict = false, onSelect }) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState(value || "");
  const isValid = options.some(o => o === value);

  // Sync external value
  if (value !== text && !focused) { /* will sync on next render */ }

  const filtered = text ? options.filter(o => o.toLowerCase().includes(text.toLowerCase())).slice(0, 10) : options.slice(0, 10);
  const show = focused && filtered.length > 0;

  const handleChange = (e) => {
    const v = e.target.value.toUpperCase();
    setText(v);
    if (!strict) onChange(v);
    setOpen(true);
  };
  const handleSelect = (o) => {
    setText(o);
    onChange(o);
    if (onSelect) onSelect(o);
    setOpen(false);
  };
  const handleBlur = () => {
    setTimeout(() => {
      setFocused(false);
      setOpen(false);
      if (strict && !options.includes(text)) { setText(value || ""); }
      else if (!strict) { onChange(text); }
    }, 150);
  };

  return (
    <div style={{ position: "relative" }}>
      <input value={focused ? text : value || ""} onChange={handleChange} onFocus={() => { setFocused(true); setText(value || ""); setOpen(true); }} onBlur={handleBlur} placeholder={placeholder} autoComplete="off" style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: `1px solid ${strict && value && !isValid ? "#FECACA" : "#D1D5DB"}`, fontSize: 12, outline: "none", boxSizing: "border-box", fontFamily: "inherit", background: "#FAFAFA", textTransform: "uppercase", ...style }} />
      {strict && value && isValid && <span style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", fontSize: 10, color: "#059669" }}>✓</span>}
      {show && open && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "#fff", border: "1px solid #D1D5DB", borderRadius: "0 0 6px 6px", boxShadow: "0 4px 12px rgba(0,0,0,.12)", zIndex: 50, maxHeight: 200, overflow: "auto" }}>
          {filtered.map(o => (
            <div key={o} onMouseDown={() => handleSelect(o)} style={{ padding: "8px 10px", fontSize: 12, cursor: "pointer", borderBottom: "1px solid #F3F4F6", background: o === value ? "#EFF6FF" : "#fff" }} onMouseEnter={e => e.currentTarget.style.background = "#EFF6FF"} onMouseLeave={e => e.currentTarget.style.background = o === value ? "#EFF6FF" : "#fff"}>
              {text ? <>{o.substring(0, o.toLowerCase().indexOf(text.toLowerCase()))}<strong>{o.substring(o.toLowerCase().indexOf(text.toLowerCase()), o.toLowerCase().indexOf(text.toLowerCase()) + text.length)}</strong>{o.substring(o.toLowerCase().indexOf(text.toLowerCase()) + text.length)}</> : o}
            </div>
          ))}
          {filtered.length === 0 && <div style={{ padding: "8px 10px", fontSize: 11, color: "#9CA3AF" }}>No hay coincidencias</div>}
        </div>
      )}
    </div>
  );
}
function Sel({ options, ...p }) { return <select {...p} style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 12, fontFamily: "inherit", background: "#FAFAFA", cursor: "pointer", boxSizing: "border-box", ...p.style }}>{options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select>; }
function Fld({ label, children }) { return <div style={{ marginBottom: 10 }}><label style={{ display: "block", fontSize: 10, fontWeight: 600, color: "#374151", marginBottom: 2, textTransform: "uppercase", letterSpacing: .3 }}>{label}</label>{children}</div>; }
function Modal({ title, onClose, children, w = 500 }) { return <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }} onClick={onClose}><div style={{ background: "#fff", borderRadius: 12, width: "100%", maxWidth: w, maxHeight: "90vh", overflow: "auto", boxShadow: "0 20px 40px rgba(0,0,0,.15)" }} onClick={e => e.stopPropagation()}><div style={{ padding: "14px 18px", borderBottom: "1px solid #E5E7EB", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, background: "#fff", borderRadius: "12px 12px 0 0", zIndex: 1 }}><h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{title}</h3><button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", padding: 3, color: "#9CA3AF" }}><I.X /></button></div><div style={{ padding: 18 }}>{children}</div></div></div>; }
function Stat({ label, value, color, icon, sub }) { return <div style={{ background: "#fff", borderRadius: 9, padding: "14px 16px", border: "1px solid #E5E7EB", flex: "1 1 160px", minWidth: 140 }}><div style={{ display: "flex", justifyContent: "space-between" }}><div><div style={{ fontSize: 10, color: "#6B7280", fontWeight: 500, textTransform: "uppercase", letterSpacing: .4 }}>{label}</div><div style={{ fontSize: 20, fontWeight: 700, color: color || "#111", fontFamily: "monospace", marginTop: 2 }}>{value}</div>{sub && <div style={{ fontSize: 10, color: "#9CA3AF", marginTop: 1 }}>{sub}</div>}</div><div style={{ width: 28, height: 28, borderRadius: 6, background: (color || "#6B7280") + "18", display: "flex", alignItems: "center", justifyContent: "center", color: color || "#6B7280" }}>{icon}</div></div></div>; }

// ============ USERS & PERMISSIONS ============
const USERS = [
  { username: "Ochoatransport", password: "Ochoaleon0612", role: "admin",   startView: "main" },
  { username: "BODEGA TJ",      password: "qwerty1",       role: "bodegatj", startView: "bodegatj" },
  { username: "BODEGA USA",     password: "qwerty1",       role: "usa",      startView: "bodegausa" },
  { username: "VENDEDOR",       password: "qwerty1",       role: "vendedor", startView: "ventas" },
];
// What each role can see in the nav
const ROLE_NAV = {
  admin:    ["ventas", "bodegausa", "bodegatj", "bitacora", "clientes", "proveedores"],
  bodegatj: ["ventas", "bodegausa", "bodegatj", "bitacora", "clientes", "proveedores"],
  usa:      ["bodegausa", "bitacora", "clientes", "proveedores"],
  vendedor: ["ventas", "bodegausa", "bodegatj", "bitacora", "clientes", "proveedores"],
};


const EMPTY_FORM = { cliente: "", descripcion: "", proveedor: "", ubicacionProv: "", vendedor: "", tipoMercancia: "", empaque: "", empaqueOtro: "", cantBultos: "1", modoPrecios: "total", cantidad: "", costoUnitario: "", costoMercancia: "", costoFlete: "", urgente: false, soloRecoger: false, fleteDesconocido: false, costoDesconocido: false, pedidoEspecial: false, precioVenta: "", notas: "" };

// ============ NEW FORM (module-level to prevent remount on App re-render) ============
const NewForm = ({ showNew, data, addF, updateF, editPedido, role, setShowNew, today, fmt, fmtD, Modal, Btn, Fld, Inp, AutoInp, I, navigate, TIPOS_MERCANCIA }) => {
  const [f, sF] = useState(EMPTY_FORM);
  const prevShowNew = useRef(false);
  if (showNew && !prevShowNew.current) {
    if (editPedido) {
      sF({ ...EMPTY_FORM, ...editPedido,
        costoMercancia: editPedido.pedidoEspecial ? String(editPedido.costoReal ?? editPedido.costoMercancia) : String(editPedido.costoMercancia || ""),
        costoFlete: String(editPedido.costoFlete || ""),
        cantBultos: String(editPedido.cantBultos || 1),
        cantidad: String(editPedido.cantidad || ""),
        costoUnitario: String(editPedido.costoUnitario || ""),
        precioVenta: editPedido.pedidoEspecial ? String(editPedido.costoMercancia || "") : "",
        notas: editPedido.notas || "",
        modoPrecios: editPedido.cantidad && editPedido.costoUnitario ? "unitario" : "total",
      });
    } else {
      sF(EMPTY_FORM);
    }
  }
  prevShowNew.current = showNew;
  if (!showNew) return null;
  const isEdit = !!editPedido;
  const calcCosto = f.modoPrecios === "unitario" ? (parseFloat(f.cantidad) || 0) * (parseFloat(f.costoUnitario) || 0) : parseFloat(f.costoMercancia) || 0;
  const allClientes = [...new Set([...(data.clientes || []), ...data.fantasmas.map(x => x.cliente).filter(Boolean)])].sort();
  const allProveedores = [...new Set([...Object.keys(data.proveedoresInfo || {}), ...(data.proveedoresList || []), ...data.fantasmas.map(x => x.proveedor).filter(Boolean)])].sort();
  const allVendedores = [...new Set([...(data.vendedores || []), ...data.fantasmas.map(x => x.vendedor).filter(Boolean)])].sort();
  const provInfo = data.proveedoresInfo || {};
  const EMPAQUES = ["Caja", "Gaylor", "Pallet", "Sobre", "Bulto", "Bolsa", "Sandillero", "Step Completa", "Espacio", "Desconocido", "Otro"];

  const noOpt = (list, label) => list.length === 0 ? <div style={{ fontSize: 10, color: "#D97706", marginTop: 2 }}>⚠️ Registra {label} primero</div> : null;

  return (
    <Modal title={isEdit ? "✏️ Editar Pedido" : "🛒 Nuevo Pedido"} onClose={() => { setShowNew(false) }} w={560}>
      {/* Tabs: Normal / Especial */}
      <div style={{ display: "flex", gap: 3, background: "#F3F4F6", borderRadius: 8, padding: 3, marginBottom: 16 }}>
        <button onClick={() => sF({ ...f, pedidoEspecial: false, precioVenta: "" })} style={{ flex: 1, padding: "7px", borderRadius: 6, border: "none", background: !f.pedidoEspecial ? "#fff" : "transparent", boxShadow: !f.pedidoEspecial ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 12, fontWeight: !f.pedidoEspecial ? 700 : 500, fontFamily: "inherit", color: !f.pedidoEspecial ? "#1A2744" : "#6B7280" }}>
          📋 Pedido Normal
        </button>
        <button onClick={() => sF({ ...f, pedidoEspecial: true })} style={{ flex: 1, padding: "7px", borderRadius: 6, border: "none", background: f.pedidoEspecial ? "#F3E8FF" : "transparent", boxShadow: f.pedidoEspecial ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 12, fontWeight: f.pedidoEspecial ? 700 : 500, fontFamily: "inherit", color: f.pedidoEspecial ? "#7C3AED" : "#6B7280" }}>
          ⭐ Pedido Especial
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0 10px" }}>
        <Fld label="Cliente *">
          <AutoInp value={f.cliente} onChange={v => sF({ ...f, cliente: v })} options={allClientes} placeholder="BUSCAR CLIENTE..." strict />
          {noOpt(allClientes, "clientes")}
        </Fld>
        <Fld label="Proveedor *">
          <AutoInp value={f.proveedor} onChange={v => sF({ ...f, proveedor: v })} options={allProveedores} placeholder="BUSCAR PROVEEDOR..." strict onSelect={v => {
            const info = provInfo[v] || {};
            sF(prev => ({ ...prev, proveedor: v, ubicacionProv: info.ubicacion || "" }));
          }} />
          {noOpt(allProveedores, "proveedores")}
          {f.proveedor && provInfo[f.proveedor] && <div style={{ fontSize: 10, color: "#6B7280", marginTop: 2 }}>📍 {provInfo[f.proveedor].ubicacion || "—"}{provInfo[f.proveedor].contacto ? ` · 👤 ${provInfo[f.proveedor].contacto}` : ""}{provInfo[f.proveedor].telefono ? ` · 📞 ${provInfo[f.proveedor].telefono}` : ""}</div>}
        </Fld>
        <Fld label="Vendedor">
          <AutoInp value={f.vendedor} onChange={v => sF({ ...f, vendedor: v })} options={allVendedores} placeholder="BUSCAR VENDEDOR..." strict />
        </Fld>

        {/* Tipo mercancía */}
        <Fld label="Tipo mercancía">
          {f.tipoMercancia === "DESCONOCIDO" ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <div style={{ flex: 1, padding: "7px 10px", borderRadius: 6, background: "#FEF3C7", border: "1px solid #FDE68A", fontSize: 11, color: "#92400E", fontWeight: 600 }}>❓ Desconocido</div>
              <button type="button" onClick={() => sF({ ...f, tipoMercancia: "" })} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #D1D5DB", background: "#fff", fontSize: 11, cursor: "pointer", fontFamily: "inherit", color: "#6B7280" }}>✕ Cambiar</button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 6 }}>
              <AutoInp value={f.tipoMercancia} onChange={v => sF({ ...f, tipoMercancia: v })} options={TIPOS_MERCANCIA} placeholder="BUSCAR TIPO... (opcional)" strict />
              <button type="button" onClick={() => sF({ ...f, tipoMercancia: "DESCONOCIDO" })} title="Marcar como desconocido" style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #FDE68A", background: "#FEF3C7", fontSize: 13, cursor: "pointer", fontFamily: "inherit", color: "#92400E", fontWeight: 700 }}>❓</button>
            </div>
          )}
        </Fld>
        <div style={{ gridColumn: "span 2" }}>
          <Fld label="Descripción mercancía">
            {f.descripcion === "DESCONOCIDO" ? (
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <div style={{ flex: 1, padding: "7px 10px", borderRadius: 6, background: "#FEF3C7", border: "1px solid #FDE68A", fontSize: 11, color: "#92400E", fontWeight: 600 }}>❓ Desconocido</div>
                <button type="button" onClick={() => sF({ ...f, descripcion: "" })} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #D1D5DB", background: "#fff", fontSize: 11, cursor: "pointer", fontFamily: "inherit", color: "#6B7280" }}>✕ Cambiar</button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 6 }}>
                <Inp value={f.descripcion} onChange={e => sF({ ...f, descripcion: e.target.value.toUpperCase() })} placeholder="¿QUÉ PIDIÓ? (opcional)" style={{ textTransform: "uppercase", flex: 1 }} />
                <button type="button" onClick={() => sF({ ...f, descripcion: "DESCONOCIDO" })} title="Marcar como desconocido" style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #FDE68A", background: "#FEF3C7", fontSize: 13, cursor: "pointer", fontFamily: "inherit", color: "#92400E", fontWeight: 700, whiteSpace: "nowrap" }}>❓</button>
              </div>
            )}
          </Fld>
        </div>

        <Fld label="Empaque">
          {f.empaque === "Desconocido" ? (
            <div style={{ padding: "7px 10px", borderRadius: 6, background: "#FEF3C7", border: "1px solid #FDE68A", fontSize: 11, color: "#92400E", fontWeight: 600 }}>❓ Desconocido</div>
          ) : (
            <AutoInp value={f.empaque} onChange={v => sF({ ...f, empaque: v })} options={EMPAQUES} placeholder="TIPO..." strict />
          )}
        </Fld>
        {f.empaque === "Otro" && <Fld label="¿Cuál?"><Inp value={f.empaqueOtro} onChange={e => sF({ ...f, empaqueOtro: e.target.value.toUpperCase() })} placeholder="ESPECIFICAR" style={{ textTransform: "uppercase" }} /></Fld>}
        <Fld label="# Bultos">
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            {f.empaque === "Desconocido" ? (
              <div style={{ flex: 1, padding: "7px 10px", borderRadius: 6, background: "#FEF3C7", border: "1px solid #FDE68A", fontSize: 11, color: "#92400E", fontWeight: 600 }}>❓ Desconocido</div>
            ) : (
              <Inp type="number" value={f.cantBultos} onChange={e => sF({ ...f, cantBultos: e.target.value })} placeholder="1" style={{ flex: 1 }} />
            )}
            <button onClick={() => {
              const isUnknown = f.empaque !== "Desconocido";
              sF({ ...f, empaque: isUnknown ? "Desconocido" : "", cantBultos: isUnknown ? "?" : "1" });
            }} style={{ padding: "6px 8px", borderRadius: 6, border: f.empaque === "Desconocido" ? "2px solid #D97706" : "1px solid #D1D5DB", background: f.empaque === "Desconocido" ? "#FEF3C7" : "#fff", color: f.empaque === "Desconocido" ? "#92400E" : "#6B7280", fontWeight: f.empaque === "Desconocido" ? 700 : 500, fontSize: 10, cursor: "pointer", fontFamily: "inherit" }}>❓</button>
          </div>
        </Fld>

        {/* Pricing mode toggle */}
        <div style={{ gridColumn: "1/-1", background: "#F9FAFB", borderRadius: 8, padding: "10px 12px", marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: "#374151", textTransform: "uppercase" }}>Costo mercancía</span>
            <div style={{ display: "flex", gap: 2, background: "#E5E7EB", borderRadius: 5, padding: 2 }}>
              <button onClick={() => sF({ ...f, modoPrecios: "total" })} style={{ padding: "3px 10px", borderRadius: 4, border: "none", fontSize: 10, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", background: f.modoPrecios === "total" ? "#fff" : "transparent", color: f.modoPrecios === "total" ? "#1A2744" : "#9CA3AF", boxShadow: f.modoPrecios === "total" ? "0 1px 2px rgba(0,0,0,.1)" : "none" }}>Monto total</button>
              <button onClick={() => sF({ ...f, modoPrecios: "unitario" })} style={{ padding: "3px 10px", borderRadius: 4, border: "none", fontSize: 10, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", background: f.modoPrecios === "unitario" ? "#fff" : "transparent", color: f.modoPrecios === "unitario" ? "#1A2744" : "#9CA3AF", boxShadow: f.modoPrecios === "unitario" ? "0 1px 2px rgba(0,0,0,.1)" : "none" }}>Precio unitario</button>
            </div>
          </div>
          {f.modoPrecios === "unitario" ? (
            <div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 10px" }}>
                <Fld label="Cantidad piezas"><Inp type="number" value={f.cantidad} onChange={e => sF({ ...f, cantidad: e.target.value })} placeholder="Piezas" /></Fld>
                <Fld label="Costo unitario USD"><Inp type="number" value={f.costoUnitario} onChange={e => sF({ ...f, costoUnitario: e.target.value })} placeholder="Costo x pieza" /></Fld>
              </div>
              {f.cantidad && f.costoUnitario && <div style={{ fontSize: 11, color: "#6B7280", marginTop: -4 }}>
                Costo total: <strong style={{ color: "#1A2744", fontFamily: "monospace" }}>{fmt(calcCosto)}</strong>
              </div>}
            </div>
          ) : (
            <Fld label="Costo total USD">
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                {f.costoDesconocido ? (
                  <div style={{ flex: 1, padding: "7px 10px", borderRadius: 6, background: "#FEF3C7", border: "1px solid #FDE68A", fontSize: 11, color: "#92400E", fontWeight: 600 }}>❓ Por definir</div>
                ) : (
                  <Inp type="number" value={f.costoMercancia} onChange={e => sF({ ...f, costoMercancia: e.target.value })} placeholder="Monto total" style={{ flex: 1 }} />
                )}
                <button onClick={() => sF({ ...f, costoDesconocido: !f.costoDesconocido, costoMercancia: f.costoDesconocido ? "" : "0" })} style={{ padding: "6px 10px", borderRadius: 6, border: f.costoDesconocido ? "2px solid #D97706" : "1px solid #D1D5DB", background: f.costoDesconocido ? "#FEF3C7" : "#fff", color: f.costoDesconocido ? "#92400E" : "#6B7280", fontWeight: f.costoDesconocido ? 700 : 500, fontSize: 10, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>❓</button>
              </div>
            </Fld>
          )}
        </div>

        {f.pedidoEspecial && (
          <div style={{ gridColumn: "1/-1", background: "#FDF4FF", borderRadius: 8, padding: "12px 14px", border: "2px solid #E9D5FF", marginBottom: 4 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#7C3AED", marginBottom: 10 }}>⭐ Precio especial — el cliente NO verá el costo real</div>
            <div style={{ display: "flex", gap: 3, background: "#E9D5FF", borderRadius: 6, padding: 2, marginBottom: 10 }}>
              <button onClick={() => sF({ ...f, modoEspecial: "total", precioVenta: "" })} style={{ flex: 1, padding: "5px", borderRadius: 5, border: "none", background: (f.modoEspecial !== "pieza") ? "#fff" : "transparent", cursor: "pointer", fontSize: 11, fontWeight: (f.modoEspecial !== "pieza") ? 700 : 500, fontFamily: "inherit", color: (f.modoEspecial !== "pieza") ? "#7C3AED" : "#9CA3AF" }}>📦 Monto total</button>
              <button onClick={() => sF({ ...f, modoEspecial: "pieza", precioVenta: "" })} style={{ flex: 1, padding: "5px", borderRadius: 5, border: "none", background: f.modoEspecial === "pieza" ? "#fff" : "transparent", cursor: "pointer", fontSize: 11, fontWeight: f.modoEspecial === "pieza" ? 700 : 500, fontFamily: "inherit", color: f.modoEspecial === "pieza" ? "#7C3AED" : "#9CA3AF" }}>🔢 Por pieza</button>
            </div>
            {f.modoEspecial === "pieza" ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 10px" }}>
                <Fld label="Costo proveedor x pieza USD">
                  <div style={{ padding: "7px 10px", borderRadius: 6, background: "#F3E8FF", border: "1px solid #E9D5FF", fontSize: 12, fontFamily: "monospace", color: "#7C3AED" }}>
                    {f.costoUnitario ? fmt(parseFloat(f.costoUnitario)) : "—"} <span style={{ fontSize: 9, color: "#9CA3AF" }}>(del campo anterior)</span>
                  </div>
                </Fld>
                <Fld label="Precio de venta x pieza USD *">
                  <Inp type="number" value={f.precioVenta} onChange={e => sF({ ...f, precioVenta: e.target.value })} placeholder="Lo que cobra al cliente" />
                </Fld>
                {f.precioVenta && f.costoUnitario && f.cantidad && (
                  <div style={{ gridColumn: "1/-1", display: "flex", gap: 12, padding: "8px 10px", background: "#fff", borderRadius: 6, border: "1px solid #E9D5FF", fontSize: 11, flexWrap: "wrap" }}>
                    <span>Costo total: <strong style={{ fontFamily: "monospace" }}>{fmt((parseFloat(f.costoUnitario)||0)*(parseFloat(f.cantidad)||0))}</strong></span>
                    <span>Venta total: <strong style={{ fontFamily: "monospace", color: "#059669" }}>{fmt((parseFloat(f.precioVenta)||0)*(parseFloat(f.cantidad)||0))}</strong></span>
                    <span style={{ fontWeight: 700, color: "#059669" }}>Ganancia: {fmt(((parseFloat(f.precioVenta)||0)-(parseFloat(f.costoUnitario)||0))*(parseFloat(f.cantidad)||0))}</span>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 10px" }}>
                <Fld label="Costo real (proveedor) USD">
                  <div style={{ padding: "7px 10px", borderRadius: 6, background: "#F3E8FF", border: "1px solid #E9D5FF", fontSize: 12, fontFamily: "monospace", color: "#7C3AED" }}>
                    {calcCosto ? fmt(calcCosto) : "—"} <span style={{ fontSize: 9, color: "#9CA3AF" }}>(del campo anterior)</span>
                  </div>
                </Fld>
                <Fld label="Precio de venta al cliente USD *">
                  <Inp type="number" value={f.precioVenta} onChange={e => sF({ ...f, precioVenta: e.target.value })} placeholder="Lo que paga el cliente" />
                </Fld>
                {f.precioVenta && calcCosto > 0 && (
                  <div style={{ gridColumn: "1/-1", display: "flex", gap: 12, padding: "8px 10px", background: "#fff", borderRadius: 6, border: "1px solid #E9D5FF", fontSize: 11, flexWrap: "wrap" }}>
                    <span>Costo: <strong style={{ fontFamily: "monospace" }}>{fmt(calcCosto)}</strong></span>
                    <span>Venta: <strong style={{ fontFamily: "monospace", color: "#059669" }}>{fmt(parseFloat(f.precioVenta))}</strong></span>
                    <span style={{ fontWeight: 700, color: "#059669" }}>Ganancia: {fmt(parseFloat(f.precioVenta) - calcCosto)}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        <Fld label="Flete USD">
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            {f.fleteDesconocido ? (
              <div style={{ flex: 1, padding: "7px 10px", borderRadius: 6, background: "#FEF3C7", border: "1px solid #FDE68A", fontSize: 11, color: "#92400E", fontWeight: 600 }}>❓ Por definir</div>
            ) : (
              <Inp type="number" value={f.costoFlete} onChange={e => sF({ ...f, costoFlete: e.target.value })} placeholder="0.00" style={{ flex: 1 }} />
            )}
            <button onClick={() => sF({ ...f, fleteDesconocido: !f.fleteDesconocido, costoFlete: f.fleteDesconocido ? "" : "0" })} style={{ padding: "6px 10px", borderRadius: 6, border: f.fleteDesconocido ? "2px solid #D97706" : "1px solid #D1D5DB", background: f.fleteDesconocido ? "#FEF3C7" : "#fff", color: f.fleteDesconocido ? "#92400E" : "#6B7280", fontWeight: f.fleteDesconocido ? 700 : 500, fontSize: 10, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>❓ Desconocido</button>
          </div>
        </Fld>
        {/* Comisión auto-calculated */}
        {(() => {
          const base = f.costoDesconocido ? 0 : (f.modoPrecios === "unitario" ? (parseFloat(f.cantidad)||0) * (parseFloat(f.costoUnitario)||0) : parseFloat(f.costoMercancia) || 0);
          const comPct = base >= 10000 ? 0.005 : base >= 1000 ? 0.008 : 0;
          const comCalc = Math.round(base * comPct * 100) / 100;
          if (comPct === 0 && !f.cobrarComision) return null;
          return (
            <div style={{ gridColumn: "1/-1", marginBottom: 8 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: f.cobrarComision ? "#F5F3FF" : "#F9FAFB", borderRadius: 6, cursor: "pointer", border: f.cobrarComision ? "2px solid #7C3AED" : "1px solid #E5E7EB" }}>
                <input type="checkbox" checked={f.cobrarComision || false} onChange={e => sF({ ...f, cobrarComision: e.target.checked })} style={{ width: 16, height: 16, accentColor: "#7C3AED" }} />
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: f.cobrarComision ? "#7C3AED" : "#6B7280" }}>💰 Cobrar comisión ({comPct * 100}%)</span>
                  <div style={{ fontSize: 10, color: "#9CA3AF" }}>Base: {fmt(base)} → Comisión: <strong style={{ color: "#7C3AED" }}>{fmt(comCalc)}</strong></div>
                </div>
                <span style={{ fontFamily: "monospace", fontWeight: 700, color: f.cobrarComision ? "#7C3AED" : "#9CA3AF", fontSize: 14 }}>{fmt(comCalc)}</span>
              </label>
            </div>
          );
        })()}
        <div style={{ gridColumn: "1/-1", display: "flex", gap: 8, marginBottom: 10 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: f.urgente ? "#FEE2E2" : "#F9FAFB", borderRadius: 6, cursor: "pointer", border: f.urgente ? "2px solid #DC2626" : "1px solid #E5E7EB", flex: 1 }}>
            <input type="checkbox" checked={f.urgente} onChange={e => sF({ ...f, urgente: e.target.checked })} style={{ width: 16, height: 16, accentColor: "#DC2626" }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: f.urgente ? "#DC2626" : "#6B7280" }}>🔥 Urgente</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: f.soloRecoger ? "#DBEAFE" : "#F9FAFB", borderRadius: 6, cursor: "pointer", border: f.soloRecoger ? "2px solid #2563EB" : "1px solid #E5E7EB", flex: 1 }}>
            <input type="checkbox" checked={f.soloRecoger} onChange={e => sF({ ...f, soloRecoger: e.target.checked })} style={{ width: 16, height: 16, accentColor: "#2563EB" }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: f.soloRecoger ? "#2563EB" : "#6B7280" }}>📦 Solo recoger</span>
          </label>
        </div>
        {f.soloRecoger && <div style={{ gridColumn: "1/-1", background: "#DBEAFE", borderRadius: 6, padding: "6px 10px", border: "1px solid #93C5FD", fontSize: 10, color: "#1E40AF", marginBottom: 8 }}>ℹ️ El cliente ya pagó directo al proveedor. Solo se recoge la mercancía, no pasa dinero por nosotros.</div>}
        <div style={{ gridColumn: "1/-1" }}><Fld label="Notas"><textarea value={f.notas} onChange={e => sF({ ...f, notas: e.target.value })} rows={2} placeholder="Detalles..." style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 12, fontFamily: "inherit", resize: "vertical", background: "#FAFAFA", boxSizing: "border-box" }} /></Fld></div>
      </div>
      {/* Total summary */}
      {(() => {
        const costoBase = f.costoDesconocido ? 0 : (f.modoPrecios === "unitario" ? (parseFloat(f.cantidad)||0) * (parseFloat(f.costoUnitario)||0) : parseFloat(f.costoMercancia) || 0);
        const esPieza = f.pedidoEspecial && f.modoEspecial === "pieza";
        const precioVentaSet = f.pedidoEspecial && f.precioVenta && parseFloat(f.precioVenta) > 0;
        const base = f.pedidoEspecial
          ? (esPieza
              ? (parseFloat(f.precioVenta)||0) * (parseFloat(f.cantidad)||0)
              : (parseFloat(f.precioVenta) || costoBase))
          : costoBase;
        const flete = f.fleteDesconocido ? 0 : (parseFloat(f.costoFlete) || 0);
        const comPct = base >= 10000 ? 0.005 : base >= 1000 ? 0.008 : 0;
        const com = f.cobrarComision ? Math.round(base * comPct * 100) / 100 : 0;
        const total = base + com;
        if (!costoBase && !flete) return null;
        return (
          <div style={{ background: f.pedidoEspecial ? "#F3E8FF" : "#F0FDF4", borderRadius: 8, padding: "10px 14px", border: `1px solid ${f.pedidoEspecial ? "#E9D5FF" : "#BBF7D0"}`, marginTop: 4, marginBottom: 4 }}>
            {f.pedidoEspecial && costoBase > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#9CA3AF", marginBottom: 2 }}>
                <span>Costo real:</span><span style={{ fontFamily: "monospace" }}>{fmt(costoBase)}</span>
              </div>
            )}
            {f.pedidoEspecial && !precioVentaSet && (
              <div style={{ fontSize: 11, color: "#D97706", fontWeight: 600, marginBottom: 4 }}>⚠️ Ingresa el precio de venta arriba para ver el total del cliente</div>
            )}
            {(!f.pedidoEspecial || precioVentaSet) && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                <span>Mercancía:</span><span style={{ fontFamily: "monospace" }}>{fmt(base)}</span>
              </div>
            )}
            {com > 0 && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#7C3AED" }}>
              <span>Comisión:</span><span style={{ fontFamily: "monospace" }}>+{fmt(com)}</span>
            </div>}
            {(!f.pedidoEspecial || precioVentaSet) && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 700, borderTop: `1px solid ${f.pedidoEspecial ? "#E9D5FF" : "#BBF7D0"}`, paddingTop: 4, marginTop: 4 }}>
                <span>Total cliente:</span><span style={{ fontFamily: "monospace", color: f.pedidoEspecial ? "#7C3AED" : "#059669" }}>{fmt(total)}</span>
              </div>
            )}
            {flete > 0 && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#6B7280" }}>
              <span>+ Flete:</span><span style={{ fontFamily: "monospace" }}>{fmt(flete)}</span>
            </div>}
            {f.pedidoEspecial && precioVentaSet && costoBase > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontWeight: 700, color: "#059669", marginTop: 4, paddingTop: 4, borderTop: "1px solid #E9D5FF" }}>
                <span>⭐ Ganancia:</span><span style={{ fontFamily: "monospace" }}>{fmt(base - costoBase)}</span>
              </div>
            )}
          </div>
        );
      })()}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 4, paddingTop: 12, borderTop: "1px solid #E5E7EB" }}>
        <Btn v="secondary" onClick={() => { setShowNew(false) }}>Cancelar</Btn>
        <Btn disabled={!f.cliente.trim() || (!isEdit && !f.soloRecoger && !allProveedores.includes(f.proveedor)) || (!f.soloRecoger && !f.costoDesconocido && f.modoPrecios === "total" && !f.costoMercancia) || (!f.soloRecoger && !f.costoDesconocido && f.modoPrecios === "unitario" && (!f.cantidad || !f.costoUnitario))} onClick={() => {
          const costoM = f.soloRecoger || f.costoDesconocido ? 0 : calcCosto; // costo real del proveedor
          const esPieza = f.pedidoEspecial && f.modoEspecial === "pieza";
          const precioVentaUnit = esPieza ? (parseFloat(f.precioVenta) || 0) : 0;
          const cantPiezas = parseFloat(f.cantidad) || 0;
          // precioVentaFinal = lo que PAGA EL CLIENTE (el mayor, e.g. $6,500)
          // costoM = lo que nos cobra el proveedor (e.g. $6,000)
          const precioVentaFinal = f.pedidoEspecial
            ? (esPieza
                ? precioVentaUnit * cantPiezas          // por pieza: precio venta x piezas
                : (parseFloat(f.precioVenta) || costoM)) // monto total: precio venta al cliente
            : costoM; // normal: el costo es lo que paga el cliente
          const ganancia = f.pedidoEspecial ? (precioVentaFinal - costoM) : null;
          const comPct = precioVentaFinal >= 10000 ? 0.005 : precioVentaFinal >= 1000 ? 0.008 : 0;
          const comCalc = Math.round(precioVentaFinal * comPct * 100) / 100;
          if (isEdit) {
            const costoFleteF = f.fleteDesconocido ? 0 : (parseFloat(f.costoFlete) || 0);
            const newDineroStatus = (f.soloRecoger && !f.fleteDesconocido && !(costoFleteF > 0))
              ? "NO_APLICA"
              : (f.costoDesconocido ? "SIN_FONDOS" : editPedido.dineroStatus);
            updateF(editPedido.id, { ...f,
              costoMercancia: precioVentaFinal,
              costoReal: f.pedidoEspecial ? costoM : null,
              pedidoEspecial: f.pedidoEspecial || false,
              modoEspecial: f.pedidoEspecial ? (f.modoEspecial || "total") : null,
              precioVentaUnitario: esPieza ? precioVentaUnit : null,
              gananciaEspecial: ganancia,
              costoFlete: costoFleteF,
              cantidad: f.modoPrecios === "unitario" ? parseFloat(f.cantidad) || 0 : 0,
              costoUnitario: f.modoPrecios === "unitario" ? parseFloat(f.costoUnitario) || 0 : 0,
              comisionMonto: f.cobrarComision ? comCalc : 0,
              comisionPendiente: f.cobrarComision || false,
              totalVenta: precioVentaFinal + (f.cobrarComision ? comCalc : 0),
              dineroStatus: newDineroStatus,
              fechaActualizacion: today(),
              historial: [...(editPedido.historial || []), { fecha: today(), accion: "✏️ Pedido editado", quien: role }],
            });
          } else {
            addF({ ...f,
              costoMercancia: precioVentaFinal,
              costoReal: f.pedidoEspecial ? costoM : null,
              pedidoEspecial: f.pedidoEspecial || false,
              modoEspecial: f.pedidoEspecial ? (f.modoEspecial || "total") : null,
              precioVentaUnitario: esPieza ? precioVentaUnit : null,
              gananciaEspecial: ganancia,
              costoFlete: f.fleteDesconocido ? 0 : (parseFloat(f.costoFlete) || 0),
              cantidad: f.modoPrecios === "unitario" ? parseFloat(f.cantidad) || 0 : 0,
              costoUnitario: f.modoPrecios === "unitario" ? parseFloat(f.costoUnitario) || 0 : 0,
              comisionMonto: f.cobrarComision ? comCalc : 0,
              comisionPendiente: f.cobrarComision || false,
              totalVenta: precioVentaFinal + (f.cobrarComision ? comCalc : 0)
            });
          }
          setShowNew(false);
        }}>{isEdit ? "💾 Guardar" : <><I.Plus /> Crear</>}</Btn>
      </div>
    </Modal>
  );
};


// ============ TRANSFERENCIAS TJ (module-level) ============


// ─── App Context — allows components to live outside App() ───────────────────
const AppCtx = React.createContext(null);
const useApp = () => React.useContext(AppCtx);
// ─────────────────────────────────────────────────────────────────────────────

// ─── Persistent form state cache ─────────────────────────────────────────────
// Components defined inside App() remount on every Firestore update.
// This cache persists form data across remounts so users never lose what they typed.
const _cache = {};
const _modals = {};
const useModalState = (key, initial = false) => {
  const [val, setVal] = useState(() => _modals[key] ?? initial);
  const setter = useCallback((v) => {
    const next = typeof v === "function" ? v(_modals[key] ?? initial) : v;
    _modals[key] = next;
    setVal(next);
  }, [key]);
  return [val, setter];
};
const usePersistedForm = (key, initial) => {
  const [val, setVal] = useState(() => _cache[key] ?? (typeof initial === 'function' ? initial() : initial));
  const setter = useCallback((v) => {
    setVal(prev => {
      const next = typeof v === 'function' ? v(prev) : v;
      _cache[key] = next;
      return next;
    });
  }, [key]);
  return [val, setter];
};
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  const [data, setData] = useState(init());
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState(() => {
    try { return localStorage.getItem("ot_role") || null; } catch { return null; }
  });
  const [currentUser, setCurrentUser] = useState(() => {
    try { return localStorage.getItem("ot_user") || null; } catch { return null; }
  });
  const [loginUser, setLoginUser] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [loginError, setLoginError] = useState("");
  const [remember, setRemember] = useState(false);
  const [view, setView] = useState(() => {
    // On reload, restore correct home view based on saved role
    try {
      const savedRole = localStorage.getItem("ot_role");
      if (savedRole) {
        const u = USERS.find(x => x.role === savedRole);
        return u?.startView === "main" ? "home" : u?.startView || "home";
      }
    } catch {}
    return "main";
  });
  const [prevView, setPrevView] = useState("main");
  const [selId, setSelId] = useState(null);
  // Bitacora states — lifted to App level to survive remounts
  const [bitSk, setBitSk] = useState("fechaCreacion");
  const [bitSd, setBitSd] = useState(-1);
  const [bitModo, setBitModo] = useState("axia");
  const [bitTab, setBitTab] = useState("estado");
  const [bitFProv, setBitFProv] = useState("ALL");
  const [bitFCli, setBitFCli] = useState("ALL");
  const [bitFVend, setBitFVend] = useState("ALL");
  const [bitSearch, setBitSearch] = useState("");
  const [bitPagoMerc, setBitPagoMerc] = useState("ALL");
  const [bitPagoFlete, setBitPagoFlete] = useState("ALL");
  const [bitEstado, setBitEstado] = useState("ALL");
    // Modal states lifted to App level to prevent closure on Firestore updates
  const [showMovApp, setShowMovApp] = useState(false);
  const [showAdelantoApp, setShowAdelantoApp] = useState(false);
  const [showGastoApp, setShowGastoApp] = useState(false);
  const [showCobroApp, setShowCobroApp] = useState(false);
  const [showGastoUSAApp, setShowGastoUSAApp] = useState(false);
    const [showNew, setShowNew] = useState(false);
  const [editPedidoId, setEditPedidoId] = useState(null);
  const [showColchon, setShowColchon] = useState(false);
  const [showTransApp, setShowTransApp] = useState(false);
  const [tFormTipo, setTFormTipo] = useState("flete"); // only tipo lives at App level to survive re-renders
  const [search, setSearch] = useState("");
  const [fEst, setFEst] = useState("ALL");

  // Browser back/forward navigation
  const navigate = useCallback((newView, newSelId = null, newPrevView = null) => {
    const state = { view: newView, selId: newSelId, prevView: newPrevView ?? view };
    window.history.pushState(state, "", "#" + newView + (newSelId ? "/" + newSelId : ""));
    setView(newView);
    if (newSelId !== undefined) setSelId(newSelId);
    if (newPrevView !== null) setPrevView(newPrevView);
  }, [view]);

  useEffect(() => {
    // Set initial history state
    window.history.replaceState({ view, selId, prevView }, "", "#" + view);
    const onPop = (e) => {
      if (!e.state) return;
      setView(e.state.view || "main");
      setSelId(e.state.selId || null);
      setPrevView(e.state.prevView || "main");
      setMenuOpen(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []); // eslint-disable-line
  const [fPagoMerc, setFPagoMerc] = useState("ALL");
  const [fPagoFlete, setFPagoFlete] = useState("ALL");
  const [confirm, setConfirm] = useState(null);
  const [detailMode, setDetailMode] = useState("full");
  const [usaTab, setUsaTab] = useState("pendientes");
  const [tjTab, setTjTab] = useState("recibir");
  const [atTab, setAtTab] = useState("pendientes");
  const [finTab, setFinTab] = useState("efectivo");
  const [pagoTabApp, setPagoTabApp] = useState("mercancia");
  const [flujoSubTabApp, setFlujoSubTabApp] = useState("clientes");

  // ── Global dialog system (replaces window.alert / window.confirm) ──
  const [dialog, setDialog] = useState(null);
  // dialog = { type: "alert"|"confirm", title, msg, onOk, onCancel }
  const showAlert = (msg, title = "Aviso") => new Promise(resolve => {
    setDialog({ type: "alert", title, msg, onOk: () => { setDialog(null); resolve(); } });
  });
  const showConfirm = (msg, title = "¿Confirmar?") => new Promise(resolve => {
    setDialog({ type: "confirm", title, msg,
      onOk:     () => { setDialog(null); resolve(true);  },
      onCancel: () => { setDialog(null); resolve(false); },
    });
  });
  const [corteExp, setCorteExp] = useState(null);
  const [periodoTipo, setPeriodoTipo] = useState("semana"); // global, año, mes, semana
  const [periodoOffset, setPeriodoOffset] = useState(0); // 0=current, -1=previous, etc
  const [menuOpen, setMenuOpen] = useState(false);

  // Date range helper
  const getDateRange = () => {
    if (periodoTipo === "global") return null;
    const now = new Date();
    let start, end;
    if (periodoTipo === "año") {
      const y = now.getFullYear() + periodoOffset;
      start = new Date(y, 0, 1); end = new Date(y, 11, 31);
    } else if (periodoTipo === "mes") {
      const d = new Date(now.getFullYear(), now.getMonth() + periodoOffset, 1);
      start = d; end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    } else if (periodoTipo === "semana") {
      const d = new Date(now);
      d.setDate(d.getDate() + periodoOffset * 7);
      const day = d.getDay(); const diff = day === 0 ? -6 : 1 - day; // Monday start
      start = new Date(d); start.setDate(d.getDate() + diff);
      end = new Date(start); end.setDate(start.getDate() + 6);
    }
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  };
  const periodoLabel = () => {
    if (periodoTipo === "global") return "Historial Global";
    const r = getDateRange(); if (!r) return "";
    const opts = { year: "numeric", month: "short", day: "numeric" };
    if (periodoTipo === "año") return `Año ${new Date(r.start).getFullYear()}`;
    if (periodoTipo === "mes") { const d = new Date(r.start); return d.toLocaleDateString("es-MX", { year: "numeric", month: "long" }).toUpperCase(); }
    if (periodoTipo === "semana") return `${new Date(r.start).toLocaleDateString("es-MX", { day: "numeric", month: "short" })} — ${new Date(r.end).toLocaleDateString("es-MX", { day: "numeric", month: "short" })}`;
  };
  const filterByDate = (list, dateField = "fechaCreacion") => {
    const r = getDateRange(); if (!r) return list;
    return list.filter(f => { const d = f[dateField] || f.fechaCreacion || ""; return d >= r.start && d <= r.end; });
  };
  const calcSaldoAnterior = (list, dateField = "fecha") => {
    const r = getDateRange(); if (!r) return { usd: 0, mxn: 0 };
    const prev = list.filter(f => (f[dateField] || "") < r.start);
    const usdMov = prev.filter(m => m.moneda !== "MXN");
    const mxnMov = prev.filter(m => m.moneda === "MXN");
    const usd = usdMov.filter(m => m.tipoMov === "ingreso").reduce((s, m) => s + (m.monto || 0), 0) - usdMov.filter(m => m.tipoMov !== "ingreso").reduce((s, m) => s + (m.monto || 0), 0);
    const mxn = mxnMov.filter(m => m.tipoMov === "ingreso").reduce((s, m) => s + (m.monto || m.montoOriginal || 0), 0) - mxnMov.filter(m => m.tipoMov !== "ingreso").reduce((s, m) => s + (m.monto || m.montoOriginal || 0), 0);
    return { usd, mxn };
  };


  const prevDataRef = useRef(null);
  const formOpenRef = useRef(false);
  const lastActivityRef = useRef(0);
  // Track user activity — pause listeners for 3s after any interaction
  const inputFocusedRef = useRef(false);
  const _activityThrottle = useRef(0);
  const onUserActivity = () => {
    const now = Date.now();
    if (now - _activityThrottle.current > 500) {
      lastActivityRef.current = now;
      _activityThrottle.current = now;
    }
  };
  // Register focus listeners once on mount only
  useEffect(() => {
    const onFocusIn = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        inputFocusedRef.current = true;
        lastActivityRef.current = Date.now();
      }
    };
    const onFocusOut = () => {
      inputFocusedRef.current = false;
      lastActivityRef.current = Date.now();
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);
  const [onlineUsers, setOnlineUsers] = useState([]);

  // Cuando showNew está abierto, pausar los listeners para no interrumpir
  useEffect(() => {
    formOpenRef.current = showNew || showColchon || showTransApp || showMovApp || showAdelantoApp || showGastoApp || showCobroApp || showGastoUSAApp;
  }, [showNew, showColchon, showTransApp, showMovApp, showAdelantoApp, showGastoApp, showCobroApp, showGastoUSAApp]);

  // ── Presence system ─────────────────────────────────────────────
  useEffect(() => {
    if (!role || !currentUser) return;
    const presenceRef = doc(db, "presence", currentUser);
    const ROLE_LABELS = { admin: "Admin", bodegatj: "Bodega TJ", usa: "Bodega USA", vendedor: "Vendedor" };

    // Register presence
    const updatePresence = () => setDoc(presenceRef, {
      user: currentUser, role, label: ROLE_LABELS[role] || role,
      lastSeen: Date.now(), online: true
    });
    updatePresence();

    // Heartbeat every 30s
    const heartbeat = setInterval(updatePresence, 30000);

    // Remove on tab close
    const handleUnload = () => setDoc(presenceRef, { user: currentUser, role, online: false, lastSeen: Date.now() });
    window.addEventListener("beforeunload", handleUnload);

    // Listen to all online users
    const unsubPresence = onSnapshot(collection(db, "presence"), (snap) => {
      const now = Date.now();
      const active = snap.docs
        .map(d => d.data())
        .filter(u => u.online && u.user !== currentUser && (now - (u.lastSeen || 0)) < 90000);
      setOnlineUsers(prev => {
        const prevSig = prev.map(u => u.user).sort().join(',');
        const newSig = active.map(u => u.user).sort().join(',');
        return prevSig === newSig ? prev : active; // Only re-render if users changed
      });
    });

    return () => {
      clearInterval(heartbeat);
      window.removeEventListener("beforeunload", handleUnload);
      unsubPresence();
      setDoc(presenceRef, { user: currentUser, role, online: false, lastSeen: Date.now() });
    };
  }, [role, currentUser]);

  useEffect(() => {
    // Safety timeout — if Firebase takes too long, show empty app
    const timeout = setTimeout(() => { setLoading(false); }, 8000);

    // Initial load from Firestore
    loadAll().then(d => {
      clearTimeout(timeout);
      const APP_VERSION = 3;
      if ((d._appVersion || 0) < APP_VERSION) {
        // MIGRATE: don't wipe existing data, just update version and save to new structure
        d._appVersion = APP_VERSION;
        if ((d.nextId || 0) < 2800) d.nextId = 2800;
        prevDataRef.current = d;
        setData(d);
        saveAll(d, null); // saves to new Firestore structure
        setLoading(false);
        return;
      }
      // Sync dineroStatus
      const PRESERVE_STATUS = ["DINERO_CAMINO","SOBRE_LISTO","DINERO_USA","COLCHON_USADO","TRANS_PENDIENTE","NO_APLICA"];
      // ── Repair: detect race-condition orphans ─────────────────────
      // If a fantasma is SOBRE_LISTO but already has a "SOBRE USA: F-XXXX" egreso in gastosAdmin,
      // the dineroStatus write was lost — correct it to DINERO_CAMINO
      const _sobreEgresoIds = new Set(
        (d.gastosAdmin || [])
          .filter(m => (m.concepto || "").startsWith("SOBRE USA:") && m.tipoMov === "egreso")
          .map(m => { const match = (m.concepto || "").match(/F-\d+/); return match ? match[0] : null; })
          .filter(Boolean)
      );
      // ─────────────────────────────────────────────────────────────
      const _fantasmasBeforeSync = d.fantasmas; // snapshot before corrections
      d.fantasmas = d.fantasmas.map(f => {
        // soloRecoger without real flete cost always stays NO_APLICA
        if (f.soloRecoger && !f.fleteDesconocido && !(f.costoFlete > 0)) {
          if (f.dineroStatus !== "NO_APLICA") return { ...f, dineroStatus: "NO_APLICA" };
          return f;
        }
        // Repair: SOBRE_LISTO but egreso already in gastosAdmin → race condition, fix to DINERO_CAMINO
        if (f.dineroStatus === "SOBRE_LISTO" && _sobreEgresoIds.has(f.id)) {
          console.log(`[repair] ${f.id} corrected SOBRE_LISTO → DINERO_CAMINO (orphaned egreso found)`);
          return { ...f, dineroStatus: "DINERO_CAMINO", adelantoAdmin: true };
        }
        // Never touch statuses that represent money in transit or already received
        if (PRESERVE_STATUS.includes(f.dineroStatus)) return f;
        const mercPagado = f.clientePago;
        const fleteOk = f.fletePagado || (f.soloRecoger && !f.fleteDesconocido && !(f.costoFlete > 0));
        // Downgrade TODO_PAGADO if flete is not actually paid
        if (f.dineroStatus === "TODO_PAGADO" && mercPagado && !fleteOk) return { ...f, dineroStatus: "FANTASMA_PAGADO" };
        if (f.dineroStatus === "TODO_PAGADO" && !mercPagado) return { ...f, dineroStatus: fleteOk ? "FLETE_PAGADO" : "SIN_FONDOS" };
        if (mercPagado && fleteOk && f.dineroStatus !== "TODO_PAGADO") return { ...f, dineroStatus: "TODO_PAGADO" };
        if (mercPagado && !fleteOk && !["TODO_PAGADO","FANTASMA_PAGADO"].includes(f.dineroStatus)) return { ...f, dineroStatus: "FANTASMA_PAGADO" };
        if (!mercPagado && f.fletePagado && f.costoFlete > 0 && !["TODO_PAGADO","FLETE_PAGADO"].includes(f.dineroStatus)) return { ...f, dineroStatus: "FLETE_PAGADO" };
        return f;
      });
      if ((d.nextId || 0) < 2800) d.nextId = 2800;
      prevDataRef.current = d;
      setData(d);
      setLoading(false);
      // Persist any dineroStatus corrections back to Firestore so realtime listener doesn't overwrite them
      const _corrected = d.fantasmas.filter((f, i) => f !== _fantasmasBeforeSync[i]);
      if (_corrected.length > 0) {
        const _fixBatch = writeBatch(db);
        _corrected.forEach(f => _fixBatch.set(doc(db, "fantasmas", f.id), f));
        _fixBatch.commit().catch(e => console.warn("Auto dineroStatus fix save failed:", e));
      }
    });

    // Real-time listener — syncs fantasmas changes from other users instantly
    const unsubFantasmas = onSnapshot(collection(db, "fantasmas"), (snap) => {
      if (formOpenRef.current || inputFocusedRef.current || Date.now() - lastActivityRef.current < 2000) return;
      const remoteFantasmas = snap.docs.map(d => d.data());
      setData(prev => {
        if (!prev) return prev;
        // Skip if nothing actually changed (prevents needless remounts)
        if (prev.fantasmas && prev.fantasmas.length === remoteFantasmas.length) {
          const prevSig = prev.fantasmas.map(f => f.id + (f.fechaActualizacion||'')).join('');
          const newSig = remoteFantasmas.map(f => f.id + (f.fechaActualizacion||'')).join('');
          if (prevSig === newSig) return prev;
        }
        const updated = { ...prev, fantasmas: remoteFantasmas };
        prevDataRef.current = updated;
        return updated;
      });
    }, (err) => console.error("Realtime listener error:", err));

    const unsubMeta = onSnapshot(configDoc("meta"), (snap) => {
      if (!snap.exists() || formOpenRef.current || inputFocusedRef.current || Date.now() - lastActivityRef.current < 2000) return;
      const meta = snap.data();
      setData(prev => {
        if (!prev) return prev;
        const updated = { ...prev,
          nextId: meta.nextId ?? prev.nextId,
          vendedores: meta.vendedores ?? prev.vendedores,
          clientes: meta.clientes ?? prev.clientes,
          proveedoresList: meta.proveedoresList ?? prev.proveedoresList,
          provUbicaciones: meta.provUbicaciones ?? prev.provUbicaciones,
          proveedoresInfo: meta.proveedoresInfo ?? prev.proveedoresInfo,
        };
        prevDataRef.current = updated;
        return updated;
      });
    });

    const unsubFinanzas = onSnapshot(configDoc("finanzas"), (snap) => {
      if (!snap.exists() || formOpenRef.current || inputFocusedRef.current || Date.now() - lastActivityRef.current < 2000) return;
      const fin = snap.data();
      setData(prev => {
        if (!prev) return prev;
        // Skip if finanzas hasn't changed
        const finSig = (fin.adelantosAdmin||[]).length + '_' + (fin.gastosAdmin||[]).length + '_' + (fin.transferencias||[]).length;
        const prevSig = (prev.adelantosAdmin||[]).length + '_' + (prev.gastosAdmin||[]).length + '_' + (prev.transferencias||[]).length;
        if (finSig === prevSig && JSON.stringify(fin.fondos) === JSON.stringify(prev.fondos)) return prev;
        const updated = { ...prev,
          gastosAdmin: fin.gastosAdmin ?? prev.gastosAdmin,
          gastosUSA: fin.gastosUSA ?? prev.gastosUSA,
          gastosBodega: fin.gastosBodega ?? prev.gastosBodega,
          transferencias: fin.transferencias ?? prev.transferencias,
          adelantosAdmin: fin.adelantosAdmin ?? prev.adelantosAdmin,
        };
        prevDataRef.current = updated;
        return updated;
      });
    });

    const unsubColchon = onSnapshot(configDoc("colchon"), (snap) => {
      if (!snap.exists() || formOpenRef.current || inputFocusedRef.current || Date.now() - lastActivityRef.current < 2000) return;
      setData(prev => {
        if (!prev) return prev;
        const updated = { ...prev, colchon: snap.data().data ?? prev.colchon };
        prevDataRef.current = updated;
        return updated;
      });
    });

    const unsubCuentas = onSnapshot(configDoc("cuentas"), (snap) => {
      if (!snap.exists() || formOpenRef.current || inputFocusedRef.current || Date.now() - lastActivityRef.current < 2000) return;
      const c = snap.data();
      setData(prev => {
        if (!prev) return prev;
        const updated = { ...prev,
          cuentasPorPagar: c.cuentasPorPagar ?? prev.cuentasPorPagar,
          cuentasPorCobrarEmp: c.cuentasPorCobrarEmp ?? prev.cuentasPorCobrarEmp,
        };
        prevDataRef.current = updated;
        return updated;
      });
    });

    return () => {
      clearTimeout(timeout);
      unsubFantasmas();
      unsubMeta();
      unsubFinanzas();
      unsubColchon();
      unsubCuentas();
    };
  }, []);

  const [saveStatus, setSaveStatus] = useState("ok");
  const persist = useCallback(nd => {
    setData(nd);
    setSaveStatus("saving");
    saveAll(nd, prevDataRef.current).then(result => {
      prevDataRef.current = nd;
      if (result === true) setSaveStatus("ok");
      else if (result === "local") setSaveStatus("local");
      else setSaveStatus("error");
      setTimeout(() => setSaveStatus("ok"), 3000);
    });
  }, []);

  // ---- DATA OPS ----
  const addF = (form) => {
    const id = genId(data.nextId);
    const cant = parseFloat(form.cantidad) || 0;
    const cu = parseFloat(form.costoUnitario) || 0;
    // If pedidoEspecial, costoMercancia already set to precioVentaFinal by caller
    // If normal, calculate from quantity or direct input
    const costoM = form.pedidoEspecial
      ? (parseFloat(form.costoMercancia) || 0)
      : (cant && cu ? cant * cu : parseFloat(form.costoMercancia) || 0);
    const nf = {
      id,
      cliente: (form.cliente || "").toUpperCase(),
      descripcion: form.descripcion,
      tipoMercancia: form.tipoMercancia || "",
      proveedor: (form.proveedor || "").toUpperCase(),
      ubicacionProv: form.ubicacionProv || "",
      vendedor: (form.vendedor || "").toUpperCase(),
      empaque: form.empaque === "Otro" ? (form.empaqueOtro || "Otro") : (form.empaque || ""),
      cantBultos: parseInt(form.cantBultos) || 1,
      cantidad: cant,
      costoUnitario: cu,
      costoMercancia: costoM,
      costoFlete: parseFloat(form.costoFlete) || 0,
      urgente: form.urgente || false,
      soloRecoger: form.soloRecoger || false,
      fleteDesconocido: form.fleteDesconocido || false,
      costoDesconocido: form.costoDesconocido || false,
      // ⭐ Pedido especial fields
      pedidoEspecial: form.pedidoEspecial || false,
      costoReal: form.pedidoEspecial ? (form.costoReal ?? null) : null,
      gananciaEspecial: form.pedidoEspecial ? (form.gananciaEspecial ?? null) : null,
      modoEspecial: form.pedidoEspecial ? (form.modoEspecial || "total") : null,
      gananciaSeparada: false,
      totalVenta: form.totalVenta || costoM,
      estado: "PEDIDO",
      dineroStatus: (form.soloRecoger || form.costoDesconocido) ? "NO_APLICA" : "SIN_FONDOS",
      fechaCreacion: today(),
      fechaActualizacion: today(),
      clientePago: form.soloRecoger ? true : false,
      clientePagoMonto: 0,
      abonoMercancia: 0,
      abonoFlete: 0,
      abonoProveedor: 0,
      proveedorPagado: form.soloRecoger ? true : false,
      fletePagado: false,
      usaColchon: false,
      creditoProveedor: false,
      notas: form.notas || "",
      movimientos: [],
      historial: [{ fecha: today(), accion: form.soloRecoger ? "Pedido creado (Solo recoger — cliente pagó directo)" : form.costoDesconocido ? "Pedido creado (Costo por definir)" : form.pedidoEspecial ? `Pedido especial creado — Ganancia: ${fmt(form.gananciaEspecial || 0)}` : "Pedido creado", quien: (form.vendedor || "Sistema").toUpperCase() }]
    };
    const vendedores = data.vendedores || [];
    const clientes = data.clientes || [];
    const proveedoresList = data.proveedoresList || [];
    const provUbicaciones = { ...(data.provUbicaciones || {}) };
    if (form.proveedor && form.ubicacionProv) provUbicaciones[form.proveedor] = form.ubicacionProv;
    const newVendedores = form.vendedor && !vendedores.includes(form.vendedor) ? [...vendedores, form.vendedor] : vendedores;
    const newClientes = form.cliente && !clientes.includes(form.cliente) ? [...clientes, form.cliente] : clientes;
    const newProveedores = form.proveedor && !proveedoresList.includes(form.proveedor) ? [...proveedoresList, form.proveedor] : proveedoresList;
    persist({ ...data, fantasmas: [nf, ...data.fantasmas], nextId: data.nextId + 1, vendedores: newVendedores, clientes: newClientes, proveedoresList: newProveedores, provUbicaciones });
    setShowNew(false)
  };
  // Helper: determine dineroStatus based on payment state
  const calcDineroStatus = (f) => {
    // soloRecoger with no real flete → always NO_APLICA
    if (f.soloRecoger && !f.fleteDesconocido && !(f.costoFlete > 0)) return "NO_APLICA";
    const mercPagado = f.clientePago;
    const fleteOk = f.fletePagado || (f.soloRecoger && !f.fleteDesconocido && !(f.costoFlete > 0));
    if (mercPagado && fleteOk) return "TODO_PAGADO";
    if (mercPagado) return "FANTASMA_PAGADO";
    if (f.fletePagado && f.costoFlete > 0) return "FLETE_PAGADO";
    return null; // don't override
  };

  const updF = (id, ch) => {
    persist({ ...data, fantasmas: data.fantasmas.map(f => {
      if (f.id !== id) return f;
      const updated = { ...f, ...ch, fechaActualizacion: today(), historial: [...(f.historial || []), { fecha: today(), accion: `✏️ Pedido editado`, quien: role || "sys" }] };
      // Only auto-sync dineroStatus if caller didn't explicitly set one
      if (!ch.dineroStatus) {
        const ds = calcDineroStatus(updated);
        const preserve = ["DINERO_CAMINO","SOBRE_LISTO","DINERO_USA","COLCHON_USADO","TRANS_PENDIENTE","NO_APLICA"];
        if (ds === "NO_APLICA") {
          updated.dineroStatus = "NO_APLICA";
        } else if (ds && !preserve.includes(updated.dineroStatus)) {
          updated.dineroStatus = ds;
        }
      }
      return updated;
    }) });
  };
  const addMov = (fId, m) => { persist({ ...data, fantasmas: data.fantasmas.map(f => f.id !== fId ? f : { ...f, movimientos: [...(f.movimientos || []), { ...m, id: Date.now(), fecha: m.fecha || today() }], fechaActualizacion: today(), historial: [...(f.historial || []), { fecha: today(), accion: `Mov: ${m.tipo} ${fmt(m.monto)}`, quien: role }] }) }); };
  const delMov = (fId, mId) => { persist({ ...data, fantasmas: data.fantasmas.map(f => f.id !== fId ? f : { ...f, movimientos: (f.movimientos || []).filter(m => m.id !== mId) }) }); };
  const delF = (id) => {
    const f = data.fantasmas.find(x => x.id === id);
    let nd = { ...data, fantasmas: data.fantasmas.filter(f => f.id !== id) };
    nd = { ...nd, envios: (nd.envios || []).map(e => ({ ...e, pedidos: e.pedidos.filter(p => p.id !== id) })).filter(e => e.pedidos.length > 0) };
    nd = { ...nd, transferencias: (nd.transferencias || []).filter(t => t.pedidoId !== id) };
    nd = { ...nd, adelantosAdmin: (nd.adelantosAdmin || []).filter(a => a.pedidoId !== id) };
    // Remove gastosBodega cobros linked to this pedido
    nd = { ...nd, gastosBodega: (nd.gastosBodega || []).filter(g => !(g.concepto || "").includes(id)) };
    // Remove bitacoraGanancias entries for this pedido
    nd = { ...nd, bitacoraGanancias: (nd.bitacoraGanancias || []).filter(b => b.pedidoId !== id) };
    // Remove gastosAdmin adelanto entries for this pedido
    const adelIds = new Set((data.adelantosAdmin || []).filter(a => a.pedidoId === id).map(a => a.movRef));
    nd = { ...nd, gastosAdmin: (nd.gastosAdmin || []).filter(g => !adelIds.has(g.id)) };
    // Clean up CxP abonos linked to this pedido's flete
    if (f && f.fletePagadoCxp) {
      nd.cuentasPorPagar = (nd.cuentasPorPagar || []).map(c => {
        if (c.cliente !== f.fletePagadoCxp) return c;
        const fleeteMovs = (c.movs || []).filter(mv => (mv.d || "").includes(f.id.slice(0,6)) || ((mv.d || "").toLowerCase().includes("flete") && mv.m === f.costoFlete));
        if (fleeteMovs.length === 0) return c;
        const totalRevert = fleeteMovs.reduce((s, mv) => s + mv.m, 0);
        return { ...c, abonado: Math.max(0, (c.abonado || 0) - totalRevert), movs: (c.movs || []).filter(mv => !fleeteMovs.includes(mv)) };
      });
    }
    persist(nd);
    if (selId === id) { navigate("ventas", null); }
    setConfirm(null);
  };
  const updColchon = (ch) => { persist({ ...data, colchon: { ...data.colchon, ...ch } }); };
  const addColMov = (m) => { const d = m.tipo === "Entrada" ? m.monto : -m.monto; persist({ ...data, colchon: { ...data.colchon, saldoActual: (data.colchon.saldoActual || 0) + d, movimientos: [...(data.colchon.movimientos || []), { ...m, id: Date.now(), fecha: today() }] } }); };

  // ---- FILTERED DATA ----
  const roleFantasmas = useMemo(() => {
    if (!data) return [];
    if (role === "admin") return data.fantasmas;
    // All non-admin roles see all non-closed pedidos
    return data.fantasmas.filter(f => f.estado !== "CERRADO");
  }, [data, role]);

  // Date-filtered fantasmas for stats, ventas list, bitacora
  const dateFilteredFantasmas = useMemo(() => filterByDate(data?.fantasmas || []), [data, periodoTipo, periodoOffset]);

  const filtered = useMemo(() => {
    let list = roleFantasmas;
    if (search) { const s = search.toLowerCase().trim(); const sNum = s.replace(/[^0-9]/g, ""); list = list.filter(f => f.cliente.toLowerCase().includes(s) || f.descripcion.toLowerCase().includes(s) || f.id.toLowerCase().includes(s) || (sNum && f.id.includes(sNum)) || (f.proveedor || "").toLowerCase().includes(s) || (f.vendedor || "").toLowerCase().includes(s) || (f.tipoMercancia || "").toLowerCase().includes(s)); }
    if (fEst !== "ALL") list = list.filter(f => f.estado === fEst);
    if (fPagoMerc === "pagado") list = list.filter(f => f.clientePago);
    if (fPagoMerc === "pendiente") list = list.filter(f => !f.clientePago);
    if (fPagoFlete === "pagado") list = list.filter(f => f.fletePagado);
    if (fPagoFlete === "pendiente") list = list.filter(f => !f.fletePagado && f.costoFlete > 0);
    return list;
  }, [roleFantasmas, search, fEst, fPagoMerc, fPagoFlete]);

  const sel = useMemo(() => data?.fantasmas.find(f => f.id === selId), [data, selId]);

  const stats = useMemo(() => {
    if (!data) return {};
    const src = roleFantasmas;
    const act = src.filter(f => f.estado !== "CERRADO");
    const pend = act.filter(f => !f.clientePago);
    const deuda = pend.reduce((s, f) => s + f.costoMercancia + f.costoFlete - (f.clientePagoMonto || 0), 0);
    const credP = act.filter(f => f.creditoProveedor && !f.proveedorPagado).reduce((s, f) => s + f.costoMercancia, 0);
    return { total: src.length, activos: act.length, deuda, pend: pend.length, credP };
  }, [data, roleFantasmas]);

  if (loading) return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#F0F2F5", fontFamily: "'DM Sans', sans-serif", gap: 16 }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ width: 36, height: 36, border: "3px solid #E5E7EB", borderTopColor: "#1A2744", borderRadius: "50%", animation: "spin .7s linear infinite" }} />
      <div style={{ fontSize: 12, color: "#6B7280" }}>Conectando con Firebase...</div>
    </div>
  );

  // ============ LOGIN SCREEN ============
  if (!role) {
    const handleLogin = (remember) => {
      const user = USERS.find(u => u.username === loginUser.trim() && u.password === loginPass);
      if (user) {
        setCurrentUser(user.username);
        setRole(user.role);
        navigate("home");
        setLoginError("");
        if (remember) {
          try { localStorage.setItem("ot_role", user.role); localStorage.setItem("ot_user", user.username); } catch {}
        } else {
          try { localStorage.removeItem("ot_role"); localStorage.removeItem("ot_user"); } catch {}
        }
      } else {
        setLoginError("Usuario o contraseña incorrectos.");
      }
    };
    return (
      <div style={{ minHeight: "100vh", background: "linear-gradient(135deg, #0F172A 0%, #1E293B 50%, #1A2744 100%)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Sans', 'Segoe UI', sans-serif", padding: 16 }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet" />
        <div style={{ width: "100%", maxWidth: 380 }}>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <div style={{ fontSize: 56, marginBottom: 12 }}>👻</div>
            <h1 style={{ color: "#fff", fontSize: 26, fontWeight: 700, margin: "0 0 4px" }}>OchoaTransport</h1>
            <p style={{ color: "#94A3B8", fontSize: 13, margin: 0 }}>Sistema de Control de Fantasmas</p>
          </div>
          <div style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 16, padding: 28 }}>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", color: "#94A3B8", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Usuario</label>
              <input value={loginUser} onChange={e => setLoginUser(e.target.value)} onKeyDown={e => e.key === "Enter" && handleLogin(remember)} placeholder="Nombre de usuario" style={{ width: "100%", padding: "10px 14px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.08)", color: "#fff", fontSize: 14, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: "block", color: "#94A3B8", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Contraseña</label>
              <input type="password" value={loginPass} onChange={e => setLoginPass(e.target.value)} onKeyDown={e => e.key === "Enter" && handleLogin(remember)} placeholder="••••••••" style={{ width: "100%", padding: "10px 14px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.08)", color: "#fff", fontSize: 14, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
            </div>
            {loginError && <div style={{ background: "rgba(220,38,38,0.2)", border: "1px solid rgba(220,38,38,0.4)", borderRadius: 8, padding: "8px 12px", marginBottom: 16, color: "#FCA5A5", fontSize: 12 }}>⚠️ {loginError}</div>}
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, cursor: "pointer" }}>
              <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} style={{ width: 16, height: 16, accentColor: "#2563EB", cursor: "pointer" }} />
              <span style={{ color: "#94A3B8", fontSize: 12 }}>Mantener sesión iniciada</span>
            </label>
            <button onClick={() => handleLogin(remember)} style={{ width: "100%", padding: "11px", borderRadius: 8, border: "none", background: "#1D4ED8", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
              Entrar →
            </button>
          </div>
          <div style={{ marginTop: 8, fontSize: 10, color: "#4B5563", textAlign: "center" }}>{data.fantasmas.length} pedidos en el sistema</div>
        </div>
      </div>
    );
  }

  // ============ HOME SCREEN (post-login section picker) ============
  const HOME_SECTIONS = {
    admin:    [
      { k: "ventas",    emoji: "📋", title: "Pedidos",        sub: "Crear pedidos, cobros y urgencias",           color: "#D97706", bg: "#FFF7ED", border: "#FED7AA" },
      { k: "bodegausa", emoji: "🇺🇸", title: "Bodega USA",    sub: "Recolección, proveedores, envíos a TJ",       color: "#1E40AF", bg: "#EFF6FF", border: "#BFDBFE" },
      { k: "bodegatj",  emoji: "🇲🇽", title: "Bodega TJ",     sub: "Recibir envíos, entregas y cobros",           color: "#065F46", bg: "#ECFDF5", border: "#A7F3D0" },
      { k: "main",      emoji: "⚙️", title: "Administración", sub: "Control total — Dashboard, bitácora, finanzas", color: "#92400E", bg: "#F9FAFB", border: "#D1D5DB" },
    ],
    bodegatj: [
      { k: "ventas",    emoji: "📋", title: "Pedidos",       sub: "Crear pedidos, cobros y urgencias",     color: "#D97706", bg: "#FFF7ED", border: "#FED7AA" },
      { k: "bodegausa", emoji: "🇺🇸", title: "Bodega USA",   sub: "Recolección, proveedores, envíos a TJ", color: "#1E40AF", bg: "#EFF6FF", border: "#BFDBFE" },
      { k: "bodegatj",  emoji: "🇲🇽", title: "Bodega TJ",    sub: "Recibir envíos, entregas y cobros",     color: "#065F46", bg: "#ECFDF5", border: "#A7F3D0" },
    ],
    usa: [
      { k: "bodegausa", emoji: "🇺🇸", title: "Bodega USA",   sub: "Recolección, proveedores, envíos a TJ", color: "#1E40AF", bg: "#EFF6FF", border: "#BFDBFE" },
      { k: "bitacora",  emoji: "📒", title: "Bitácora",      sub: "Historial de todos los pedidos",              color: "#374151", bg: "#F9FAFB", border: "#D1D5DB" },
      { k: "clientes",  emoji: "👥", title: "Clientes",      sub: "Clientes y vendedores",                      color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
      { k: "proveedores", emoji: "🏪", title: "Proveedores", sub: "Directorio de proveedores",                  color: "#7C3AED", bg: "#F5F3FF", border: "#E9D5FF" },
    ],
    vendedor: [
      { k: "ventas",    emoji: "📋", title: "Pedidos",       sub: "Crear pedidos, cobros y urgencias",     color: "#D97706", bg: "#FFF7ED", border: "#FED7AA" },
      { k: "bodegausa", emoji: "🇺🇸", title: "Bodega USA",   sub: "Recolección, proveedores, envíos a TJ", color: "#1E40AF", bg: "#EFF6FF", border: "#BFDBFE" },
      { k: "bodegatj",  emoji: "🇲🇽", title: "Bodega TJ",    sub: "Recibir envíos, entregas y cobros",     color: "#065F46", bg: "#ECFDF5", border: "#A7F3D0" },
    ],
  };

  if (view === "home") {
    const sections = HOME_SECTIONS[role] || [];
    const activos = data.fantasmas.filter(f => f.estado !== "CERRADO").length;
    const urgentes = data.fantasmas.filter(f => f.urgente && f.estado !== "CERRADO").length;
    const porCobrar = data.fantasmas.filter(f => f.estado !== "CERRADO" && f.dineroStatus !== "TRANS_PENDIENTE" && (!f.clientePago || (!f.fletePagado && f.costoFlete > 0))).length;
    return (
      <div style={{ minHeight: "100vh", background: "linear-gradient(135deg, #0F172A 0%, #1E293B 50%, #1A2744 100%)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Sans', 'Segoe UI', sans-serif", padding: 16 }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet" />
        <div style={{ textAlign: "center", maxWidth: 480, width: "100%" }}>
          <div style={{ fontSize: 50, marginBottom: 8 }}>👻</div>
          <h1 style={{ color: "#fff", fontSize: 24, fontWeight: 700, margin: "0 0 2px" }}>OchoaTransport</h1>
          <p style={{ color: "#94A3B8", fontSize: 13, margin: "0 0 6px" }}>Bienvenido, {currentUser}</p>
          {data.fantasmas.length > 0 && (
            <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 20 }}>
              <span style={{ background: "rgba(255,255,255,0.08)", color: "#94A3B8", padding: "4px 10px", borderRadius: 6, fontSize: 11 }}>{activos} activos</span>
              {urgentes > 0 && <span style={{ background: "rgba(220,38,38,0.2)", color: "#FCA5A5", padding: "4px 10px", borderRadius: 6, fontSize: 11 }}>🔥 {urgentes} urgentes</span>}
              {porCobrar > 0 && <span style={{ background: "rgba(255,255,255,0.08)", color: "#FCA5A5", padding: "4px 10px", borderRadius: 6, fontSize: 11 }}>💸 {porCobrar} por cobrar</span>}
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 32 }}>
            {sections.map(s => (
              <button key={s.k} onClick={() => navigate(s.k)} style={{ background: s.bg, border: `2px solid ${s.border}`, borderRadius: 14, padding: "18px 22px", cursor: "pointer", display: "flex", alignItems: "center", gap: 16, textAlign: "left", transition: "all .2s", fontFamily: "inherit", width: "100%" }}
                onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 8px 24px rgba(0,0,0,.25)"; }}
                onMouseLeave={e => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "none"; }}>
                <div style={{ fontSize: 32, flexShrink: 0 }}>{s.emoji}</div>
                <div>
                  <div style={{ fontSize: 17, fontWeight: 700, color: s.color }}>{s.title}</div>
                  <div style={{ fontSize: 12, color: "#6B7280", marginTop: 2 }}>{s.sub}</div>
                </div>
              </button>
            ))}
          </div>
          <button onClick={() => { setRole(null); setCurrentUser(null); setLoginUser(""); setLoginPass(""); setView("main"); }} style={{ marginTop: 20, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "#6B7280", padding: "8px 18px", borderRadius: 8, cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>
            Cerrar sesión
          </button>
        </div>
      </div>
    );
  }

  const ROLE_COLORS = { usa: "#1E40AF", tj: "#065F46", admin: "#92400E", bodegatj: "#065F46", vendedor: "#D97706" };
  const ROLE_NAMES  = { usa: "🇺🇸 Bodega USA", tj: "🇲🇽 Bodega TJ", admin: "⚙️ Admin", bodegatj: "🇲🇽 Bodega TJ", vendedor: "📋 Vendedor" };

  // ============ COLCHÓN MODAL ============
  const ColchonModal = () => {
    const [amt, setAmt] = useState("");
    const [mf, setMf] = useState({ tipo: "Entrada", concepto: "", monto: "" });
    const c = data.colchon;
    const pct = c.montoOriginal > 0 ? Math.round((c.saldoActual / c.montoOriginal) * 100) : 0;
    const pc = pct >= 70 ? "#059669" : pct >= 30 ? "#D97706" : "#DC2626";
    return (
      <Modal title="🛡️ Colchón USA" onClose={() => { setShowColchon(false) }} w={440}>
        {c.montoOriginal === 0 ? (
          <div><p style={{ fontSize: 12, color: "#6B7280", marginTop: 0 }}>Define el monto inicial (3-5 pedidos promedio).</p><Fld label="Monto (USD)"><Inp type="number" value={amt} onChange={e => setAmt(e.target.value)} placeholder="1500" /></Fld><Btn disabled={!amt} onClick={() => { const m = parseFloat(amt) || 0; updColchon({ montoOriginal: m, saldoActual: m }); }} style={{ width: "100%" }}>Establecer</Btn></div>
        ) : (
          <div>
            <div style={{ textAlign: "center", marginBottom: 14 }}>
              <div style={{ fontSize: 10, color: "#6B7280", textTransform: "uppercase" }}>Saldo</div>
              <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "monospace", color: pc }}>{fmt(c.saldoActual)}</div>
              <div style={{ fontSize: 11, color: "#9CA3AF" }}>de {fmt(c.montoOriginal)}</div>
              <div style={{ width: "100%", height: 6, background: "#E5E7EB", borderRadius: 3, marginTop: 6, overflow: "hidden" }}><div style={{ width: `${Math.min(pct, 100)}%`, height: "100%", background: pc, borderRadius: 3 }} /></div>
              <div style={{ fontSize: 11, fontWeight: 600, color: pc, marginTop: 3 }}>{pct}%{pct < 30 && " ⚠️ BAJO"}</div>
            </div>
            <div style={{ borderTop: "1px solid #E5E7EB", paddingTop: 10, marginTop: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6 }}>Movimiento</div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                <select value={mf.tipo} onChange={e => setMf({ ...mf, tipo: e.target.value })} style={{ padding: "5px 7px", borderRadius: 5, border: "1px solid #D1D5DB", fontSize: 11, fontFamily: "inherit" }}><option value="Entrada">Reposición</option><option value="Salida">Uso</option></select>
                <input value={mf.concepto} onChange={e => setMf({ ...mf, concepto: e.target.value })} placeholder="Concepto" style={{ flex: 1, minWidth: 80, padding: "5px 7px", borderRadius: 5, border: "1px solid #D1D5DB", fontSize: 11, fontFamily: "inherit" }} />
                <input type="number" value={mf.monto} onChange={e => setMf({ ...mf, monto: e.target.value })} placeholder="$" style={{ width: 70, padding: "5px 7px", borderRadius: 5, border: "1px solid #D1D5DB", fontSize: 11, fontFamily: "inherit" }} />
                <Btn sz="sm" disabled={!mf.concepto || !mf.monto} onClick={() => { addColMov({ tipo: mf.tipo, concepto: mf.concepto, monto: parseFloat(mf.monto) || 0 }); setMf({ tipo: "Entrada", concepto: "", monto: "" }); }}><I.Plus /></Btn>
              </div>
            </div>
            {(c.movimientos || []).length > 0 && <div style={{ maxHeight: 180, overflow: "auto", marginTop: 10 }}>{[...(c.movimientos || [])].reverse().map(m => <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 0", borderBottom: "1px solid #F3F4F6", fontSize: 11 }}><span style={{ width: 5, height: 5, borderRadius: "50%", background: m.tipo === "Entrada" ? "#059669" : "#DC2626" }} /><span style={{ color: "#9CA3AF", minWidth: 44 }}>{fmtD(m.fecha)}</span><span style={{ flex: 1 }}>{m.concepto}</span><span style={{ fontFamily: "monospace", fontWeight: 600, color: m.tipo === "Entrada" ? "#059669" : "#DC2626" }}>{m.tipo === "Entrada" ? "+" : "-"}{fmt(m.monto)}</span></div>)}</div>}
          </div>
        )}
      </Modal>
    );
  };

  // ============ CONSTANTS ============
  const TIPOS_MERCANCIA = ["ROPA", "CALZADO", "ELECTRÓNICO", "ACCESORIOS", "ALIMENTOS", "COSMÉTICOS", "HOGAR", "JUGUETES", "HERRAMIENTAS", "AUTOPARTES", "FARMACIA", "DEPORTES", "TECNOLOGÍA", "MUEBLES", "TEXTIL", "JOYERÍA", "PAPELERÍA", "OTRO"];
  const VEHICULOS = ["ECO 06", "ECO 07", "ECO 08", "ECO 10", "ECO 11", "ECO 12", "ECO 14", "TRAILER", "RABON"];


  // ============ DETAIL VIEW - clean read-only ============
  const DetailView = () => {
    const f = sel; if (!f) return null;
    const [ed, setEd] = useState(false);
    const [ef, setEf] = useState({});
    const [confirm, setConfirm] = useState(null);
    const canDelete = role === "admin";
    const canEdit = role === "admin" || role === "bodegatj" || role === "vendedor";

    return (
      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        {/* Top bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          <button onClick={() => { navigate(prevView, null); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#6B7280", display: "flex", alignItems: "center", gap: 3, fontSize: 12, fontFamily: "inherit" }}><I.Back /> Volver</button>
          <span style={{ color: "#D1D5DB" }}>|</span>
          <span style={{ fontSize: 11, color: "#9CA3AF", fontFamily: "monospace" }}>{f.id}</span>
          <Badge estado={f.estado} />
          <DBadge status={f.dineroStatus || "SIN_FONDOS"} />
          <div style={{ marginLeft: "auto", display: "flex", gap: 5 }}>
            {canEdit && <Btn v="secondary" sz="sm" onClick={() => { setEditPedidoId(f.id); setShowNew(true); }}>✏️ Editar</Btn>}
            {canDelete && <Btn v="danger" sz="sm" onClick={() => setConfirm(f.id)}><I.Trash /></Btn>}
          </div>
        </div>

        {/* Main info card */}
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #E5E7EB", padding: 20, marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 12 }}>
            <div>
              <h2 style={{ margin: "0 0 2px", fontSize: 18, fontWeight: 700 }}>{f.cliente}</h2>
              <p style={{ margin: 0, color: "#6B7280", fontSize: 13 }}>{f.descripcion}</p>
            </div>
            {f.pedidoEspecial && <span style={{ background: "#F3E8FF", color: "#7C3AED", fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 4 }}>⭐ ESPECIAL</span>}
          </div>

          {/* Estado */}
          <div style={{ background: ESTADO_COLORS[f.estado].bg, border: `2px solid ${ESTADO_COLORS[f.estado].dot}`, borderRadius: 8, padding: "10px 14px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#6B7280", textTransform: "uppercase" }}>Estado:</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: ESTADO_COLORS[f.estado].text }}>{ESTADOS[f.estado]}</div>
            <div style={{ marginLeft: "auto", fontSize: 10, color: "#9CA3AF" }}>({ESTADO_RESP[f.estado]})</div>
          </div>

          {/* Info rows */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 20px" }}>
            <div><div style={{ fontSize: 10, color: "#9CA3AF", fontWeight: 600, textTransform: "uppercase", marginBottom: 2 }}>Proveedor</div><div style={{ fontSize: 13, fontWeight: 600 }}>{f.proveedor || "—"}{f.ubicacionProv && <span style={{ color: "#9CA3AF", fontWeight: 400 }}> ({f.ubicacionProv})</span>}</div></div>
            <div><div style={{ fontSize: 10, color: "#9CA3AF", fontWeight: 600, textTransform: "uppercase", marginBottom: 2 }}>Vendedor</div><div style={{ fontSize: 13, fontWeight: 600 }}>{f.vendedor || "—"}</div></div>
            <div><div style={{ fontSize: 10, color: "#9CA3AF", fontWeight: 600, textTransform: "uppercase", marginBottom: 2 }}>Tipo mercancía</div><div style={{ fontSize: 13, fontWeight: 600 }}>{f.tipoMercancia || "—"}</div></div>
            <div><div style={{ fontSize: 10, color: "#9CA3AF", fontWeight: 600, textTransform: "uppercase", marginBottom: 2 }}>Empaque</div><div style={{ fontSize: 13, fontWeight: 600 }}>{f.empaque === "Desconocido" ? "❓ Desconocido" : f.empaque ? `📦 ${f.cantBultos || 1} ${f.empaque}` : "—"}</div></div>
            {f.cantidad > 0 && <div><div style={{ fontSize: 10, color: "#9CA3AF", fontWeight: 600, textTransform: "uppercase", marginBottom: 2 }}>Piezas</div><div style={{ fontSize: 13, fontWeight: 600 }}>{f.cantidad} pzs × {fmt(f.costoUnitario)}</div></div>}
            <div><div style={{ fontSize: 10, color: "#9CA3AF", fontWeight: 600, textTransform: "uppercase", marginBottom: 2 }}>Fecha creación</div><div style={{ fontSize: 13, fontWeight: 600 }}>{fmtD(f.fechaCreacion)}</div></div>
          </div>

          {/* Costos */}
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid #F3F4F6" }}>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 120, background: f.pedidoEspecial ? "#FDF4FF" : "#F9FAFB", borderRadius: 8, padding: "10px 14px", border: f.pedidoEspecial ? "2px solid #E9D5FF" : "1px solid #E5E7EB" }}>
                <div style={{ fontSize: 10, color: f.pedidoEspecial ? "#7C3AED" : "#9CA3AF", fontWeight: 600, textTransform: "uppercase", marginBottom: 4 }}>
                  👻 {f.pedidoEspecial ? "Total cliente (fantasma + ganancia)" : "Mercancía"}
                </div>
                <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "monospace" }}>{fmt(f.totalVenta || f.costoMercancia)}</div>
                {f.pedidoEspecial && f.costoReal != null && role === "admin" && (
                  <div style={{ fontSize: 10, color: "#9CA3AF", marginTop: 3 }}>
                    Fantasma {fmt(f.costoReal)} + Ganancia {fmt(f.gananciaEspecial || ((f.totalVenta || f.costoMercancia) - f.costoReal))}
                  </div>
                )}
                {f.clientePago
                  ? <div style={{ fontSize: 10, color: "#059669", fontWeight: 700, marginTop: 3 }}>✓ Pagado</div>
                  : (f.abonoMercancia || 0) > 0
                    ? <div style={{ fontSize: 10, color: "#D97706", marginTop: 3 }}>Abonado {fmt(f.abonoMercancia)} · Debe {fmt((f.totalVenta || f.costoMercancia) - (f.abonoMercancia || 0))}</div>
                    : <div style={{ fontSize: 10, color: "#DC2626", marginTop: 3 }}>Pendiente</div>
                }
              </div>
              <div style={{ flex: 1, minWidth: 120, background: "#F9FAFB", borderRadius: 8, padding: "10px 14px", border: "1px solid #E5E7EB" }}>
                <div style={{ fontSize: 10, color: "#9CA3AF", fontWeight: 600, textTransform: "uppercase", marginBottom: 4 }}>🚛 Flete</div>
                <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "monospace" }}>{f.fleteDesconocido ? "❓" : fmt(f.costoFlete || 0)}</div>
                {f.fletePagado ? <div style={{ fontSize: 10, color: "#059669", fontWeight: 700, marginTop: 3 }}>✓ Pagado</div> : !f.costoFlete ? <div style={{ fontSize: 10, color: "#9CA3AF", marginTop: 3 }}>N/A</div> : <div style={{ fontSize: 10, color: "#DC2626", marginTop: 3 }}>Pendiente</div>}
              </div>
            </div>
          </div>

          {/* Notas */}
          {f.notas && (
            <div style={{ marginTop: 14, padding: "10px 14px", background: "#FFFBEB", borderRadius: 8, border: "1px solid #FDE68A", fontSize: 12, color: "#92400E" }}>
              📝 {f.notas}
            </div>
          )}

          {/* Historial */}
          {(f.historial || []).length > 0 && (
            <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid #F3F4F6" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#6B7280", marginBottom: 8 }}>Historial</div>
              {[...(f.historial || [])].reverse().map((h, i) => (
                <div key={i} style={{ display: "flex", gap: 8, fontSize: 11, padding: "4px 0", borderBottom: "1px solid #F9FAFB" }}>
                  <span style={{ color: "#9CA3AF", minWidth: 50 }}>{fmtD(h.fecha)}</span>
                  <span style={{ flex: 1, color: "#374151" }}>{h.accion}</span>
                  {h.quien && <span style={{ color: "#9CA3AF", fontSize: 10 }}>{h.quien}</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Edit modal */}
        {ed && <Modal title="✏️ Editar pedido" onClose={() => setEd(false)} w={520}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 10px" }}>
            <Fld label="Cliente"><Inp value={ef.cliente} onChange={e => setEf({ ...ef, cliente: e.target.value.toUpperCase() })} /></Fld>
            <Fld label="Proveedor"><Inp value={ef.proveedor} onChange={e => setEf({ ...ef, proveedor: e.target.value.toUpperCase() })} /></Fld>
            <Fld label="Vendedor"><Inp value={ef.vendedor} onChange={e => setEf({ ...ef, vendedor: e.target.value.toUpperCase() })} /></Fld>
            <Fld label="Tipo mercancía"><Inp value={ef.tipoMercancia} onChange={e => setEf({ ...ef, tipoMercancia: e.target.value.toUpperCase() })} /></Fld>
            <div style={{ gridColumn: "1/-1" }}><Fld label="Descripción"><Inp value={ef.descripcion} onChange={e => setEf({ ...ef, descripcion: e.target.value })} /></Fld></div>
            <Fld label="Empaque"><Inp value={ef.empaque} onChange={e => setEf({ ...ef, empaque: e.target.value })} /></Fld>
            <Fld label="# Bultos"><Inp type="number" value={ef.cantBultos} onChange={e => setEf({ ...ef, cantBultos: e.target.value })} /></Fld>
            <div style={{ gridColumn: "1/-1", display: "flex", gap: 3, background: "#F3F4F6", borderRadius: 8, padding: 3, marginBottom: 4 }}>
              <button onClick={() => setEf({ ...ef, pedidoEspecial: false, precioVenta: "" })} style={{ flex: 1, padding: "6px", borderRadius: 6, border: "none", background: !ef.pedidoEspecial ? "#fff" : "transparent", boxShadow: !ef.pedidoEspecial ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 11, fontWeight: !ef.pedidoEspecial ? 700 : 500, fontFamily: "inherit", color: !ef.pedidoEspecial ? "#1A2744" : "#6B7280" }}>📋 Normal</button>
              <button onClick={() => setEf({ ...ef, pedidoEspecial: true })} style={{ flex: 1, padding: "6px", borderRadius: 6, border: "none", background: ef.pedidoEspecial ? "#F3E8FF" : "transparent", boxShadow: ef.pedidoEspecial ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 11, fontWeight: ef.pedidoEspecial ? 700 : 500, fontFamily: "inherit", color: ef.pedidoEspecial ? "#7C3AED" : "#6B7280" }}>⭐ Especial</button>
            </div>
            <Fld label={ef.pedidoEspecial ? "Costo real (proveedor) USD" : "Costo USD"}>
              <Inp type="number" value={ef.costoMercancia} onChange={e => setEf({ ...ef, costoMercancia: e.target.value })} />
            </Fld>
            {ef.pedidoEspecial ? (
              <Fld label="Precio de venta al cliente USD">
                <Inp type="number" value={ef.precioVenta} onChange={e => setEf({ ...ef, precioVenta: e.target.value })} placeholder="Lo que paga el cliente" />
              </Fld>
            ) : (
              <Fld label="Flete USD"><Inp type="number" value={ef.costoFlete} onChange={e => setEf({ ...ef, costoFlete: e.target.value })} /></Fld>
            )}
            {ef.pedidoEspecial && ef.precioVenta && ef.costoMercancia && (
              <div style={{ gridColumn: "1/-1", display: "flex", gap: 12, padding: "8px 10px", background: "#F3E8FF", borderRadius: 6, fontSize: 11, flexWrap: "wrap" }}>
                <span>Costo: <strong style={{ fontFamily: "monospace" }}>{fmt(parseFloat(ef.costoMercancia)||0)}</strong></span>
                <span>Venta: <strong style={{ fontFamily: "monospace", color: "#059669" }}>{fmt(parseFloat(ef.precioVenta)||0)}</strong></span>
                <span style={{ fontWeight: 700, color: "#059669" }}>Ganancia: {fmt((parseFloat(ef.precioVenta)||0)-(parseFloat(ef.costoMercancia)||0))}</span>
              </div>
            )}
            {ef.pedidoEspecial && <Fld label="Flete USD"><Inp type="number" value={ef.costoFlete} onChange={e => setEf({ ...ef, costoFlete: e.target.value })} /></Fld>}
            <div style={{ gridColumn: "1/-1" }}><Fld label="Notas"><Inp value={ef.notas} onChange={e => setEf({ ...ef, notas: e.target.value })} /></Fld></div>
            {/* Comisión toggle */}
            {(() => {
              const base = ef.pedidoEspecial && ef.precioVenta ? parseFloat(ef.precioVenta) : (parseFloat(ef.costoMercancia) || 0);
              const comPct = base >= 10000 ? 0.005 : base >= 1000 ? 0.008 : 0;
              if (comPct === 0) return null;
              const comCalc = Math.round(base * comPct * 100) / 100;
              // If already cobrada — show locked, can't re-enable
              if (ef.comisionCobrada) {
                return (
                  <div style={{ gridColumn: "1/-1" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#ECFDF5", borderRadius: 6, border: "2px solid #A7F3D0" }}>
                      <span style={{ fontSize: 16 }}>✅</span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: "#065F46" }}>Comisión ya cobrada</span>
                      <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#059669", fontSize: 14, marginLeft: "auto" }}>{fmt(ef.comisionMonto || comCalc)}</span>
                    </div>
                  </div>
                );
              }
              return (
                <div style={{ gridColumn: "1/-1" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: ef.cobrarComision ? "#F5F3FF" : "#F9FAFB", borderRadius: 6, cursor: "pointer", border: ef.cobrarComision ? "2px solid #7C3AED" : "1px solid #E5E7EB" }}>
                    <input type="checkbox" checked={ef.cobrarComision || false} onChange={e => setEf({ ...ef, cobrarComision: e.target.checked })} style={{ width: 16, height: 16, accentColor: "#7C3AED" }} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: ef.cobrarComision ? "#7C3AED" : "#6B7280" }}>💰 Cobrar comisión ({comPct * 100}%)</span>
                    <span style={{ fontFamily: "monospace", fontWeight: 700, color: ef.cobrarComision ? "#7C3AED" : "#9CA3AF", fontSize: 14, marginLeft: "auto" }}>{fmt(comCalc)}</span>
                  </label>
                </div>
              );
            })()}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5E7EB" }}>
            <Btn v="secondary" onClick={() => setEd(false)}>Cancelar</Btn>
            <Btn onClick={() => {
              const costoReal = parseFloat(ef.costoMercancia) || 0;
              const precioV = ef.pedidoEspecial && ef.precioVenta ? parseFloat(ef.precioVenta) : costoReal;
              const cf = parseFloat(ef.costoFlete) || 0;
              const comPct = precioV >= 10000 ? 0.005 : precioV >= 1000 ? 0.008 : 0;
              const comCalc = Math.round(precioV * comPct * 100) / 100;
              const cobrar = ef.cobrarComision && comPct > 0;
              // Never downgrade a cobrada commission on edit
              const wasAlreadyCobrada = f.comisionCobrada;
              updF(f.id, {
                ...ef,
                costoMercancia: precioV,
                costoReal: ef.pedidoEspecial ? costoReal : null,
                gananciaEspecial: ef.pedidoEspecial ? (precioV - costoReal) : null,
                pedidoEspecial: ef.pedidoEspecial || false,
                costoFlete: cf,
                cantBultos: parseInt(ef.cantBultos) || 1,
                costoDesconocido: costoReal > 0 ? false : f.costoDesconocido,
                fleteDesconocido: cf > 0 ? false : f.fleteDesconocido,
                totalVenta: wasAlreadyCobrada ? f.totalVenta : (precioV + (cobrar ? comCalc : 0)),
                cobrarComision: wasAlreadyCobrada ? true : cobrar,
                comisionMonto: wasAlreadyCobrada ? f.comisionMonto : (cobrar ? comCalc : 0),
                comisionPendiente: wasAlreadyCobrada ? false : cobrar,
                comisionCobrada: wasAlreadyCobrada ? true : false,
                dineroStatus: (() => {
                  const _preserveEdit = ["DINERO_CAMINO","SOBRE_LISTO","DINERO_USA","COLCHON_USADO","TRANS_PENDIENTE"];
                  // When a costoDesconocido pedido now has a real cost, reset to SIN_FONDOS so money flow can start
                  if (f.costoDesconocido && costoReal > 0 && !f.soloRecoger) return "SIN_FONDOS";
                  // Only preserve in-transit statuses; let updF auto-calc the rest
                  return _preserveEdit.includes(f.dineroStatus) ? f.dineroStatus : undefined;
                })()
              });
              setEd(false);
            }}>Guardar</Btn>
          </div>
        </Modal>}

        {/* Confirm delete */}
        {confirm === f.id && <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100, padding: 16 }}><div style={{ background: "#fff", borderRadius: 12, padding: 18, maxWidth: 380, width: "100%" }}><p style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 700 }}>¿Eliminar pedido?</p><p style={{ margin: "0 0 12px", fontSize: 11, color: "#6B7280" }}><strong>{f.cliente}</strong> — {f.descripcion} ({fmt(f.costoMercancia)})</p><div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}><Btn v="secondary" onClick={() => setConfirm(null)}>Cancelar</Btn><Btn v="danger" onClick={() => delF(f.id)}>Sí, eliminar</Btn></div></div></div>}
      </div>
    );
  };


  // ============ LIST VIEW ============
  const ListView = () => {
    const searchRef = useCallback(node => { if (node) node.focus(); }, []);
    const availEstados = role === "admin" ? ESTADO_KEYS : TJ_ESTADOS;
    return (
      <div>
        <div style={{ display: "flex", gap: 5, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ position: "relative", flex: "1 1 160px", minWidth: 140 }}>
            <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "#9CA3AF" }}><I.Search /></span>
            <input ref={search ? searchRef : undefined} value={search} onChange={e => setSearch(e.target.value)} placeholder="Folio, cliente, proveedor..." autoComplete="off" style={{ width: "100%", padding: "7px 10px", paddingLeft: 28, borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 12, outline: "none", boxSizing: "border-box", fontFamily: "inherit", background: "#FAFAFA" }} />
          </div>
          <select value={fEst} onChange={e => setFEst(e.target.value)} style={{ padding: "7px 9px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, fontFamily: "inherit", background: "#FAFAFA" }}>
            <option value="ALL">Todos los estados</option>
            {availEstados.map(k => <option key={k} value={k}>{ESTADOS[k]}</option>)}
          </select>
          <select value={fPagoMerc} onChange={e => setFPagoMerc(e.target.value)} style={{ padding: "7px 9px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, fontFamily: "inherit", background: fPagoMerc !== "ALL" ? "#FEF2F2" : "#FAFAFA" }}>
            <option value="ALL">👻 Mercancía: Todos</option>
            <option value="pagado">👻 Pagada ✓</option>
            <option value="pendiente">👻 Pendiente ✗</option>
          </select>
          <select value={fPagoFlete} onChange={e => setFPagoFlete(e.target.value)} style={{ padding: "7px 9px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, fontFamily: "inherit", background: fPagoFlete !== "ALL" ? "#EFF6FF" : "#FAFAFA" }}>
            <option value="ALL">🚛 Flete: Todos</option>
            <option value="pagado">🚛 Pagado ✓</option>
            <option value="pendiente">🚛 Pendiente ✗</option>
          </select>
          <Btn onClick={() => { setShowNew(true); }}><I.Plus /> Nuevo Pedido</Btn>
        </div>
        <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 8 }}>{filtered.length} pedido{filtered.length !== 1 ? "s" : ""}</div>
        {filtered.length === 0 ? <div style={{ textAlign: "center", padding: 32, color: "#9CA3AF" }}><p style={{ fontSize: 12 }}>No hay pedidos{search || fEst !== "ALL" ? " con esos filtros" : " en esta vista"}.</p></div> : (() => {
          // Group by bodega for USA role
          const renderItem = (f) => {
            const rest = f.costoMercancia + f.costoFlete - (f.clientePagoMonto || 0);
            return <div key={f.id} onClick={() => { setDetailMode("full"); navigate("detail", f.id, view); }} style={{ background: "#fff", borderRadius: 8, border: "1px solid #E5E7EB", padding: "10px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, transition: "border-color .12s" }} onMouseEnter={e => e.currentTarget.style.borderColor = "#93C5FD"} onMouseLeave={e => e.currentTarget.style.borderColor = "#E5E7EB"}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 2, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 9, color: "#9CA3AF", fontFamily: "monospace" }}>{f.id}</span>
                  <strong style={{ fontSize: 12 }}>{f.cliente}</strong>
                  <Badge estado={f.estado} />
                  {f.ubicacionProv && <span style={{ fontSize: 9, background: "#F3F4F6", color: "#6B7280", padding: "1px 5px", borderRadius: 3 }}>📍 {f.ubicacionProv}</span>}
                  {f.dineroStatus === "COLCHON_USADO" && <span style={{ fontSize: 9, background: "#FEF3C7", color: "#92400E", padding: "1px 5px", borderRadius: 3, fontWeight: 600 }}>🛡️</span>}
                  {(!f.dineroStatus || f.dineroStatus === "SIN_FONDOS") && f.estado !== "PEDIDO" && f.estado !== "CERRADO" && <span style={{ fontSize: 9, background: "#FEE2E2", color: "#991B1B", padding: "1px 5px", borderRadius: 3, fontWeight: 600 }}>💵!</span>}
                  {f.estadoMercancia && f.estadoMercancia !== "completa" && <span style={{ fontSize: 9, background: f.estadoMercancia === "dañada" ? "#FEE2E2" : "#FEF3C7", color: f.estadoMercancia === "dañada" ? "#991B1B" : "#92400E", padding: "1px 5px", borderRadius: 3, fontWeight: 600 }}>{f.estadoMercancia === "dañada" ? "🔴" : "⚠️"} {f.estadoMercancia}</span>}
                </div>
                <div style={{ fontSize: 11, color: "#6B7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.descripcion}{f.proveedor && <span style={{ color: "#9CA3AF" }}> · {f.proveedor}</span>}</div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "monospace", color: "#1A2744" }}>{fmt(f.costoMercancia)}</div>
                {!f.clientePago && rest > 0 && <div style={{ fontSize: 9, color: "#DC2626", fontWeight: 600 }}>Debe: {fmt(rest)}</div>}
              </div>
              <I.Right />
            </div>;
          };

          if (role === "usa") {
            const otay = filtered.filter(f => (f.ubicacionProv || "").toLowerCase().includes("otay") || (!f.ubicacionProv && !(f.ubicacionProv || "").toLowerCase().includes("ángeles") && !(f.ubicacionProv || "").toLowerCase().includes("angeles")));
            const la = filtered.filter(f => (f.ubicacionProv || "").toLowerCase().includes("ángeles") || (f.ubicacionProv || "").toLowerCase().includes("angeles"));
            const otra = filtered.filter(f => f.ubicacionProv && !otay.includes(f) && !la.includes(f));
            const sinUbic = filtered.filter(f => !f.ubicacionProv);
            const groups = [
              { label: "📍 Proveedores Otay", items: otay.filter(f => f.ubicacionProv), color: "#1E40AF", bg: "#EFF6FF" },
              { label: "📍 Proveedores Los Ángeles", items: la, color: "#7C3AED", bg: "#F5F3FF" },
              ...(otra.length > 0 ? [{ label: "📍 Otra ubicación", items: otra, color: "#6B7280", bg: "#F9FAFB" }] : []),
              ...(sinUbic.length > 0 ? [{ label: "📍 Sin ubicación asignada", items: sinUbic, color: "#9CA3AF", bg: "#F9FAFB" }] : []),
            ].filter(g => g.items.length > 0);

            return <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {groups.map(g => (
                <div key={g.label}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, padding: "6px 10px", background: g.bg, borderRadius: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: g.color }}>{g.label}</span>
                    <span style={{ fontSize: 11, color: "#9CA3AF" }}>({g.items.length})</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>{g.items.map(renderItem)}</div>
                </div>
              ))}
            </div>;
          }

          return <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>{filtered.map(renderItem)}</div>;
        })()}
      </div>
    );
  };

  // ============ DASHBOARD (admin) ============
  const Dashboard = () => {
    const [dashTab, setDashTab] = useState("fletes");
    const [dashSearch, setDashSearch] = useState("");
    const [dashFCli, setDashFCli] = useState("ALL");
    const [dashFProv, setDashFProv] = useState("ALL");
    const act = data.fantasmas.filter(f => f.estado !== "CERRADO");

    // Admin cash (separated USD/MXN)
    const adminMovs = data.gastosAdmin || [];
    const admUSD = adminMovs.filter(m => m.moneda !== "MXN");
    const admMXN = adminMovs.filter(m => m.moneda === "MXN");
    const saldoAdmUSD = admUSD.filter(m => m.tipoMov === "ingreso").reduce((s, m) => s + (m.monto || 0), 0) - admUSD.filter(m => m.tipoMov === "egreso").reduce((s, m) => s + (m.monto || 0), 0);
    const saldoAdmMXN = admMXN.filter(m => m.tipoMov === "ingreso").reduce((s, m) => s + (m.monto || 0), 0) - admMXN.filter(m => m.tipoMov === "egreso").reduce((s, m) => s + (m.monto || 0), 0);

    // Bodega USA cash (separated USD/MXN)
    const usaMovs = data.gastosUSA || [];
    const usaUSD = usaMovs.filter(g => g.moneda !== "MXN");
    const usaMXN = usaMovs.filter(g => g.moneda === "MXN");
    const saldoUsaUSD = usaUSD.filter(g => g.tipoMov === "ingreso").reduce((s, g) => s + (g.monto || 0), 0) - usaUSD.filter(g => g.tipoMov !== "ingreso").reduce((s, g) => s + (g.monto || 0), 0);
    const saldoUsaMXN = usaMXN.filter(g => g.tipoMov === "ingreso").reduce((s, g) => s + (g.monto || g.montoOriginal || 0), 0) - usaMXN.filter(g => g.tipoMov !== "ingreso").reduce((s, g) => s + (g.monto || g.montoOriginal || 0), 0);

    // Colchon
    const c = data.colchon || { montoOriginal: 0, saldoActual: 0 };
    const colPct = c.montoOriginal > 0 ? Math.round((c.saldoActual / c.montoOriginal) * 100) : 0;
    const colC = colPct >= 70 ? "#059669" : colPct >= 30 ? "#D97706" : "#DC2626";

    // Bodega TJ cash (separated USD/MXN)
    // Filter out orphaned entries - payments linked to deleted pedidos
    const fantasmaIds = new Set(data.fantasmas.map(f => f.id));
    const tjMovs = (data.gastosBodega || []).filter(g => {
      // Keep manual gastos (not linked to a pedido)
      if (!g.concepto) return true;
      const conceptoUpper = (g.concepto || "").toUpperCase();
      // If it mentions a folio, check the pedido exists
      const folioMatch = conceptoUpper.match(/F-(\d+)/);
      if (folioMatch) {
        const folioId = `F-${folioMatch[1]}`;
        return fantasmaIds.has(folioId);
      }
      return true;
    });
    const tjUSD = tjMovs.filter(g => g.moneda !== "MXN");
    const tjMXN = tjMovs.filter(g => g.moneda === "MXN");
    const saldoTjUSD = tjUSD.filter(g => g.tipoMov === "ingreso").reduce((s, g) => s + (g.monto || 0), 0) - tjUSD.filter(g => g.tipoMov !== "ingreso").reduce((s, g) => s + (g.monto || 0), 0);
    const saldoTjMXN = tjMXN.filter(g => g.tipoMov === "ingreso").reduce((s, g) => s + (g.monto || g.montoOriginal || 0), 0) - tjMXN.filter(g => g.tipoMov !== "ingreso").reduce((s, g) => s + (g.monto || g.montoOriginal || 0), 0);
    const fmtMXND = (n) => "$" + (n || 0).toLocaleString("en-US", { minimumFractionDigits: 2 }) + " MXN";

    // Pedidos stats
    const pendClientes = act.filter(f => !f.clientePago && f.dineroStatus !== "TRANS_PENDIENTE");
    const deudaClientes = pendClientes.reduce((s, f) => s + ((f.totalVenta || f.costoMercancia) - (f.abonoMercancia || 0)), 0);
    const deudaFletes = act.filter(f => !f.fletePagado && f.costoFlete > 0).reduce((s, f) => s + (f.costoFlete - (f.abonoFlete || 0)), 0);
    const credProv = act.filter(f => f.creditoProveedor && !f.proveedorPagado).reduce((s, f) => s + f.costoMercancia, 0);
    const credProvCount = act.filter(f => f.creditoProveedor && !f.proveedorPagado).length;

    // Adelantos pendientes
    const adelPend = (data.adelantosAdmin || []).filter(a => !a.recuperado);
    const totalAdelPend = adelPend.reduce((s, a) => s + (a.monto || 0), 0);

    // Pipeline
    const porEst = ESTADO_KEYS.filter(k => k !== "CERRADO").map(k => ({ key: k, label: ESTADOS[k], count: data.fantasmas.filter(f => f.estado === k).length, color: ESTADO_COLORS[k] })).filter(x => x.count > 0);

    // Alertas
    const alertas = data.fantasmas.filter(f => { if (f.estado === "CERRADO") return false; if (f.creditoProveedor && !f.proveedorPagado) return true; if (!f.clientePago && f.estado === "ENTREGADO") return true; if (f.dineroStatus === "COLCHON_USADO") return true; const d = Math.floor((new Date() - new Date(f.fechaActualizacion)) / 864e5); if (d > 3) return true; return false; });

    // Ganancias especiales pendientes de separar
    const gananciasPendientes = data.fantasmas.filter(f => {
      if (!f.pedidoEspecial) return false;
      if (f.gananciaSeparada) return false;
      const precioVenta = f.totalVenta || f.costoMercancia || 0;
      return f.clientePago || (f.abonoMercancia || 0) >= precioVenta;
    });
    const totalGananciaPend = gananciasPendientes.reduce((s, f) => s + (f.gananciaEspecial || (f.costoMercancia - f.costoReal) || 0), 0);

    const separarGanancia = (fId) => {
      const f = data.fantasmas.find(x => x.id === fId);
      if (!f) return;
      const ganancia = f.gananciaEspecial || (f.costoMercancia - f.costoReal) || 0;
      const registro = {
        id: Date.now(),
        pedidoId: fId,
        cliente: f.cliente,
        descripcion: f.descripcion,
        costoReal: f.costoReal,
        precioVenta: f.costoMercancia,
        ganancia,
        fecha: today(),
      };
      // Add to gastosAdmin as income so it shows in Admin Efectivo
      const ingresoAdmin = {
        id: Date.now() + 1,
        concepto: `⭐ GANANCIA ${fId} — ${f.cliente}${f.descripcion ? ' · ' + f.descripcion : ''}`,
        monto: ganancia,
        montoUSD: ganancia,
        montoMXN: 0,
        moneda: "USD",
        destino: "ADMIN",
        fecha: today(),
        nota: f.descripcion || "",
        tipoMov: "ingreso",
        gananciaPedidoId: fId,
      };
      const nd = {
        ...data,
        fantasmas: data.fantasmas.map(x => x.id !== fId ? x : { ...x, gananciaSeparada: true, fechaGananciaSeparada: today() }),
        bitacoraGanancias: [...(data.bitacoraGanancias || []), registro],
        gastosAdmin: [...(data.gastosAdmin || []), ingresoAdmin],
      };
      persist(nd);
    };

    return (
      <div>
        {/* Saldos principales */}
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>💰 Saldos</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          <div onClick={() => { navigate("finanzas"); setFinTab("efectivo"); }} style={{ flex: "1 1 170px", background: "#EFF6FF", borderRadius: 10, padding: "14px 18px", border: "2px solid #BFDBFE", cursor: "pointer" }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: "#1E40AF", textTransform: "uppercase" }}>💼 Caja Admin</div>
            <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "monospace", color: saldoAdmUSD >= 0 ? "#1A2744" : "#DC2626" }}>{fmt(saldoAdmUSD)}</div>
            {saldoAdmMXN !== 0 && <div style={{ fontSize: 12, fontWeight: 600, fontFamily: "monospace", color: saldoAdmMXN >= 0 ? "#D97706" : "#DC2626" }}>{fmtMXND(saldoAdmMXN)}</div>}
          </div>
          <div onClick={() => { navigate("bodegausa"); setUsaTab("efectivo"); }} style={{ flex: "1 1 130px", background: "#fff", borderRadius: 10, padding: "14px 18px", border: "1px solid #BFDBFE", cursor: "pointer" }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: "#2563EB", textTransform: "uppercase" }}>🇺🇸 Bodega USA</div>
            <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "monospace", color: saldoUsaUSD >= 0 ? "#2563EB" : "#DC2626" }}>{fmt(saldoUsaUSD)}</div>
            {saldoUsaMXN !== 0 && <div style={{ fontSize: 12, fontWeight: 600, fontFamily: "monospace", color: saldoUsaMXN >= 0 ? "#D97706" : "#DC2626" }}>{fmtMXND(saldoUsaMXN)}</div>}
          </div>
          <div onClick={() => { navigate("bodegausa"); setUsaTab("colchon"); }} style={{ flex: "1 1 110px", background: colPct < 30 ? "#FEF2F2" : "#FEF3C7", borderRadius: 10, padding: "14px 18px", border: colPct < 30 ? "2px solid #FECACA" : "1px solid #FDE68A", cursor: "pointer" }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: "#92400E", textTransform: "uppercase" }}>🛡️ Colchón</div>
            <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "monospace", color: colC }}>{fmt(c.saldoActual)}</div>
            <div style={{ fontSize: 9, color: "#9CA3AF" }}>{colPct}% de {fmt(c.montoOriginal)}</div>
          </div>
          <div onClick={() => { navigate("bodegatj"); setTjTab("efectivo"); }} style={{ flex: "1 1 130px", background: "#fff", borderRadius: 10, padding: "14px 18px", border: "1px solid #A7F3D0", cursor: "pointer" }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: "#059669", textTransform: "uppercase" }}>🇲🇽 Bodega TJ</div>
            <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "monospace", color: saldoTjUSD >= 0 ? "#059669" : "#DC2626" }}>{fmt(saldoTjUSD)}</div>
            {saldoTjMXN !== 0 && <div style={{ fontSize: 12, fontWeight: 600, fontFamily: "monospace", color: saldoTjMXN >= 0 ? "#D97706" : "#DC2626" }}>{fmtMXND(saldoTjMXN)}</div>}
          </div>
        </div>

        {/* Pedidos y deudas */}
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>📊 Pendientes</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          <Stat label="Pedidos activos" value={act.length} color="#2563EB" icon={<I.Box />} sub={`${data.fantasmas.length} totales`} />
          <Stat label="👻 Clientes deben" value={fmt(deudaClientes)} color="#DC2626" icon={<I.Dollar />} sub={`${pendClientes.length} pedidos`} />
          <Stat label="🚛 Fletes por cobrar" value={fmt(deudaFletes)} color="#2563EB" icon={<I.Truck />} sub={`${act.filter(f => !f.fletePagado && (f.costoFlete > 0 || f.fleteDesconocido)).length} pedidos`} />
          <Stat label="🏦 Crédito prov." value={fmt(credProv)} color="#7C3AED" icon={<I.Store />} sub={`${credProvCount} pedidos`} />
          {totalAdelPend > 0 && <Stat label="💸 Adelantos pend." value={fmt(totalAdelPend)} color="#D97706" icon={<I.Dollar />} sub={`${adelPend.length} pedidos`} />}
        </div>

        {/* Pipeline */}
        {porEst.length > 0 && <div style={{ background: "#fff", borderRadius: 9, border: "1px solid #E5E7EB", padding: 16, marginBottom: 12 }}><h3 style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 700 }}>Pipeline</h3><div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{porEst.map(e => <div key={e.key} onClick={() => { navigate("list"); setFEst(e.key); }} style={{ flex: "1 1 70px", minWidth: 65, padding: "8px 5px", borderRadius: 6, textAlign: "center", background: e.color.bg, cursor: "pointer" }}><div style={{ fontSize: 18, fontWeight: 700, color: e.color.text }}>{e.count}</div><div style={{ fontSize: 8, color: e.color.text, fontWeight: 600 }}>{e.label}</div></div>)}</div></div>}

        {/* ⭐ Ganancias especiales pendientes */}
        {(gananciasPendientes.length > 0 || (data.bitacoraGanancias || []).length > 0) && (
          <div style={{ background: "#FDF4FF", borderRadius: 9, border: "2px solid #E9D5FF", padding: 16, marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: gananciasPendientes.length > 0 ? 10 : 0 }}>
              <h3 style={{ margin: 0, fontSize: 12, fontWeight: 700, color: "#7C3AED" }}>⭐ Ganancias especiales{gananciasPendientes.length > 0 ? ` — ${gananciasPendientes.length} por separar` : " — al día ✓"}</h3>
              {gananciasPendientes.length > 0 && <span style={{ fontSize: 13, fontWeight: 700, fontFamily: "monospace", color: "#059669" }}>Total pendiente: {fmt(totalGananciaPend)}</span>}
            </div>
            {gananciasPendientes.length === 0 && (data.bitacoraGanancias || []).length === 0 && (
              <div style={{ fontSize: 11, color: "#9CA3AF", textAlign: "center", padding: "8px 0" }}>No hay pedidos especiales pagados pendientes de separar.</div>
            )}
            {gananciasPendientes.map(f => {
              const ganancia = f.gananciaEspecial || (f.costoMercancia - f.costoReal) || 0;
              return (
                <div key={f.id} style={{ background: "#fff", padding: "10px 12px", borderRadius: 8, border: "1px solid #E9D5FF", marginBottom: 6, display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ fontSize: 9, fontFamily: "monospace", color: "#9CA3AF" }}>{f.id}</span>
                      <strong style={{ fontSize: 12 }}>{f.cliente}</strong>
                      <span style={{ fontSize: 10, color: "#6B7280" }}>{f.descripcion}</span>
                    </div>
                    <div style={{ display: "flex", gap: 12, marginTop: 4, fontSize: 11 }}>
                      <span style={{ color: "#6B7280" }}>Costo real: <strong style={{ fontFamily: "monospace" }}>{fmt(f.costoReal)}</strong></span>
                      <span style={{ color: "#6B7280" }}>Vendido: <strong style={{ fontFamily: "monospace" }}>{fmt(f.costoMercancia)}</strong></span>
                      <span style={{ color: "#059669", fontWeight: 700 }}>Ganancia: {fmt(ganancia)}</span>
                    </div>
                  </div>
                  <button onClick={() => separarGanancia(f.id)} style={{ background: "#7C3AED", border: "none", color: "#fff", padding: "7px 14px", borderRadius: 7, cursor: "pointer", fontSize: 11, fontWeight: 700, fontFamily: "inherit", whiteSpace: "nowrap" }}>
                    ✅ Separar {fmt(ganancia)}
                  </button>
                </div>
              );
            })}
            {/* Bitácora dentro del mismo bloque */}
            {(data.bitacoraGanancias || []).length > 0 && (
              <div style={{ marginTop: 12, borderTop: "1px solid #E9D5FF", paddingTop: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#7C3AED" }}>📒 Historial separado</span>
                  <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "monospace", color: "#059669" }}>
                    Total: {fmt([...(data.bitacoraGanancias || [])].reduce((s, g) => s + (g.ganancia || 0), 0))}
                  </span>
                </div>
                {[...(data.bitacoraGanancias || [])].reverse().map(g => (
                  <div key={g.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderBottom: "1px solid #F3E8FF", fontSize: 11, background: "#fff", borderRadius: 4, marginBottom: 2 }}>
                    <span style={{ color: "#9CA3AF", fontSize: 9, fontFamily: "monospace", minWidth: 50 }}>{g.pedidoId}</span>
                    <span style={{ flex: 1 }}><strong>{g.cliente}</strong> — {g.descripcion}</span>
                    <span style={{ color: "#6B7280", fontSize: 10 }}>{fmtD(g.fecha)}</span>
                    <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#059669" }}>{fmt(g.ganancia)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Alertas */}
        {alertas.length > 0 && <div style={{ background: "#FFF7ED", borderRadius: 9, border: "1px solid #FED7AA", padding: 16, marginBottom: 14 }}><h3 style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 700, color: "#9A3412" }}><I.Alert /> Atención ({alertas.length})</h3>{alertas.slice(0, 8).map(f => { const r = []; if (f.creditoProveedor && !f.proveedorPagado) r.push("Deuda prov."); if (!f.clientePago && f.estado === "ENTREGADO") r.push("Sin cobrar"); if (f.dineroStatus === "COLCHON_USADO") r.push("🛡️ Reponer"); const d = Math.floor((new Date() - new Date(f.fechaActualizacion)) / 864e5); if (d > 3) r.push(`${d}d`); return <div key={f.id} onClick={() => { setDetailMode("full"); navigate("detail", f.id, view); }} style={{ background: "#fff", padding: "6px 10px", borderRadius: 6, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", border: "1px solid #FED7AA", marginBottom: 3, fontSize: 11 }}><div><span style={{ fontFamily: "monospace", color: "#9CA3AF", fontSize: 9 }}>{f.id}</span> <strong>{f.cliente}</strong> <span style={{ color: "#9A3412" }}>{r.join(" · ")}</span></div><I.Right /></div>; })}</div>}

        {/* Pedidos pendientes table */}
        <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E5E7EB", padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
            <div style={{ display: "flex", gap: 3, background: "#F3F4F6", borderRadius: 6, padding: 2 }}>
              <button onClick={() => setDashTab("fletes")} style={{ padding: "5px 12px", borderRadius: 5, border: "none", background: dashTab === "fletes" ? "#fff" : "transparent", boxShadow: dashTab === "fletes" ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 11, fontWeight: dashTab === "fletes" ? 700 : 500, fontFamily: "inherit", color: dashTab === "fletes" ? "#2563EB" : "#6B7280" }}>🚛 Fletes pendientes</button>
              <button onClick={() => setDashTab("fantasmas")} style={{ padding: "5px 12px", borderRadius: 5, border: "none", background: dashTab === "fantasmas" ? "#fff" : "transparent", boxShadow: dashTab === "fantasmas" ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 11, fontWeight: dashTab === "fantasmas" ? 700 : 500, fontFamily: "inherit", color: dashTab === "fantasmas" ? "#DC2626" : "#6B7280" }}>👻 Fantasmas pendientes</button>
            </div>
          </div>
          {/* Search + filters */}
          <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
            <div style={{ position: "relative", flex: "1 1 160px" }}>
              <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "#9CA3AF" }}><I.Search /></span>
              <input value={dashSearch} onChange={e => setDashSearch(e.target.value)} placeholder="Folio, cliente, mercancía..." autoComplete="off" style={{ width: "100%", padding: "7px 10px", paddingLeft: 28, borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, outline: "none", boxSizing: "border-box", fontFamily: "inherit", background: "#FAFAFA" }} />
            </div>
            <select value={dashFCli} onChange={e => setDashFCli(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, fontFamily: "inherit", background: dashFCli !== "ALL" ? "#EFF6FF" : "#FAFAFA" }}>
              <option value="ALL">Clientes</option>
              {[...new Set(act.map(f => f.cliente))].sort().map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={dashFProv} onChange={e => setDashFProv(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, fontFamily: "inherit", background: dashFProv !== "ALL" ? "#FEF3C7" : "#FAFAFA" }}>
              <option value="ALL">Proveedores</option>
              {[...new Set(act.map(f => f.proveedor).filter(Boolean))].sort().map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          {(() => {
            const isMerc = dashTab === "fantasmas";
            let list = isMerc ? act.filter(f => !f.clientePago) : act.filter(f => !f.fletePagado && (f.costoFlete > 0 || f.fleteDesconocido));
            if (dashSearch) { const s = dashSearch.toLowerCase(); list = list.filter(f => f.cliente.toLowerCase().includes(s) || f.id.toLowerCase().includes(s) || f.descripcion.toLowerCase().includes(s) || (f.proveedor || "").toLowerCase().includes(s)); }
            if (dashFCli !== "ALL") list = list.filter(f => f.cliente === dashFCli);
            if (dashFProv !== "ALL") list = list.filter(f => f.proveedor === dashFProv);
            const totalPend = list.reduce((s, f) => s + (isMerc ? (f.costoMercancia - (f.abonoMercancia || 0)) : (f.costoFlete - (f.abonoFlete || 0))), 0);
            const th = { padding: "6px 8px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", background: isMerc ? "#991B1B" : "#1E40AF", color: "#fff", position: "sticky", top: 0, whiteSpace: "nowrap" };
            const td = { padding: "7px 8px", borderBottom: "1px solid #F3F4F6", fontSize: 11 };
            return (
              <div>
                <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 6 }}>{list.length} pedidos · Pendiente: <strong style={{ color: isMerc ? "#DC2626" : "#2563EB" }}>{fmt(totalPend)}</strong></div>
                {list.length === 0 ? <div style={{ textAlign: "center", padding: 20, color: "#9CA3AF", fontSize: 11 }}>No hay {isMerc ? "fantasmas" : "fletes"} pendientes.</div> : (
                  <div style={{ overflow: "auto", maxHeight: 350, borderRadius: 8, border: "1px solid #E5E7EB" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "inherit" }}>
                      <thead><tr>
                        <th style={th}>Folio</th>
                        <th style={th}>Cliente</th>
                        <th style={th}>Proveedor</th>
                        <th style={th}>Mercancía</th>
                        <th style={th}>Empaque</th>
                        <th style={{ ...th, textAlign: "right" }}>Total</th>
                        <th style={{ ...th, textAlign: "right" }}>Abonado</th>
                        <th style={{ ...th, textAlign: "right" }}>Debe</th>
                        <th style={th}>Estado</th>
                        <th style={th}>Dinero</th>
                      </tr></thead>
                      <tbody>{list.map((f, i) => {
                        const tot = isMerc ? f.costoMercancia : (f.costoFlete || 0);
                        const ab = isMerc ? (f.abonoMercancia || 0) : (f.abonoFlete || 0);
                        return (
                          <tr key={f.id} onClick={() => { setDetailMode("full"); navigate("detail", f.id, view); }} style={{ cursor: "pointer", background: i % 2 === 0 ? "#fff" : "#FAFBFC" }} onMouseEnter={e => e.currentTarget.style.background = "#EFF6FF"} onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? "#fff" : "#FAFBFC"}>
                            <td style={{ ...td, fontFamily: "monospace", fontWeight: 600 }}>{f.id}</td>
                            <td style={{ ...td, fontWeight: 600 }}>{f.cliente}</td>
                            <td style={{ ...td, color: "#D97706" }}>{f.proveedor || "—"}</td>
                            <td style={{ ...td, color: "#6B7280", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.descripcion}</td>
                            <td style={{ ...td, color: "#6B7280" }}>{f.cantBultos || 1} {f.empaque || "—"}</td>
                            <td style={{ ...td, textAlign: "right", fontFamily: "monospace" }}>{fmt(tot)}</td>
                            <td style={{ ...td, textAlign: "right", fontFamily: "monospace", color: ab > 0 ? "#D97706" : "#9CA3AF" }}>{ab > 0 ? fmt(ab) : "—"}</td>
                            <td style={{ ...td, textAlign: "right", fontFamily: "monospace", fontWeight: 700, color: isMerc ? "#DC2626" : "#2563EB" }}>{fmt(tot - ab)}</td>
                            <td style={{ ...td, padding: "4px 6px" }}><Badge estado={f.estado} /></td>
                            <td style={{ ...td, padding: "4px 6px" }}><DBadge status={f.dineroStatus || "SIN_FONDOS"} /></td>
                          </tr>
                        );
                      })}</tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>
    );
  };

  // ============ BITÁCORA ============
  const Bitacora = () => {
    const sk = bitSk; const setSk = setBitSk;
    const sd = bitSd; const setSd = setBitSd;
    const modo = bitModo; const setModo = setBitModo;
    const fProv = bitFProv; const setFProv = setBitFProv;
    const fCli = bitFCli; const setFCli = setBitFCli;
    const fVend = bitFVend; const setFVend = setBitFVend;
    const bSearch = bitSearch; const setBSearch = setBitSearch;
    const bPagoMerc = bitPagoMerc; const setBPagoMerc = setBitPagoMerc;
    const bPagoFlete = bitPagoFlete; const setBPagoFlete = setBitPagoFlete;
    const bEstado = bitEstado; const setBEstado = setBitEstado;
    const [editCell, setEditCell] = useState(null); // { id, field, val }

    const EMPAQUES = ["Caja", "Gaylor", "Pallet", "Sobre", "Bulto", "Bolsa", "Sandillero", "Step Completa", "Espacio", "Desconocido", "Otro"];

    const clickTimer = useRef(null);
    const startEdit = (e, f, field) => {
      e.stopPropagation();
      if (clickTimer.current) clearTimeout(clickTimer.current);
      setEditCell({ id: f.id, field, val: String(f[field] ?? "") });
    };
    const goDelayed = (fn) => {
      if (clickTimer.current) clearTimeout(clickTimer.current);
      clickTimer.current = setTimeout(fn, 220);
    };
    const saveEdit = () => {
      if (!editCell) return;
      const f = data.fantasmas.find(x => x.id === editCell.id);
      if (!f) { setEditCell(null); return; }
      const { field, val } = editCell;
      const numFields = ["costoMercancia", "costoFlete", "cantBultos"];
      const noUpper = ["cliente", "proveedor", "vendedor"];
      const parsed = numFields.includes(field) ? (parseFloat(val) || 0) : noUpper.includes(field) ? val.trim() : val.trim().toUpperCase();
      if (String(f[field] ?? "") === String(parsed)) { setEditCell(null); return; }
      updF(f.id, { [field]: parsed });
      setEditCell(null);
    };
    const EditCell = ({ f, field, style = {}, numeric = false, select = null }) => {
      const isEditing = editCell?.id === f.id && editCell?.field === field;
      if (isEditing) {
        if (select) return (
          <select autoFocus value={editCell.val} onChange={e => setEditCell({ ...editCell, val: e.target.value })}
            onBlur={saveEdit} onClick={e => e.stopPropagation()}
            style={{ width: "100%", fontSize: 11, border: "2px solid #2563EB", borderRadius: 4, padding: "2px 4px", fontFamily: "inherit", background: "#EFF6FF" }}>
            {select.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        );
        return <input autoFocus type={numeric ? "number" : "text"} value={editCell.val}
          onChange={e => setEditCell({ ...editCell, val: e.target.value })}
          onClick={e => e.stopPropagation()}
          onBlur={saveEdit} onKeyDown={e => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditCell(null); }}
          style={{ width: "100%", fontSize: 11, border: "2px solid #2563EB", borderRadius: 4, padding: "2px 4px", fontFamily: numeric ? "monospace" : "inherit", background: "#EFF6FF", outline: "none", ...style }} />;
      }
      return <span
        onClick={e => e.stopPropagation()}
        onDoubleClick={e => startEdit(e, f, field)}
        title="Doble click para editar"
        style={{ cursor: "cell", display: "block", minHeight: 16, ...style }}>{f[field] ?? "—"}</span>;
    };
    const provs = [...new Set(data.fantasmas.map(f => f.proveedor).filter(Boolean))];
    const clis = [...new Set(data.fantasmas.map(f => f.cliente).filter(Boolean))];
    const vends = [...new Set(data.fantasmas.map(f => f.vendedor).filter(Boolean))];

    let list = data.fantasmas.filter(f => f.estado !== "CERRADO");
    if (fProv !== "ALL") list = list.filter(f => f.proveedor === fProv);
    if (fCli !== "ALL") list = list.filter(f => f.cliente === fCli);
    if (fVend !== "ALL") list = list.filter(f => f.vendedor === fVend);
    if (bEstado !== "ALL") list = list.filter(f => f.estado === bEstado);
    if (bPagoMerc === "pagado") list = list.filter(f => f.clientePago);
    if (bPagoMerc === "pendiente") list = list.filter(f => !f.clientePago);
    if (bPagoFlete === "pagado") list = list.filter(f => f.fletePagado);
    if (bPagoFlete === "pendiente") list = list.filter(f => !f.fletePagado && (f.costoFlete > 0 || f.fleteDesconocido));
    if (bSearch) { const s = bSearch.toLowerCase().trim(); const sNum = s.replace(/[^0-9]/g, ""); list = list.filter(f => f.cliente.toLowerCase().includes(s) || f.descripcion.toLowerCase().includes(s) || f.id.toLowerCase().includes(s) || (sNum && f.id.includes(sNum)) || (f.proveedor||"").toLowerCase().includes(s) || (f.vendedor||"").toLowerCase().includes(s) || (f.tipoMercancia||"").toLowerCase().includes(s)); }

    const sorted = [...list].sort((a, b) => { const va = a[sk] ?? ""; const vb = b[sk] ?? ""; return (typeof va === "number" ? va - vb : String(va).localeCompare(String(vb))) * sd; });
    const toggle = k => { if (sk === k) setSd(d => d * -1); else { setSk(k); setSd(-1); } };
    const th = { padding: "7px 8px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", cursor: "pointer", whiteSpace: "nowrap", background: "#1A2744", color: "#fff", position: "sticky", top: 0, letterSpacing: .3 };
    const arr = k => sk === k ? (sd === 1 ? " ↑" : " ↓") : "";
    const exportCSV = () => { const BOM = "\uFEFF"; const h = ["#","Vendedor","Proveedor","Cliente","Mercancía","Empaque","# Bultos","Cant","C.Unit","Costo","Flete","Estado","Dinero","👻 Pagó","🚛 Flete Pagó","Fecha"]; const rows = sorted.map((f,i) => [i+1,f.vendedor||"—",f.proveedor||"",f.cliente,f.descripcion,f.empaque||"",f.cantBultos||"",f.cantidad||"",f.costoUnitario||"",f.costoMercancia,f.costoFlete,ESTADOS[f.estado],DINERO_STATUS[f.dineroStatus||"SIN_FONDOS"],f.clientePago?"Pagado":(f.abonoMercancia||0)>0?`Abono ${f.abonoMercancia}`:"No",f.fletePagado?"Pagado":(f.abonoFlete||0)>0?`Abono ${f.abonoFlete}`:"No",f.fechaCreacion]); const csv = BOM + [h,...rows].map(r => r.map(c => `"${String(c??"").replace(/"/g,'""')}"`).join(",")).join("\n"); const b = new Blob([csv],{type:"text/csv;charset=utf-8;"}); const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href=u; a.download=`bitacora-${today()}.csv`; a.click(); URL.revokeObjectURL(u); };

    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Bitácora</h2>
          <div style={{ display: "flex", gap: 4 }}>
            <Btn sz="sm" v={modo === "axia" ? "primary" : "secondary"} onClick={() => setModo("axia")}>📋 Completa</Btn>
            <Btn sz="sm" v={modo === "status" ? "primary" : "secondary"} onClick={() => setModo("status")}>📊 Compacta</Btn>
            <Btn v="secondary" sz="sm" onClick={exportCSV}><I.Dl /> CSV</Btn>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 3, background: "#F3F4F6", borderRadius: 8, padding: 3, marginBottom: 10 }}>
          <button onClick={() => setBitTab("estado")} style={{ flex: 1, padding: "6px 12px", borderRadius: 6, border: "none", background: bitTab === "estado" ? "#fff" : "transparent", boxShadow: bitTab === "estado" ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 11, fontWeight: bitTab === "estado" ? 700 : 500, fontFamily: "inherit", color: bitTab === "estado" ? "#1A2744" : "#6B7280" }}>📦 Estado</button>
          <button onClick={() => setBitTab("fletes")} style={{ flex: 1, padding: "6px 12px", borderRadius: 6, border: "none", background: bitTab === "fletes" ? "#fff" : "transparent", boxShadow: bitTab === "fletes" ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 11, fontWeight: bitTab === "fletes" ? 700 : 500, fontFamily: "inherit", color: bitTab === "fletes" ? "#2563EB" : "#6B7280" }}>🚛 Fletes</button>
          <button onClick={() => setBitTab("fantasmas")} style={{ flex: 1, padding: "6px 12px", borderRadius: 6, border: "none", background: bitTab === "fantasmas" ? "#fff" : "transparent", boxShadow: bitTab === "fantasmas" ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 11, fontWeight: bitTab === "fantasmas" ? 700 : 500, fontFamily: "inherit", color: bitTab === "fantasmas" ? "#DC2626" : "#6B7280" }}>👻 Fantasmas</button>
          <button onClick={() => setBitTab("todos")} style={{ flex: 1, padding: "6px 12px", borderRadius: 6, border: "none", background: bitTab === "todos" ? "#fff" : "transparent", boxShadow: bitTab === "todos" ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 11, fontWeight: bitTab === "todos" ? 700 : 500, fontFamily: "inherit", color: bitTab === "todos" ? "#374151" : "#6B7280" }}>📋 Todo</button>
        </div>

        {/* Filters */}
        <div style={{ display: "flex", gap: 5, marginBottom: 6, flexWrap: "wrap" }}>
          <div style={{ position: "relative", flex: "1 1 140px" }}><span style={{ position: "absolute", left: 7, top: "50%", transform: "translateY(-50%)", color: "#9CA3AF" }}><I.Search /></span><input value={bSearch} onChange={e => setBSearch(e.target.value)} placeholder="Folio, cliente, proveedor..." autoComplete="off" style={{ width: "100%", padding: "7px 10px", paddingLeft: 26, borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, outline: "none", boxSizing: "border-box", fontFamily: "inherit", background: "#FAFAFA" }} /></div>
          <select value={fProv} onChange={e => setFProv(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, fontFamily: "inherit", background: "#FAFAFA" }}><option value="ALL">Proveedores</option>{provs.map(p => <option key={p} value={p}>{p}</option>)}</select>
          <select value={fCli} onChange={e => setFCli(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, fontFamily: "inherit", background: "#FAFAFA" }}><option value="ALL">Clientes</option>{clis.map(c => <option key={c} value={c}>{c}</option>)}</select>
          {vends.length > 0 && <select value={fVend} onChange={e => setFVend(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, fontFamily: "inherit", background: "#FAFAFA" }}><option value="ALL">Vendedores</option>{vends.map(v => <option key={v} value={v}>{v}</option>)}</select>}
        </div>
        <div style={{ display: "flex", gap: 5, marginBottom: 10, flexWrap: "wrap" }}>
          <select value={bEstado} onChange={e => setBEstado(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, fontFamily: "inherit", background: bEstado !== "ALL" ? "#EFF6FF" : "#FAFAFA" }}><option value="ALL">Todos los estados</option>{ESTADO_KEYS.map(k => <option key={k} value={k}>{ESTADOS[k]}</option>)}</select>
          <select value={bPagoMerc} onChange={e => setBPagoMerc(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, fontFamily: "inherit", background: bPagoMerc !== "ALL" ? "#FEF2F2" : "#FAFAFA" }}><option value="ALL">👻 Mercancía: Todos</option><option value="pagado">👻 Pagada ✓</option><option value="pendiente">👻 Pendiente ✗</option></select>
          <select value={bPagoFlete} onChange={e => setBPagoFlete(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, fontFamily: "inherit", background: bPagoFlete !== "ALL" ? "#EFF6FF" : "#FAFAFA" }}><option value="ALL">🚛 Flete: Todos</option><option value="pagado">🚛 Pagado ✓</option><option value="pendiente">🚛 Pendiente ✗</option></select>
        </div>

        <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 6 }}>
          {sorted.length} pedidos
          {bitTab === "estado" && (() => { const byEst = {}; sorted.forEach(f => { byEst[f.estado] = (byEst[f.estado] || 0) + 1; }); return <span> · {Object.entries(byEst).map(([k, v]) => `${ESTADOS[k]}: ${v}`).join(" · ")}</span>; })()}
          {bitTab === "fletes" && (() => { const tf = sorted.reduce((s, f) => s + (f.costoFlete || 0), 0); const tp = sorted.filter(f => f.fletePagado).reduce((s, f) => s + (f.costoFlete || 0), 0); return <span> · Total: <strong>{fmt(tf)}</strong> · Pagado: <strong style={{ color: "#059669" }}>{fmt(tp)}</strong> · Pendiente: <strong style={{ color: "#DC2626" }}>{fmt(tf - tp)}</strong></span>; })()}
          {bitTab === "fantasmas" && (() => { const tf = sorted.reduce((s, f) => s + f.costoMercancia, 0); const tp = sorted.filter(f => f.clientePago).reduce((s, f) => s + f.costoMercancia, 0); return <span> · Total: <strong>{fmt(tf)}</strong> · Pagado: <strong style={{ color: "#059669" }}>{fmt(tp)}</strong> · Pendiente: <strong style={{ color: "#DC2626" }}>{fmt(tf - tp)}</strong></span>; })()}
        </div>

        <div style={{ background: "#fff", borderRadius: 9, border: "1px solid #E5E7EB", overflow: "auto", maxHeight: "70vh" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: "inherit" }}>
            <thead><tr>
              <th onClick={() => toggle("id")} style={th}>Folio{arr("id")}</th>
              {modo === "axia" && <th style={th}>Vendedor</th>}
              <th onClick={() => toggle("proveedor")} style={th}>Proveedor{arr("proveedor")}</th>
              <th onClick={() => toggle("cliente")} style={th}>Cliente{arr("cliente")}</th>
              <th style={th}>Mercancía</th>
              {modo === "axia" && <th style={th}>Empaque</th>}
              {bitTab === "estado" && <><th style={th}>Estado</th><th style={th}>Dinero</th></>}
              {(bitTab === "fantasmas" || bitTab === "todos") && <><th onClick={() => toggle("costoMercancia")} style={{...th, color: "#FCA5A5"}}>👻 Costo{arr("costoMercancia")}</th><th style={th}>👻 Pagó</th></>}
              {(bitTab === "fletes" || bitTab === "todos") && <><th onClick={() => toggle("costoFlete")} style={{...th, color: "#93C5FD"}}>🚛 Flete{arr("costoFlete")}</th><th style={th}>🚛 Pagó</th></>}
              <th style={{...th, cursor: "default", width: 30}}></th>
            </tr></thead>
            <tbody>{sorted.map((f, i) => {
                const td = { padding: "4px 8px", borderBottom: "1px solid #F3F4F6" };
                const go = () => { if (editCell) return; setDetailMode("full"); navigate("detail", f.id, view); };
                return (
                  <tr key={f.id} style={{ background: i % 2 === 0 ? "#fff" : "#FAFBFC" }} onMouseEnter={e => e.currentTarget.style.background = "#EFF6FF"} onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? "#fff" : "#FAFBFC"}>
                    <td onClick={() => goDelayed(go)} style={{ ...td, fontFamily: "monospace", color: "#1A2744", fontSize: 10, fontWeight: 600, cursor: "pointer" }}>{f.id}</td>
                    {modo === "axia" && <td style={td}><EditCell f={f} field="vendedor" select={vends} /></td>}
                    <td style={{ ...td, color: "#D97706", fontWeight: 600 }}><EditCell f={f} field="proveedor" select={provs} /></td>
                    <td style={{ ...td, fontWeight: 600 }}><EditCell f={f} field="cliente" select={clis} /></td>
                    <td style={{ ...td, maxWidth: 140 }}><EditCell f={f} field="descripcion" /></td>
                    {modo === "axia" && <td style={td}>
                      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                        <EditCell f={f} field="cantBultos" numeric style={{ width: 30 }} />
                        <EditCell f={f} field="empaque" select={EMPAQUES} />
                      </div>
                    </td>}
                    {bitTab === "estado" && <><td onClick={() => goDelayed(go)} style={{ ...td, padding: "6px 4px", cursor: "pointer" }}><Badge estado={f.estado} /></td><td onClick={go} style={{ ...td, padding: "6px 4px", cursor: "pointer" }}><DBadge status={f.dineroStatus || "SIN_FONDOS"} /></td></>}
                    {(bitTab === "fantasmas" || bitTab === "todos") && <>
                      <td style={td}><EditCell f={f} field="costoMercancia" numeric style={{ color: "#DC2626", fontFamily: "monospace", fontWeight: 700, textAlign: "right" }} /></td>
                      <td onClick={go} style={{ ...td, textAlign: "center", cursor: "pointer" }}>{f.clientePago ? <span style={{ background: "#D1FAE5", color: "#065F46", padding: "3px 8px", borderRadius: 10, fontSize: 10, fontWeight: 700, display: "inline-block" }}>✅ PAGADO</span> : (f.abonoMercancia || 0) > 0 ? <span style={{ background: "#FEF3C7", color: "#92400E", padding: "3px 8px", borderRadius: 10, fontSize: 9, fontWeight: 700, display: "inline-block" }}>⚠️ {fmt(f.abonoMercancia)}</span> : f.costoDesconocido ? <span style={{ background: "#FEF3C7", color: "#92400E", padding: "3px 8px", borderRadius: 10, fontSize: 10, fontWeight: 700, display: "inline-block" }}>❓ POR DEFINIR</span> : <span style={{ background: "#FEE2E2", color: "#991B1B", padding: "3px 8px", borderRadius: 10, fontSize: 10, fontWeight: 700, display: "inline-block" }}>❌ PENDIENTE</span>}
                      </td>
                    </>}
                    {(bitTab === "fletes" || bitTab === "todos") && <>
                      <td style={td}><EditCell f={f} field="costoFlete" numeric style={{ color: "#2563EB", fontFamily: "monospace", fontWeight: 600, textAlign: "right" }} /></td>
                      <td onClick={go} style={{ ...td, textAlign: "center", cursor: "pointer" }}>{f.fletePagado ? <span style={{ background: "#D1FAE5", color: "#065F46", padding: "3px 8px", borderRadius: 10, fontSize: 10, fontWeight: 700, display: "inline-block" }}>✅ PAGADO</span> : f.fleteDesconocido ? <span style={{ background: "#FEF3C7", color: "#92400E", padding: "3px 8px", borderRadius: 10, fontSize: 10, fontWeight: 700, display: "inline-block" }}>❓ POR DEFINIR</span> : !f.costoFlete ? <span style={{ color: "#9CA3AF" }}>—</span> : (f.abonoFlete || 0) > 0 ? <span style={{ background: "#FEF3C7", color: "#92400E", padding: "3px 8px", borderRadius: 10, fontSize: 9, fontWeight: 700, display: "inline-block" }}>⚠️ {fmt(f.abonoFlete)}</span> : <span style={{ background: "#FEE2E2", color: "#991B1B", padding: "3px 8px", borderRadius: 10, fontSize: 10, fontWeight: 700, display: "inline-block" }}>❌ PENDIENTE</span>}
                      </td>
                    </>}
                    <td style={{ ...td, textAlign: "center", padding: "4px" }}><button onClick={(e) => { e.stopPropagation(); setConfirm(f.id); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#D1D5DB", padding: 2 }} onMouseEnter={e => e.currentTarget.style.color = "#DC2626"} onMouseLeave={e => e.currentTarget.style.color = "#D1D5DB"}><I.Trash /></button></td>
                  </tr>
                );
              })}</tbody>
          </table>
        </div>
        {confirm && (() => { const cf = data.fantasmas.find(x => x.id === confirm); return cf ? (
          <Modal title="Eliminar pedido" onClose={() => setConfirm(null)} w={380}>
            <p style={{ margin: "0 0 8px", fontSize: 12 }}><strong>{cf.cliente}</strong> — {cf.descripcion} ({fmt(cf.costoMercancia)})</p>
            {(() => { const linked = []; if (cf.fletePagadoCxp) linked.push(`Abono flete a CxP: ${cf.fletePagadoCxp} (${fmt(cf.costoFlete)})`); if (cf.dineroStatus === "DINERO_CAMINO") linked.push("Sobre en camino a USA"); if (cf.usaColchon) linked.push("Uso de colchón"); if ((cf.movimientos||[]).length > 0) linked.push(`${cf.movimientos.length} pago(s)`); if (cf.comisionCobrada) linked.push(`Comisión (${fmt(cf.comisionMonto)})`); return linked.length > 0 ? <div style={{ background: "#FEF2F2", borderRadius: 6, padding: "8px 10px", marginBottom: 10, border: "1px solid #FECACA" }}><div style={{ fontSize: 10, fontWeight: 600, color: "#991B1B", marginBottom: 4 }}>⚠️ También se eliminará:</div>{linked.map((l,i) => <div key={i} style={{ fontSize: 10, color: "#DC2626" }}>• {l}</div>)}</div> : null; })()}
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <Btn v="secondary" onClick={() => setConfirm(null)}>Cancelar</Btn>
              <Btn v="danger" onClick={() => delF(cf.id)}>Sí, eliminar</Btn>
            </div>
          </Modal>
        ) : null; })()}
      </div>
    );
  };
  const Clientes = () => {
    const [exp, setExp] = useState(null);
    const [cSearch, setCSearch] = useState("");
    const [cFiltro, setCFiltro] = useState("ALL"); // ALL, pendiente, pagado, moroso
    const [cSort, setCSort] = useState("saldo_desc"); // nombre_asc, nombre_desc, saldo_desc, saldo_asc, monto_desc, monto_asc
    const [pagoCliente, setPagoCliente] = useState(null);
    const [pagoForm, setPagoForm] = usePersistedForm("pagoForm", { fecha: today(), monto: "", nota: "", selected: {}, tipo: "merc" });

    const [showNewCliente, setShowNewCliente] = useModalState("showNewCliente");
    const [showNewVendedor, setShowNewVendedor] = useModalState("showNewVendedor");
    const [newName, setNewName] = useState("");

    const addCliente = async (name) => {
      if (!name) return;
      const n = name.toUpperCase();
      const existing = data.clientes || [];
      // Exact match — block
      if (existing.includes(n)) { showAlert("⚠️ El cliente \"" + n + "\" ya existe."); return; }
      // Similar match — warn
      const similar = existing.filter(c => {
        if (c.includes(n) || n.includes(c)) return true;
        // Check word overlap
        const words = n.split(" ").filter(w => w.length > 2);
        return words.some(w => c.includes(w));
      });
      if (similar.length > 0) {
        if (!await showConfirm(`⚠️ Ya existen clientes con nombre similar:\n\n${similar.join("\n")}\n\n¿Seguro que quieres agregar "${n}"?`)) return;
      }
      persist({ ...data, clientes: [...existing, n] });
      setShowNewCliente(false); setNewName("");
    };
    const addVendedor = async (name) => {
      if (!name) return;
      const n = name.toUpperCase();
      const existing = data.vendedores || [];
      if (existing.includes(n)) { showAlert("⚠️ El vendedor \"" + n + "\" ya existe."); return; }
      const similar = existing.filter(v => v.includes(n) || n.includes(v) || n.split(" ").filter(w => w.length > 2).some(w => v.includes(w)));
      if (similar.length > 0) {
        if (!await showConfirm(`⚠️ Ya existen vendedores con nombre similar:\n\n${similar.join("\n")}\n\n¿Seguro que quieres agregar "${n}"?`)) return;
      }
      persist({ ...data, vendedores: [...existing, n] });
      setShowNewVendedor(false); setNewName("");
    };
    const deleteCliente = (name) => {
      persist({ ...data, clientes: (data.clientes || []).filter(c => c !== name) });
    };
    const deleteVendedor = (name) => {
      persist({ ...data, vendedores: (data.vendedores || []).filter(v => v !== name) });
    };
    const cm = useMemo(() => {
      const m = {};
      // Include registered clientes even if they have no pedidos
      (data.clientes || []).forEach(c => { if (!m[c]) m[c] = { n: c, p: [] }; });
      data.fantasmas.forEach(f => { if (!m[f.cliente]) m[f.cliente] = { n: f.cliente, p: [] }; m[f.cliente].p.push(f); });
      return Object.values(m).map(c => {
        const act = c.p.filter(f => f.estado !== "CERRADO");
        const totalVendido = c.p.reduce((s, f) => s + (f.totalVenta || f.costoMercancia) + (f.costoFlete || 0), 0);
        const totalRecibido = c.p.reduce((s, f) => {
          const rm = f.clientePago ? (f.totalVenta || f.costoMercancia) : (f.abonoMercancia || f.clientePagoMonto || 0);
          const rf = f.fletePagado ? (f.costoFlete || 0) : (f.abonoFlete || 0);
          return s + rm + rf;
        }, 0);
        const saldo = totalVendido - totalRecibido;
        const pendientes = act.filter(f => !f.clientePago || !f.fletePagado);
        const mor = c.p.some(f => !f.clientePago && f.estado === "ENTREGADO");
        const pagos = c.p.flatMap(f => (f.movimientos || []).filter(m => m.tipo === "Entrada").map(m => ({ ...m, fId: f.id, desc: f.descripcion }))).sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
        return { ...c, act: act.length, totalVendido, totalRecibido, saldo, pendientes, mor, pagos };
      }).sort((a, b) => b.saldo - a.saldo);
    }, [data]);

    const openPago = (clientName) => {
      setPagoCliente(clientName);
      setPagoForm({ fecha: today(), monto: "", nota: "", selected: {}, tipo: {} });
    };

    const registrarPago = () => {
      const monto = parseFloat(pagoForm.monto) || 0;
      if (monto <= 0) return;
      const selIds = Object.keys(pagoForm.selected).filter(k => pagoForm.selected[k]);
      if (selIds.length === 0) return;

      // distribute monto across selected pedidos
      let remaining = monto;
      const updates = [];
      for (const fId of selIds) {
        if (remaining <= 0) break;
        const f = data.fantasmas.find(x => x.id === fId);
        if (!f) continue;
        const tipo = pagoForm.tipo[fId] || "mercancia";

        if (tipo === "mercancia") {
          const debe = (f.totalVenta || f.costoMercancia) - (f.abonoMercancia || 0);
          const aplicar = Math.min(remaining, debe);
          const nuevoAbono = (f.abonoMercancia || 0) + aplicar;
          const pagado = nuevoAbono >= (f.totalVenta || f.costoMercancia);
          updates.push({ id: fId, ch: { abonoMercancia: nuevoAbono, clientePago: pagado, clientePagoMonto: nuevoAbono + (f.abonoFlete || 0) }, monto: aplicar, concepto: `Pago mercancía${pagoForm.nota ? " - " + pagoForm.nota : ""}` });
          remaining -= aplicar;
        } else {
          const debe = (f.costoFlete || 0) - (f.abonoFlete || 0);
          const aplicar = Math.min(remaining, debe);
          const nuevoAbono = (f.abonoFlete || 0) + aplicar;
          const pagado = nuevoAbono >= (f.costoFlete || 0);
          updates.push({ id: fId, ch: { abonoFlete: nuevoAbono, fletePagado: pagado, clientePagoMonto: (f.abonoMercancia || 0) + nuevoAbono }, monto: aplicar, concepto: `Pago flete${pagoForm.nota ? " - " + pagoForm.nota : ""}` });
          remaining -= aplicar;
        }
      }

      // apply all updates
      const PRESERVE_DS = ["DINERO_CAMINO","SOBRE_LISTO","DINERO_USA","COLCHON_USADO","TRANS_PENDIENTE","NO_APLICA"];
      let newData = { ...data };
      for (const u of updates) {
        newData = { ...newData, fantasmas: newData.fantasmas.map(f => {
          if (f.id !== u.id) return f;
          const updated = {
            ...f, ...u.ch, fechaActualizacion: today(),
            movimientos: [...(f.movimientos || []), { id: Date.now() + Math.random(), tipo: "Entrada", concepto: u.concepto, monto: u.monto, fecha: pagoForm.fecha }],
            historial: [...(f.historial || []), { fecha: today(), accion: `Pago: ${fmt(u.monto)} (${u.concepto})`, quien: role }],
          };
          if (!PRESERVE_DS.includes(updated.dineroStatus)) {
            const ds = calcDineroStatus(updated);
            if (ds) updated.dineroStatus = ds;
          }
          return updated;
        }) };
      }
      persist(newData);
      setPagoCliente(null);
    };

    const filteredCm = (() => {
      let list = cm;
      if (cSearch) list = list.filter(c => c.n.toLowerCase().includes(cSearch.toLowerCase()));
      if (cFiltro === "pendiente") list = list.filter(c => c.saldo > 0);
      if (cFiltro === "pagado") list = list.filter(c => c.saldo <= 0 && c.p.length > 0);
      if (cFiltro === "moroso") list = list.filter(c => c.mor);
      if (cFiltro === "sin_pedidos") list = list.filter(c => c.p.length === 0);
      const sortFns = {
        nombre_asc: (a, b) => a.n.localeCompare(b.n),
        nombre_desc: (a, b) => b.n.localeCompare(a.n),
        saldo_desc: (a, b) => b.saldo - a.saldo,
        saldo_asc: (a, b) => a.saldo - b.saldo,
        monto_desc: (a, b) => b.totalVendido - a.totalVendido,
        monto_asc: (a, b) => a.totalVendido - b.totalVendido,
      };
      return [...list].sort(sortFns[cSort] || sortFns.saldo_desc);
    })();
    const initials = (name) => name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
    const colors = ["#DC2626", "#2563EB", "#7C3AED", "#059669", "#D97706", "#EC4899", "#0891B2", "#4F46E5"];
    const getColor = (name) => colors[Math.abs([...name].reduce((h, c) => (h << 5) - h + c.charCodeAt(0), 0)) % colors.length];

    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Clientes & Vendedores</h2>
          <div style={{ display: "flex", gap: 6 }}>
            <Btn sz="sm" onClick={() => { setShowNewCliente(true); setNewName(""); }}><I.Plus /> Cliente</Btn>
            <Btn sz="sm" v="secondary" onClick={() => { setShowNewVendedor(true); setNewName(""); }}><I.Plus /> Vendedor</Btn>
          </div>
        </div>
        {/* Search bar — full width */}
        <div style={{ position: "relative", marginBottom: 12 }}>
          <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "#9CA3AF", fontSize: 18 }}><I.Search /></span>
          <input value={cSearch} onChange={e => setCSearch(e.target.value)} placeholder="Buscar cliente o vendedor..." autoComplete="off" style={{ width: "100%", padding: "12px 40px 12px 44px", borderRadius: 10, border: "2px solid #E5E7EB", fontSize: 15, outline: "none", boxSizing: "border-box", fontFamily: "inherit", background: "#fff" }} onFocus={e => e.target.style.borderColor = "#2563EB"} onBlur={e => e.target.style.borderColor = "#E5E7EB"} />
          {cSearch && <button onClick={() => setCSearch("")} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#9CA3AF", fontSize: 16, fontFamily: "inherit" }}>✕</button>}
        </div>

        {/* Filters and Sort */}
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
          <select value={cFiltro} onChange={e => setCFiltro(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, fontFamily: "inherit", background: cFiltro !== "ALL" ? "#EFF6FF" : "#FAFAFA" }}>
            <option value="ALL">Todos los clientes</option>
            <option value="pendiente">💸 Con saldo pendiente</option>
            <option value="pagado">✅ Todo pagado</option>
            <option value="moroso">⚠️ Morosos</option>
            <option value="sin_pedidos">📭 Sin pedidos</option>
          </select>
          <select value={cSort} onChange={e => setCSort(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, fontFamily: "inherit", background: "#FAFAFA" }}>
            <option value="saldo_desc">Ordenar: Mayor saldo primero</option>
            <option value="saldo_asc">Ordenar: Menor saldo primero</option>
            <option value="monto_desc">Ordenar: Mayor monto vendido</option>
            <option value="monto_asc">Ordenar: Menor monto vendido</option>
            <option value="nombre_asc">Ordenar: A → Z</option>
            <option value="nombre_desc">Ordenar: Z → A</option>
          </select>
        </div>

        {/* Vendedores list */}
        {(data.vendedores || []).length > 0 && (
          <div style={{ background: "#F9FAFB", borderRadius: 8, padding: "10px 14px", marginBottom: 12, border: "1px solid #E5E7EB" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#374151", marginBottom: 4 }}>👥 Vendedores ({(data.vendedores || []).length})</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {(data.vendedores || []).sort().map(v => (
                <span key={v} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#fff", border: "1px solid #E5E7EB", borderRadius: 6, padding: "3px 8px", fontSize: 11 }}>
                  {v}
                  <button onClick={() => { deleteVendedor(v); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#D1D5DB", padding: 0, fontSize: 10 }}>✕</button>
                </span>
              ))}
            </div>
          </div>
        )}

        <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 8 }}>{filteredCm.length} clientes</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {filteredCm.map(c => {
            const isExp = exp === c.n;
            const bg = getColor(c.n);
            return (
              <div key={c.n} style={{ background: "#fff", borderRadius: 12, border: c.mor ? "2px solid #FECACA" : "1px solid #E5E7EB", overflow: "hidden" }}>
                {/* Header card - Axia style */}
                <div onClick={() => setExp(isExp ? null : c.n)} style={{ padding: "16px 18px", cursor: "pointer" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
                    <div style={{ width: 44, height: 44, borderRadius: "50%", background: bg, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 700, fontSize: 15, flexShrink: 0 }}>{initials(c.n)}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <strong style={{ fontSize: 16 }}>{c.n}</strong>
                        {c.mor && <span style={{ fontSize: 9, background: "#FEE2E2", color: "#991B1B", padding: "2px 7px", borderRadius: 4, fontWeight: 700 }}>⚠ MOROSO</span>}
                      </div>
                      <div style={{ fontSize: 11, color: "#9CA3AF" }}>{c.p.length} pedidos ({c.act} activos)</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 10, color: "#6B7280" }}>Saldo</div>
                      <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "monospace", color: c.saldo > 0 ? "#DC2626" : "#059669" }}>{fmt(c.saldo)}</div>
                    </div>
                  </div>

                  {/* Summary boxes */}
                  <div style={{ display: "flex", gap: 8 }}>
                    <div style={{ flex: 1, background: "#FEF2F2", borderRadius: 8, padding: "8px 12px" }}>
                      <div style={{ fontSize: 9, color: "#6B7280", textTransform: "uppercase" }}>Total vendido</div>
                      <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "monospace", color: "#1A2744" }}>{fmt(c.totalVendido)}</div>
                    </div>
                    <div style={{ flex: 1, background: "#ECFDF5", borderRadius: 8, padding: "8px 12px" }}>
                      <div style={{ fontSize: 9, color: "#6B7280", textTransform: "uppercase" }}>Total recibido</div>
                      <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "monospace", color: "#059669" }}>{fmt(c.totalRecibido)}</div>
                    </div>
                  </div>
                </div>

                {/* Expanded detail */}
                {isExp && (
                  <div style={{ borderTop: "1px solid #E5E7EB" }}>
                    {/* Pedidos pendientes */}
                    {c.pendientes.length > 0 && (
                      <div style={{ padding: "12px 18px", borderBottom: "1px solid #F3F4F6" }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#DC2626", marginBottom: 6 }}>📋 Pedidos pendientes de pago ({c.pendientes.length})</div>
                        {c.pendientes.map(f => {
                          const debeMerc = (f.totalVenta || f.costoMercancia) - (f.clientePago ? (f.totalVenta || f.costoMercancia) : (f.abonoMercancia || 0));
                          const debeFlete = (f.costoFlete || 0) - (f.fletePagado ? (f.costoFlete || 0) : (f.abonoFlete || 0));
                          return (
                            <div key={f.id} onClick={() => { setDetailMode("full"); navigate("detail", f.id, view); }} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid #F9FAFB", cursor: "pointer", fontSize: 11 }}>
                              <span style={{ fontFamily: "monospace", color: "#9CA3AF", fontSize: 9 }}>{f.id}</span>
                              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.descripcion}</span>
                              <Badge estado={f.estado} />
                              <div style={{ textAlign: "right", minWidth: 100 }}>
                                {debeMerc > 0 && <div style={{ fontSize: 10 }}><span style={{ color: "#9CA3AF" }}>👻</span> <span style={{ fontFamily: "monospace", fontWeight: 600, color: "#DC2626" }}>{fmt(debeMerc)}</span></div>}
                                {debeFlete > 0 && <div style={{ fontSize: 10 }}><span style={{ color: "#9CA3AF" }}>🚛</span> <span style={{ fontFamily: "monospace", fontWeight: 600, color: "#DC2626" }}>{fmt(debeFlete)}</span></div>}
                                {(f.abonoMercancia || 0) > 0 && !f.clientePago && <div style={{ fontSize: 9, color: "#059669" }}>Abonó merc: {fmt(f.abonoMercancia)}</div>}
                                {(f.abonoFlete || 0) > 0 && !f.fletePagado && <div style={{ fontSize: 9, color: "#059669" }}>Abonó flete: {fmt(f.abonoFlete)}</div>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* All orders */}
                    <div style={{ padding: "12px 18px", borderBottom: "1px solid #F3F4F6" }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#374151", marginBottom: 6 }}>📦 Todos los pedidos</div>
                      {c.p.map(f => (
                        <div key={f.id} onClick={() => { setDetailMode("full"); navigate("detail", f.id, view); }} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: "1px solid #F9FAFB", cursor: "pointer", fontSize: 11 }}>
                          <span style={{ fontFamily: "monospace", color: "#9CA3AF", fontSize: 9 }}>{f.id}</span>
                          <span style={{ color: "#9CA3AF", minWidth: 44 }}>{fmtD(f.fechaCreacion)}</span>
                          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.descripcion}</span>
                          <Badge estado={f.estado} />
                          <span style={{ fontFamily: "monospace", fontWeight: 600, color: "#1A2744" }}>{fmt((f.totalVenta || f.costoMercancia) + (f.costoFlete || 0))}</span>
                          {f.clientePago ? <span style={{ color: "#059669", fontSize: 10 }}>Pagado ✓</span> : <span style={{ color: "#DC2626", fontSize: 10 }}>Pendiente</span>}
                        </div>
                      ))}
                    </div>

                    {/* Payment history */}
                    {c.pagos.length > 0 && (
                      <div style={{ padding: "12px 18px" }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#059669", marginBottom: 6 }}>💵 Historial de pagos/abonos</div>
                        {c.pagos.slice(0, 15).map(m => (
                          <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid #F9FAFB", fontSize: 11 }}>
                            <span style={{ color: "#9CA3AF", minWidth: 60 }}>{fmtD(m.fecha)}</span>
                            <span style={{ fontFamily: "monospace", color: "#9CA3AF", fontSize: 9 }}>{m.fId}</span>
                            <span style={{ flex: 1, color: "#6B7280" }}>{m.desc}</span>
                            <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#059669" }}>+{fmt(m.monto)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {c.pagos.length === 0 && c.pendientes.length > 0 && (
                      <div style={{ padding: "12px 18px", textAlign: "center", color: "#9CA3AF", fontSize: 11 }}>Sin pagos registrados aún</div>
                    )}

                    {/* Registrar pago button + edit/delete */}
                    <div style={{ padding: "12px 18px", display: "flex", gap: 8 }}>
                      <Btn v="primary" onClick={(e) => { e.stopPropagation(); openPago(c.n); }} style={{ flex: 1, justifyContent: "center" }}>+ Registrar pago</Btn>
                      <Btn v="secondary" sz="sm" onClick={(e) => { e.stopPropagation(); const nn = c.n; if (nn && nn.trim()) { const upper = nn.trim().toUpperCase(); const newClientes = (data.clientes || []).map(x => x === c.n ? upper : x); const newFantasmas = data.fantasmas.map(f => f.cliente === c.n ? { ...f, cliente: upper } : f); persist({ ...data, clientes: newClientes, fantasmas: newFantasmas }); } }}><I.Edit /></Btn>
                      <Btn v="danger" sz="sm" onClick={async (e) => { e.stopPropagation(); if (c.p.length > 0) { await showAlert("No se puede eliminar un cliente con pedidos."); } else deleteCliente(c.n); }}><I.Trash /></Btn>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {filteredCm.length === 0 && <p style={{ textAlign: "center", padding: 32, color: "#9CA3AF", fontSize: 12 }}>{cSearch ? "No se encontró ese cliente." : "No hay clientes aún."}</p>}
        </div>

        {/* NEW CLIENTE MODAL */}
        {showNewCliente && (
          <Modal title="Nuevo Cliente" onClose={() => { setShowNewCliente(false) }} w={360}>
            <Fld label="Nombre del cliente"><Inp value={newName} onChange={e => setNewName(e.target.value.toUpperCase())} placeholder="NOMBRE COMPLETO" style={{ textTransform: "uppercase" }} /></Fld>
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <Btn v="secondary" onClick={() => { setShowNewCliente(false) }}>Cancelar</Btn>
              <Btn disabled={!newName} onClick={() => addCliente(newName)}>Crear</Btn>
            </div>
          </Modal>
        )}
        {/* NEW VENDEDOR MODAL */}
        {showNewVendedor && (
          <Modal title="Nuevo Vendedor" onClose={() => { setShowNewVendedor(false) }} w={360}>
            <Fld label="Nombre del vendedor"><Inp value={newName} onChange={e => setNewName(e.target.value.toUpperCase())} placeholder="NOMBRE COMPLETO" style={{ textTransform: "uppercase" }} /></Fld>
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <Btn v="secondary" onClick={() => { setShowNewVendedor(false) }}>Cancelar</Btn>
              <Btn disabled={!newName} onClick={() => addVendedor(newName)}>Crear</Btn>
            </div>
          </Modal>
        )}

        {/* PAGO MODAL */}
        {pagoCliente && (() => {
          const cliente = cm.find(c => c.n === pagoCliente);
          if (!cliente) return null;
          const pendientes = cliente.p.filter(f => !f.clientePago || (!f.fletePagado && f.costoFlete > 0));
          const totalSelected = Object.keys(pagoForm.selected).filter(k => pagoForm.selected[k]).reduce((s, fId) => {
            const f = data.fantasmas.find(x => x.id === fId);
            if (!f) return s;
            const tipo = pagoForm.tipo[fId] || "mercancia";
            if (tipo === "mercancia") return s + ((f.totalVenta || f.costoMercancia) - (f.abonoMercancia || 0));
            return s + ((f.costoFlete || 0) - (f.abonoFlete || 0));
          }, 0);

          return (
            <Modal title={`Registrar pago de ${pagoCliente}`} onClose={() => setPagoCliente(null)} w={500}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
                <Fld label="Fecha"><Inp type="date" value={pagoForm.fecha} onChange={e => setPagoForm({ ...pagoForm, fecha: e.target.value })} /></Fld>
                <Fld label="Monto recibido"><Inp type="number" value={pagoForm.monto} onChange={e => setPagoForm({ ...pagoForm, monto: e.target.value })} placeholder="0.00" /></Fld>
              </div>
              <Fld label="Nota"><Inp value={pagoForm.nota} onChange={e => setPagoForm({ ...pagoForm, nota: e.target.value })} placeholder="Referencia, forma de pago, etc." /></Fld>

              <div style={{ fontSize: 10, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: .3, marginBottom: 6, marginTop: 4 }}>Pedidos pendientes de pago</div>
              <div style={{ maxHeight: 280, overflow: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                {pendientes.map(f => {
                  const precioVenta = f.totalVenta || f.costoMercancia;
                  const debeMerc = !f.clientePago ? precioVenta - (f.abonoMercancia || 0) : 0;
                  const debeFlete = !f.fletePagado && f.costoFlete > 0 ? (f.costoFlete || 0) - (f.abonoFlete || 0) : 0;
                  return (
                    <div key={f.id} style={{ border: "1px solid #E5E7EB", borderRadius: 8, overflow: "hidden" }}>
                      {/* Mercancía row */}
                      {debeMerc > 0 && (
                        <label style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", cursor: "pointer", background: pagoForm.selected[f.id + "_m"] ? "#EFF6FF" : "#fff" }}>
                          <input type="checkbox" checked={!!pagoForm.selected[f.id + "_m"]} onChange={e => {
                            const ns = { ...pagoForm.selected, [f.id + "_m"]: e.target.checked };
                            const nt = { ...pagoForm.tipo, [f.id + "_m"]: "mercancia" };
                            setPagoForm({ ...pagoForm, selected: ns, tipo: nt });
                          }} style={{ width: 16, height: 16, accentColor: "#2563EB", flexShrink: 0 }} />
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 12, fontWeight: 600 }}>👻 {f.id} — {f.descripcion.length > 28 ? f.descripcion.slice(0, 28) + "..." : f.descripcion}</div>
                            {f.pedidoEspecial && f.costoReal != null ? (
                              <div style={{ fontSize: 10, color: "#7C3AED" }}>
                                Fantasma {fmt(f.costoReal)} + Ganancia {fmt(f.gananciaEspecial || (precioVenta - f.costoReal))} = <strong>{fmt(precioVenta)}</strong>
                              </div>
                            ) : (
                              <div style={{ fontSize: 10, color: "#9CA3AF" }}>{f.cantidad ? `Cant: ${f.cantidad} · Unit: ${fmt(f.costoUnitario)}` : "Mercancía"}</div>
                            )}
                          </div>
                          <div style={{ fontFamily: "monospace", fontWeight: 700, color: "#DC2626", fontSize: 13 }}>{fmt(debeMerc)}</div>
                        </label>
                      )}
                      {/* Flete row */}
                      {debeFlete > 0 && (
                        <label style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", cursor: "pointer", borderTop: debeMerc > 0 ? "1px solid #F3F4F6" : "none", background: pagoForm.selected[f.id + "_f"] ? "#ECFDF5" : "#fff" }}>
                          <input type="checkbox" checked={!!pagoForm.selected[f.id + "_f"]} onChange={e => {
                            setPagoForm({ ...pagoForm, selected: { ...pagoForm.selected, [f.id + "_f"]: e.target.checked }, tipo: { ...pagoForm.tipo, [f.id + "_f"]: "flete" } });
                          }} style={{ width: 16, height: 16, accentColor: "#059669", flexShrink: 0 }} />
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 12, fontWeight: 600 }}>🚛 {f.id} — Flete</div>
                          </div>
                          <div style={{ fontFamily: "monospace", fontWeight: 700, color: "#DC2626", fontSize: 13 }}>{fmt(debeFlete)}</div>
                        </label>
                      )}
                    </div>
                  );
                })}
                {pendientes.length === 0 && <p style={{ textAlign: "center", color: "#9CA3AF", fontSize: 11, padding: 16 }}>No hay pedidos pendientes.</p>}
              </div>

              {totalSelected > 0 && (
                <div style={{ marginTop: 8, padding: "6px 0", fontSize: 11, color: "#6B7280" }}>
                  Total seleccionado: <strong style={{ fontFamily: "monospace", color: "#1A2744" }}>{fmt(totalSelected)}</strong>
                </div>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 12, paddingTop: 12, borderTop: "1px solid #E5E7EB" }}>
                <Btn v="secondary" onClick={() => setPagoCliente(null)} style={{ flex: 1, justifyContent: "center" }}>Cancelar</Btn>
                <Btn v="primary" disabled={!pagoForm.monto || Object.keys(pagoForm.selected).filter(k => pagoForm.selected[k]).length === 0} onClick={() => {
                  // remap selected keys to real fantasma ids with tipo
                  const realSelected = {};
                  const realTipo = {};
                  Object.keys(pagoForm.selected).filter(k => pagoForm.selected[k]).forEach(k => {
                    const parts = k.split("_");
                    const fId = parts.slice(0, -1).join("_");
                    const t = parts[parts.length - 1] === "f" ? "flete" : "mercancia";
                    realSelected[fId] = true;
                    realTipo[fId] = t;
                  });
                  // call with remapped
                  const monto = parseFloat(pagoForm.monto) || 0;
                  if (monto <= 0) return;
                  let remaining = monto;
                  let newData = { ...data };
                  Object.keys(realSelected).forEach(fId => {
                    if (remaining <= 0) return;
                    const f = newData.fantasmas.find(x => x.id === fId);
                    if (!f) return;
                    const tipo = realTipo[fId];
                    if (tipo === "mercancia") {
                      const debe = (f.totalVenta || f.costoMercancia) - (f.abonoMercancia || 0);
                      const aplicar = Math.min(remaining, debe);
                      const nuevoAbono = (f.abonoMercancia || 0) + aplicar;
                      const pagado = nuevoAbono >= (f.totalVenta || f.costoMercancia);
                      newData = { ...newData, fantasmas: newData.fantasmas.map(x => { if (x.id !== fId) return x; const upd = { ...x, abonoMercancia: nuevoAbono, clientePago: pagado, clientePagoMonto: nuevoAbono + (x.abonoFlete || 0), fechaActualizacion: today(), movimientos: [...(x.movimientos || []), { id: Date.now() + Math.random(), tipo: "Entrada", concepto: `Pago mercancía${pagoForm.nota ? " - " + pagoForm.nota : ""}`, monto: aplicar, fecha: pagoForm.fecha }], historial: [...(x.historial || []), { fecha: today(), accion: `Pago merc: ${fmt(aplicar)}`, quien: role }] }; const _PRES = ["DINERO_CAMINO","SOBRE_LISTO","DINERO_USA","COLCHON_USADO","TRANS_PENDIENTE","NO_APLICA"]; if (!_PRES.includes(upd.dineroStatus)) { const ds = calcDineroStatus(upd); if (ds) upd.dineroStatus = ds; } return upd; }) };
                      remaining -= aplicar;
                    } else {
                      const debe = (f.costoFlete || 0) - (f.abonoFlete || 0);
                      const aplicar = Math.min(remaining, debe);
                      const nuevoAbono = (f.abonoFlete || 0) + aplicar;
                      const pagado = nuevoAbono >= (f.costoFlete || 0);
                      newData = { ...newData, fantasmas: newData.fantasmas.map(x => { if (x.id !== fId) return x; const upd = { ...x, abonoFlete: nuevoAbono, fletePagado: pagado, clientePagoMonto: (x.abonoMercancia || 0) + nuevoAbono, fechaActualizacion: today(), movimientos: [...(x.movimientos || []), { id: Date.now() + Math.random(), tipo: "Entrada", concepto: `Pago flete${pagoForm.nota ? " - " + pagoForm.nota : ""}`, monto: aplicar, fecha: pagoForm.fecha }], historial: [...(x.historial || []), { fecha: today(), accion: `Pago flete: ${fmt(aplicar)}`, quien: role }] }; const _PRES2 = ["DINERO_CAMINO","SOBRE_LISTO","DINERO_USA","COLCHON_USADO","TRANS_PENDIENTE","NO_APLICA"]; if (!_PRES2.includes(upd.dineroStatus)) { const ds = calcDineroStatus(upd); if (ds) upd.dineroStatus = ds; } return upd; }) };
                      remaining -= aplicar;
                    }
                  });
                  persist(newData);
                  setPagoCliente(null);
                }} style={{ flex: 1, justifyContent: "center", background: "#DC2626" }}>Registrar pago</Btn>
              </div>
            </Modal>
          );
        })()}
      </div>
    );
  };

  // ============ PROVEEDORES ============
  const Proveedores = () => {
    const [exp, setExp] = useState(null);
    const [pSearch, setPSearch] = useState("");
    const [pFiltro, setPFiltro] = useState("ALL");
    const [pSort, setPSort] = useState("deuda_desc");
    const [pagoProv, setPagoProv] = useState(null);
    const [pagoProvForm, setPagoProvForm] = usePersistedForm("pagoProvForm", { fecha: today(), monto: "", nota: "", selected: {} });

    const [showNewProv, setShowNewProv] = useModalState("showNewProv");
    const [editProv, setEditProv] = useState(null);
    const [provForm, setProvForm] = usePersistedForm("provForm", { nombre: "", ubicacion: "Otay", telefono: "", contacto: "" });


    const provInfo = data.proveedoresInfo || {}; // { provName: { ubicacion, telefono, contacto } }

    const saveProv = async (old, form) => {
      const nombre = form.nombre.toUpperCase();
      const provList = Object.keys(data.proveedoresInfo || {});
      // Exact match — block
      if (!old && provList.includes(nombre)) { showAlert("⚠️ El proveedor \"" + nombre + "\" ya existe."); return; }
      if (old && old !== nombre && provList.includes(nombre)) { showAlert("⚠️ El proveedor \"" + nombre + "\" ya existe."); return; }
      // Similar match — warn (only when adding new)
      if (!old) {
        const similar = provList.filter(p => {
          if (p.includes(nombre) || nombre.includes(p)) return true;
          const words = nombre.split(" ").filter(w => w.length > 2);
          return words.some(w => p.includes(w));
        });
        if (similar.length > 0) {
          if (!await showConfirm(`⚠️ Ya existen proveedores con nombre similar:\n\n${similar.join("\n")}\n\n¿Seguro que quieres agregar "${nombre}"?`)) return;
        }
      }
      const contacto = (form.contacto || "").toUpperCase();
      const newInfo = { ...(data.proveedoresInfo || {}) };
      if (old && old !== nombre) delete newInfo[old];
      newInfo[nombre] = { ubicacion: form.ubicacion, telefono: form.telefono, contacto };
      const newUbic = { ...(data.provUbicaciones || {}), [nombre]: form.ubicacion };
      const newList = [...new Set([...(data.proveedoresList || []), nombre])];
      let newFantasmas = data.fantasmas;
      if (old && old !== nombre) {
        newFantasmas = data.fantasmas.map(f => f.proveedor === old ? { ...f, proveedor: nombre, ubicacionProv: form.ubicacion } : f);
      }
      persist({ ...data, proveedoresInfo: newInfo, provUbicaciones: newUbic, proveedoresList: newList, fantasmas: newFantasmas });
    };

    const deleteProv = (name) => {
      const newInfo = { ...(data.proveedoresInfo || {}) };
      delete newInfo[name];
      persist({ ...data, proveedoresInfo: newInfo });
    };

    const pm = useMemo(() => {
      // Merge registry providers with providers from fantasmas
      const allNames = [...new Set([...Object.keys(provInfo), ...data.fantasmas.map(f => f.proveedor).filter(Boolean)])];
      return allNames.map(name => {
        const info = provInfo[name] || {};
        const pedidos = data.fantasmas.filter(f => f.proveedor === name);
        const tc = pedidos.reduce((s, f) => s + f.costoMercancia, 0);
        const tp = pedidos.filter(f => f.proveedorPagado).reduce((s, f) => s + f.costoMercancia, 0) + pedidos.reduce((s, f) => s + (f.abonoProveedor || 0), 0);
        const pendientes = pedidos.filter(f => !f.proveedorPagado);
        const d = pendientes.reduce((s, f) => s + f.costoMercancia - (f.abonoProveedor || 0), 0);
        const nf = pedidos.filter(f => f.creditoProveedor).length;
        const ca = pedidos.filter(f => f.creditoProveedor && !f.proveedorPagado).length;
        const pagos = pedidos.flatMap(f => (f.movimientos || []).filter(m => m.tipo === "Salida" && (m.concepto || "").toLowerCase().includes("proveedor")).map(m => ({ ...m, fId: f.id, desc: f.descripcion }))).sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
        return { n: name, p: pedidos, info, tc, tp, d, nf, ca, pendientes, pagos };
      }).sort((a, b) => b.d - a.d);
    }, [data, provInfo]);

    const filteredPm = (() => {
      let list = pm;
      if (pSearch) list = list.filter(p => p.n.toLowerCase().includes(pSearch.toLowerCase()));
      if (pFiltro === "pendiente") list = list.filter(p => p.d > 0);
      if (pFiltro === "pagado") list = list.filter(p => p.d <= 0 && p.p.length > 0);
      if (pFiltro === "credito") list = list.filter(p => p.ca > 0);
      if (pFiltro === "sin_pedidos") list = list.filter(p => p.p.length === 0);
      const sortFns = {
        nombre_asc: (a, b) => a.n.localeCompare(b.n),
        nombre_desc: (a, b) => b.n.localeCompare(a.n),
        deuda_desc: (a, b) => b.d - a.d,
        deuda_asc: (a, b) => a.d - b.d,
        monto_desc: (a, b) => b.tc - a.tc,
        monto_asc: (a, b) => a.tc - b.tc,
      };
      return [...list].sort(sortFns[pSort] || sortFns.deuda_desc);
    })();
    const initials = (name) => name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
    const colors = ["#7C3AED", "#D97706", "#0891B2", "#DC2626", "#059669", "#EC4899", "#2563EB", "#4F46E5"];
    const getColor = (name) => colors[Math.abs([...name].reduce((h, c) => (h << 5) - h + c.charCodeAt(0), 0)) % colors.length];
    const UBICACIONES = ["Otay", "Los Ángeles", "Otra"];

    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Proveedores</h2>
          <Btn onClick={() => { setShowNewProv(true); setProvForm({ nombre: "", ubicacion: "Otay", telefono: "", contacto: "" }); }}><I.Plus /> Nuevo Proveedor</Btn>
        </div>
        {/* Search bar — full width */}
        <div style={{ position: "relative", marginBottom: 12 }}>
          <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "#9CA3AF", fontSize: 18 }}><I.Search /></span>
          <input value={pSearch} onChange={e => setPSearch(e.target.value)} placeholder="Buscar proveedor..." autoComplete="off" style={{ width: "100%", padding: "12px 40px 12px 44px", borderRadius: 10, border: "2px solid #E5E7EB", fontSize: 15, outline: "none", boxSizing: "border-box", fontFamily: "inherit", background: "#fff" }} onFocus={e => e.target.style.borderColor = "#2563EB"} onBlur={e => e.target.style.borderColor = "#E5E7EB"} />
          {pSearch && <button onClick={() => setPSearch("")} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#9CA3AF", fontSize: 16, fontFamily: "inherit" }}>✕</button>}
        </div>
        {/* Filters and Sort */}
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
          <select value={pFiltro} onChange={e => setPFiltro(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, fontFamily: "inherit", background: pFiltro !== "ALL" ? "#EFF6FF" : "#FAFAFA" }}>
            <option value="ALL">Todos los proveedores</option>
            <option value="pendiente">💸 Con deuda pendiente</option>
            <option value="pagado">✅ Todo pagado</option>
            <option value="credito">🏦 Con crédito activo</option>
            <option value="sin_pedidos">📭 Sin pedidos</option>
          </select>
          <select value={pSort} onChange={e => setPSort(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, fontFamily: "inherit", background: "#FAFAFA" }}>
            <option value="deuda_desc">Ordenar: Mayor deuda primero</option>
            <option value="deuda_asc">Ordenar: Menor deuda primero</option>
            <option value="monto_desc">Ordenar: Mayor monto total</option>
            <option value="monto_asc">Ordenar: Menor monto total</option>
            <option value="nombre_asc">Ordenar: A → Z</option>
            <option value="nombre_desc">Ordenar: Z → A</option>
          </select>
        </div>
        <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 8 }}>{filteredPm.length} proveedores</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {filteredPm.map(p => {
            const isExp = exp === p.n;
            const bg = getColor(p.n);
            return (
              <div key={p.n} style={{ background: "#fff", borderRadius: 12, border: p.d > 0 ? "2px solid #E9D5FF" : "1px solid #E5E7EB", overflow: "hidden" }}>
                <div onClick={() => setExp(isExp ? null : p.n)} style={{ padding: "16px 18px", cursor: "pointer" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
                    <div style={{ width: 44, height: 44, borderRadius: "50%", background: bg, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 700, fontSize: 15, flexShrink: 0 }}>{initials(p.n)}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <strong style={{ fontSize: 16 }}>{p.n}</strong>
                        {p.info.ubicacion && <span style={{ fontSize: 9, background: "#F3F4F6", color: "#6B7280", padding: "2px 7px", borderRadius: 4 }}>📍 {p.info.ubicacion}</span>}
                        {p.ca > 0 && <span style={{ fontSize: 9, background: "#E9D5FF", color: "#581C87", padding: "2px 7px", borderRadius: 4, fontWeight: 700 }}>{p.ca} crédito{p.ca > 1 ? "s" : ""}</span>}
                      </div>
                      <div style={{ fontSize: 11, color: "#9CA3AF" }}>
                        {p.p.length} pedidos
                        {p.info.contacto && <> · 👤 {p.info.contacto}</>}
                        {p.info.telefono && <> · 📞 {p.info.telefono}</>}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 10, color: "#6B7280" }}>Le debemos</div>
                      <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "monospace", color: p.d > 0 ? "#7C3AED" : "#059669" }}>{fmt(p.d)}</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <div style={{ flex: 1, background: "#F5F3FF", borderRadius: 8, padding: "8px 12px" }}>
                      <div style={{ fontSize: 9, color: "#6B7280", textTransform: "uppercase" }}>Total comprado</div>
                      <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "monospace", color: "#1A2744" }}>{fmt(p.tc)}</div>
                    </div>
                    <div style={{ flex: 1, background: "#ECFDF5", borderRadius: 8, padding: "8px 12px" }}>
                      <div style={{ fontSize: 9, color: "#6B7280", textTransform: "uppercase" }}>Total pagado</div>
                      <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "monospace", color: "#059669" }}>{fmt(p.tp)}</div>
                    </div>
                  </div>
                </div>

                {isExp && (
                  <div style={{ borderTop: "1px solid #E5E7EB" }}>
                    {/* Info & Edit */}
                    <div style={{ padding: "10px 18px", background: "#F9FAFB", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", fontSize: 11 }}>
                      {p.info.ubicacion && <span>📍 {p.info.ubicacion}</span>}
                      {p.info.contacto && <span>👤 {p.info.contacto}</span>}
                      {p.info.telefono && <span>📞 {p.info.telefono}</span>}
                      {p.nf > 0 && <span style={{ color: "#6B7280" }}>Nos ha fiado {p.nf}x</span>}
                      <Btn sz="sm" v="secondary" onClick={(e) => { e.stopPropagation(); setEditProv(p.n); setProvForm({ nombre: p.n, ubicacion: p.info.ubicacion || "Otay", telefono: p.info.telefono || "", contacto: p.info.contacto || "" }); }}><I.Edit /> Editar</Btn>
                    </div>

                    {p.pendientes.length > 0 && (
                      <div style={{ padding: "12px 18px", borderBottom: "1px solid #F3F4F6" }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#7C3AED", marginBottom: 6 }}>📋 Pendientes de pago ({p.pendientes.length})</div>
                        {p.pendientes.map(f => {
                          const debe = f.costoMercancia - (f.abonoProveedor || 0);
                          return (
                            <div key={f.id} onClick={() => { setDetailMode("full"); navigate("detail", f.id, view); }} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid #F9FAFB", cursor: "pointer", fontSize: 11 }}>
                              <span style={{ fontFamily: "monospace", color: "#9CA3AF", fontSize: 9 }}>{f.id}</span>
                              <span style={{ color: "#6B7280" }}>{f.cliente}</span>
                              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.descripcion}</span>
                              <div style={{ textAlign: "right", minWidth: 80 }}>
                                <div style={{ fontFamily: "monospace", fontWeight: 600, color: "#7C3AED" }}>{fmt(debe)}</div>
                                {(f.abonoProveedor || 0) > 0 && <div style={{ fontSize: 9, color: "#059669" }}>Abonado: {fmt(f.abonoProveedor)}</div>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <div style={{ padding: "12px 18px", borderBottom: "1px solid #F3F4F6" }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#374151", marginBottom: 6 }}>📦 Todos los pedidos</div>
                      {p.p.map(f => (
                        <div key={f.id} onClick={() => { setDetailMode("full"); navigate("detail", f.id, view); }} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: "1px solid #F9FAFB", cursor: "pointer", fontSize: 11 }}>
                          <span style={{ fontFamily: "monospace", color: "#9CA3AF", fontSize: 9 }}>{f.id}</span>
                          <span style={{ color: "#6B7280" }}>{f.cliente}</span>
                          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.descripcion}</span>
                          <span style={{ fontFamily: "monospace", fontWeight: 600 }}>{fmt(f.costoMercancia)}</span>
                          {f.proveedorPagado ? <span style={{ color: "#059669", fontSize: 10 }}>Pagado ✓</span> : f.creditoProveedor ? <span style={{ color: "#7C3AED", fontSize: 10, fontWeight: 600 }}>Crédito ⚠</span> : <span style={{ color: "#9CA3AF", fontSize: 10 }}>Pendiente</span>}
                        </div>
                      ))}
                    </div>

                    {p.pagos.length > 0 && (
                      <div style={{ padding: "12px 18px", borderBottom: "1px solid #F3F4F6" }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#059669", marginBottom: 6 }}>💵 Historial de pagos</div>
                        {p.pagos.slice(0, 15).map(m => (
                          <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid #F9FAFB", fontSize: 11 }}>
                            <span style={{ color: "#9CA3AF", minWidth: 60 }}>{fmtD(m.fecha)}</span>
                            <span style={{ fontFamily: "monospace", color: "#9CA3AF", fontSize: 9 }}>{m.fId}</span>
                            <span style={{ flex: 1, color: "#6B7280" }}>{m.concepto}</span>
                            <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#DC2626" }}>-{fmt(m.monto)}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    <div style={{ padding: "12px 18px", display: "flex", gap: 8 }}>
                      <Btn v="primary" onClick={(e) => { e.stopPropagation(); setPagoProv(p.n); setPagoProvForm({ fecha: today(), monto: "", nota: "", selected: {} }); }} style={{ flex: 1, justifyContent: "center", background: "#7C3AED" }}>+ Registrar pago a proveedor</Btn>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {filteredPm.length === 0 && <p style={{ textAlign: "center", padding: 32, color: "#9CA3AF", fontSize: 12 }}>{pSearch ? "No se encontró." : "No hay proveedores. Agrega uno con el botón de arriba."}</p>}
        </div>

        {/* NEW / EDIT PROVEEDOR MODAL */}
        {(showNewProv || editProv) && (
          <Modal title={editProv ? `Editar: ${editProv}` : "Nuevo Proveedor"} onClose={() => { setShowNewProv(false); setEditProv(null); }} w={420}>
            <Fld label="Nombre del proveedor *"><Inp value={provForm.nombre} onChange={e => setProvForm({ ...provForm, nombre: e.target.value.toUpperCase() })} placeholder="NOMBRE" style={{ textTransform: "uppercase" }} /></Fld>
            <Fld label="Ubicación / Bodega">
              <select value={provForm.ubicacion} onChange={e => setProvForm({ ...provForm, ubicacion: e.target.value })} style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 12, fontFamily: "inherit", background: "#FAFAFA" }}>
                {UBICACIONES.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </Fld>
            <Fld label="Nombre de contacto"><Inp value={provForm.contacto} onChange={e => setProvForm({ ...provForm, contacto: e.target.value.toUpperCase() })} placeholder="PERSONA DE CONTACTO" style={{ textTransform: "uppercase" }} /></Fld>
            <Fld label="Teléfono"><Inp value={provForm.telefono} onChange={e => setProvForm({ ...provForm, telefono: e.target.value })} placeholder="Teléfono" type="tel" /></Fld>
            <div style={{ display: "flex", gap: 6, marginTop: 12, paddingTop: 12, borderTop: "1px solid #E5E7EB" }}>
              {editProv && <Btn v="danger" sz="sm" onClick={() => { deleteProv(editProv); setEditProv(null); }}>Eliminar</Btn>}
              <div style={{ flex: 1 }} />
              <Btn v="secondary" onClick={() => { setShowNewProv(false); setEditProv(null); }}>Cancelar</Btn>
              <Btn disabled={!provForm.nombre} onClick={() => { saveProv(editProv, provForm); setShowNewProv(false); setEditProv(null); }}>{editProv ? "Guardar" : "Crear"}</Btn>
            </div>
          </Modal>
        )}

        {/* PAGO PROVEEDOR MODAL */}
        {pagoProv && (() => {
          const prov = pm.find(p => p.n === pagoProv);
          if (!prov) return null;
          const pendientes = prov.p.filter(f => !f.proveedorPagado);
          return (
            <Modal title={`Pago a ${pagoProv}`} onClose={() => setPagoProv(null)} w={500}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
                <Fld label="Fecha"><Inp type="date" value={pagoProvForm.fecha} onChange={e => setPagoProvForm({ ...pagoProvForm, fecha: e.target.value })} /></Fld>
                <Fld label="Monto pagado"><Inp type="number" value={pagoProvForm.monto} onChange={e => setPagoProvForm({ ...pagoProvForm, monto: e.target.value })} placeholder="0.00" /></Fld>
              </div>
              <Fld label="Nota"><Inp value={pagoProvForm.nota} onChange={e => setPagoProvForm({ ...pagoProvForm, nota: e.target.value })} placeholder="Referencia, método, etc." /></Fld>

              <div style={{ fontSize: 10, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: .3, marginBottom: 6, marginTop: 4 }}>Pedidos pendientes de pago al proveedor</div>
              <div style={{ maxHeight: 280, overflow: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                {pendientes.map(f => {
                  const debe = f.costoMercancia - (f.abonoProveedor || 0);
                  return (
                    <label key={f.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", border: "1px solid #E5E7EB", borderRadius: 8, cursor: "pointer", background: pagoProvForm.selected[f.id] ? "#F5F3FF" : "#fff" }}>
                      <input type="checkbox" checked={!!pagoProvForm.selected[f.id]} onChange={e => setPagoProvForm({ ...pagoProvForm, selected: { ...pagoProvForm.selected, [f.id]: e.target.checked } })} style={{ width: 16, height: 16, accentColor: "#7C3AED", flexShrink: 0 }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 600 }}>{f.id} — {f.descripcion.length > 30 ? f.descripcion.slice(0, 30) + "..." : f.descripcion}</div>
                        <div style={{ fontSize: 10, color: "#9CA3AF" }}>{f.cliente}{f.cantidad ? ` · Cant: ${f.cantidad}` : ""}{f.creditoProveedor ? " · Crédito" : ""}</div>
                      </div>
                      <div style={{ fontFamily: "monospace", fontWeight: 700, color: "#7C3AED", fontSize: 13 }}>{fmt(debe)}</div>
                    </label>
                  );
                })}
                {pendientes.length === 0 && <p style={{ textAlign: "center", color: "#9CA3AF", fontSize: 11, padding: 16 }}>Todo pagado.</p>}
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 12, paddingTop: 12, borderTop: "1px solid #E5E7EB" }}>
                <Btn v="secondary" onClick={() => setPagoProv(null)} style={{ flex: 1, justifyContent: "center" }}>Cancelar</Btn>
                <Btn disabled={!pagoProvForm.monto || Object.keys(pagoProvForm.selected).filter(k => pagoProvForm.selected[k]).length === 0} onClick={() => {
                  const monto = parseFloat(pagoProvForm.monto) || 0;
                  if (monto <= 0) return;
                  let remaining = monto;
                  let newData = { ...data };
                  Object.keys(pagoProvForm.selected).filter(k => pagoProvForm.selected[k]).forEach(fId => {
                    if (remaining <= 0) return;
                    const f = newData.fantasmas.find(x => x.id === fId);
                    if (!f) return;
                    const debe = f.costoMercancia - (f.abonoProveedor || 0);
                    const aplicar = Math.min(remaining, debe);
                    const nuevoAbono = (f.abonoProveedor || 0) + aplicar;
                    const pagado = nuevoAbono >= f.costoMercancia;
                    newData = { ...newData, fantasmas: newData.fantasmas.map(x => x.id !== fId ? x : {
                      ...x, abonoProveedor: nuevoAbono, proveedorPagado: pagado, fechaActualizacion: today(),
                      movimientos: [...(x.movimientos || []), { id: Date.now() + Math.random(), tipo: "Salida", concepto: `Pago proveedor ${pagoProv}${pagoProvForm.nota ? " - " + pagoProvForm.nota : ""}`, monto: aplicar, fecha: pagoProvForm.fecha }],
                      historial: [...(x.historial || []), { fecha: today(), accion: `Pago prov: ${fmt(aplicar)}`, quien: role }],
                    }) };
                    remaining -= aplicar;
                  });
                  persist(newData);
                  setPagoProv(null);
                }} style={{ flex: 1, justifyContent: "center", background: "#7C3AED", color: "#fff", border: "none" }}>Registrar pago</Btn>
              </div>
            </Modal>
          );
        })()}
      </div>
    );
  };

  // ============ ENVÍOS / INVENTARIO ============
  const Envios = () => {
    const [showNewEnvio, setShowNewEnvio] = useModalState("showNewEnvio");
    const [envioForm, setEnvioForm] = usePersistedForm("envioForm", { fecha: today(), vehiculo: "", notas: "", pedidos: {} });

    const envios = data.envios || [];

    // Pedidos ready to ship (in BODEGA_USA)
    const listos = data.fantasmas.filter(f => f.estado === "PEDIDO" && (f.dineroStatus === "DINERO_USA" || f.dineroStatus === "COLCHON_USADO"));
    // Pedidos in transit
    const enTransito = data.fantasmas.filter(f => f.estado === "BODEGA_TJ");

    const crearEnvio = () => {
      const selIds = Object.keys(envioForm.pedidos).filter(k => envioForm.pedidos[k]);
      if (selIds.length === 0) return;
      const envio = {
        id: `E-${String((envios.length || 0) + 1).padStart(3, "0")}`,
        fecha: envioForm.fecha, vehiculo: envioForm.vehiculo, notas: envioForm.notas,
        pedidos: selIds.map(fId => {
          const f = data.fantasmas.find(x => x.id === fId);
          return { id: fId, cliente: f?.cliente, descripcion: f?.descripcion, empaque: f?.empaque, cantBultos: f?.cantBultos, enviado: envioForm.pedidos[fId]?.bultos || f?.cantBultos || 1, completo: envioForm.pedidos[fId]?.completo !== false, notaEnvio: envioForm.pedidos[fId]?.nota || "" };
        }),
        confirmadoTJ: false, fechaConfirmacion: null, notasTJ: "",
      };
      // Update fantasmas to MERCAN_CRUZANDO
      let newData = { ...data, envios: [...envios, envio] };
      selIds.forEach(fId => {
        newData = { ...newData, fantasmas: newData.fantasmas.map(f => f.id !== fId ? f : { ...f, estado: "BODEGA_TJ", envioId: envio.id, fechaActualizacion: today(), historial: [...(f.historial || []), { fecha: today(), accion: `Recibido en bodega TJ (${envio.vehiculo || "sin vehículo"})`, quien: role }] }) };
      });
      persist(newData);
      setShowNewEnvio(false);
      setEnvioForm({ fecha: today(), vehiculo: "", notas: "", pedidos: {} });
    };

    const confirmarEnvio = (envioId, notasTJ) => {
      let newData = { ...data, envios: (data.envios || []).map(e => e.id !== envioId ? e : { ...e, confirmadoTJ: true, fechaConfirmacion: today(), notasTJ }) };
      const envio = newData.envios.find(e => e.id === envioId);
      if (envio) {
        envio.pedidos.forEach(p => {
          newData = { ...newData, fantasmas: newData.fantasmas.map(f => f.id !== p.id ? f : { ...f, estado: "BODEGA_TJ", fechaActualizacion: today(), historial: [...(f.historial || []), { fecha: today(), accion: `Recibido en bodega TJ${notasTJ ? " — " + notasTJ : ""}`, quien: role }] }) };
        });
      }
      persist(newData);
    };

    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 6 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>📦 Envíos USA → TJ</h2>
          {(role === "usa" || role === "admin") && listos.length > 0 && <Btn onClick={() => { setShowNewEnvio(true) }}><I.Plus /> Nuevo Envío</Btn>}
        </div>

        {/* Pedidos listos para enviar - solo USA */}
        {(role === "usa" || role === "admin") && listos.length > 0 && (
          <div style={{ background: "#EFF6FF", borderRadius: 10, border: "1px solid #BFDBFE", padding: 16, marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#1E40AF", marginBottom: 8 }}>🏭 En bodega USA — listos para enviar ({listos.length})</div>
            {listos.map(f => (
              <div key={f.id} onClick={() => { setDetailMode("full"); navigate("detail", f.id, view); }} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 6px", borderBottom: "1px solid #DBEAFE", fontSize: 11, cursor: "pointer" }}>
                <span style={{ fontFamily: "monospace", color: "#6B7280", fontSize: 10 }}>{f.id}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div><strong>{f.cliente}</strong> <span style={{ color: "#6B7280" }}>— {f.descripcion}</span></div>
                  <div style={{ fontSize: 10, color: "#9CA3AF", display: "flex", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
                    <span>📦 {f.cantBultos || 1} {f.empaque || "bulto"}{(f.cantBultos || 1) > 1 ? "s" : ""}</span>
                    {f.ubicacionProv && <span>📍 {f.ubicacionProv}</span>}
                    {f.proveedor && <span>🏭 {f.proveedor}</span>}
                    {f.costoMercancia > 0 && <span>💵 {fmt(f.costoMercancia)}</span>}
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                  {f.estadoMercancia === "completa" && <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: "#ECFDF5", color: "#065F46", fontWeight: 600 }}>✅ Completa</span>}
                  {f.estadoMercancia === "incompleta" && <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: "#FEF3C7", color: "#92400E", fontWeight: 600 }}>⚠️ Incompleta</span>}
                  {f.estadoMercancia === "dañada" && <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: "#FEE2E2", color: "#991B1B", fontWeight: 600 }}>🔴 Dañada</span>}
                  {!f.estadoMercancia && <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: "#F3F4F6", color: "#9CA3AF" }}>Sin revisar</span>}
                  {f.envioId && <span style={{ fontSize: 9, color: "#7C3AED" }}>📋 {f.envioId}</span>}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Envíos en tránsito - pendientes de confirmar */}
        {envios.filter(e => !e.confirmadoTJ).map(e => (
          <div key={e.id} style={{ background: "#fff", borderRadius: 10, border: "2px solid #E9D5FF", padding: 16, marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div>
                <span style={{ fontSize: 14, fontWeight: 700, color: "#581C87" }}>🚛 {e.id}</span>
                <span style={{ fontSize: 11, color: "#6B7280", marginLeft: 8 }}>{fmtD(e.fecha)}{e.vehiculo && ` · ${e.vehiculo}`}</span>
              </div>
              <span style={{ fontSize: 10, background: "#FEF3C7", color: "#92400E", padding: "2px 8px", borderRadius: 4, fontWeight: 700 }}>En tránsito</span>
            </div>
            {e.pedidos.map(p => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid #F3F4F6", fontSize: 11 }}>
                <span style={{ fontFamily: "monospace", color: "#9CA3AF", fontSize: 10 }}>{p.id}</span>
                <strong>{p.cliente}</strong>
                <span style={{ flex: 1, color: "#6B7280" }}>{p.descripcion}</span>
                <span style={{ color: "#6B7280" }}>{p.enviado} {p.empaque || "bulto"}{p.enviado > 1 ? "s" : ""}</span>
                {!p.completo && <span style={{ fontSize: 9, background: "#FEF3C7", color: "#92400E", padding: "1px 5px", borderRadius: 3 }}>Parcial</span>}
                {p.notaEnvio && <span style={{ fontSize: 9, color: "#6B7280" }}>({p.notaEnvio})</span>}
              </div>
            ))}
            {e.notas && <div style={{ fontSize: 10, color: "#6B7280", marginTop: 6 }}>Nota: {e.notas}</div>}
            {(role === "bodegatj" || role === "vendedor" || role === "admin") && (
              <div style={{ marginTop: 10 }}>
                <Btn v="success" onClick={() => {
                  const nota = "";
                  confirmarEnvio(e.id, nota || "");
                }} style={{ width: "100%", justifyContent: "center" }}>✅ Confirmar recepción en bodega TJ</Btn>
              </div>
            )}
          </div>
        ))}

        {/* Envíos confirmados */}
        {envios.filter(e => e.confirmadoTJ).length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 8 }}>Historial de envíos</div>
            {envios.filter(e => e.confirmadoTJ).reverse().map(e => (
              <div key={e.id} style={{ background: "#fff", borderRadius: 8, border: "1px solid #E5E7EB", padding: "10px 14px", marginBottom: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div><span style={{ fontSize: 12, fontWeight: 700 }}>{e.id}</span> <span style={{ fontSize: 11, color: "#6B7280" }}>{fmtD(e.fecha)}{e.vehiculo && ` · ${e.vehiculo}`} · {e.pedidos.length} pedido{e.pedidos.length > 1 ? "s" : ""}</span></div>
                  <span style={{ fontSize: 10, color: "#059669", fontWeight: 600 }}>✓ Recibido {fmtD(e.fechaConfirmacion)}</span>
                </div>
                {e.notasTJ && <div style={{ fontSize: 10, color: "#D97706", marginTop: 3 }}>TJ: {e.notasTJ}</div>}
              </div>
            ))}
          </div>
        )}

        {envios.length === 0 && listos.length === 0 && <div style={{ textAlign: "center", padding: 40, color: "#9CA3AF" }}><div style={{ fontSize: 32, marginBottom: 8 }}>🚛</div><p style={{ fontSize: 12 }}>No hay envíos aún. Cuando haya pedidos en bodega USA, podrás crear envíos.</p></div>}

        {/* New Envío Modal */}
        {showNewEnvio && (
          <Modal title="🚛 Nuevo Envío a Tijuana" onClose={() => { setShowNewEnvio(false) }} w={520}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 10px" }}>
              <Fld label="Fecha de envío"><Inp type="date" value={envioForm.fecha} onChange={e => setEnvioForm({ ...envioForm, fecha: e.target.value })} /></Fld>
              <Fld label="Vehículo"><Inp value={envioForm.vehiculo} onChange={e => setEnvioForm({ ...envioForm, vehiculo: e.target.value })} placeholder="Rabón, box truck, etc." /></Fld>
            </div>
            <Fld label="Notas del envío"><Inp value={envioForm.notas} onChange={e => setEnvioForm({ ...envioForm, notas: e.target.value })} placeholder="Detalles del viaje..." /></Fld>

            <div style={{ fontSize: 10, fontWeight: 700, color: "#374151", textTransform: "uppercase", marginBottom: 6, marginTop: 4 }}>Pedidos en bodega USA — selecciona los que van</div>
            <div style={{ maxHeight: 300, overflow: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
              {listos.map(f => {
                const sel = envioForm.pedidos[f.id];
                const isSelected = !!sel;
                return (
                  <div key={f.id} style={{ border: "1px solid #E5E7EB", borderRadius: 8, overflow: "hidden", background: isSelected ? "#EFF6FF" : "#fff" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", cursor: "pointer" }}>
                      <input type="checkbox" checked={isSelected} onChange={e => {
                        const np = { ...envioForm.pedidos };
                        if (e.target.checked) np[f.id] = { bultos: f.cantBultos || 1, completo: true, nota: "" };
                        else delete np[f.id];
                        setEnvioForm({ ...envioForm, pedidos: np });
                      }} style={{ width: 16, height: 16, accentColor: "#2563EB" }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 600 }}>{f.id} — {f.cliente}</div>
                        <div style={{ fontSize: 10, color: "#6B7280" }}>{f.descripcion} · {f.cantBultos || 1} {f.empaque || "bulto"}{(f.cantBultos || 1) > 1 ? "s" : ""}</div>
                      </div>
                    </label>
                    {isSelected && (
                      <div style={{ padding: "6px 12px 10px 42px", display: "flex", gap: 6, flexWrap: "wrap", fontSize: 11 }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>Bultos:<input type="number" value={sel.bultos} onChange={e => setEnvioForm({ ...envioForm, pedidos: { ...envioForm.pedidos, [f.id]: { ...sel, bultos: parseInt(e.target.value) || 0 } } })} style={{ width: 50, padding: "2px 5px", borderRadius: 4, border: "1px solid #D1D5DB", fontSize: 11, fontFamily: "inherit" }} /></label>
                        <label style={{ display: "flex", alignItems: "center", gap: 4 }}><input type="checkbox" checked={sel.completo} onChange={e => setEnvioForm({ ...envioForm, pedidos: { ...envioForm.pedidos, [f.id]: { ...sel, completo: e.target.checked } } })} style={{ accentColor: "#059669" }} />Completo</label>
                        <input value={sel.nota} onChange={e => setEnvioForm({ ...envioForm, pedidos: { ...envioForm.pedidos, [f.id]: { ...sel, nota: e.target.value } } })} placeholder="Nota..." style={{ flex: 1, minWidth: 80, padding: "2px 5px", borderRadius: 4, border: "1px solid #D1D5DB", fontSize: 11, fontFamily: "inherit" }} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 12, paddingTop: 12, borderTop: "1px solid #E5E7EB" }}>
              <Btn v="secondary" onClick={() => { setShowNewEnvio(false) }} style={{ flex: 1, justifyContent: "center" }}>Cancelar</Btn>
              <Btn disabled={Object.keys(envioForm.pedidos).filter(k => envioForm.pedidos[k]).length === 0} onClick={crearEnvio} style={{ flex: 1, justifyContent: "center" }}>Crear Envío ({Object.keys(envioForm.pedidos).filter(k => envioForm.pedidos[k]).length} pedidos)</Btn>
            </div>
          </Modal>
        )}
      </div>
    );
  };

  // ============ VENTAS ============
  const Ventas = () => {
    const [selPedidos, setSelPedidos] = useState({});
    const [vSearch, setVSearch] = useState("");
    const [vFiltro, setVFiltro] = useState("ALL");
    const [showSobreModal, setShowSobreModal] = useModalState("showSobreModal");
    const [ventasTab, setVentasTab] = useState("fantasmas"); // "fantasmas" | "fletes"

    let pedidosNuevos = data.fantasmas.filter(f => f.estado === "PEDIDO").sort((a, b) => (b.urgente ? 1 : 0) - (a.urgente ? 1 : 0) || new Date(b.fechaCreacion) - new Date(a.fechaCreacion));

    // Search
    if (vSearch) {
      const s = vSearch.toLowerCase().trim();
      const sNum = s.replace(/[^0-9]/g, "");
      pedidosNuevos = pedidosNuevos.filter(f => f.cliente.toLowerCase().includes(s) || f.descripcion.toLowerCase().includes(s) || f.id.toLowerCase().includes(s) || (sNum && f.id.includes(sNum)) || (f.proveedor || "").toLowerCase().includes(s) || (f.tipoMercancia || "").toLowerCase().includes(s));
    }

    // Groups — pedidos pagados por transferencia NO se pueden seleccionar para sobre desde aquí
    const pagoConTransferencia = (f) => (data.transferencias || []).some(t => t.pedidoId === f.id && t.tipo === "fantasma" && t.confirmada === true);
    // sinSobre = pedidos sin sobre: sin fondos + pagados por cliente (tienen dinero, pueden enviar sobre)
    const sinSobre = pedidosNuevos.filter(f => !f.dineroStatus || f.dineroStatus === "SIN_FONDOS" || f.dineroStatus === "FANTASMA_PAGADO" || f.dineroStatus === "FLETE_PAGADO" || f.dineroStatus === "TODO_PAGADO" || f.dineroStatus === "NO_APLICA");
    const sobreListo = pedidosNuevos.filter(f => f.dineroStatus === "SOBRE_LISTO");
    const sobreEnviado = pedidosNuevos.filter(f => f.dineroStatus === "DINERO_CAMINO");
    const pagadoCliente = pedidosNuevos.filter(f => ["FANTASMA_PAGADO", "FLETE_PAGADO", "TODO_PAGADO"].includes(f.dineroStatus));
    const conDineroV = pedidosNuevos.filter(f => f.dineroStatus === "DINERO_USA" || f.dineroStatus === "COLCHON_USADO");
    const transPendientes = pedidosNuevos.filter(f => f.dineroStatus === "TRANS_PENDIENTE");

    // Filter
    const grupos = vFiltro === "ALL" ? [
      { key: "sin_sobre", label: "💵 Sin sobre", items: sinSobre, color: "#DC2626", showSelect: true },
      { key: "trans_pendiente", label: "🏦 Transferencia pendiente", items: transPendientes, color: "#7C3AED", showSelect: false },
      { key: "sobre_listo", label: "📋 Sobre listo", items: sobreListo, color: "#2563EB", showSelect: true },
      { key: "sobre_enviado", label: "📨 Sobre enviado a USA", items: sobreEnviado, color: "#7C3AED", showSelect: false },
      { key: "con_dinero", label: "✅ Dinero en USA", items: conDineroV, color: "#059669", showSelect: false },
    ] : vFiltro === "sobre_listo" ? [
      { key: "sobre_listo", label: "📋 Sobre listo", items: sobreListo, color: "#2563EB", showSelect: true },
    ] : [
      { key: vFiltro, label: vFiltro === "sin_sobre" ? "💵 Sin sobre" : vFiltro === "sobre_enviado" ? "📨 Sobre enviado" : vFiltro === "pagado_cliente" ? "💰 Pagado por cliente" : "✅ Con dinero",
        items: vFiltro === "sin_sobre" ? sinSobre : vFiltro === "sobre_enviado" ? sobreEnviado : vFiltro === "pagado_cliente" ? pagadoCliente : conDineroV,
        color: vFiltro === "sin_sobre" ? "#DC2626" : vFiltro === "sobre_enviado" ? "#7C3AED" : vFiltro === "pagado_cliente" ? "#EC4899" : "#059669",
        showSelect: vFiltro === "sin_sobre" || (vFiltro === "pagado_cliente") }
    ];

    const allPendientesMerc = data.fantasmas.filter(f => f.estado !== "CERRADO" && !f.clientePago);
    const pendientesMerc = vSearch ? allPendientesMerc.filter(f => { const s = vSearch.toLowerCase().trim(); return f.cliente.toLowerCase().includes(s) || f.id.toLowerCase().includes(s) || (f.descripcion||"").toLowerCase().includes(s) || (f.proveedor||"").toLowerCase().includes(s); }) : allPendientesMerc;
    const pendientesFlete = data.fantasmas.filter(f => f.estado !== "CERRADO" && f.clientePago && !f.fletePagado && !f.soloRecoger);
    const totalPorCobrarMerc = pendientesMerc.reduce((s, f) => s + ((f.totalVenta || f.costoMercancia) - (f.abonoMercancia || 0)), 0);
    const totalPorCobrarFlete = pendientesFlete.reduce((s, f) => s + ((f.costoFlete || 0) - (f.abonoFlete || 0)), 0);
    const selCount = Object.keys(selPedidos).filter(k => selPedidos[k]).length;

    const marcarSobreEnviado = (origen) => {
      const ids = Object.keys(selPedidos).filter(k => selPedidos[k]);
      if (ids.length === 0) return;
      let nd = { ...data };
      const totalMonto = ids.reduce((s, fId) => {
        const f = nd.fantasmas.find(x => x.id === fId);
        if (!f) return s;
        // Para pedido especial: el sobre lleva solo el costo real (proveedor)
        // la ganancia ya está en TJ, no va en el sobre
        const montoSobre = f.pedidoEspecial && f.costoReal != null ? f.costoReal : f.costoMercancia;
        return s + montoSobre;
      }, 0);
      ids.forEach(fId => {
        nd = { ...nd, fantasmas: nd.fantasmas.map(f => f.id !== fId ? f : { ...f, dineroStatus: "DINERO_CAMINO", sobreOrigen: origen, fechaActualizacion: today(), historial: [...(f.historial || []), { fecha: today(), accion: `📨 Sobre enviado a USA (${origen === "admin" ? "💼 Caja Admin" : "🇲🇽 Caja Adolfo"})`, quien: role }] }) };
      });
      if (origen === "admin") {
        const nuevosEgresos = [];
        const nuevosAdelantos = [];
        ids.forEach((fId, i) => {
          const f = nd.fantasmas.find(x => x.id === fId);
          if (!f) return;
          const monto = f.pedidoEspecial && f.costoReal != null ? f.costoReal : f.costoMercancia;
          const refId = Date.now() + i * 2;
          nuevosEgresos.push({ id: refId, concepto: `SOBRE USA: ${fId} — ${f.cliente}${f.descripcion ? ' · ' + f.descripcion : ''}`, monto, montoUSD: monto, montoMXN: 0, moneda: "USD", destino: "BODEGA_USA", fecha: today(), nota: f.descripcion || "", tipoMov: "egreso", adelantoRef: refId + 1 });
          // Only create adelanto if there's a real amount to recover — $0 pedidos (soloRecoger, etc.) don't need tracking
          if (monto > 0) {
            nuevosAdelantos.push({ id: refId + 1, pedidoId: fId, monto, fecha: today(), nota: `Sobre enviado a USA — ${f.cliente}`, recuperado: false, movRef: refId });
          }
        });
        nd.gastosAdmin = [...(nd.gastosAdmin || []), ...nuevosEgresos];
        nd.adelantosAdmin = [...(nd.adelantosAdmin || []), ...nuevosAdelantos];
        // Mark pedidos as adelanto
        nd.fantasmas = nd.fantasmas.map(f => ids.includes(f.id) ? { ...f, adelantoAdmin: true } : f);
      }
      persist(nd);
      setSelPedidos({});
      setShowSobreModal(false);
    };

    const desenviarSobre = (fId) => {
      const f = data.fantasmas.find(x => x.id === fId);
      if (!f || f.dineroStatus !== "DINERO_CAMINO") return;
      let nd = { ...data };
      // Revert status: if client paid, go back to SOBRE_LISTO, otherwise SIN_FONDOS
      const nuevoStatus = (f.clientePago || (f.abonoMercancia || 0) > 0) ? "SOBRE_LISTO" : "SIN_FONDOS";
      nd.fantasmas = nd.fantasmas.map(x => x.id !== fId ? x : { ...x, dineroStatus: nuevoStatus, sobreOrigen: null, fechaActualizacion: today(), historial: [...(x.historial || []), { fecha: today(), accion: "↩ Sobre desenviado — se revirtió el envío", quien: role }] });
      // If it was from admin, remove the egreso and adelanto
      if (f.sobreOrigen === "admin") {
        nd.gastosAdmin = (nd.gastosAdmin || []).filter(m => !((m.concepto || "").startsWith("SOBRE USA") && (m.concepto || "").includes(fId)));
        nd.adelantosAdmin = (nd.adelantosAdmin || []).filter(a => a.pedidoId !== fId || a.recuperado);
        nd.fantasmas = nd.fantasmas.map(x => x.id !== fId ? x : { ...x, adelantoAdmin: false });
      }
      persist(nd);
    };

    const renderPedido = (f, showSelect) => {
      const esTrans = f.dineroStatus === "TRANS_PENDIENTE" || pagoConTransferencia(f);
      return (
      <div key={f.id} style={{ background: f.urgente ? "#FFF5F5" : selPedidos[f.id] ? "#EFF6FF" : "#fff", borderRadius: 8, border: selPedidos[f.id] ? "2px solid #93C5FD" : f.urgente ? "2px solid #FECACA" : "1px solid #E5E7EB", padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        {showSelect && <input type="checkbox" checked={!!selPedidos[f.id]} onChange={e => setSelPedidos({ ...selPedidos, [f.id]: e.target.checked })} style={{ width: 16, height: 16, accentColor: "#2563EB", flexShrink: 0 }} />}
        <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => { setDetailMode("full"); navigate("detail", f.id, view); }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 2, flexWrap: "wrap" }}>
            <span style={{ fontSize: 9, color: "#9CA3AF", fontFamily: "monospace" }}>{f.id}</span>
            {f.urgente && <span style={{ fontSize: 9, background: "#DC2626", color: "#fff", padding: "1px 6px", borderRadius: 3, fontWeight: 700 }}>🔥 URGENTE</span>}
            {f.soloRecoger && <span style={{ fontSize: 9, background: "#2563EB", color: "#fff", padding: "1px 6px", borderRadius: 3, fontWeight: 700 }}>📦 SOLO RECOGER</span>}
            {f.fleteDesconocido && <span style={{ fontSize: 9, background: "#D97706", color: "#fff", padding: "1px 6px", borderRadius: 3, fontWeight: 700 }}>❓ FLETE DESC.</span>}
            {f.costoDesconocido && <span style={{ fontSize: 9, background: "#D97706", color: "#fff", padding: "1px 6px", borderRadius: 3, fontWeight: 700 }}>❓ COSTO DESC.</span>}
            <strong style={{ fontSize: 12 }}>{f.cliente}</strong>
            <DBadge status={f.dineroStatus || "SIN_FONDOS"} />
          </div>
          <div style={{ fontSize: 11, color: "#6B7280" }}>{f.tipoMercancia ? f.tipoMercancia + " · " : ""}{f.descripcion}{f.proveedor && <span style={{ color: "#9CA3AF" }}> · {f.proveedor}</span>}{f.ubicacionProv && <span style={{ color: "#9CA3AF" }}> (📍{f.ubicacionProv})</span>}</div>
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
          {f.dineroStatus === "DINERO_CAMINO" && <button onClick={(e) => { e.stopPropagation(); desenviarSobre(f.id); }} style={{ background: "#F5F3FF", color: "#7C3AED", border: "1px solid #E9D5FF", borderRadius: 5, padding: "4px 8px", cursor: "pointer", fontSize: 10, fontWeight: 600, fontFamily: "inherit", whiteSpace: "nowrap" }}>↩ Desenviar</button>}
          <button onClick={(e) => { e.stopPropagation(); updF(f.id, { urgente: !f.urgente }); }} style={{ background: f.urgente ? "#DC2626" : "#F3F4F6", color: f.urgente ? "#fff" : "#9CA3AF", border: "none", borderRadius: 5, padding: "4px 8px", cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: "inherit" }}>🔥</button>
          <button onClick={(e) => { e.stopPropagation(); setConfirm(f.id); }} style={{ background: "#F3F4F6", color: "#D1D5DB", border: "none", borderRadius: 5, padding: "4px 6px", cursor: "pointer", fontSize: 11, fontFamily: "inherit" }} onMouseEnter={e => e.currentTarget.style.color = "#DC2626"} onMouseLeave={e => e.currentTarget.style.color = "#D1D5DB"}><I.Trash /></button>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "monospace", color: "#1A2744" }}>
              {fmt(f.pedidoEspecial && f.costoReal != null ? f.costoReal : f.costoMercancia)}
            </div>
            {f.pedidoEspecial && f.costoReal != null && <div style={{ fontSize: 9, color: "#7C3AED", fontWeight: 600 }}>⭐ Sobre: costo real</div>}
            {f.costoFlete > 0 && <div style={{ fontSize: 9, color: "#6B7280" }}>Flete: {fmt(f.costoFlete)}</div>}
          </div>
          <I.Right />
        </div>
      </div>
      );
    };

    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>📋 Pedidos</h2>
          <Btn onClick={() => { setShowNew(true); }}><I.Plus /> Nuevo Pedido</Btn>
        </div>

        {/* Main tabs: Fantasmas vs Fletes */}
        <div style={{ display: "flex", gap: 3, background: "#F3F4F6", borderRadius: 8, padding: 3, marginBottom: 14 }}>
          <button onClick={() => { setVentasTab("fantasmas"); setVFiltro("ALL"); }} style={{ flex: 1, padding: "9px", borderRadius: 6, border: "none", background: ventasTab === "fantasmas" ? "#fff" : "transparent", boxShadow: ventasTab === "fantasmas" ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 12, fontWeight: ventasTab === "fantasmas" ? 700 : 500, fontFamily: "inherit", color: ventasTab === "fantasmas" ? "#DC2626" : "#6B7280" }}>👻 Fantasmas</button>
          <button onClick={() => { setVentasTab("fletes"); setVFiltro("ALL"); }} style={{ flex: 1, padding: "9px", borderRadius: 6, border: "none", background: ventasTab === "fletes" ? "#fff" : "transparent", boxShadow: ventasTab === "fletes" ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 12, fontWeight: ventasTab === "fletes" ? 700 : 500, fontFamily: "inherit", color: ventasTab === "fletes" ? "#2563EB" : "#6B7280" }}>🚛 Fletes</button>
        </div>

        {/* Stats según tab */}
        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          <Stat label="Pedidos nuevos" value={pedidosNuevos.length} color="#D97706" icon={<I.Box />} sub={`${pedidosNuevos.filter(f => f.urgente).length} urgentes`} />
          {ventasTab === "fantasmas" && <Stat label="Merc. por recibir" value={fmt(totalPorCobrarMerc)} color="#DC2626" icon={<I.Dollar />} sub={`${pendientesMerc.length} pedidos`} />}
          {ventasTab === "fletes" && <Stat label="Flete por recibir" value={fmt(totalPorCobrarFlete)} color="#2563EB" icon={<I.Truck />} sub={`${pendientesFlete.length} pedidos`} />}
        </div>

        {/* Search and status tabs — solo en fantasmas */}
        {ventasTab === "fantasmas" && <>
        <div style={{ position: "relative", marginBottom: 8 }}>
          <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "#9CA3AF" }}><I.Search /></span>
          <input value={vSearch} onChange={e => setVSearch(e.target.value)} placeholder="Buscar folio, cliente, proveedor..." autoComplete="off" style={{ width: "100%", padding: "8px 10px", paddingLeft: 28, borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 12, outline: "none", boxSizing: "border-box", fontFamily: "inherit", background: "#FAFAFA" }} />
        </div>
        <div style={{ display: "flex", gap: 3, background: "#F3F4F6", borderRadius: 8, padding: 3, marginBottom: 12 }}>
          {[["ALL","📋 Todos",null,"#1A2744"],["sin_sobre","💵 Pendientes",sinSobre.length,"#DC2626"],["sobre_listo","📋 Sobre listo",sobreListo.length,"#2563EB"],["sobre_enviado","📨 Enviados",sobreEnviado.length,"#7C3AED"],["con_dinero","✅ En USA",conDineroV.length,"#059669"]].map(([k,l,n,c]) => (
            <button key={k} onClick={() => setVFiltro(k)} style={{ flex: 1, padding: "8px 6px", borderRadius: 6, border: "none", background: vFiltro === k ? "#fff" : "transparent", boxShadow: vFiltro === k ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 11, fontWeight: vFiltro === k ? 700 : 500, fontFamily: "inherit", color: vFiltro === k ? c : "#9CA3AF" }}>{l}{n != null ? ` (${n})` : ""}</button>
          ))}
        </div>
        </>}

        {/* Fantasmas tab content */}
        {ventasTab === "fantasmas" && <>
        {/* Groups */}
        {grupos.map(g => g.items.length > 0 && (
          <div key={g.key} style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: g.color }}>{g.label} ({g.items.length})</div>
              {g.showSelect && <div style={{ display: "flex", gap: 4 }}>
                <Btn sz="sm" v="secondary" onClick={() => { const ns = { ...selPedidos }; g.items.forEach(f => ns[f.id] = true); setSelPedidos(ns); }}>Seleccionar</Btn>
              </div>}
            </div>
            {g.items.map(f => renderPedido(f, g.showSelect))}
          </div>
        ))}

        {/* Pendientes de pago — solo mercancía */}
        {allPendientesMerc.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#DC2626", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}
                onClick={() => setVFiltro(vFiltro === "merc_pend" ? "ALL" : "merc_pend")}>
                👻 Mercancía pendiente de pago ({allPendientesMerc.length})
                <span style={{ fontSize: 10, color: "#9CA3AF" }}>{vFiltro === "merc_pend" ? "▲ ocultar" : "▼ ver"}</span>
              </div>
              {vFiltro === "merc_pend" && <Btn sz="sm" v="secondary" onClick={() => { const ns = { ...selPedidos }; pendientesMerc.forEach(f => ns[f.id] = true); setSelPedidos(ns); }}>Seleccionar todos</Btn>}
            </div>
            {vFiltro === "merc_pend" && pendientesMerc.sort((a, b) => (b.urgente ? 1 : 0) - (a.urgente ? 1 : 0)).map(f => {
              const dm = (f.totalVenta || f.costoMercancia) - (f.abonoMercancia || 0);
              return <div key={f.id} style={{ background: selPedidos[f.id] ? "#EFF6FF" : "#fff", borderRadius: 8, border: selPedidos[f.id] ? "2px solid #93C5FD" : "1px solid #E5E7EB", padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                <input type="checkbox" checked={!!selPedidos[f.id]} onChange={e => setSelPedidos({ ...selPedidos, [f.id]: e.target.checked })} style={{ width: 16, height: 16, accentColor: "#2563EB", flexShrink: 0 }} />
                <div style={{ flex: 1, cursor: "pointer" }} onClick={() => { setDetailMode("full"); navigate("detail", f.id, view); }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}><span style={{ fontSize: 9, color: "#9CA3AF", fontFamily: "monospace" }}>{f.id}</span>{f.urgente && <span style={{ fontSize: 9, background: "#DC2626", color: "#fff", padding: "1px 5px", borderRadius: 3, fontWeight: 700 }}>🔥</span>}<strong style={{ fontSize: 12 }}>{f.cliente}</strong><Badge estado={f.estado} /><DBadge status={f.dineroStatus || "SIN_FONDOS"} /></div>
                  <div style={{ fontSize: 11, color: "#6B7280" }}>{f.descripcion}</div>
                </div>
                <div style={{ fontSize: 10, flexShrink: 0 }}>{dm > 0 && <span style={{ color: "#DC2626", fontWeight: 600 }}>👻 {fmt(dm)}</span>}</div>
                <button onClick={(e) => { e.stopPropagation(); setConfirm(f.id); }} style={{ background: "#F3F4F6", color: "#D1D5DB", border: "none", borderRadius: 5, padding: "4px 6px", cursor: "pointer", fontSize: 11, fontFamily: "inherit", flexShrink: 0 }} onMouseEnter={e => e.currentTarget.style.color = "#DC2626"} onMouseLeave={e => e.currentTarget.style.color = "#D1D5DB"}><I.Trash /></button>
                <I.Right />
              </div>;
            })}
          </div>
        )}
        {pedidosNuevos.length === 0 && pendientesMerc.length === 0 && <div style={{ textAlign: "center", padding: 40, color: "#9CA3AF" }}><div style={{ fontSize: 32, marginBottom: 8 }}>📋</div><p style={{ fontSize: 12 }}>No hay pedidos nuevos ni mercancía pendiente.</p></div>}
        </>}

        {/* Fletes tab content */}
        {ventasTab === "fletes" && (() => {
          const conFletesPendientes = data.fantasmas.filter(f => f.estado !== "CERRADO" && !f.soloRecoger && !f.fletePagado && (f.costoFlete > 0 || f.fleteDesconocido)).sort((a, b) => (b.urgente ? 1 : 0) - (a.urgente ? 1 : 0));
          const conFletesPagados = data.fantasmas.filter(f => f.estado !== "CERRADO" && f.fletePagado).sort((a, b) => new Date(b.fechaActualizacion) - new Date(a.fechaActualizacion));
          const mkRow = (f) => {
            const df = (f.costoFlete || 0) - (f.abonoFlete || 0);
            return <div key={f.id} onClick={() => { setDetailMode("full"); navigate("detail", f.id, view); }} style={{ background: "#fff", borderRadius: 8, border: "1px solid #E5E7EB", padding: "10px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
              <div style={{ flex: 1 }}><div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}><span style={{ fontSize: 9, color: "#9CA3AF", fontFamily: "monospace" }}>{f.id}</span>{f.urgente && <span style={{ fontSize: 9, background: "#DC2626", color: "#fff", padding: "1px 5px", borderRadius: 3, fontWeight: 700 }}>🔥</span>}<strong style={{ fontSize: 12 }}>{f.cliente}</strong><Badge estado={f.estado} />{f.fleteDesconocido && <span style={{ fontSize: 9, background: "#D97706", color: "#fff", padding: "1px 5px", borderRadius: 3 }}>❓ Desc.</span>}</div><div style={{ fontSize: 11, color: "#6B7280" }}>{f.descripcion} · {f.proveedor || "—"}</div></div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                {f.fleteDesconocido ? <span style={{ color: "#D97706", fontWeight: 700, fontSize: 13 }}>❓</span> : <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 13, color: f.fletePagado ? "#059669" : "#2563EB" }}>{fmt(f.costoFlete)}</span>}
                {!f.fletePagado && df > 0 && <div style={{ fontSize: 10, color: "#DC2626" }}>Debe: {fmt(df)}</div>}
                {f.fletePagado && <div style={{ fontSize: 10, color: "#059669" }}>✓ Pagado</div>}
              </div>
              <I.Right />
            </div>;
          };
          return <div>
            {conFletesPendientes.length > 0 && <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#2563EB", marginBottom: 8 }}>🚛 Flete pendiente ({conFletesPendientes.length})</div>
              {conFletesPendientes.map(mkRow)}
            </div>}
            {conFletesPagados.length > 0 && <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#059669", marginBottom: 8 }}>✅ Fletes pagados ({conFletesPagados.length})</div>
              {conFletesPagados.slice(0, 20).map(mkRow)}
            </div>}
            {conFletesPendientes.length === 0 && conFletesPagados.length === 0 && <div style={{ textAlign: "center", padding: 40, color: "#9CA3AF" }}><div style={{ fontSize: 32, marginBottom: 8 }}>🚛</div><p style={{ fontSize: 12 }}>No hay fletes registrados.</p></div>}
          </div>;
        })()}

        {selCount > 0 && <div style={{ position: "sticky", bottom: 16, padding: "12px 16px", background: "#1A2744", borderRadius: 10, color: "#fff", display: "flex", justifyContent: "space-between", alignItems: "center", boxShadow: "0 4px 16px rgba(0,0,0,.2)" }}><span style={{ fontSize: 13, fontWeight: 600 }}>{selCount} seleccionado{selCount > 1 ? "s" : ""}</span><div style={{ display: "flex", gap: 6 }}><Btn v="secondary" sz="sm" onClick={() => setSelPedidos({})}>Deseleccionar</Btn><Btn onClick={() => setShowSobreModal(true)} style={{ background: "#2563EB" }}>📨 Sobre enviado a USA</Btn></div></div>}

        {/* Modal: ¿De dónde sale el sobre? */}
        {showSobreModal && (() => {
          const ids = Object.keys(selPedidos).filter(k => selPedidos[k]);
          const selectedPedidos = ids.map(id => data.fantasmas.find(x => x.id === id)).filter(Boolean);
          const totalMonto = selectedPedidos.reduce((s, f) => {
            // Para pedido especial: el sobre lleva solo el costo real del proveedor
            const montoSobre = f.pedidoEspecial && f.costoReal != null ? f.costoReal : (f.costoMercancia || 0);
            return s + montoSobre;
          }, 0);
          const sinPago = selectedPedidos.filter(f => !f.clientePago && (f.abonoMercancia || 0) <= 0);
          const hayPedidosSinPago = sinPago.length > 0;
          // Pedidos pagados por transferencia → solo puede salir de Caja Admin
          const conTransferencia = selectedPedidos.filter(f => pagoConTransferencia(f) || ["FANTASMA_PAGADO","TODO_PAGADO"].includes(f.dineroStatus) && (data.transferencias||[]).some(t => t.pedidoId === f.id && t.confirmada));
          const soloAdmin = conTransferencia.length > 0;
          // Saldo admin USD
          const admMovs = data.gastosAdmin || [];
          const admUSD = admMovs.filter(m => m.moneda !== "MXN");
          const saldoAdmUSD = admUSD.filter(m => m.tipoMov === "ingreso").reduce((s, m) => s + (m.montoUSD || (m.moneda !== "MXN" ? m.monto : 0) || 0), 0) - admUSD.filter(m => m.tipoMov === "egreso").reduce((s, m) => s + (m.montoUSD || (m.moneda !== "MXN" ? m.monto : 0) || 0), 0);
          const sinSaldoAdmin = totalMonto > saldoAdmUSD;
          return (
            <Modal title="📨 Enviar sobre a USA" onClose={() => { setShowSobreModal(false) }} w={420}>
              <div style={{ background: "#F9FAFB", borderRadius: 6, padding: "8px 12px", marginBottom: 12, border: "1px solid #E5E7EB", fontSize: 11 }}>
                <strong>{ids.length}</strong> pedido{ids.length > 1 ? "s" : ""} · Total: <strong>{fmt(totalMonto)}</strong>
              </div>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>¿De dónde sale el dinero?</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {/* Caja Adolfo — solo si NO hay pedidos con transferencia */}
                {!soloAdmin && (
                  <button onClick={() => marcarSobreEnviado("adolfo")} style={{ padding: "14px 16px", borderRadius: 10, border: `2px solid ${hayPedidosSinPago ? "#D97706" : "#059669"}`, background: hayPedidosSinPago ? "#FEF3C7" : "#ECFDF5", cursor: "pointer", textAlign: "left" }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: hayPedidosSinPago ? "#92400E" : "#065F46" }}>🇲🇽 Caja de Adolfo (Bodega TJ)</div>
                    {hayPedidosSinPago ? (
                      <div style={{ fontSize: 10, color: "#92400E", marginTop: 4 }}>⚠️ {sinPago.length} pedido{sinPago.length > 1 ? "s" : ""} aún sin pago: {sinPago.map(f => f.cliente).join(", ")}</div>
                    ) : (
                      <div style={{ fontSize: 11, color: "#6B7280", marginTop: 2 }}>El cliente ya trajo el dinero a bodega</div>
                    )}
                  </button>
                )}
                {soloAdmin && (
                  <div style={{ padding: "10px 14px", borderRadius: 8, background: "#EFF6FF", border: "1px solid #BFDBFE", fontSize: 10, color: "#1E40AF" }}>
                    💳 {conTransferencia.length} pedido{conTransferencia.length > 1 ? "s" : ""} pagado{conTransferencia.length > 1 ? "s" : ""} por transferencia — el dinero está en Caja Admin
                  </div>
                )}
                {sinSaldoAdmin ? (
                  <div style={{ padding: "14px 16px", borderRadius: 10, border: "2px solid #D1D5DB", background: "#F9FAFB", opacity: 0.6 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#9CA3AF" }}>💼 Caja Admin (Administración)</div>
                    <div style={{ fontSize: 11, color: "#DC2626", marginTop: 4, fontWeight: 600 }}>⚠️ Saldo insuficiente</div>
                    <div style={{ fontSize: 10, color: "#DC2626", marginTop: 2 }}>Necesitas {fmt(totalMonto)} · Tienes {fmt(saldoAdmUSD)} USD</div>
                  </div>
                ) : (
                  <button onClick={() => marcarSobreEnviado("admin")} style={{ padding: "14px 16px", borderRadius: 10, border: "2px solid #2563EB", background: "#EFF6FF", cursor: "pointer", textAlign: "left" }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#1E40AF" }}>💼 Caja Admin (Administración)</div>
                    <div style={{ fontSize: 11, color: "#6B7280", marginTop: 2 }}>El cliente aún no paga, yo adelanto</div>
                    <div style={{ fontSize: 10, color: "#059669", marginTop: 2 }}>Saldo disponible: {fmt(saldoAdmUSD)} USD</div>
                  </button>
                )}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}><Btn v="secondary" onClick={() => { setShowSobreModal(false) }}>Cancelar</Btn></div>
            </Modal>
          );
        })()}
        {confirm && (() => { const cf = data.fantasmas.find(x => x.id === confirm); return cf ? (
          <Modal title="Eliminar pedido" onClose={() => setConfirm(null)} w={380}>
            <p style={{ margin: "0 0 8px", fontSize: 12 }}><strong>{cf.cliente}</strong> — {cf.descripcion} ({fmt(cf.costoMercancia)})</p>
            {(() => { const linked = []; if (cf.fletePagadoCxp) linked.push(`Abono flete a CxP: ${cf.fletePagadoCxp} (${fmt(cf.costoFlete)})`); if (cf.dineroStatus === "DINERO_CAMINO") linked.push("Sobre en camino a USA"); if (cf.usaColchon) linked.push("Uso de colchón"); if ((cf.movimientos||[]).length > 0) linked.push(`${cf.movimientos.length} pago(s)`); if (cf.comisionCobrada) linked.push(`Comisión (${fmt(cf.comisionMonto)})`); return linked.length > 0 ? <div style={{ background: "#FEF2F2", borderRadius: 6, padding: "8px 10px", marginBottom: 10, border: "1px solid #FECACA" }}><div style={{ fontSize: 10, fontWeight: 600, color: "#991B1B", marginBottom: 4 }}>⚠️ También se eliminará:</div>{linked.map((l,i) => <div key={i} style={{ fontSize: 10, color: "#DC2626" }}>• {l}</div>)}</div> : null; })()}
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <Btn v="secondary" onClick={() => setConfirm(null)}>Cancelar</Btn>
              <Btn v="danger" onClick={() => delF(cf.id)}>Sí, eliminar</Btn>
            </div>
          </Modal>
        ) : null; })()}
      </div>
    );
  };


  // ============ RECOLECCIÓN (Jordi) ============
  const Recoleccion = () => {
    const [selected, setSelected] = useState({});
    const [fZona, setFZona] = useState("ALL");
    const [fProv, setFProv] = useState("ALL");
    const provInfo = data.proveedoresInfo || {};

    // Recolección: ONLY pedidos with money confirmed, still in PEDIDO estado, with chofer
    let pendientes = data.fantasmas.filter(f => f.estado === "PEDIDO" && (f.dineroStatus === "DINERO_USA" || f.dineroStatus === "COLCHON_USADO" || f.dineroStatus === "NO_APLICA") && f.choferAsignado).sort((a, b) => (b.urgente ? 1 : 0) - (a.urgente ? 1 : 0));

    const isOtay = (f) => { const u = (f.ubicacionProv || provInfo[f.proveedor]?.ubicacion || "").toLowerCase(); return u.includes("otay"); };
    const isLA = (f) => { const u = (f.ubicacionProv || provInfo[f.proveedor]?.ubicacion || "").toLowerCase(); return u.includes("ángeles") || u.includes("angeles"); };
    const getZona = (f) => isOtay(f) ? "Otay" : isLA(f) ? "Los Ángeles" : f.ubicacionProv || "Sin ubicación";

    // Get unique zonas and proveedores for filters
    const zonas = [...new Set(pendientes.map(f => getZona(f)))].sort();
    const proveedores = [...new Set(pendientes.map(f => f.proveedor).filter(Boolean))].sort();

    // Apply filters
    if (fZona !== "ALL") pendientes = pendientes.filter(f => getZona(f) === fZona);
    if (fProv !== "ALL") pendientes = pendientes.filter(f => f.proveedor === fProv);

    const otay = pendientes.filter(f => isOtay(f));
    const la = pendientes.filter(f => isLA(f));
    const otra = pendientes.filter(f => !isOtay(f) && !isLA(f) && f.ubicacionProv);
    const sinUbic = pendientes.filter(f => !f.ubicacionProv && !provInfo[f.proveedor]?.ubicacion);

    const selCount = Object.keys(selected).filter(k => selected[k]).length;

    const marcarRecolectado = () => {
      const ids = Object.keys(selected).filter(k => selected[k]);
      if (ids.length === 0) return;
      let newData = { ...data };
      ids.forEach(fId => {
        newData = { ...newData, fantasmas: newData.fantasmas.map(f => f.id !== fId ? f : { ...f, estado: "RECOLECTADO", fechaActualizacion: today(), historial: [...(f.historial || []), { fecha: today(), accion: "Recolectado — en camino a TJ", quien: role }] }) };
      });
      persist(newData);
      setSelected({});
    };

    const regresarAPendientes = () => {
      const ids = Object.keys(selected).filter(k => selected[k]);
      if (ids.length === 0) return;
      let newData = { ...data };
      ids.forEach(fId => {
        newData = { ...newData, fantasmas: newData.fantasmas.map(f => f.id !== fId ? f : { ...f, dineroStatus: "SIN_FONDOS", choferAsignado: null, usaColchon: false, fechaActualizacion: today(), historial: [...(f.historial || []), { fecha: today(), accion: "↩ Regresado a pendientes — sin dinero ni chofer", quien: role }] }) };
      });
      persist(newData); setSelected({});
    };

    const regresarAChofer = () => {
      const ids = Object.keys(selected).filter(k => selected[k]);
      if (ids.length === 0) return;
      let newData = { ...data };
      ids.forEach(fId => {
        newData = { ...newData, fantasmas: newData.fantasmas.map(f => f.id !== fId ? f : { ...f, choferAsignado: null, fechaActualizacion: today(), historial: [...(f.historial || []), { fecha: today(), accion: "↩ Regresado a Asignar Chofer — se quitó el chofer", quien: role }] }) };
      });
      persist(newData); setSelected({});
    };

    const renderItem = (f) => {
      const info = provInfo[f.proveedor] || {};
      return (
        <label key={f.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: selected[f.id] ? "#EFF6FF" : f.urgente ? "#FFF5F5" : "#fff", borderRadius: 8, border: selected[f.id] ? "2px solid #93C5FD" : f.urgente ? "2px solid #FECACA" : "1px solid #E5E7EB", cursor: "pointer" }}>
          <input type="checkbox" checked={!!selected[f.id]} onChange={e => setSelected({ ...selected, [f.id]: e.target.checked })} style={{ width: 16, height: 16, accentColor: "#2563EB", flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2, flexWrap: "wrap" }}>
              <span style={{ fontSize: 9, color: "#9CA3AF", fontFamily: "monospace" }}>{f.id}</span>
              {f.urgente && <span style={{ fontSize: 9, background: "#DC2626", color: "#fff", padding: "1px 6px", borderRadius: 3, fontWeight: 700 }}>🔥 URGENTE</span>}
            {f.soloRecoger && <span style={{ fontSize: 9, background: "#2563EB", color: "#fff", padding: "1px 6px", borderRadius: 3, fontWeight: 700 }}>📦 SOLO RECOGER</span>}
            {f.fleteDesconocido && <span style={{ fontSize: 9, background: "#D97706", color: "#fff", padding: "1px 6px", borderRadius: 3, fontWeight: 700 }}>❓ FLETE DESC.</span>}
            {f.costoDesconocido && <span style={{ fontSize: 9, background: "#D97706", color: "#fff", padding: "1px 6px", borderRadius: 3, fontWeight: 700 }}>❓ COSTO DESC.</span>}
              <strong style={{ fontSize: 12 }}>{f.cliente}</strong>
              {f.choferAsignado && <span style={{ fontSize: 9, background: "#DBEAFE", color: "#1E40AF", padding: "1px 7px", borderRadius: 3, fontWeight: 700 }}>🚗 {f.choferAsignado}</span>}
            </div>
            <div style={{ fontSize: 11, color: "#6B7280" }}>{f.descripcion}</div>
            <div style={{ fontSize: 10, color: "#9CA3AF", display: "flex", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
              {info.contacto && <span>👤 {info.contacto}</span>}
              {info.telefono && <span>📞 {info.telefono}</span>}
              <span>📦 {f.cantBultos || 1} {f.empaque || "bulto"}{(f.cantBultos || 1) > 1 ? "s" : ""}</span>
              {f.costoMercancia > 0 && <span>💵 {fmt(f.costoMercancia)}</span>}
            </div>
          </div>
          <DBadge status={f.dineroStatus || "SIN_FONDOS"} />
        </label>
      );
    };

    const renderZona = (label, items, color, bgColor, emoji) => {
      if (items.length === 0) return null;
      // Group items by proveedor within this zona
      const byProv = {};
      items.forEach(f => { const p = f.proveedor || "SIN PROVEEDOR"; if (!byProv[p]) byProv[p] = []; byProv[p].push(f); });
      const provNames = Object.keys(byProv).sort();
      const allSel = items.every(f => selected[f.id]);

      return (
        <div key={label} style={{ marginBottom: 16 }}>
          {/* Zona header */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, padding: "8px 12px", background: bgColor, borderRadius: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", flex: 1 }}>
              <input type="checkbox" checked={allSel} onChange={e => { const ns = { ...selected }; items.forEach(f => ns[f.id] = e.target.checked); setSelected(ns); }} style={{ width: 16, height: 16, accentColor: color }} />
              <span style={{ fontSize: 14, fontWeight: 700, color }}>{emoji} {label}</span>
              <span style={{ fontSize: 11, color: "#9CA3AF" }}>({items.length} pedido{items.length > 1 ? "s" : ""} · {provNames.length} proveedor{provNames.length > 1 ? "es" : ""})</span>
            </label>
          </div>
          {/* Proveedores within this zona */}
          {provNames.map(pName => {
            const pItems = byProv[pName];
            const pInfo = provInfo[pName] || {};
            const pAllSel = pItems.every(f => selected[f.id]);
            return (
              <div key={pName} style={{ marginLeft: 16, marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, padding: "4px 8px" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", flex: 1 }}>
                    <input type="checkbox" checked={pAllSel} onChange={e => { const ns = { ...selected }; pItems.forEach(f => ns[f.id] = e.target.checked); setSelected(ns); }} style={{ width: 14, height: 14, accentColor: color }} />
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#374151" }}>🏭 {pName}</span>
                    <span style={{ fontSize: 10, color: "#9CA3AF" }}>({pItems.length})</span>
                    {pInfo.contacto && <span style={{ fontSize: 10, color: "#9CA3AF" }}>· 👤 {pInfo.contacto}</span>}
                    {pInfo.telefono && <span style={{ fontSize: 10, color: "#9CA3AF" }}>· 📞 {pInfo.telefono}</span>}
                  </label>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginLeft: 8 }}>
                  {pItems.map(renderItem)}
                </div>
              </div>
            );
          })}
        </div>
      );
    };

    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>🛒 Recolección</h2>
            <div style={{ fontSize: 11, color: "#6B7280", marginTop: 2 }}>{pendientes.length} pedidos listos para recoger</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 5, marginBottom: 10, flexWrap: "wrap" }}>
          <select value={fZona} onChange={e => setFZona(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, fontFamily: "inherit", background: fZona !== "ALL" ? "#EFF6FF" : "#FAFAFA" }}>
            <option value="ALL">Todas las zonas</option>
            {zonas.map(z => <option key={z} value={z}>{z}</option>)}
          </select>
          <select value={fProv} onChange={e => setFProv(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, fontFamily: "inherit", background: fProv !== "ALL" ? "#F5F3FF" : "#FAFAFA" }}>
            <option value="ALL">Todos los proveedores</option>
            {proveedores.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>

        {pendientes.length === 0 ? (
          <div style={{ textAlign: "center", padding: 40, color: "#9CA3AF" }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
            <p style={{ fontSize: 12 }}>No hay pedidos pendientes de recoger.</p>
          </div>
        ) : (
          <>
            {renderZona("Proveedores Otay", otay, "#1E40AF", "#EFF6FF", "📍")}
            {renderZona("Proveedores Los Ángeles", la, "#7C3AED", "#F5F3FF", "📍")}
            {otra.length > 0 && renderZona("Otra ubicación", otra, "#6B7280", "#F9FAFB", "📍")}
            {sinUbic.length > 0 && renderZona("Sin ubicación", sinUbic, "#9CA3AF", "#F9FAFB", "❓")}
          </>
        )}

        {selCount > 0 && (
          <div style={{ position: "sticky", bottom: 16, padding: "12px 16px", background: "#1A2744", borderRadius: 10, color: "#fff", display: "flex", justifyContent: "space-between", alignItems: "center", boxShadow: "0 4px 16px rgba(0,0,0,.2)", flexWrap: "wrap", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{selCount} pedido{selCount > 1 ? "s" : ""}</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Btn v="secondary" sz="sm" onClick={() => setSelected({})}>Deseleccionar</Btn>
              <Btn onClick={regresarAChofer} style={{ background: "#D97706" }}>🚗 ← Cambiar chofer</Btn>
              <Btn onClick={regresarAPendientes} style={{ background: "#DC2626" }}>💵 ← A pendientes</Btn>
              <Btn onClick={marcarRecolectado} style={{ background: "#6366F1" }}>✅ Marcar recolectado</Btn>
            </div>
          </div>
        )}
      </div>
    );
  };


  // ============ BODEGA USA (wrapper with sub-tabs) ============
  const BodegaUSA = () => {
    const tab = usaTab; const setTab = setUsaTab;
    const [selSobres, setSelSobres] = useState({});
    const [usaPendTab, setUsaPendTab] = useState("camino");
    const [usaSearch, setUsaSearch] = useState("");

    const usaMatch = (f) => {
      if (!usaSearch.trim()) return true;
      const s = usaSearch.toLowerCase().trim();
      return f.cliente.toLowerCase().includes(s) || f.id.toLowerCase().includes(s) || (f.descripcion||"").toLowerCase().includes(s) || (f.proveedor||"").toLowerCase().includes(s);
    };

    // CLEAN FILTERS: each pedido in exactly ONE tab
    const pendientes = data.fantasmas.filter(f => f.estado === "PEDIDO" && (!f.dineroStatus || f.dineroStatus === "SIN_FONDOS" || f.dineroStatus === "SOBRE_LISTO" || f.dineroStatus === "DINERO_CAMINO")).sort((a, b) => (b.urgente ? 1 : 0) - (a.urgente ? 1 : 0));
    const sobreEnCamino = pendientes.filter(f => f.dineroStatus === "DINERO_CAMINO");
    const sinSobreUSA = pendientes.filter(f => !f.dineroStatus || f.dineroStatus === "SIN_FONDOS" || f.dineroStatus === "SOBRE_LISTO");
    const listoRecoleccion = data.fantasmas.filter(f => f.estado === "PEDIDO" && (f.dineroStatus === "DINERO_USA" || f.dineroStatus === "COLCHON_USADO" || f.dineroStatus === "NO_APLICA") && f.choferAsignado).sort((a, b) => (b.urgente ? 1 : 0) - (a.urgente ? 1 : 0));
    const recolectados = data.fantasmas.filter(f => f.estado === "RECOLECTADO").sort((a, b) => new Date(b.fechaActualizacion) - new Date(a.fechaActualizacion));

    const selCount = Object.keys(selSobres).filter(k => selSobres[k]).length;
    // Check if any selected have sobre en camino (can confirm receipt)
    const selConSobre = Object.keys(selSobres).filter(k => selSobres[k]).some(fId => { const f = data.fantasmas.find(x => x.id === fId); return f && f.dineroStatus === "DINERO_CAMINO"; });
    const selSinSobre = Object.keys(selSobres).filter(k => selSobres[k]).some(fId => { const f = data.fantasmas.find(x => x.id === fId); return f && f.dineroStatus !== "DINERO_CAMINO"; });

    const marcarDineroUSA = () => {
      const ids = Object.keys(selSobres).filter(k => selSobres[k]);
      if (ids.length === 0) return;
      // Only mark pedidos that have sobre en camino
      let nd = { ...data };
      ids.forEach(fId => {
        const f = nd.fantasmas.find(x => x.id === fId);
        if (!f || f.dineroStatus !== "DINERO_CAMINO") return;
        nd = { ...nd, fantasmas: nd.fantasmas.map(x => x.id !== fId ? x : {
          ...x, dineroStatus: "DINERO_USA",
          fechaActualizacion: today(),
          historial: [...(x.historial || []), { fecha: today(), accion: "💵 Sobre recibido — Dinero en USA", quien: role }]
        }) };
      });
      persist(nd);
      setSelSobres({});
    };

    const colchonSaldo = (data.colchon || {}).saldoActual || 0;
    const marcarColchon = async () => {
      const ids = Object.keys(selSobres).filter(k => selSobres[k]);
      if (ids.length === 0) return;
      const totalNeeded = ids.reduce((s, id) => { const f = data.fantasmas.find(x => x.id === id); return s + (f ? (f.totalVenta || f.costoMercancia || 0) : 0); }, 0);
      if (colchonSaldo <= 0) { showAlert("⚠️ El colchón está en $0.00 — no hay fondos disponibles."); return; }
      if (totalNeeded > colchonSaldo) { if (!await showConfirm(`⚠️ El colchón tiene ${fmt(colchonSaldo)} pero necesitas ${fmt(totalNeeded)}.\n\n¿Continuar de todas formas?`)) return; }
      let nd = { ...data };
      let totalUsado = 0;
      ids.forEach(fId => {
        const ff = nd.fantasmas.find(x => x.id === fId);
        const monto = ff ? (ff.totalVenta || ff.costoMercancia || 0) : 0;
        totalUsado += monto;
        nd = { ...nd, fantasmas: nd.fantasmas.map(f => f.id !== fId ? f : {
          ...f, dineroStatus: "COLCHON_USADO", usaColchon: true,
          fechaActualizacion: today(),
          historial: [...(f.historial || []), { fecha: today(), accion: `🛡️ Colchón usado: ${fmt(monto)}`, quien: role }]
        }) };
      });
      // Deduct from colchón
      const c = nd.colchon || { montoOriginal: 0, saldoActual: 0, movimientos: [] };
      nd.colchon = { ...c, saldoActual: (c.saldoActual || 0) - totalUsado, movimientos: [...(c.movimientos || []), { id: Date.now(), tipo: "Salida", concepto: `${ids.length} pedido(s) con colchón`, monto: totalUsado, fecha: today() }] };
      persist(nd);
      setSelSobres({});
    };

    const PendientesTab = () => {
      const renderItem = (f) => {
        const dias = diasHabiles(f.fechaCreacion);
        const autoUrgente = dias >= 3;
        const esUrgente = f.urgente || autoUrgente;
        return (
        <label key={f.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: selSobres[f.id] ? "#EFF6FF" : esUrgente ? "#FFF5F5" : "#fff", borderRadius: 8, border: selSobres[f.id] ? "2px solid #93C5FD" : esUrgente ? "2px solid #FECACA" : "1px solid #E5E7EB", cursor: "pointer", marginBottom: 4 }}>
          <input type="checkbox" checked={!!selSobres[f.id]} onChange={e => setSelSobres({ ...selSobres, [f.id]: e.target.checked })} style={{ width: 18, height: 18, accentColor: "#2563EB", flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }} onClick={() => { setDetailMode("full"); navigate("detail", f.id, view); }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
              <span style={{ fontSize: 9, color: "#9CA3AF", fontFamily: "monospace" }}>{f.id}</span>
              {esUrgente && <span style={{ fontSize: 9, background: "#DC2626", color: "#fff", padding: "1px 6px", borderRadius: 3, fontWeight: 700 }}>🔥 URGENTE</span>}
              {f.soloRecoger && <span style={{ fontSize: 9, background: "#2563EB", color: "#fff", padding: "1px 6px", borderRadius: 3, fontWeight: 700 }}>📦 SOLO RECOGER</span>}
              {f.fleteDesconocido && <span style={{ fontSize: 9, background: "#D97706", color: "#fff", padding: "1px 6px", borderRadius: 3, fontWeight: 700 }}>❓ FLETE DESC.</span>}
              {f.costoDesconocido && <span style={{ fontSize: 9, background: "#D97706", color: "#fff", padding: "1px 6px", borderRadius: 3, fontWeight: 700 }}>❓ COSTO DESC.</span>}
              <strong style={{ fontSize: 12 }}>{f.cliente}</strong>
              <DBadge status={f.dineroStatus || "SIN_FONDOS"} />
              <span style={{ fontSize: 9, background: dias >= 3 ? "#FEE2E2" : dias >= 2 ? "#FEF3C7" : "#F3F4F6", color: dias >= 3 ? "#DC2626" : dias >= 2 ? "#D97706" : "#6B7280", padding: "1px 6px", borderRadius: 3, fontWeight: 700 }}>
                🕐 {dias}d
              </span>
            </div>
            <div style={{ fontSize: 11, color: "#6B7280" }}>{f.descripcion} · {f.proveedor}{f.ubicacionProv ? ` (📍${f.ubicacionProv})` : ""}</div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "monospace", color: "#1A2744" }}>{fmt(f.costoMercancia)}</div>
          </div>
        </label>
        );
      };

      return (
      <div>
        {/* Sub-tabs: Pendientes / Sobres en camino */}
        <div style={{ display: "flex", gap: 3, background: "#F3F4F6", borderRadius: 8, padding: 3, marginBottom: 14 }}>
          <button onClick={() => setUsaPendTab("pendientes")} style={{ flex: 1, padding: "7px 12px", borderRadius: 6, border: "none", background: usaPendTab === "pendientes" ? "#fff" : "transparent", boxShadow: usaPendTab === "pendientes" ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 11, fontWeight: usaPendTab === "pendientes" ? 700 : 500, fontFamily: "inherit", color: usaPendTab === "pendientes" ? "#DC2626" : "#6B7280" }}>
            💵 Esperando sobre{sinSobreUSA.length > 0 && <span style={{ marginLeft: 5, background: "#DC2626", color: "#fff", borderRadius: 8, padding: "1px 6px", fontSize: 9, fontWeight: 700 }}>{sinSobreUSA.length}</span>}
          </button>
          <button onClick={() => setUsaPendTab("camino")} style={{ flex: 1, padding: "7px 12px", borderRadius: 6, border: "none", background: usaPendTab === "camino" ? "#fff" : "transparent", boxShadow: usaPendTab === "camino" ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 11, fontWeight: usaPendTab === "camino" ? 700 : 500, fontFamily: "inherit", color: usaPendTab === "camino" ? "#7C3AED" : "#6B7280" }}>
            📨 Sobre en camino{sobreEnCamino.length > 0 && <span style={{ marginLeft: 5, background: "#7C3AED", color: "#fff", borderRadius: 8, padding: "1px 6px", fontSize: 9, fontWeight: 700 }}>{sobreEnCamino.length}</span>}
          </button>
        </div>

        {/* Pendientes: esperando sobre desde México */}
        {usaPendTab === "pendientes" && (
          <div>
            {sinSobreUSA.length === 0 ? (
              <div style={{ textAlign: "center", padding: 40, color: "#9CA3AF" }}><div style={{ fontSize: 32, marginBottom: 8 }}>✅</div><p style={{ fontSize: 12 }}>No hay pedidos esperando sobre.</p></div>
            ) : (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ fontSize: 10, color: "#9CA3AF", padding: "4px 8px", background: "#FEF3C7", borderRadius: 4, flex: 1, marginRight: 8 }}>⚠️ México no ha marcado el sobre como enviado. Solo puedes usar colchón.</div>
                  <Btn sz="sm" v="secondary" onClick={() => { const ns = { ...selSobres }; sinSobreUSA.forEach(f => ns[f.id] = true); setSelSobres(ns); }}>Seleccionar todos</Btn>
                </div>
                {sinSobreUSA.filter(usaMatch).map(renderItem)}
              </div>
            )}
          </div>
        )}

        {/* Sobres en camino desde México */}
        {usaPendTab === "camino" && (
          <div>
            {sobreEnCamino.length === 0 ? (
              <div style={{ textAlign: "center", padding: 40, color: "#9CA3AF" }}><div style={{ fontSize: 32, marginBottom: 8 }}>📭</div><p style={{ fontSize: 12 }}>No hay sobres en camino.</p></div>
            ) : (
              <div>
                <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
                  <Btn sz="sm" v="secondary" onClick={() => { const ns = { ...selSobres }; sobreEnCamino.forEach(f => ns[f.id] = true); setSelSobres(ns); }}>Seleccionar todos</Btn>
                </div>
                {sobreEnCamino.filter(usaMatch).map(renderItem)}
              </div>
            )}
          </div>
        )}

        {/* Sticky action bar */}
        {selCount > 0 && (
          <div style={{ position: "sticky", bottom: 16, padding: "12px 16px", background: "#1A2744", borderRadius: 10, color: "#fff", display: "flex", justifyContent: "space-between", alignItems: "center", boxShadow: "0 4px 16px rgba(0,0,0,.2)", marginTop: 16, flexWrap: "wrap", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{selCount} seleccionado{selCount > 1 ? "s" : ""}</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Btn v="secondary" sz="sm" onClick={() => setSelSobres({})}>Deseleccionar</Btn>
              {selConSobre && <Btn onClick={marcarDineroUSA} style={{ background: "#059669" }}>💵 Sobre recibido</Btn>}
              <Btn onClick={marcarColchon} disabled={colchonSaldo <= 0} style={{ background: colchonSaldo <= 0 ? "#9CA3AF" : "#D97706" }} title={colchonSaldo <= 0 ? "Sin fondos en colchón" : `Colchón: ${fmt(colchonSaldo)}`}>🛡️ Colchón{colchonSaldo > 0 ? ` (${fmt(colchonSaldo)})` : ""}</Btn>
              <Btn onClick={() => {
                const ids = Object.keys(selSobres).filter(k => selSobres[k]);
                if (!ids.length) return;
                let nd = { ...data };
                ids.forEach(fId => {
                  nd = { ...nd, fantasmas: nd.fantasmas.map(f => f.id !== fId ? f : {
                    ...f,
                    estado: "PEDIDO",
                    dineroStatus: "SIN_FONDOS",
                    choferAsignado: null,
                    usaColchon: false,
                    fechaActualizacion: today(),
                    historial: [...(f.historial || []), { fecha: today(), accion: "↩ Sobre retornado a TJ — pedido cancelado", quien: role }]
                  }) };
                });
                persist(nd);
                setSelSobres({});
              }} style={{ background: "#DC2626" }}>↩ Retornar a PEDIDOS</Btn>
            </div>
          </div>
        )}
      </div>
      );
    };

    // ColchonTab - full colchon management
    const ColchonTab = () => {
      const [colMov, setColMov] = useState({ tipo: "Entrada", concepto: "", monto: "", pedidoId: "", pedSearch: "" });
      const c = data.colchon || { montoOriginal: 0, saldoActual: 0, movimientos: [] };
      const pct = c.montoOriginal > 0 ? Math.round(c.saldoActual / c.montoOriginal * 100) : 0;
      const pc = pct > 50 ? "#059669" : pct > 20 ? "#D97706" : "#DC2626";

      const agregarMovColchon = () => {
        const monto = parseFloat(colMov.monto) || 0;
        if (!colMov.concepto || monto <= 0) return;
        const d = colMov.tipo === "Entrada" ? monto : -monto;
        const mov = { id: Date.now(), tipo: colMov.tipo, concepto: colMov.concepto, monto, fecha: today(), pedidoId: colMov.pedidoId || null };
        const nd = { ...data, colchon: { ...c, saldoActual: (c.saldoActual || 0) + d, movimientos: [...(c.movimientos || []), mov] } };
        // If using for a fantasma, update the pedido
        if (colMov.tipo === "Salida" && colMov.pedidoId) {
          nd.fantasmas = nd.fantasmas.map(f => f.id !== colMov.pedidoId ? f : { ...f, usaColchon: true, dineroStatus: "COLCHON_USADO", fechaActualizacion: today(), historial: [...(f.historial || []), { fecha: today(), accion: `🛡️ Colchón usado: ${fmt(monto)}`, quien: role }] });
        }
        persist(nd);
        setColMov({ tipo: "Entrada", concepto: "", monto: "", pedidoId: "", pedSearch: "" });
      };

      const eliminarMovColchon = async (movId) => {
                const mov = (c.movimientos || []).find(m => m.id === movId);
        if (!mov) return;
        if (!await showConfirm(`¿Eliminar movimiento del colchón?\n\n${mov.concepto || "?"} — ${fmt(mov.monto || 0)}`)) return;
        const d = mov.tipo === "Entrada" ? -mov.monto : mov.monto;
        persist({ ...data, colchon: { ...c, saldoActual: (c.saldoActual || 0) + d, movimientos: (c.movimientos || []).filter(m => m.id !== movId) } });
      };

      return (
        <div>
          {/* Saldo */}
          <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 160px", background: "#FEF3C7", borderRadius: 10, padding: "16px 20px", border: "2px solid #FDE68A", textAlign: "center" }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "#92400E", textTransform: "uppercase" }}>🛡️ Saldo Colchón</div>
              <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "monospace", color: pc }}>{fmt(c.saldoActual)}</div>
              <div style={{ fontSize: 11, color: "#9CA3AF" }}>de {fmt(c.montoOriginal)}</div>
              <div style={{ width: "100%", height: 6, background: "#E5E7EB", borderRadius: 3, marginTop: 6, overflow: "hidden" }}><div style={{ width: `${Math.min(pct, 100)}%`, height: "100%", background: pc, borderRadius: 3 }} /></div>
              <div style={{ fontSize: 11, fontWeight: 600, color: pc, marginTop: 3 }}>{pct}%{pct < 30 && " ⚠️ BAJO"}</div>
            </div>
            <div style={{ flex: "1 1 160px", background: "#fff", borderRadius: 10, padding: "16px 20px", border: "1px solid #E5E7EB" }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "#6B7280", textTransform: "uppercase", marginBottom: 6 }}>Monto original</div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <Inp type="number" value={c.montoOriginal || ""} onChange={e => updColchon({ montoOriginal: parseFloat(e.target.value) || 0 })} style={{ width: 120, fontSize: 14, fontWeight: 700 }} />
                <span style={{ fontSize: 10, color: "#9CA3AF" }}>USD</span>
              </div>
            </div>
          </div>

          {/* Nuevo movimiento */}
          <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E5E7EB", padding: 16, marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Nuevo movimiento</div>
            <div style={{ display: "flex", gap: 3, marginBottom: 10 }}>
              <button onClick={() => setColMov({ ...colMov, tipo: "Entrada", pedidoId: "", pedSearch: "" })} style={{ flex: 1, padding: "8px 12px", borderRadius: 6, border: colMov.tipo === "Entrada" ? "2px solid #059669" : "1px solid #D1D5DB", background: colMov.tipo === "Entrada" ? "#ECFDF5" : "#fff", color: colMov.tipo === "Entrada" ? "#065F46" : "#6B7280", fontWeight: colMov.tipo === "Entrada" ? 700 : 500, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>💰 Reposición</button>
              <button onClick={() => setColMov({ ...colMov, tipo: "Salida" })} style={{ flex: 1, padding: "8px 12px", borderRadius: 6, border: colMov.tipo === "Salida" ? "2px solid #DC2626" : "1px solid #D1D5DB", background: colMov.tipo === "Salida" ? "#FEF2F2" : "#fff", color: colMov.tipo === "Salida" ? "#DC2626" : "#6B7280", fontWeight: colMov.tipo === "Salida" ? 700 : 500, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>👻 Usar para fantasma</button>
            </div>

            {/* Select pedido if Salida */}
            {colMov.tipo === "Salida" && (
              <div style={{ marginBottom: 8 }}>
                <Fld label="Seleccionar pedido">
                  <div style={{ position: "relative", marginBottom: 4 }}>
                    <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "#9CA3AF" }}><I.Search /></span>
                    <input value={colMov.pedSearch} onChange={e => setColMov({ ...colMov, pedSearch: e.target.value })} placeholder="Folio, cliente..." autoComplete="off" style={{ width: "100%", padding: "7px 10px", paddingLeft: 28, borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, outline: "none", boxSizing: "border-box", fontFamily: "inherit", background: "#FAFAFA" }} />
                  </div>
                </Fld>
                <div style={{ maxHeight: 140, overflow: "auto", border: "1px solid #E5E7EB", borderRadius: 8 }}>
                  {(() => {
                    let peds = data.fantasmas.filter(f => f.estado === "PEDIDO" && (!f.dineroStatus || f.dineroStatus === "SIN_FONDOS"));
                    if (colMov.pedSearch) { const s = colMov.pedSearch.toLowerCase(); peds = peds.filter(f => f.cliente.toLowerCase().includes(s) || f.id.toLowerCase().includes(s) || f.descripcion.toLowerCase().includes(s)); }
                    if (peds.length === 0) return <div style={{ padding: 12, textAlign: "center", color: "#9CA3AF", fontSize: 11 }}>No hay pedidos sin fondos</div>;
                    return peds.map(f => {
                      const sel = colMov.pedidoId === f.id;
                      return (
                        <div key={f.id} onClick={() => setColMov({ ...colMov, pedidoId: f.id, concepto: `COLCHÓN → ${f.id} ${f.cliente}`, monto: String(f.costoMercancia), pedSearch: "" })} style={{ padding: "6px 10px", cursor: "pointer", background: sel ? "#FEF3C7" : "#fff", borderBottom: "1px solid #F3F4F6", borderLeft: sel ? "3px solid #D97706" : "3px solid transparent" }} onMouseEnter={e => { if (!sel) e.currentTarget.style.background = "#FAFBFC"; }} onMouseLeave={e => { if (!sel) e.currentTarget.style.background = "#fff"; }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                            <span style={{ fontSize: 9, fontFamily: "monospace", fontWeight: 700, color: "#9CA3AF" }}>{f.id}</span>
                            <strong style={{ fontSize: 11 }}>{f.cliente}</strong>
                            {sel && <span style={{ fontSize: 8, background: "#D97706", color: "#fff", padding: "1px 5px", borderRadius: 3 }}>✓</span>}
                            <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 600, color: "#DC2626" }}>{fmt(f.costoMercancia)}</span>
                          </div>
                          <div style={{ fontSize: 10, color: "#6B7280" }}>{f.descripcion}</div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <Fld label="Concepto"><Inp value={colMov.concepto} onChange={e => setColMov({ ...colMov, concepto: e.target.value.toUpperCase() })} placeholder="REPOSICIÓN, FANTASMA..." style={{ textTransform: "uppercase" }} /></Fld>
              <Fld label="Monto USD"><Inp type="number" value={colMov.monto} onChange={e => setColMov({ ...colMov, monto: e.target.value })} placeholder="0.00" /></Fld>
            </div>
            {colMov.tipo === "Salida" && (parseFloat(colMov.monto) || 0) > c.saldoActual && <div style={{ fontSize: 11, color: "#DC2626", marginBottom: 6 }}>⚠️ Monto mayor al saldo disponible ({fmt(c.saldoActual)})</div>}
            {colMov.tipo === "Salida" && c.saldoActual <= 0 && <div style={{ fontSize: 11, color: "#DC2626", marginBottom: 6, fontWeight: 600 }}>⚠️ El colchón está en $0.00 — no hay fondos</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
              <Btn disabled={!colMov.concepto || !colMov.monto || (colMov.tipo === "Salida" && c.saldoActual <= 0)} onClick={agregarMovColchon} style={{ background: colMov.tipo === "Entrada" ? "#059669" : c.saldoActual <= 0 ? "#9CA3AF" : "#DC2626" }}>{colMov.tipo === "Entrada" ? "💰 Reponer" : "👻 Usar colchón"}</Btn>
            </div>
          </div>

          {/* Historial */}
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Historial de movimientos</div>
          {(c.movimientos || []).length === 0 ? <p style={{ color: "#9CA3AF", fontSize: 11, textAlign: "center" }}>Sin movimientos.</p> : (
            <div style={{ maxHeight: 300, overflow: "auto" }}>
              {[...(c.movimientos || [])].reverse().map(m => {
                const isEnt = m.tipo === "Entrada";
                const pf = m.pedidoId ? data.fantasmas.find(x => x.id === m.pedidoId) : null;
                return (
                  <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "#fff", borderRadius: 6, border: "1px solid #E5E7EB", borderLeft: `3px solid ${isEnt ? "#059669" : "#DC2626"}`, marginBottom: 4, fontSize: 11 }}>
                    <span style={{ color: "#9CA3AF", fontSize: 9, minWidth: 50 }}>{fmtD(m.fecha)}</span>
                    <span style={{ fontSize: 9, background: isEnt ? "#D1FAE5" : "#FEE2E2", color: isEnt ? "#065F46" : "#991B1B", padding: "1px 6px", borderRadius: 3, fontWeight: 600 }}>{isEnt ? "REPOSICIÓN" : "USO"}</span>
                    <strong style={{ flex: 1 }}>{m.concepto}</strong>
                    {pf && <span style={{ fontSize: 9, color: "#6B7280" }}>{pf.cliente}</span>}
                    <span style={{ fontFamily: "monospace", fontWeight: 700, color: isEnt ? "#059669" : "#DC2626" }}>{isEnt ? "+" : "-"}{fmt(m.monto)}</span>
                    <button onClick={() => eliminarMovColchon(m.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#D1D5DB", padding: 2 }} onMouseEnter={e => e.currentTarget.style.color = "#DC2626"} onMouseLeave={e => e.currentTarget.style.color = "#D1D5DB"}><I.Trash /></button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    };

    // FlujoEfectivoUSA
    const FlujoEfectivoUSA = () => {
      const showGastoUSA = showGastoUSAApp; const setShowGastoUSA = setShowGastoUSAApp;
    const [gastoUSAForm, setGastoUSAForm] = usePersistedForm("gastoUSAForm", { concepto: "", monto: "", categoria: "OPERACIÓN", fecha: today(), nota: "", tipoMov: "gasto", moneda: "USD", tipoCambio: "" });

      const CATEGORIAS_USA = ["OPERACIÓN", "GASOLINA", "COMIDA", "RENTA", "LUZ/AGUA", "MANTENIMIENTO", "SUELDOS", "MATERIALES", "PROVEEDOR", "OTRO"];

      const allGastosUSA = filterByDate(data.gastosUSA || [], "fecha");
      const eliminarGastoUSA = async (gId) => { const g = (data.gastosUSA || []).find(x => x.id === gId); if (!g) return; if (!await showConfirm(`¿Eliminar movimiento?\n\n${g.concepto || "?"} — ${fmt(g.monto || 0)}\n\nEsto puede afectar pedidos vinculados.`)) return; const ref = g?.cambioRef; persist({ ...data, gastosUSA: (data.gastosUSA || []).filter(x => x.id !== gId && x.id !== ref) }); };

      // Saldos separados USD/MXN (con arrastre)
      const prevUSA = calcSaldoAnterior(data.gastosUSA || [], "fecha");
      const uMovsUSA = allGastosUSA.filter(g => g.moneda !== "MXN");
      const mMovsUSA = allGastosUSA.filter(g => g.moneda === "MXN");
      const ingUSD = uMovsUSA.filter(g => g.tipoMov === "ingreso").reduce((s, g) => s + (g.monto || 0), 0);
      const gasUSD = uMovsUSA.filter(g => g.tipoMov !== "ingreso").reduce((s, g) => s + (g.monto || 0), 0);
      const saldoUSD = prevUSA.usd + ingUSD - gasUSD;
      const ingMXN = mMovsUSA.filter(g => g.tipoMov === "ingreso").reduce((s, g) => s + (g.monto || g.montoOriginal || 0), 0);
      const gasMXN = mMovsUSA.filter(g => g.tipoMov !== "ingreso").reduce((s, g) => s + (g.monto || g.montoOriginal || 0), 0);
      const saldoMXN = prevUSA.mxn + ingMXN - gasMXN;
      const fmtMXN = (n) => "$" + (n||0).toLocaleString("en-US", { minimumFractionDigits: 2 }) + " MXN";

      return (
        <div>
          <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 180px", background: "#EFF6FF", borderRadius: 10, padding: "16px 20px", border: "2px solid #BFDBFE" }}>
              <div style={{ fontSize: 9, fontWeight: 600, color: "#1E40AF", textTransform: "uppercase" }}>🇺🇸 Caja USD</div>
              <div style={{ fontSize: 26, fontWeight: 700, fontFamily: "monospace", color: saldoUSD >= 0 ? "#1A2744" : "#DC2626" }}>{fmt(saldoUSD)}</div>
              <div style={{ fontSize: 9, color: "#6B7280" }}>+{fmt(ingUSD)} / -{fmt(gasUSD)}</div>
            </div>
            <div style={{ flex: "1 1 180px", background: "#FEF3C7", borderRadius: 10, padding: "16px 20px", border: "2px solid #FDE68A" }}>
              <div style={{ fontSize: 9, fontWeight: 600, color: "#92400E", textTransform: "uppercase" }}>🇲🇽 Caja MXN</div>
              <div style={{ fontSize: 26, fontWeight: 700, fontFamily: "monospace", color: saldoMXN >= 0 ? "#92400E" : "#DC2626" }}>{fmtMXN(saldoMXN)}</div>
              <div style={{ fontSize: 9, color: "#6B7280" }}>+{fmtMXN(ingMXN)} / -{fmtMXN(gasMXN)}</div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <Btn onClick={() => { setGastoUSAForm({ concepto: "", monto: "", categoria: "GASTOS USA", fecha: today(), nota: "", tipoMov: "ingreso", moneda: "USD", tipoCambio: "", pedidoId: "", pedSearch: "" }); setShowGastoUSA(true); }} style={{ background: "#059669" }}><I.Plus /> Ingreso</Btn>
            <Btn onClick={() => { setGastoUSAForm({ concepto: "", monto: "", categoria: "OPERACIÓN", fecha: today(), nota: "", tipoMov: "gasto", moneda: "USD", tipoCambio: "" }); setShowGastoUSA(true); }}><I.Plus /> Gasto</Btn>
            <Btn onClick={() => { setGastoUSAForm({ concepto: "", monto: "", categoria: "ENVÍO", fecha: today(), nota: "", tipoMov: "envio", destino: "ADMIN", moneda: "USD", tipoCambio: "" }); setShowGastoUSA(true); }} style={{ background: "#2563EB" }}>📤 Enviar</Btn>
            <Btn onClick={() => { setGastoUSAForm({ concepto: "", monto: "", categoria: "CAMBIO", fecha: today(), nota: "", tipoMov: "cambio", moneda: "USD", tipoCambio: "" }); setShowGastoUSA(true); }} style={{ background: "#7C3AED" }}>💱 Cambio</Btn>
          </div>

          {allGastosUSA.length === 0 ? <p style={{ color: "#9CA3AF", fontSize: 11, textAlign: "center", padding: 30 }}>No hay movimientos registrados.</p> : (
            <div style={{ maxHeight: 400, overflow: "auto" }}>
              {[...allGastosUSA].sort((a, b) => new Date(b.fecha) - new Date(a.fecha) || b.id - a.id).map(g => {
                const isIng = g.tipoMov === "ingreso";
                return (
                  <div key={g.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "#fff", borderRadius: 6, border: "1px solid #E5E7EB", borderLeft: `3px solid ${isIng ? "#059669" : "#DC2626"}`, marginBottom: 4, fontSize: 11 }}>
                    <span style={{ color: "#9CA3AF", fontSize: 9, minWidth: 50 }}>{fmtD(g.fecha)}</span>
                    <span style={{ fontSize: 9, background: isIng ? "#D1FAE5" : "#F3F4F6", color: isIng ? "#065F46" : "#6B7280", padding: "1px 6px", borderRadius: 3, fontWeight: 600 }}>{isIng ? "INGRESO" : g.categoria}</span>
                    <strong style={{ flex: 1 }}>{g.concepto}</strong>
                    {g.nota && <span style={{ color: "#9CA3AF", fontSize: 10 }}>{g.nota}</span>}
                    <span style={{ fontFamily: "monospace", fontWeight: 700, color: isIng ? "#059669" : "#DC2626" }}>{isIng ? "+" : "-"}{fmt(g.monto)}</span>
                    {g.moneda === "MXN" && <span style={{ fontSize: 8, background: "#FEF3C7", color: "#92400E", padding: "1px 4px", borderRadius: 3, fontWeight: 600 }}>🇲🇽 {fmt(g.montoOriginal)} MXN @{g.tipoCambio}</span>}
                    <button onClick={() => eliminarGastoUSA(g.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#D1D5DB", padding: 2 }} onMouseEnter={e => e.currentTarget.style.color = "#DC2626"} onMouseLeave={e => e.currentTarget.style.color = "#D1D5DB"}><I.Trash /></button>
                  </div>
                );
              })}
              {periodoTipo !== "global" && (prevUSA.usd !== 0 || prevUSA.mxn !== 0) && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "#F9FAFB", borderRadius: 6, border: "2px dashed #D1D5DB", marginBottom: 4, fontSize: 11 }}>
                  <span style={{ fontSize: 14 }}>📋</span>
                  <strong style={{ flex: 1, color: "#6B7280" }}>Saldo anterior</strong>
                  {prevUSA.usd !== 0 && <span style={{ fontFamily: "monospace", fontWeight: 700, color: prevUSA.usd >= 0 ? "#059669" : "#DC2626" }}>{fmt(prevUSA.usd)}</span>}
                  {prevUSA.mxn !== 0 && <span style={{ fontFamily: "monospace", fontWeight: 700, color: prevUSA.mxn >= 0 ? "#D97706" : "#DC2626" }}>${(prevUSA.mxn).toLocaleString("en-US", {minimumFractionDigits:2})} MXN</span>}
                </div>
              )}
            </div>
          )}

          {showGastoUSA && (
            <Modal title={gastoUSAForm.tipoMov === "ingreso" ? "💰 Registrar ingreso" : gastoUSAForm.tipoMov === "envio" ? "📤 Enviar dinero" : gastoUSAForm.tipoMov === "cambio" ? "💱 Cambio de moneda" : "🏢 Registrar gasto"} onClose={() => { setShowGastoUSA(false) }} w={500}>
              {/* Cambio de moneda */}
              {gastoUSAForm.tipoMov === "cambio" && (
                <div>
                  <Fld label="Dirección del cambio">
                    <div style={{ display: "flex", gap: 3 }}>
                      <button onClick={() => setGastoUSAForm({ ...gastoUSAForm, moneda: "USD" })} style={{ flex: 1, padding: "10px 12px", borderRadius: 8, border: gastoUSAForm.moneda === "USD" ? "2px solid #2563EB" : "1px solid #D1D5DB", background: gastoUSAForm.moneda === "USD" ? "#EFF6FF" : "#fff", cursor: "pointer", textAlign: "center" }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: gastoUSAForm.moneda === "USD" ? "#1E40AF" : "#6B7280" }}>🇺🇸 → 🇲🇽</div>
                        <div style={{ fontSize: 10, color: "#9CA3AF" }}>Dólares a pesos</div>
                      </button>
                      <button onClick={() => setGastoUSAForm({ ...gastoUSAForm, moneda: "MXN" })} style={{ flex: 1, padding: "10px 12px", borderRadius: 8, border: gastoUSAForm.moneda === "MXN" ? "2px solid #D97706" : "1px solid #D1D5DB", background: gastoUSAForm.moneda === "MXN" ? "#FEF3C7" : "#fff", cursor: "pointer", textAlign: "center" }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: gastoUSAForm.moneda === "MXN" ? "#92400E" : "#6B7280" }}>🇲🇽 → 🇺🇸</div>
                        <div style={{ fontSize: 10, color: "#9CA3AF" }}>Pesos a dólares</div>
                      </button>
                    </div>
                  </Fld>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Fld label={gastoUSAForm.moneda === "USD" ? "Entrego USD" : "Entrego MXN"}><Inp type="number" value={gastoUSAForm.monto} onChange={e => setGastoUSAForm({ ...gastoUSAForm, monto: e.target.value })} placeholder="0.00" /></Fld>
                    <Fld label="Tipo de cambio"><Inp type="number" value={gastoUSAForm.tipoCambio || ""} onChange={e => setGastoUSAForm({ ...gastoUSAForm, tipoCambio: e.target.value })} placeholder="17.50" /></Fld>
                  </div>
                  {gastoUSAForm.monto && gastoUSAForm.tipoCambio && parseFloat(gastoUSAForm.tipoCambio) > 0 && (
                    <div style={{ background: "#ECFDF5", borderRadius: 8, padding: "10px 14px", border: "1px solid #A7F3D0", marginBottom: 8, textAlign: "center" }}>
                      <div style={{ fontSize: 11, color: "#6B7280" }}>Recibo:</div>
                      <div style={{ fontSize: 20, fontWeight: 700, color: "#059669" }}>{gastoUSAForm.moneda === "USD" ? "$" + (parseFloat(gastoUSAForm.monto) * parseFloat(gastoUSAForm.tipoCambio)).toLocaleString("en-US", {minimumFractionDigits: 2}) + " MXN" : fmt(parseFloat(gastoUSAForm.monto) / parseFloat(gastoUSAForm.tipoCambio))}</div>
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8 }}><Fld label="Fecha"><Inp type="date" value={gastoUSAForm.fecha} onChange={e => setGastoUSAForm({ ...gastoUSAForm, fecha: e.target.value })} /></Fld></div>
                  <Fld label="Nota (opcional)"><Inp value={gastoUSAForm.nota} onChange={e => setGastoUSAForm({ ...gastoUSAForm, nota: e.target.value })} placeholder="Casa de cambio, lugar..." /></Fld>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5E7EB" }}>
                    <Btn v="secondary" onClick={() => { setShowGastoUSA(false) }}>Cancelar</Btn>
                    <Btn disabled={!(parseFloat(gastoUSAForm.monto) > 0) || !(parseFloat(gastoUSAForm.tipoCambio) > 0)} onClick={() => {
                      const mo = parseFloat(gastoUSAForm.monto);
                      const tc = parseFloat(gastoUSAForm.tipoCambio);
                      const esUSDaMXN = gastoUSAForm.moneda === "USD";
                      const montoOrigen = mo;
                      const montoDestino = esUSDaMXN ? Math.round(mo * tc * 100) / 100 : Math.round(mo / tc * 100) / 100;
                      const cambioId = Date.now();
                      const egreso = { id: cambioId, concepto: `CAMBIO ${esUSDaMXN ? "USD→MXN" : "MXN→USD"} @${tc}`, monto: montoOrigen, moneda: esUSDaMXN ? "USD" : "MXN", categoria: "CAMBIO", fecha: gastoUSAForm.fecha, nota: gastoUSAForm.nota, tipoMov: "gasto", cambioRef: cambioId + 1 };
                      const ingreso = { id: cambioId + 1, concepto: `CAMBIO ${esUSDaMXN ? "USD→MXN" : "MXN→USD"} @${tc}`, monto: montoDestino, moneda: esUSDaMXN ? "MXN" : "USD", categoria: "CAMBIO", fecha: gastoUSAForm.fecha, nota: gastoUSAForm.nota, tipoMov: "ingreso", cambioRef: cambioId };
                      persist({ ...data, gastosUSA: [...(data.gastosUSA || []), egreso, ingreso] });
                      setShowGastoUSA(false);
                    }} style={{ background: "#7C3AED" }}>💱 Registrar cambio</Btn>
                  </div>
                </div>
              )}
              {/* Destination for envio */}
              {gastoUSAForm.tipoMov === "envio" && (
                <Fld label="Destino">
                  <div style={{ display: "flex", gap: 3 }}>
                    <button onClick={() => setGastoUSAForm({ ...gastoUSAForm, destino: "ADMIN" })} style={{ flex: 1, padding: "8px 12px", borderRadius: 6, border: gastoUSAForm.destino === "ADMIN" ? "2px solid #1A2744" : "1px solid #D1D5DB", background: gastoUSAForm.destino === "ADMIN" ? "#EFF6FF" : "#fff", color: gastoUSAForm.destino === "ADMIN" ? "#1A2744" : "#6B7280", fontWeight: gastoUSAForm.destino === "ADMIN" ? 700 : 500, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>💼 Admin</button>
                    <button onClick={() => setGastoUSAForm({ ...gastoUSAForm, destino: "BODEGA_TJ" })} style={{ flex: 1, padding: "8px 12px", borderRadius: 6, border: gastoUSAForm.destino === "BODEGA_TJ" ? "2px solid #059669" : "1px solid #D1D5DB", background: gastoUSAForm.destino === "BODEGA_TJ" ? "#ECFDF5" : "#fff", color: gastoUSAForm.destino === "BODEGA_TJ" ? "#059669" : "#6B7280", fontWeight: gastoUSAForm.destino === "BODEGA_TJ" ? 700 : 500, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>🇲🇽 Bodega TJ</button>
                  </div>
                </Fld>
              )}
              {/* Categoría primero para ingresos */}
              {gastoUSAForm.tipoMov === "ingreso" && (
                <Fld label="Tipo de ingreso *">
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {["GASTOS USA", "FLETE", "FANTASMA", "OTRO"].map(c => (
                      <button key={c} onClick={() => setGastoUSAForm({ ...gastoUSAForm, categoria: c, pedidoId: "", concepto: c === "GASTOS USA" ? "" : c === "OTRO" ? "" : gastoUSAForm.concepto })} style={{ padding: "8px 16px", borderRadius: 8, border: gastoUSAForm.categoria === c ? "2px solid #1A2744" : "1px solid #D1D5DB", background: gastoUSAForm.categoria === c ? "#EFF6FF" : "#fff", color: gastoUSAForm.categoria === c ? "#1A2744" : "#6B7280", fontWeight: gastoUSAForm.categoria === c ? 700 : 500, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>{c === "FANTASMA" ? "👻 Fantasma" : c === "FLETE" ? "🚛 Flete" : c === "GASTOS USA" ? "💵 Gastos USA" : "📦 Otro"}</button>
                    ))}
                  </div>
                </Fld>
              )}

              {/* Pedido selection for FLETE or FANTASMA */}
              {gastoUSAForm.tipoMov === "ingreso" && (gastoUSAForm.categoria === "FLETE" || gastoUSAForm.categoria === "FANTASMA") && (
                <div style={{ marginBottom: 8 }}>
                  <Fld label={`Seleccionar pedido (${gastoUSAForm.categoria === "FANTASMA" ? "fantasma" : "flete"})`}>
                    <div style={{ position: "relative", marginBottom: 4 }}>
                      <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "#9CA3AF" }}><I.Search /></span>
                      <input value={gastoUSAForm.pedSearch || ""} onChange={e => setGastoUSAForm({ ...gastoUSAForm, pedSearch: e.target.value })} placeholder="Folio, cliente..." autoComplete="off" style={{ width: "100%", padding: "7px 10px", paddingLeft: 28, borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, outline: "none", boxSizing: "border-box", fontFamily: "inherit", background: "#FAFAFA" }} />
                    </div>
                  </Fld>
                  <div style={{ maxHeight: 160, overflow: "auto", border: "1px solid #E5E7EB", borderRadius: 8 }}>
                    {(() => {
                      const isMerc = gastoUSAForm.categoria === "FANTASMA";
                      let peds = data.fantasmas.filter(f => f.estado !== "CERRADO");
                      if (gastoUSAForm.pedSearch) { const s = (gastoUSAForm.pedSearch || "").toLowerCase(); peds = peds.filter(f => f.cliente.toLowerCase().includes(s) || f.id.toLowerCase().includes(s) || f.descripcion.toLowerCase().includes(s)); }
                      if (peds.length === 0) return <div style={{ padding: 12, textAlign: "center", color: "#9CA3AF", fontSize: 11 }}>No hay pedidos</div>;
                      return peds.slice(0, 20).map(f => {
                        const sel = gastoUSAForm.pedidoId === f.id;
                        return (
                          <div key={f.id} onClick={() => { const deuda = isMerc ? f.costoMercancia : (f.costoFlete || 0); setGastoUSAForm({ ...gastoUSAForm, pedidoId: f.id, concepto: `${isMerc ? "FANTASMA" : "FLETE"} ${f.id} - ${f.cliente}`, pedSearch: "" }); }} style={{ padding: "6px 10px", cursor: "pointer", background: sel ? "#EFF6FF" : "#fff", borderBottom: "1px solid #F3F4F6", borderLeft: sel ? "3px solid #2563EB" : "3px solid transparent" }} onMouseEnter={e => { if (!sel) e.currentTarget.style.background = "#FAFBFC"; }} onMouseLeave={e => { if (!sel) e.currentTarget.style.background = "#fff"; }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                              <span style={{ fontSize: 9, color: "#9CA3AF", fontFamily: "monospace", fontWeight: 700 }}>{f.id}</span>
                              <strong style={{ fontSize: 11 }}>{f.cliente}</strong>
                              {sel && <span style={{ fontSize: 8, background: "#2563EB", color: "#fff", padding: "1px 5px", borderRadius: 3 }}>✓</span>}
                              <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 600, color: isMerc ? "#DC2626" : "#2563EB" }}>{fmt(isMerc ? f.costoMercancia : (f.costoFlete || 0))}</span>
                            </div>
                            <div style={{ fontSize: 10, color: "#6B7280" }}>{f.descripcion}</div>
                          </div>
                        );
                      });
                    })()}
                  </div>
                </div>
              )}

              {gastoUSAForm.tipoMov !== "cambio" && <>
              <Fld label="Concepto *"><Inp value={gastoUSAForm.concepto} onChange={e => setGastoUSAForm({ ...gastoUSAForm, concepto: e.target.value.toUpperCase() })} placeholder={gastoUSAForm.tipoMov === "ingreso" ? "DESCRIPCIÓN..." : "DESCRIPCIÓN DEL GASTO"} style={{ textTransform: "uppercase" }} /></Fld>
              <Fld label="Moneda">
                <div style={{ display: "flex", gap: 3 }}>
                  <button onClick={() => setGastoUSAForm({ ...gastoUSAForm, moneda: "USD", tipoCambio: "" })} style={{ flex: 1, padding: "7px 12px", borderRadius: 6, border: (gastoUSAForm.moneda || "USD") === "USD" ? "2px solid #059669" : "1px solid #D1D5DB", background: (gastoUSAForm.moneda || "USD") === "USD" ? "#ECFDF5" : "#fff", color: (gastoUSAForm.moneda || "USD") === "USD" ? "#065F46" : "#6B7280", fontWeight: (gastoUSAForm.moneda || "USD") === "USD" ? 700 : 500, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>🇺🇸 USD</button>
                  <button onClick={() => setGastoUSAForm({ ...gastoUSAForm, moneda: "MXN" })} style={{ flex: 1, padding: "7px 12px", borderRadius: 6, border: gastoUSAForm.moneda === "MXN" ? "2px solid #D97706" : "1px solid #D1D5DB", background: gastoUSAForm.moneda === "MXN" ? "#FEF3C7" : "#fff", color: gastoUSAForm.moneda === "MXN" ? "#92400E" : "#6B7280", fontWeight: gastoUSAForm.moneda === "MXN" ? 700 : 500, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>🇲🇽 MXN</button>
                </div>
              </Fld>
              <div style={{ display: "flex", gap: 8 }}>
                <Fld label={`Monto en ${(gastoUSAForm.moneda || "USD") === "MXN" ? "pesos" : "dólares"} *`}><Inp type="number" value={gastoUSAForm.monto} onChange={e => setGastoUSAForm({ ...gastoUSAForm, monto: e.target.value })} placeholder="0.00" /></Fld>
                <Fld label="Fecha"><Inp type="date" value={gastoUSAForm.fecha} onChange={e => setGastoUSAForm({ ...gastoUSAForm, fecha: e.target.value })} /></Fld>
              </div>
              {gastoUSAForm.tipoMov !== "ingreso" && <Fld label="Categoría"><div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>{CATEGORIAS_USA.map(c => (<button key={c} onClick={() => setGastoUSAForm({ ...gastoUSAForm, categoria: c })} style={{ padding: "4px 10px", borderRadius: 5, border: gastoUSAForm.categoria === c ? "2px solid #1A2744" : "1px solid #D1D5DB", background: gastoUSAForm.categoria === c ? "#EFF6FF" : "#fff", color: gastoUSAForm.categoria === c ? "#1A2744" : "#6B7280", fontWeight: gastoUSAForm.categoria === c ? 700 : 500, fontSize: 10, cursor: "pointer", fontFamily: "inherit" }}>{c}</button>))}</div></Fld>}
              <Fld label="Nota (opcional)"><Inp value={gastoUSAForm.nota} onChange={e => setGastoUSAForm({ ...gastoUSAForm, nota: e.target.value })} placeholder="Detalle..." /></Fld>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5E7EB" }}>
                <Btn v="secondary" onClick={() => { setShowGastoUSA(false) }}>Cancelar</Btn>
                <Btn disabled={!gastoUSAForm.concepto || !gastoUSAForm.monto || (gastoUSAForm.moneda === "MXN" && !gastoUSAForm.tipoCambio)} onClick={() => {
                  const mo = parseFloat(gastoUSAForm.monto) || 0;
                  const esMXN = gastoUSAForm.moneda === "MXN";
                  const isEnvio = gastoUSAForm.tipoMov === "envio";
                  const g = { id: Date.now(), concepto: gastoUSAForm.concepto.toUpperCase(), monto: mo, moneda: esMXN ? "MXN" : "USD", categoria: gastoUSAForm.categoria, fecha: gastoUSAForm.fecha, nota: gastoUSAForm.nota, tipoMov: isEnvio ? "gasto" : (gastoUSAForm.tipoMov || "gasto"), pedidoId: gastoUSAForm.pedidoId || null, destino: isEnvio ? gastoUSAForm.destino : null };
                  let nd = { ...data, gastosUSA: [...(data.gastosUSA || []), g] };
                  if (isEnvio) {
                    const ingDest = { id: Date.now() + 1, concepto: `FONDO BODEGA USA: ${gastoUSAForm.concepto.toUpperCase()}`, monto: mo, moneda: esMXN ? "MXN" : "USD", categoria: "FONDO BODEGA USA", fecha: gastoUSAForm.fecha, nota: gastoUSAForm.nota, tipoMov: "ingreso" };
                    if (gastoUSAForm.destino === "ADMIN") { ingDest.destino = "ADMIN"; ingDest.origen = "BODEGA_USA"; nd.gastosAdmin = [...(nd.gastosAdmin || []), ingDest]; }
                    else { nd.gastosBodega = [...(nd.gastosBodega || []), ingDest]; }
                  }
                  persist(nd);
                  setShowGastoUSA(false);
                }} style={{ background: gastoUSAForm.tipoMov === "ingreso" ? "#059669" : gastoUSAForm.tipoMov === "envio" ? "#2563EB" : "#1A2744" }}>{gastoUSAForm.tipoMov === "ingreso" ? "💰 Registrar ingreso" : gastoUSAForm.tipoMov === "envio" ? "📤 Enviar" : "Registrar gasto"}</Btn>
              </div>
              </>}
            </Modal>
          )}
        </div>
      );
    };

    // Listo para chofer: DINERO_USA o COLCHON_USADO pero sin chofer asignado aún
    const listoParaChofer = data.fantasmas.filter(f =>
      f.estado === "PEDIDO" &&
      (f.dineroStatus === "DINERO_USA" || f.dineroStatus === "COLCHON_USADO" || f.dineroStatus === "NO_APLICA") &&
      !f.choferAsignado
    ).sort((a, b) => (b.urgente ? 1 : 0) - (a.urgente ? 1 : 0));

    const CHOFERES = ["Jorge Villanueva","Luis Arias","Aaron Enrique","Edgar Serrano","Neftali Ochoa","Daniel Ochoa","Jordy"];

    const AsignarChofer = () => {
      const [selPeds, setSelPeds] = useState({});
      const [choferSel, setChoferSel] = useState("");
      const selCount = Object.keys(selPeds).filter(k => selPeds[k]).length;

      const asignar = () => {
        if (!choferSel || selCount === 0) return;
        const ids = Object.keys(selPeds).filter(k => selPeds[k]);
        let nd = { ...data };
        ids.forEach(fId => {
          nd = { ...nd, fantasmas: nd.fantasmas.map(f => f.id !== fId ? f : {
            ...f, choferAsignado: choferSel, fechaActualizacion: today(),
            historial: [...(f.historial || []), { fecha: today(), accion: `🚗 Sobre asignado a ${choferSel}`, quien: role }]
          }) };
        });
        persist(nd); setSelPeds({}); setChoferSel(""); setTab("recoleccion");
      };

      const regresarAPendientesDesdeChofer = () => {
        const ids = Object.keys(selPeds).filter(k => selPeds[k]);
        if (ids.length === 0) return;
        let nd = { ...data };
        ids.forEach(fId => {
          nd = { ...nd, fantasmas: nd.fantasmas.map(f => f.id !== fId ? f : {
            ...f, dineroStatus: "SIN_FONDOS", usaColchon: false, fechaActualizacion: today(),
            historial: [...(f.historial || []), { fecha: today(), accion: "↩ Regresado a pendientes — se revirtió el dinero", quien: role }]
          }) };
        });
        persist(nd); setSelPeds({});
      };

      return (
        <div>
          <div style={{ marginBottom: 14 }}>
            <h2 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700 }}>🚗 Asignar Chofer</h2>
            <div style={{ fontSize: 11, color: "#6B7280" }}>Selecciona los sobres y asígnalos a un chofer — pasarán a Recolección</div>
          </div>
          {listoParaChofer.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40, color: "#9CA3AF" }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
              <p style={{ fontSize: 12 }}>No hay sobres listos para asignar.</p>
              <p style={{ fontSize: 11, color: "#D1D5DB" }}>Los sobres aparecen aquí cuando el dinero ya está en USA.</p>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 80 }}>
                {listoParaChofer.map(f => {
                  const sel = !!selPeds[f.id];
                  const dias = diasHabiles(f.fechaCreacion);
                  return (
                    <label key={f.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", background: sel ? "#EFF6FF" : f.urgente ? "#FFF5F5" : "#fff", borderRadius: 8, border: sel ? "2px solid #2563EB" : f.urgente ? "2px solid #FECACA" : "1px solid #E5E7EB", cursor: "pointer" }}>
                      <input type="checkbox" checked={sel} onChange={e => setSelPeds({ ...selPeds, [f.id]: e.target.checked })} style={{ width: 18, height: 18, accentColor: "#2563EB", flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", marginBottom: 2 }}>
                          <span style={{ fontSize: 9, color: "#9CA3AF", fontFamily: "monospace" }}>{f.id}</span>
                          {f.urgente && <span style={{ fontSize: 9, background: "#DC2626", color: "#fff", padding: "1px 6px", borderRadius: 3, fontWeight: 700 }}>🔥 URGENTE</span>}
                          <strong style={{ fontSize: 12 }}>{f.cliente}</strong>
                          <DBadge status={f.dineroStatus || "SIN_FONDOS"} />
                          <span style={{ fontSize: 9, background: dias >= 3 ? "#FEE2E2" : dias >= 2 ? "#FEF3C7" : "#F3F4F6", color: dias >= 3 ? "#DC2626" : dias >= 2 ? "#D97706" : "#6B7280", padding: "1px 6px", borderRadius: 3, fontWeight: 700 }}>🕐 {dias}d</span>
                        </div>
                        <div style={{ fontSize: 11, color: "#6B7280" }}>{f.descripcion}{f.proveedor ? ` · ${f.proveedor}` : ""}</div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "monospace" }}>{fmt(f.pedidoEspecial && f.costoReal != null ? f.costoReal : f.costoMercancia)}</div>
                        {f.costoFlete > 0 && <div style={{ fontSize: 9, color: "#6B7280" }}>Flete: {fmt(f.costoFlete)}</div>}
                      </div>
                    </label>
                  );
                })}
              </div>
              {/* Sticky action bar */}
              <div style={{ position: "sticky", bottom: 16, background: "#1A2744", borderRadius: 12, padding: "14px 16px", boxShadow: "0 4px 20px rgba(0,0,0,.25)" }}>
                <div style={{ fontSize: 10, color: "#94A3B8", fontWeight: 600, marginBottom: 8 }}>
                  {selCount > 0 ? `${selCount} sobre${selCount > 1 ? "s" : ""} seleccionado${selCount > 1 ? "s" : ""} — elige chofer:` : "Selecciona sobres arriba y elige un chofer:"}
                </div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 10 }}>
                  {CHOFERES.map(ch => (
                    <button key={ch} onClick={() => setChoferSel(ch)} style={{ padding: "7px 12px", borderRadius: 6, border: "none", background: choferSel === ch ? "#2563EB" : "rgba(255,255,255,.1)", color: choferSel === ch ? "#fff" : "#94A3B8", cursor: "pointer", fontSize: 12, fontWeight: choferSel === ch ? 700 : 400, fontFamily: "inherit", whiteSpace: "nowrap" }}>
                      {ch}
                    </button>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                  {selCount > 0 && <Btn v="secondary" sz="sm" onClick={() => setSelPeds({})}>Deseleccionar</Btn>}
                  {selCount > 0 && <Btn onClick={regresarAPendientesDesdeChofer} style={{ background: "#DC2626" }}>💵 ← A pendientes</Btn>}
                  <Btn disabled={!choferSel || selCount === 0} onClick={asignar} style={{ background: choferSel && selCount > 0 ? "#059669" : undefined }}>
                    🚗 Asignar{choferSel ? ` a ${choferSel}` : " chofer"}
                  </Btn>
                </div>
              </div>
            </>
          )}
        </div>
      );
    };

    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>🇺🇸 Bodega USA</h2>
          <div style={{ display: "flex", gap: 3, background: "#F3F4F6", borderRadius: 8, padding: 3, overflow: "auto" }}>
            {[
              { k: "pendientes",  l: "💵 Pendientes",      c: pendientes.length },
              { k: "chofer",      l: "🚗 Asignar Chofer",  c: listoParaChofer.length },
              { k: "recoleccion", l: "🛒 Recolección",     c: listoRecoleccion.length },
              { k: "recolectado", l: "📦 Recolectado",     c: recolectados.length },
            ].map(t => (
              <button key={t.k} onClick={() => setTab(t.k)} style={{ padding: "6px 10px", borderRadius: 6, border: "none", background: tab === t.k ? "#fff" : "transparent", boxShadow: tab === t.k ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 11, fontWeight: tab === t.k ? 700 : 500, fontFamily: "inherit", color: tab === t.k ? "#1A2744" : "#6B7280", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                {t.l}{t.c > 0 && <span style={{ background: tab === t.k ? "#1A2744" : "#D1D5DB", color: "#fff", fontSize: 9, padding: "1px 5px", borderRadius: 8, fontWeight: 700 }}>{t.c}</span>}
              </button>
            ))}
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            <button onClick={() => setTab("efectivo")} style={{ padding: "6px 14px", borderRadius: 8, border: tab === "efectivo" ? "2px solid #059669" : "1px solid #D1D5DB", background: tab === "efectivo" ? "#ECFDF5" : "#fff", cursor: "pointer", fontSize: 11, fontWeight: tab === "efectivo" ? 700 : 500, fontFamily: "inherit", color: tab === "efectivo" ? "#065F46" : "#6B7280", display: "flex", alignItems: "center", gap: 4 }}>💰 Efectivo</button>
            <button onClick={() => setTab("colchon")} style={{ padding: "6px 14px", borderRadius: 8, border: tab === "colchon" ? "2px solid #D97706" : "1px solid #D1D5DB", background: tab === "colchon" ? "#FEF3C7" : "#fff", cursor: "pointer", fontSize: 11, fontWeight: tab === "colchon" ? 700 : 500, fontFamily: "inherit", color: tab === "colchon" ? "#92400E" : "#6B7280", display: "flex", alignItems: "center", gap: 4 }}>🛡️ Colchón</button>
          </div>
        </div>
        {/* Search bar — visible in all tabs */}
        <div style={{ position: "relative", marginBottom: 12 }}>
          <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "#9CA3AF", pointerEvents: "none" }}>🔍</span>
          <input value={usaSearch} onChange={e => setUsaSearch(e.target.value)} placeholder="Buscar cliente, folio, mercancía..." style={{ width: "100%", padding: "8px 12px 8px 32px", borderRadius: 8, border: "1px solid #D1D5DB", fontSize: 11, fontFamily: "inherit", outline: "none", background: "#FAFAFA", boxSizing: "border-box" }} />
          {usaSearch && <button onClick={() => setUsaSearch("")} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#9CA3AF", fontSize: 14, lineHeight: 1 }}>✕</button>}
        </div>
        {tab === "pendientes" && <PendientesTab />}
        {tab === "chofer" && <AsignarChofer />}
        {tab === "recoleccion" && <Recoleccion />}
        {tab === "recolectado" && (
          <div>
            <div style={{ marginBottom: 12 }}>
              <h2 style={{ margin: "0 0 2px", fontSize: 16, fontWeight: 700 }}>📦 Recolectado</h2>
              <div style={{ fontSize: 11, color: "#6B7280" }}>{recolectados.length} pedido{recolectados.length !== 1 ? "s" : ""} en camino — pendientes de confirmar en Bodega TJ</div>
            </div>
            {recolectados.length === 0 ? (
              <div style={{ textAlign: "center", padding: 40, color: "#9CA3AF" }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>📭</div>
                <p style={{ fontSize: 12 }}>No hay pedidos recolectados aún.</p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {recolectados.filter(usaMatch).map(f => (
                  <div key={f.id} style={{ background: "#fff", borderRadius: 8, border: "1px solid #E0E7FF", padding: "10px 14px", display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 2 }}>
                        <span style={{ fontSize: 9, color: "#9CA3AF", fontFamily: "monospace" }}>{f.id}</span>
                        {f.urgente && <span style={{ fontSize: 9, background: "#DC2626", color: "#fff", padding: "1px 6px", borderRadius: 3, fontWeight: 700 }}>🔥 URGENTE</span>}
                        <strong style={{ fontSize: 12 }}>{f.cliente}</strong>
                      </div>
                      <div style={{ fontSize: 11, color: "#6B7280" }}>{f.descripcion}</div>
                      <div style={{ fontSize: 10, color: "#9CA3AF", marginTop: 2, display: "flex", gap: 8 }}>
                        {f.proveedor && <span>🏭 {f.proveedor}</span>}
                        <span>📦 {f.cantBultos || 1} {f.empaque || "bulto"}{(f.cantBultos || 1) > 1 ? "s" : ""}</span>
                        <span>🕐 {fmtD(f.fechaActualizacion)}</span>
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                      <Badge estado="RECOLECTADO" />
                      <button onClick={() => updF(f.id, { estado: "PEDIDO", historial: [...(f.historial || []), { fecha: today(), accion: "Regresado a Recolección", quien: role }] })} style={{ fontSize: 9, background: "#FEF3C7", border: "1px solid #FCD34D", color: "#92400E", padding: "2px 8px", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>← Regresar</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div style={{ display: tab === "efectivo" ? "block" : "none" }}><FlujoEfectivoUSA /></div>
        {tab === "colchon" && <ColchonTab />}
        {confirm && (() => { const cf = data.fantasmas.find(x => x.id === confirm); return cf ? (
          <Modal title="Eliminar pedido" onClose={() => setConfirm(null)} w={380}>
            <p style={{ margin: "0 0 8px", fontSize: 12 }}><strong>{cf.cliente}</strong> — {cf.descripcion} ({fmt(cf.costoMercancia)})</p>
            {(() => { const linked = []; if (cf.fletePagadoCxp) linked.push(`Abono flete a CxP: ${cf.fletePagadoCxp} (${fmt(cf.costoFlete)})`); if (cf.dineroStatus === "DINERO_CAMINO") linked.push("Sobre en camino a USA"); if (cf.usaColchon) linked.push("Uso de colchón"); if ((cf.movimientos||[]).length > 0) linked.push(`${cf.movimientos.length} pago(s)`); if (cf.comisionCobrada) linked.push(`Comisión (${fmt(cf.comisionMonto)})`); return linked.length > 0 ? <div style={{ background: "#FEF2F2", borderRadius: 6, padding: "8px 10px", marginBottom: 10, border: "1px solid #FECACA" }}><div style={{ fontSize: 10, fontWeight: 600, color: "#991B1B", marginBottom: 4 }}>⚠️ También se eliminará:</div>{linked.map((l,i) => <div key={i} style={{ fontSize: 10, color: "#DC2626" }}>• {l}</div>)}</div> : null; })()}
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <Btn v="secondary" onClick={() => setConfirm(null)}>Cancelar</Btn>
              <Btn v="danger" onClick={() => delF(cf.id)}>Sí, eliminar</Btn>
            </div>
          </Modal>
        ) : null; })()}
      </div>
    );
  };


  // ============ BODEGA TJ (wrapper with sub-tabs) ============
  const BodegaTJ = () => {
    const pagoTab = pagoTabApp; const setPagoTab = setPagoTabApp;
    const tab = tjTab; const setTab = setTjTab;
    const enviosPend = data.fantasmas.filter(f => f.estado === "RECOLECTADO").length;
    const enBodegaCount = data.fantasmas.filter(f => f.estado === "BODEGA_TJ").length;

    // Recibir envíos from USA
    const RecibirTJ = () => {
      const [selected, setSelected] = useState({});
      const porRecibir = data.fantasmas.filter(f => f.estado === "RECOLECTADO").sort((a, b) => (b.urgente ? 1 : 0) - (a.urgente ? 1 : 0));
      const selCount = Object.keys(selected).filter(k => selected[k]).length;

      const confirmarRecibido = () => {
        const ids = Object.keys(selected).filter(k => selected[k]);
        if (ids.length === 0) return;
        let nd = { ...data };
        ids.forEach(fId => {
          nd = { ...nd, fantasmas: nd.fantasmas.map(f => f.id !== fId ? f : {
            ...f, estado: "BODEGA_TJ", estadoRecepcion: "completo", fechaActualizacion: today(),
            historial: [...(f.historial || []), { fecha: today(), accion: "✅ Recibido en Bodega TJ", quien: role }]
          }) };
        });
        persist(nd);
        setSelected({});
      };

      const noRecibido = (fId) => {
        updF(fId, { estado: "PEDIDO", estadoRecepcion: "no_recibido" });
      };

      return (
        <div>
          <div style={{ marginBottom: 12 }}>
            <h2 style={{ margin: "0 0 2px", fontSize: 16, fontWeight: 700 }}>📥 Pedido Recibido</h2>
            <div style={{ fontSize: 11, color: "#6B7280" }}>{porRecibir.length} pedido{porRecibir.length !== 1 ? "s" : ""} recolectados — pendientes de confirmar recepción</div>
          </div>
          {porRecibir.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40, color: "#9CA3AF" }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>📭</div>
              <p style={{ fontSize: 12 }}>No hay pedidos pendientes de recibir.</p>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {porRecibir.map(f => (
                  <div key={f.id} style={{ background: selected[f.id] ? "#EFF6FF" : "#fff", borderRadius: 8, border: selected[f.id] ? "2px solid #93C5FD" : "2px solid #E0E7FF", padding: "10px 14px", display: "flex", alignItems: "center", gap: 10 }}>
                    <input type="checkbox" checked={!!selected[f.id]} onChange={e => setSelected({ ...selected, [f.id]: e.target.checked })} style={{ width: 16, height: 16, accentColor: "#6366F1", flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 2 }}>
                        <span style={{ fontSize: 9, color: "#9CA3AF", fontFamily: "monospace" }}>{f.id}</span>
                        {f.urgente && <span style={{ fontSize: 9, background: "#DC2626", color: "#fff", padding: "1px 6px", borderRadius: 3, fontWeight: 700 }}>🔥 URGENTE</span>}
                        <strong style={{ fontSize: 12 }}>{f.cliente}</strong>
                      </div>
                      <div style={{ fontSize: 11, color: "#6B7280" }}>{f.descripcion}</div>
                      <div style={{ fontSize: 10, color: "#9CA3AF", marginTop: 2, display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {f.proveedor && <span>🏭 {f.proveedor}</span>}
                        <span>📦 {f.cantBultos || 1} {f.empaque || "bulto"}{(f.cantBultos || 1) > 1 ? "s" : ""}</span>
                        <span>{fmt(f.costoMercancia)}</span>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                      <button onClick={() => { updF(f.id, { estado: "BODEGA_TJ", estadoRecepcion: "completo", fechaActualizacion: today() }); }} style={{ background: "#ECFDF5", border: "1px solid #A7F3D0", color: "#065F46", padding: "4px 10px", borderRadius: 5, cursor: "pointer", fontSize: 10, fontWeight: 700, fontFamily: "inherit" }}>✅ Recibido</button>
                      <button onClick={() => noRecibido(f.id)} style={{ background: "#FEE2E2", border: "1px solid #FECACA", color: "#991B1B", padding: "4px 10px", borderRadius: 5, cursor: "pointer", fontSize: 10, fontWeight: 700, fontFamily: "inherit" }}>❌ No llegó</button>
                    </div>
                  </div>
                ))}
              </div>
              {selCount > 0 && (
                <div style={{ position: "sticky", bottom: 16, marginTop: 12, padding: "12px 16px", background: "#1A2744", borderRadius: 10, color: "#fff", display: "flex", justifyContent: "space-between", alignItems: "center", boxShadow: "0 4px 16px rgba(0,0,0,.2)" }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{selCount} seleccionado{selCount > 1 ? "s" : ""}</span>
                  <div style={{ display: "flex", gap: 6 }}>
                    <Btn v="secondary" sz="sm" onClick={() => setSelected({})}>Deseleccionar</Btn>
                    <Btn onClick={confirmarRecibido} style={{ background: "#059669" }}>✅ Confirmar recibidos ({selCount})</Btn>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      );
    };


    // Entregados
    const EntregadosTJ = () => {
      const [selEnt, setSelEnt] = useState({});
      const enBodega = data.fantasmas.filter(f => f.estado === "BODEGA_TJ").sort((a, b) => (b.urgente ? 1 : 0) - (a.urgente ? 1 : 0) || new Date(b.fechaActualizacion) - new Date(a.fechaActualizacion));
      const entregados = data.fantasmas.filter(f => f.estado === "ENTREGADO").sort((a, b) => new Date(b.fechaActualizacion) - new Date(a.fechaActualizacion));
      const selCount = Object.keys(selEnt).filter(k => selEnt[k]).length;

      const marcarEntregados = () => {
        const ids = Object.keys(selEnt).filter(k => selEnt[k]);
        if (ids.length === 0) return;
        let nd = { ...data };
        ids.forEach(fId => {
          nd = { ...nd, fantasmas: nd.fantasmas.map(f => f.id !== fId ? f : {
            ...f, estado: "ENTREGADO", fechaEntrega: today(), fechaActualizacion: today(),
            historial: [...(f.historial || []), { fecha: today(), accion: "✅ Entregado al cliente", quien: role }]
          }) };
        });
        persist(nd);
        setSelEnt({});
      };

      return (
        <div>
          {/* En bodega - pendientes de entregar */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div>
                <h2 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>📦 En Bodega TJ — por entregar</h2>
                <div style={{ fontSize: 11, color: "#6B7280" }}>{enBodega.length} pedido{enBodega.length !== 1 ? "s" : ""} esperando entrega al cliente</div>
              </div>
              {enBodega.length > 0 && (
                <button onClick={() => { const ns = {}; enBodega.forEach(f => ns[f.id] = true); setSelEnt(ns); }} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, color: "#2563EB", fontFamily: "inherit", textDecoration: "underline" }}>Seleccionar todos</button>
              )}
            </div>

            {enBodega.length === 0 ? (
              <div style={{ textAlign: "center", padding: 32, color: "#9CA3AF" }}>
                <div style={{ fontSize: 28, marginBottom: 6 }}>📭</div>
                <p style={{ fontSize: 12 }}>No hay pedidos en bodega pendientes de entregar.</p>
              </div>
            ) : (
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {enBodega.map(f => {
                    const dias = diasHabiles(f.fechaActualizacion);
                    const sel = !!selEnt[f.id];
                    return (
                      <div key={f.id} style={{ background: sel ? "#EFF6FF" : f.urgente ? "#FFF5F5" : "#fff", borderRadius: 8, border: sel ? "2px solid #93C5FD" : f.urgente ? "2px solid #FECACA" : "1px solid #E5E7EB", padding: "10px 14px", display: "flex", alignItems: "center", gap: 10 }}>
                        <input type="checkbox" checked={sel} onChange={e => setSelEnt({ ...selEnt, [f.id]: e.target.checked })} style={{ width: 18, height: 18, accentColor: "#059669", flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => { setDetailMode("full"); navigate("detail", f.id, view); }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", marginBottom: 2 }}>
                            <span style={{ fontSize: 9, color: "#9CA3AF", fontFamily: "monospace" }}>{f.id}</span>
                            {f.urgente && <span style={{ fontSize: 9, background: "#DC2626", color: "#fff", padding: "1px 6px", borderRadius: 3, fontWeight: 700 }}>🔥 URGENTE</span>}
                            <strong style={{ fontSize: 12 }}>{f.cliente}</strong>
                            <span style={{ fontSize: 9, background: dias >= 3 ? "#FEE2E2" : dias >= 2 ? "#FEF3C7" : "#F3F4F6", color: dias >= 3 ? "#DC2626" : dias >= 2 ? "#D97706" : "#6B7280", padding: "1px 6px", borderRadius: 3, fontWeight: 700 }}>🕐 {dias}d</span>
                          </div>
                          <div style={{ fontSize: 11, color: "#6B7280" }}>{f.descripcion} · <span style={{ color: "#9CA3AF" }}>{f.empaque ? `${f.cantBultos || 1} ${f.empaque}` : ""}</span></div>
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "monospace" }}>{fmt(f.totalVenta || f.costoMercancia)}</div>
                          {f.clientePago ? <div style={{ fontSize: 9, color: "#059669", fontWeight: 700 }}>✓ Pagado</div> : <div style={{ fontSize: 9, color: "#DC2626" }}>Sin cobrar</div>}
                        </div>
                        <I.Right />
                      </div>
                    );
                  })}
                </div>

                {/* Sticky action bar */}
                {selCount > 0 && (
                  <div style={{ position: "sticky", bottom: 16, marginTop: 12, padding: "12px 16px", background: "#1A2744", borderRadius: 10, color: "#fff", display: "flex", justifyContent: "space-between", alignItems: "center", boxShadow: "0 4px 16px rgba(0,0,0,.2)" }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{selCount} seleccionado{selCount > 1 ? "s" : ""}</span>
                    <div style={{ display: "flex", gap: 6 }}>
                      <Btn v="secondary" sz="sm" onClick={() => setSelEnt({})}>Deseleccionar</Btn>
                      <Btn onClick={marcarEntregados} style={{ background: "#059669" }}>✅ Marcar entregado{selCount > 1 ? "s" : ""} ({selCount})</Btn>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Historial de entregados */}
          {entregados.length > 0 && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#059669", marginBottom: 8, paddingTop: 12, borderTop: "1px solid #E5E7EB" }}>
                ✅ Entregados al cliente ({entregados.length})
              </div>
              {entregados.map(f => {
                const pagado = f.clientePago && (f.fletePagado || (!f.costoFlete && !f.fleteDesconocido));
                const dias = !pagado ? diasHabiles(f.fechaEntrega || f.fechaActualizacion) : 0;
                const autoUrgente = !pagado && dias >= 3;
                if (autoUrgente && !f.urgente) updF(f.id, { urgente: true });
                return (
                  <div key={f.id} style={{ background: autoUrgente ? "#FFF5F5" : "#fff", borderRadius: 8, border: autoUrgente ? "2px solid #FECACA" : "1px solid #E5E7EB", padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, marginBottom: 4, cursor: "pointer" }} onClick={() => { setDetailMode("full"); navigate("detail", f.id, view); }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 9, color: "#9CA3AF", fontFamily: "monospace" }}>{f.id}</span>
                        {autoUrgente && <span style={{ fontSize: 9, background: "#DC2626", color: "#fff", padding: "1px 6px", borderRadius: 3, fontWeight: 700 }}>🔥 URGENTE</span>}
                        <strong style={{ fontSize: 12 }}>{f.cliente}</strong>
                        {!pagado && <span style={{ fontSize: 9, background: dias >= 3 ? "#FEE2E2" : dias >= 2 ? "#FEF3C7" : "#F3F4F6", color: dias >= 3 ? "#DC2626" : dias >= 2 ? "#D97706" : "#6B7280", padding: "1px 6px", borderRadius: 3, fontWeight: 700 }}>🕐 {dias}d sin cobrar</span>}
                      </div>
                      <div style={{ fontSize: 11, color: "#6B7280" }}>{f.descripcion}</div>
                    </div>
                    {pagado ? <span style={{ color: "#059669", fontWeight: 600, fontSize: 11, flexShrink: 0 }}>✓ Pagado</span> : <span style={{ color: "#DC2626", fontWeight: 600, fontSize: 11, flexShrink: 0 }}>Sin cobrar</span>}
                    <I.Right />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    };

    // Flujo de Efectivo
    // TransferenciasTJ


    const TransferenciasTJ = () => {
      const [tjTransSearch, setTjTransSearch] = useState("");
      const showTrans = showTransApp; const setShowTrans = setShowTransApp;
      const [editId, setEditId] = useState(null);
      const [tForm, setTForm] = usePersistedForm("tForm", { pedidoId: "", pedSearch: "", montoMXN: "", tipoCambio: "", montoUSD: "", moneda: "MXN", cuenta: "", fecha: today(), nota: "", tipo: "flete" });

      const CUENTAS = [
        { id: "scotiabank", banco: "SCOTIABANK", titular: "Cinthia Jazmin Ramos Leon", tarjeta: "5579 2091 5461 3159", clabe: "044028256059014716", color: "#DC2626", uso: "flete", tag: "🚛 FLETES" },
        { id: "banorte", banco: "BANORTE", titular: "Ismael Ochoa", tarjeta: "4189 1430 9762 5597", clabe: "072028013241127587", color: "#DC2626", uso: "flete", tag: "🚛 FLETES" },
        { id: "azteca_cinthia", banco: "BANCO AZTECA", titular: "Cinthia Jazmin Ramos Leon", tarjeta: "4027 6661 0513 0560", clabe: "1270 2801 3077 598361", color: "#2563EB", uso: "fantasma", tag: "👻 MERCANCÍA" },
        { id: "azteca_ismael", banco: "BANCO AZTECA", titular: "Ismael Ochoa Duran", tarjeta: "5343 8102 0981 8688", clabe: "1270 2800 1671 744594", color: "#2563EB", uso: "fantasma", tag: "👻 MERCANCÍA" },
      ];

      const transferencias = filterByDate(data.transferencias || [], "fecha");
      const totalMXN = transferencias.reduce((s, t) => s + (t.montoMXN || 0), 0);
      const totalUSD = transferencias.reduce((s, t) => s + (t.montoUSD || 0), 0);

      const registrarTrans = () => {
        const mxn = parseFloat(tForm.montoMXN) || 0;
        const usd = parseFloat(tForm.montoUSD) || 0;
        const tc = parseFloat(tForm.tipoCambio) || 0;
        const montoConvertido = tForm.moneda === "MXN" && tc > 0 ? Math.round(mxn / tc * 100) / 100 : usd;
        if (!tForm.pedidoId || (!mxn && !usd) || !tForm.cuenta) return;
        const cuenta = CUENTAS.find(c => c.id === tForm.cuenta);
        const pf = data.fantasmas.find(f => f.id === tForm.pedidoId);
        let nd = { ...data };

        // If editing, first revert old abono
        if (editId) {
          const old = (data.transferencias || []).find(t => t.id === editId);
          if (old && old.confirmada) {
            if (old.tipo === "flete") {
              nd.fantasmas = nd.fantasmas.map(f => f.id !== old.pedidoId ? f : { ...f, abonoFlete: Math.max(0, (f.abonoFlete || 0) - (old.montoUSD || 0)), fletePagado: Math.max(0, (f.abonoFlete || 0) - (old.montoUSD || 0)) >= (f.costoFlete || 0) });
            } else {
              nd.fantasmas = nd.fantasmas.map(f => f.id !== old.pedidoId ? f : { ...f, abonoMercancia: Math.max(0, (f.abonoMercancia || 0) - (old.montoUSD || 0)), clientePago: Math.max(0, (f.abonoMercancia || 0) - (old.montoUSD || 0)) >= f.costoMercancia });
            }
          }
          nd.transferencias = (nd.transferencias || []).map(t => t.id !== editId ? t : { ...t, pedidoId: tForm.pedidoId, tipo: tForm.tipo, montoMXN: mxn || null, montoUSD: usd || montoConvertido, tipoCambio: tc || null, moneda: tForm.moneda, cuentaId: tForm.cuenta, banco: cuenta?.banco || "", titular: cuenta?.titular || "", fecha: tForm.fecha, nota: tForm.nota, cliente: pf?.cliente || "", confirmada: false });
        } else {
          // Nueva transferencia: pendiente de confirmación — NO marca como pagado aún
          const t = { id: Date.now(), pedidoId: tForm.pedidoId, tipo: tForm.tipo, montoMXN: mxn || null, montoUSD: usd || montoConvertido, tipoCambio: tc || null, moneda: tForm.moneda, cuentaId: tForm.cuenta, banco: cuenta?.banco || "", titular: cuenta?.titular || "", fecha: tForm.fecha, nota: tForm.nota, cliente: pf?.cliente || "", confirmada: false };
          nd.transferencias = [...(nd.transferencias || []), t];
          // Mark pedido as TRANS_PENDIENTE — has funds coming, not paid yet
          nd.fantasmas = nd.fantasmas.map(f => f.id !== tForm.pedidoId ? f : {
            ...f,
            dineroStatus: "TRANS_PENDIENTE",
            transferenciaPendiente: true,
            fechaActualizacion: today(),
            historial: [...(f.historial || []), { fecha: tForm.fecha, accion: `🏦 Transferencia registrada (pendiente confirmación): ${tForm.moneda === "MXN" ? `$${mxn} MXN @${tc}` : `$${usd} USD`} → ${cuenta?.banco}`, quien: role }]
          });
        }
        persist(nd);
        setShowTrans(false);
        setEditId(null);
      };

      const eliminarTrans = async (tId) => {
        const tr = (data.transferencias || []).find(t => t.id === tId);
        if (!tr) return;
        if (!await showConfirm(`¿Eliminar transferencia?\n\n${tr.cliente || ""} — ${tr.tipo === "flete" ? "🚛 Flete" : "👻 Fantasma"} — ${tr.montoMXN ? `$${tr.montoMXN} MXN` : fmt(tr.montoUSD)}`)) return;
        let nd = { ...data, transferencias: (data.transferencias || []).filter(t => t.id !== tId) };
        // Revert pedido status
        nd.fantasmas = nd.fantasmas.map(f => {
          if (f.id !== tr.pedidoId) return f;
          if (tr.tipo === "flete") {
            const nuevoAbono = Math.max(0, (f.abonoFlete || 0) - (tr.montoUSD || 0));
            return { ...f, abonoFlete: nuevoAbono, fletePagado: nuevoAbono >= (f.costoFlete || 0) };
          } else {
            const nuevoAbono = Math.max(0, (f.abonoMercancia || 0) - (tr.montoUSD || 0));
            // Also revert TRANS_PENDIENTE status if no other pending transfers remain
            const otrasTrans = (nd.transferencias || []).filter(t => t.pedidoId === f.id && !t.confirmada && !t.noRecibida);
            const dineroStatus = otrasTrans.length === 0 && !nuevoAbono ? "SIN_FONDOS" : f.dineroStatus === "TRANS_PENDIENTE" && otrasTrans.length === 0 ? "SIN_FONDOS" : f.dineroStatus;
            return { ...f, abonoMercancia: nuevoAbono, clientePago: nuevoAbono >= f.costoMercancia, transferenciaPendiente: otrasTrans.length > 0, dineroStatus };
          }
        });
        persist(nd);
      };

      const fmtMXN = (n) => "$" + (n || 0).toLocaleString("en-US", { minimumFractionDigits: 2 });

      return (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#7C3AED" }}>🏦 Transferencias recibidas</div>
            <Btn onClick={() => { setEditId(null); setTForm({ pedidoId: "", pedSearch: "", montoMXN: "", tipoCambio: "", montoUSD: "", moneda: "MXN", cuenta: "", fecha: today(), nota: "", tipo: "flete" }); setShowTrans(true); }} style={{ background: "#7C3AED" }}><I.Plus /> Nueva transferencia</Btn>
          </div>

          {/* Summary */}
          <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 120px", background: "#F5F3FF", borderRadius: 8, padding: "10px 14px", border: "1px solid #E9D5FF" }}><div style={{ fontSize: 9, fontWeight: 600, color: "#7C3AED" }}>TOTAL MXN</div><div style={{ fontSize: 18, fontWeight: 700, fontFamily: "monospace", color: "#7C3AED" }}>{fmtMXN(totalMXN)}</div></div>
            <div style={{ flex: "1 1 120px", background: "#EFF6FF", borderRadius: 8, padding: "10px 14px", border: "1px solid #BFDBFE" }}><div style={{ fontSize: 9, fontWeight: 600, color: "#2563EB" }}>TOTAL USD (convertido)</div><div style={{ fontSize: 18, fontWeight: 700, fontFamily: "monospace", color: "#2563EB" }}>{fmt(totalUSD)}</div></div>
            <div style={{ flex: "1 1 120px", background: "#fff", borderRadius: 8, padding: "10px 14px", border: "1px solid #E5E7EB" }}><div style={{ fontSize: 9, fontWeight: 600, color: "#6B7280" }}>REGISTRADAS</div><div style={{ fontSize: 18, fontWeight: 700, color: "#374151" }}>{transferencias.length}</div></div>
          </div>

          {/* List */}
          <div style={{ position: "relative", marginBottom: 8 }}><span style={{ position: "absolute", left: 7, top: "50%", transform: "translateY(-50%)", color: "#9CA3AF" }}><I.Search /></span><input value={tjTransSearch} onChange={e => setTjTransSearch(e.target.value)} placeholder="Buscar folio, cliente, banco..." autoComplete="off" style={{ width: "100%", padding: "7px 10px", paddingLeft: 26, borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, outline: "none", boxSizing: "border-box", fontFamily: "inherit", background: "#FAFAFA" }} /></div>
          {(() => { const s = tjTransSearch.toLowerCase(); const tList = transferencias.filter(t => !s || (t.cliente || "").toLowerCase().includes(s) || (t.pedidoId || "").toLowerCase().includes(s) || (t.banco || "").toLowerCase().includes(s) || (t.nota || "").toLowerCase().includes(s)); return tList.length === 0 ? <p style={{ textAlign: "center", color: "#9CA3AF", fontSize: 11, padding: 30 }}>No hay transferencias{tjTransSearch ? ` con "${tjTransSearch}"` : ""}.</p> : (
            <div style={{ maxHeight: 400, overflow: "auto" }}>
              {[...tList].sort((a, b) => new Date(b.fecha) - new Date(a.fecha) || b.id - a.id).map(t => {
                const pf = data.fantasmas.find(f => f.id === t.pedidoId);
                return (
                  <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "#fff", borderRadius: 6, border: "1px solid #E5E7EB", borderLeft: `3px solid ${t.tipo === "flete" ? "#2563EB" : "#DC2626"}`, marginBottom: 4, fontSize: 11 }}>
                    <span style={{ color: "#9CA3AF", fontSize: 9, minWidth: 50 }}>{fmtD(t.fecha)}</span>
                    <span style={{ fontSize: 9, background: t.tipo === "flete" ? "#DBEAFE" : "#FEE2E2", color: t.tipo === "flete" ? "#1E40AF" : "#991B1B", padding: "1px 6px", borderRadius: 3, fontWeight: 600 }}>{t.tipo === "flete" ? "🚛 FLETE" : "👻 FANTASMA"}</span>
                    <span style={{ fontFamily: "monospace", fontSize: 9, color: "#9CA3AF" }}>{t.pedidoId}</span>
                    <strong>{t.cliente || pf?.cliente || "—"}</strong>
                    <span style={{ flex: 1, color: "#6B7280" }}>{pf?.descripcion || ""}</span>
                    <span style={{ fontSize: 9, background: "#F3F4F6", padding: "1px 5px", borderRadius: 3, color: "#6B7280" }}>{t.banco}</span>
                    {t.montoMXN > 0 && <span style={{ fontFamily: "monospace", fontWeight: 600, color: "#7C3AED" }}>{fmtMXN(t.montoMXN)} MXN</span>}
                    {t.tipoCambio > 0 && <span style={{ fontSize: 9, color: "#9CA3AF" }}>@{t.tipoCambio}</span>}
                    <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#059669" }}>{fmt(t.montoUSD)}</span>
                    {t.confirmada && <span style={{ fontSize: 8, background: "#D1FAE5", color: "#065F46", padding: "2px 6px", borderRadius: 4, fontWeight: 700 }}>✅ CONFIRMADA</span>}
                    {t.noRecibida && <span style={{ fontSize: 8, background: "#FEE2E2", color: "#991B1B", padding: "2px 6px", borderRadius: 4, fontWeight: 700 }}>❌ NO RECIBIDA</span>}
                    {!t.confirmada && !t.noRecibida && <button onClick={() => { setEditId(t.id); setTForm({ pedidoId: t.pedidoId, pedSearch: "", montoMXN: String(t.montoMXN || ""), tipoCambio: String(t.tipoCambio || ""), montoUSD: String(t.montoUSD || ""), moneda: t.moneda || "MXN", cuenta: t.cuentaId || "", fecha: t.fecha, nota: t.nota || "", tipo: t.tipo }); setShowTrans(true); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#D1D5DB", padding: 2 }} onMouseEnter={e => e.currentTarget.style.color = "#2563EB"} onMouseLeave={e => e.currentTarget.style.color = "#D1D5DB"}><I.Edit /></button>}
                    {!t.confirmada && <button onClick={() => eliminarTrans(t.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#D1D5DB", padding: 2 }} onMouseEnter={e => e.currentTarget.style.color = "#DC2626"} onMouseLeave={e => e.currentTarget.style.color = "#D1D5DB"}><I.Trash /></button>}
                  </div>
                );
              })}
            </div>
          ); })()}

          {/* Modal */}
          {showTrans && (
            <Modal title={editId ? "✏️ Editar transferencia" : "🏦 Registrar transferencia"} onClose={() => { setShowTrans(false); setEditId(null); }} w={520}>
              {/* Tipo */}
              <Fld label="Tipo de pago">
                <div style={{ display: "flex", gap: 3 }}>
                  <button onClick={() => setTForm({ ...tForm, tipo: "flete", cuenta: "" })} style={{ flex: 1, padding: "8px 12px", borderRadius: 6, border: tForm.tipo === "flete" ? "2px solid #2563EB" : "1px solid #D1D5DB", background: tForm.tipo === "flete" ? "#EFF6FF" : "#fff", color: tForm.tipo === "flete" ? "#2563EB" : "#6B7280", fontWeight: tForm.tipo === "flete" ? 700 : 500, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>🚛 Flete</button>
                  <button onClick={() => setTForm({ ...tForm, tipo: "fantasma", cuenta: "" })} style={{ flex: 1, padding: "8px 12px", borderRadius: 6, border: tForm.tipo === "fantasma" ? "2px solid #DC2626" : "1px solid #D1D5DB", background: tForm.tipo === "fantasma" ? "#FEF2F2" : "#fff", color: tForm.tipo === "fantasma" ? "#DC2626" : "#6B7280", fontWeight: tForm.tipo === "fantasma" ? 700 : 500, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>👻 Fantasma</button>
                </div>
              </Fld>

              {/* Pedido */}
              <Fld label="Pedido">
                <div style={{ position: "relative", marginBottom: 4 }}>
                  <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "#9CA3AF" }}><I.Search /></span>
                  <input value={tForm.pedSearch} onChange={e => setTForm({ ...tForm, pedSearch: e.target.value })} placeholder="Folio, cliente..." autoComplete="off" style={{ width: "100%", padding: "7px 10px", paddingLeft: 28, borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, outline: "none", boxSizing: "border-box", fontFamily: "inherit", background: "#FAFAFA" }} />
                </div>
              </Fld>
              <div style={{ maxHeight: 130, overflow: "auto", border: "1px solid #E5E7EB", borderRadius: 8, marginBottom: 8 }}>
                {(() => {
                  const isFlete = tForm.tipo === "flete";
                  let peds = data.fantasmas.filter(f => {
                    if (f.estado === "CERRADO") return false;
                    // Exclude only if FULLY paid for this type
                    if (isFlete && f.fletePagado) return false;
                    if (!isFlete && f.clientePago) return false;
                    return true;
                  });
                  if (tForm.pedSearch) { const s = tForm.pedSearch.toLowerCase(); peds = peds.filter(f => f.cliente.toLowerCase().includes(s) || f.id.toLowerCase().includes(s) || f.descripcion.toLowerCase().includes(s)); }
                  if (peds.length === 0) return <div style={{ padding: 16, textAlign: "center", color: "#9CA3AF", fontSize: 11 }}>No hay pedidos pendientes de {isFlete ? "flete" : "fantasma"}</div>;
                  return peds.slice(0, 15).map(f => {
                    const sel = tForm.pedidoId === f.id;
                    const costoTotal = tForm.tipo === "flete" ? (f.costoFlete || 0) : (f.totalVenta || f.costoMercancia);
                    const abonadoHasta = tForm.tipo === "flete" ? (f.abonoFlete || 0) : (f.abonoMercancia || 0);
                    const transPend = (data.transferencias || []).filter(t => t.pedidoId === f.id && t.tipo === tForm.tipo && !t.confirmada && !t.noRecibida && t.id !== editId);
                    const montoPendTrans = transPend.reduce((s, t) => s + (t.montoUSD || 0), 0);
                    const saldoPendiente = Math.max(0, costoTotal - abonadoHasta - montoPendTrans);
                    return (
                      <div key={f.id} onClick={() => setTForm({ ...tForm, pedidoId: f.id, pedSearch: f.cliente })} style={{ padding: "6px 10px", cursor: "pointer", background: sel ? "#F5F3FF" : "#fff", borderBottom: "1px solid #F3F4F6", borderLeft: sel ? "3px solid #7C3AED" : "3px solid transparent" }} onMouseEnter={e => { if (!sel) e.currentTarget.style.background = "#FAFBFC"; }} onMouseLeave={e => { if (!sel) e.currentTarget.style.background = "#fff"; }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          <span style={{ fontSize: 9, fontFamily: "monospace", fontWeight: 700, color: "#9CA3AF" }}>{f.id}</span>
                          <strong style={{ fontSize: 11 }}>{f.cliente}</strong>
                          {sel && <span style={{ fontSize: 8, background: "#7C3AED", color: "#fff", padding: "1px 5px", borderRadius: 3 }}>✓</span>}
                          {transPend.length > 0 && <span style={{ fontSize: 8, background: "#FEF3C7", color: "#92400E", padding: "1px 5px", borderRadius: 3 }}>{transPend.length} trans. pend.</span>}
                          <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 700, color: saldoPendiente <= 0 ? "#059669" : tForm.tipo === "flete" ? "#2563EB" : "#DC2626" }}>
                            {saldoPendiente <= 0 ? "✓ Cubierto" : `Saldo: ${fmt(saldoPendiente)}`}
                          </span>
                        </div>
                        <div style={{ fontSize: 10, color: "#6B7280" }}>{f.descripcion}{montoPendTrans > 0 ? <span style={{ color: "#D97706", fontWeight: 600 }}> · En tránsito: {fmt(montoPendTrans)}</span> : ""}</div>
                      </div>
                    );
                  });
                })()}
              </div>

              {/* Cuenta bancaria */}
              <Fld label="Cuenta de depósito *">
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {CUENTAS.filter(c => c.uso === tForm.tipo).length > 0 ? CUENTAS.filter(c => c.uso === tForm.tipo).map(c => {
                    const sel = tForm.cuenta === c.id;
                    return (
                      <div key={c.id} onClick={() => setTForm({ ...tForm, cuenta: c.id })} style={{ padding: "8px 12px", borderRadius: 8, border: sel ? `2px solid ${c.color}` : "1px solid #E5E7EB", background: sel ? (c.uso === "flete" ? "#FEF2F2" : "#EFF6FF") : "#fff", cursor: "pointer" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: c.color }}>{c.banco}</span>
                          <span style={{ fontSize: 8, background: c.uso === "flete" ? "#FEE2E2" : "#DBEAFE", color: c.uso === "flete" ? "#991B1B" : "#1E40AF", padding: "1px 5px", borderRadius: 3, fontWeight: 600 }}>{c.tag}</span>
                          {sel && <span style={{ fontSize: 8, background: c.color, color: "#fff", padding: "1px 5px", borderRadius: 3 }}>✓</span>}
                        </div>
                        <div style={{ fontSize: 10, color: "#374151", fontWeight: 600 }}>{c.titular}</div>
                        <div style={{ fontSize: 9, color: "#9CA3AF" }}>Tarjeta: {c.tarjeta} · CLABE: {c.clabe}</div>
                      </div>
                    );
                  }) : (
                    <div style={{ padding: 12, textAlign: "center", color: "#9CA3AF", fontSize: 11 }}>No hay cuentas para este tipo.</div>
                  )}
                  {CUENTAS.filter(c => c.uso !== tForm.tipo).length > 0 && (
                    <details style={{ marginTop: 4 }}>
                      <summary style={{ cursor: "pointer", fontSize: 10, color: "#9CA3AF" }}>Ver otras cuentas ({CUENTAS.filter(c => c.uso !== tForm.tipo)[0].tag})</summary>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
                        {CUENTAS.filter(c => c.uso !== tForm.tipo).map(c => {
                          const sel = tForm.cuenta === c.id;
                          return (
                            <div key={c.id} onClick={() => setTForm({ ...tForm, cuenta: c.id })} style={{ padding: "8px 12px", borderRadius: 8, border: sel ? `2px solid ${c.color}` : "1px solid #E5E7EB", background: sel ? "#FAFBFC" : "#fff", cursor: "pointer", opacity: 0.7 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <span style={{ fontSize: 10, fontWeight: 700, color: c.color }}>{c.banco}</span>
                                <span style={{ fontSize: 8, background: c.uso === "flete" ? "#FEE2E2" : "#DBEAFE", color: c.uso === "flete" ? "#991B1B" : "#1E40AF", padding: "1px 5px", borderRadius: 3, fontWeight: 600 }}>{c.tag}</span>
                                {sel && <span style={{ fontSize: 8, background: c.color, color: "#fff", padding: "1px 5px", borderRadius: 3 }}>✓</span>}
                              </div>
                              <div style={{ fontSize: 10, color: "#374151", fontWeight: 600 }}>{c.titular}</div>
                              <div style={{ fontSize: 9, color: "#9CA3AF" }}>Tarjeta: {c.tarjeta} · CLABE: {c.clabe}</div>
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  )}
                </div>
              </Fld>

              {/* Moneda y monto */}
              <Fld label="Moneda">
                <div style={{ display: "flex", gap: 3 }}>
                  <button onClick={() => setTForm({ ...tForm, moneda: "MXN", montoUSD: "" })} style={{ flex: 1, padding: "6px 12px", borderRadius: 6, border: tForm.moneda === "MXN" ? "2px solid #D97706" : "1px solid #D1D5DB", background: tForm.moneda === "MXN" ? "#FEF3C7" : "#fff", color: tForm.moneda === "MXN" ? "#92400E" : "#6B7280", fontWeight: tForm.moneda === "MXN" ? 700 : 500, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>🇲🇽 MXN (pesos)</button>
                  <button onClick={() => setTForm({ ...tForm, moneda: "USD", montoMXN: "", tipoCambio: "" })} style={{ flex: 1, padding: "6px 12px", borderRadius: 6, border: tForm.moneda === "USD" ? "2px solid #059669" : "1px solid #D1D5DB", background: tForm.moneda === "USD" ? "#ECFDF5" : "#fff", color: tForm.moneda === "USD" ? "#065F46" : "#6B7280", fontWeight: tForm.moneda === "USD" ? 700 : 500, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>🇺🇸 USD</button>
                </div>
              </Fld>
              {tForm.moneda === "MXN" ? (
                <div style={{ background: "#FEF3C7", borderRadius: 8, padding: "10px 12px", border: "1px solid #FDE68A", marginBottom: 8 }}>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Fld label="Monto MXN *"><Inp type="number" value={tForm.montoMXN} onChange={e => setTForm({ ...tForm, montoMXN: e.target.value })} placeholder="0.00" /></Fld>
                    <Fld label="Tipo de cambio *"><Inp type="number" value={tForm.tipoCambio} onChange={e => setTForm({ ...tForm, tipoCambio: e.target.value })} placeholder="17.50" /></Fld>
                  </div>
                  {tForm.montoMXN && tForm.tipoCambio && parseFloat(tForm.tipoCambio) > 0 && <div style={{ fontSize: 11, fontWeight: 600, color: "#065F46", marginTop: 4 }}>= {fmt(parseFloat(tForm.montoMXN) / parseFloat(tForm.tipoCambio))} USD</div>}
                </div>
              ) : (
                <Fld label="Monto USD *"><Inp type="number" value={tForm.montoUSD} onChange={e => setTForm({ ...tForm, montoUSD: e.target.value })} placeholder="0.00" /></Fld>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <Fld label="Fecha"><Inp type="date" value={tForm.fecha} onChange={e => setTForm({ ...tForm, fecha: e.target.value })} /></Fld>
                <Fld label="Nota"><Inp value={tForm.nota} onChange={e => setTForm({ ...tForm, nota: e.target.value })} placeholder="Referencia, concepto..." /></Fld>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5E7EB" }}>
                <Btn v="secondary" onClick={() => { setShowTrans(false) }}>Cancelar</Btn>
                <Btn disabled={!tForm.pedidoId || !tForm.cuenta || (tForm.moneda === "MXN" ? (!tForm.montoMXN || !tForm.tipoCambio) : !tForm.montoUSD)} onClick={registrarTrans} style={{ background: "#7C3AED" }}>{editId ? "✏️ Guardar cambios" : "🏦 Registrar transferencia"}</Btn>
              </div>
            </Modal>
          )}
        </div>
      );
    };


    const FlujoEfectivo = () => {
      const subTab = flujoSubTabApp; const setSubTab = setFlujoSubTabApp;
      const showGasto = showGastoApp; const setShowGasto = setShowGastoApp;
      const [gastoForm, setGastoForm] = usePersistedForm("gastoFormTJ", { concepto: "", monto: "", categoria: "OPERACIÓN", fecha: today(), nota: "" });
      const [cobForm, setCobForm] = usePersistedForm("cobForm", { tipo: "mercancia", pedidoId: "", monto: "", fecha: today(), nota: "" });
      const showCobro = showCobroApp; const setShowCobro = setShowCobroApp;
      const [cobSearch, setCobSearch] = useState("");
      const [editMov, setEditMov] = useState(null); // { fId, movId, monto, fecha, nota }
      const CATEGORIAS_GASTO = ["OPERACIÓN", "GASOLINA", "COMIDA", "RENTA", "LUZ/AGUA", "MANTENIMIENTO", "SUELDOS", "MATERIALES", "OTRO"];

      const gastos = filterByDate(data.gastosBodega || [], "fecha");
      const totalGastos = gastos.reduce((s, g) => s + (g.monto || 0), 0);

      // Cobros de clientes
      const dfFantasmas = data.fantasmas.filter(f => f.estado !== "CERRADO");
      const cobros = dfFantasmas.flatMap(f => (f.movimientos || []).filter(m => m.tipo === "Entrada").map(m => ({ ...m, cliente: f.cliente, fId: f.id, desc: f.descripcion }))).sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
      const totalCobradoMerc = dfFantasmas.reduce((s, f) => s + (f.abonoMercancia || 0), 0);
      const totalCobradoFlete = dfFantasmas.reduce((s, f) => s + (f.abonoFlete || 0), 0);
      const totalCobrado = totalCobradoMerc + totalCobradoFlete;
      const totalPendMerc = dfFantasmas.filter(f => !f.clientePago && f.estado !== "CERRADO").reduce((s, f) => s + (f.costoMercancia - (f.abonoMercancia || 0)), 0);
      const totalPendFlete = dfFantasmas.filter(f => !f.fletePagado && f.costoFlete > 0 && f.estado !== "CERRADO").reduce((s, f) => s + (f.costoFlete - (f.abonoFlete || 0)), 0);

      const agregarGasto = () => {
        const mo = parseFloat(gastoForm.monto) || 0;
        const esMXN = gastoForm.moneda === "MXN";
        const isEnvio = gastoForm.tipoMov === "envio";
        const g = { id: Date.now(), concepto: gastoForm.concepto.toUpperCase(), monto: mo, moneda: esMXN ? "MXN" : "USD", categoria: gastoForm.categoria, fecha: gastoForm.fecha, nota: gastoForm.nota, tipoMov: isEnvio ? "gasto" : (gastoForm.tipoMov || "gasto"), destino: isEnvio ? gastoForm.destino : null };
        let nd = { ...data, gastosBodega: [...(data.gastosBodega || []), g] };
        if (isEnvio) {
          const ingDest = { id: Date.now() + 1, concepto: `FONDO BODEGA TJ: ${gastoForm.concepto.toUpperCase()}`, monto: mo, moneda: esMXN ? "MXN" : "USD", categoria: "FONDO BODEGA TJ", fecha: gastoForm.fecha, nota: gastoForm.nota, tipoMov: "ingreso" };
          if (gastoForm.destino === "ADMIN") { ingDest.destino = "ADMIN"; ingDest.origen = "BODEGA_TJ"; nd.gastosAdmin = [...(nd.gastosAdmin || []), ingDest]; }
          else { nd.gastosUSA = [...(nd.gastosUSA || []), ingDest]; }
        }
        persist(nd);
        setGastoForm({ concepto: "", monto: "", categoria: "OPERACIÓN", fecha: today(), nota: "", tipoMov: "gasto", moneda: "USD", tipoCambio: "" });
        setShowGasto(false);
      };

    const PagosList = () => {
      const [busqueda, setBusqueda] = useState("");
      const [filtro, setFiltro] = useState("todos");
      const [sk, setSk] = useState("id");
      const [sd, setSd] = useState(1);
      const [editCell, setEditCell] = useState(null);
      const [showPagoModal, setShowPagoModal] = useModalState("showPagoModal");
      const [pagoSearch, setPagoSearch] = useState("");
      const [pagoSel, setPagoSel] = useState(null); // { fId, tipo }
      const [pagoMonto, setPagoMonto] = useState("");
      const [pagoMotoMXN, setPagoMontoMXN] = useState("");
      const [pagoTC, setPagoTC] = useState("");
      const [pagoNota, setPagoNota] = useState("");
      const [pagoFecha, setPagoFecha] = useState(today());
      const isMerc = pagoTab === "mercancia";
      const EMPAQUES = ["Caja", "Gaylor", "Pallet", "Sobre", "Bulto", "Bolsa", "Sandillero", "Step Completa", "Espacio", "Desconocido", "Otro"];

      const clickTimer2 = useRef(null);
      const goDelayed2 = (fn) => { if (clickTimer2.current) clearTimeout(clickTimer2.current); clickTimer2.current = setTimeout(fn, 220); };
      const startEdit = (e, f, field) => { e.stopPropagation(); if (clickTimer2.current) clearTimeout(clickTimer2.current); setEditCell({ id: f.id, field, val: String(f[field] ?? "") }); };
      const saveEdit = () => {
        if (!editCell) return;
        const f = data.fantasmas.find(x => x.id === editCell.id);
        if (!f) { setEditCell(null); return; }
        const numFields = ["costoMercancia", "costoFlete", "cantBultos"];
        const noUpper = ["cliente", "proveedor", "vendedor"];
        const parsed = numFields.includes(editCell.field) ? (parseFloat(editCell.val) || 0) : noUpper.includes(editCell.field) ? editCell.val.trim() : editCell.val.trim().toUpperCase();
        if (String(f[editCell.field] ?? "") !== String(parsed)) updF(f.id, { [editCell.field]: parsed });
        setEditCell(null);
      };
      const EC = ({ f, field, numeric = false, select = null, style = {} }) => {
        const isE = editCell?.id === f.id && editCell?.field === field;
        if (isE) {
          if (select) return <select autoFocus value={editCell.val} onChange={e => setEditCell({ ...editCell, val: e.target.value })} onBlur={saveEdit} onClick={e => e.stopPropagation()} style={{ width: "100%", fontSize: 11, border: "2px solid #2563EB", borderRadius: 4, padding: "2px 4px", fontFamily: "inherit" }}>{select.map(o => <option key={o} value={o}>{o}</option>)}</select>;
          return <input autoFocus type={numeric ? "number" : "text"} value={editCell.val} onChange={e => setEditCell({ ...editCell, val: e.target.value })} onClick={e => e.stopPropagation()} onBlur={saveEdit} onKeyDown={e => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditCell(null); }} style={{ width: "100%", fontSize: 11, border: "2px solid #2563EB", borderRadius: 4, padding: "2px 4px", fontFamily: numeric ? "monospace" : "inherit", background: "#EFF6FF", outline: "none", ...style }} />;
        }
        return <span onClick={e => e.stopPropagation()} onDoubleClick={e => startEdit(e, f, field)} title="Doble click para editar" style={{ cursor: "cell", display: "block", minHeight: 16, ...style }}>{f[field] ?? "—"}</span>;
      };

      // Payment registration
      const pendientesPago = data.fantasmas.filter(f => f.estado !== "CERRADO" && (isMerc ? !f.clientePago : (!f.fletePagado && !f.soloRecoger)));
      const pagoSearched = pagoSearch ? pendientesPago.filter(f => f.cliente.toLowerCase().includes(pagoSearch.toLowerCase()) || f.id.toLowerCase().includes(pagoSearch.toLowerCase()) || (f.proveedor||"").toLowerCase().includes(pagoSearch.toLowerCase())) : pendientesPago;

      const registrarPago = async () => {
        if (!pagoSel) return;
        const usd = parseFloat(pagoMonto) || 0;
        const mxn = parseFloat(pagoMotoMXN) || 0;
        const tc = parseFloat(pagoTC) || 0;
        const mxnToUsd = tc > 0 ? Math.round(mxn / tc * 100) / 100 : 0;
        const totalUSD = usd + mxnToUsd;
        // Allow $0 flete payments with confirmation
        if (totalUSD <= 0 && isMerc) return;
        if (totalUSD === 0 && !isMerc) {
          const ok = await showConfirm("¿Vas a registrar un flete de $0 como pagado?\n\nEsto marcará el flete como pagado aunque el monto sea $0.00.\n\n¿Estás seguro?");
          if (!ok) return;
        }
        const f = data.fantasmas.find(x => x.id === pagoSel.fId);
        if (!f) return;
        const detalle = [usd > 0 ? `${fmt(usd)} USD` : "", mxnToUsd > 0 ? `${fmt(mxn)} MXN @${tc}` : ""].filter(Boolean).join(" + ");
        const mov = { id: Date.now(), tipo: "Entrada", concepto: isMerc ? `👻 Pago mercancía — ${detalle}${pagoNota ? " — " + pagoNota : ""}` : `🚛 Pago flete — ${detalle}${pagoNota ? " — " + pagoNota : ""}`, monto: totalUSD, montoUSD: usd, montoMXN: mxn || null, tipoCambio: tc || null, fecha: pagoFecha };
        let upd = {};
        if (isMerc) { const na = (f.abonoMercancia||0)+totalUSD; upd = { abonoMercancia: na, clientePago: na >= (f.totalVenta||f.costoMercancia), clientePagoMonto: na }; }
        else { const na = (f.abonoFlete||0)+totalUSD; upd = { abonoFlete: na, fletePagado: na >= (f.costoFlete||0) }; }
        upd.movimientos = [...(f.movimientos||[]), mov];
        upd.historial = [...(f.historial||[]), { fecha: pagoFecha, accion: `💰 Pago ${isMerc?"mercancía":"flete"}: ${fmt(totalUSD)} (${detalle})${pagoNota ? " — " + pagoNota : ""}`, quien: role }];
        upd.fechaActualizacion = today();
        let nd = { ...data, fantasmas: data.fantasmas.map(x => x.id !== pagoSel.fId ? x : { ...x, ...upd }) };
        const label = isMerc ? "PAGO FANTASMA" : "PAGO FLETE";
        if (usd > 0) nd.gastosBodega = [...(nd.gastosBodega||[]), { id: Date.now()+10, concepto: `${label} ${pagoSel.fId} (USD)`, monto: usd, moneda: "USD", categoria: isMerc?"COBRO FANTASMA":"COBRO FLETE", fecha: pagoFecha, nota: f.cliente, tipoMov: "ingreso" }];
        if (mxn > 0) nd.gastosBodega = [...(nd.gastosBodega||[]), { id: Date.now()+11, concepto: `${label} ${pagoSel.fId} (MXN)`, monto: mxn, moneda: "MXN", categoria: isMerc?"COBRO FANTASMA":"COBRO FLETE", fecha: pagoFecha, nota: `${f.cliente} · @${tc} = ${fmt(mxnToUsd)} USD`, tipoMov: "ingreso" }];
        persist(nd);
        setPagoSel(null); setPagoMonto(""); setPagoMontoMXN(""); setPagoTC(""); setPagoNota(""); setPagoFecha(today());
        if (pagoSearched.length <= 1) setShowPagoModal(false);
      };

      // Table data
      let lista = data.fantasmas.filter(f => f.estado !== "CERRADO");
      if (filtro === "pendientes") lista = lista.filter(f => isMerc ? !f.clientePago : (!f.fletePagado && !f.soloRecoger));
      if (filtro === "pagados") lista = lista.filter(f => isMerc ? f.clientePago : f.fletePagado);
      if (busqueda) { const s = busqueda.toLowerCase(); lista = lista.filter(f => f.cliente.toLowerCase().includes(s) || f.id.toLowerCase().includes(s) || (f.descripcion||"").toLowerCase().includes(s) || (f.proveedor||"").toLowerCase().includes(s)); }
      lista = [...lista].sort((a, b) => { const va = a[sk]||""; const vb = b[sk]||""; return typeof va === "number" ? (va-vb)*sd : String(va).localeCompare(String(vb))*sd; });
      const toggle = (k) => { if (sk===k) setSd(d=>-d); else { setSk(k); setSd(1); } };
      const arr = (k) => sk===k?(sd===1?" ↑":" ↓"):"";

      // Week movements
      const allMovs = data.fantasmas.flatMap(f => (f.movimientos||[]).filter(m => { const d = m.fecha||""; const r = getDateRange(); if (!r) return true; return d >= r.start && d <= r.end; }).map(m => ({ ...m, cliente: f.cliente, folio: f.id })));
      const semMovs = allMovs.filter(m => isMerc ? (m.concepto||"").includes("mercancía") : (m.concepto||"").includes("flete")).sort((a,b) => {
        const dateDiff = (b.fecha||"").localeCompare(a.fecha||"");
        if (dateDiff !== 0) return dateDiff;
        return (b.id||0) - (a.id||0); // tie-break by timestamp (newer first)
      });

      const pendCount = data.fantasmas.filter(f => f.estado !== "CERRADO" && (isMerc ? !f.clientePago : (!f.fletePagado && (f.costoFlete > 0 || f.fleteDesconocido)))).length;
      const pagCount = data.fantasmas.filter(f => f.estado !== "CERRADO" && (isMerc ? f.clientePago : f.fletePagado)).length;
      const totalPend = data.fantasmas.filter(f => f.estado !== "CERRADO" && (isMerc ? !f.clientePago : (!f.fletePagado && !f.soloRecoger))).reduce((s,f) => s + (isMerc ? ((f.totalVenta||f.costoMercancia)-(f.abonoMercancia||0)) : ((f.costoFlete||0)-(f.abonoFlete||0))), 0);
      const totalPag = data.fantasmas.filter(f => f.estado !== "CERRADO" && (isMerc ? f.clientePago : f.fletePagado)).reduce((s,f) => s + (isMerc ? (f.totalVenta||f.costoMercancia) : (f.costoFlete||0)), 0);

      const th = { padding: "6px 8px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", background: "#1A2744", color: "#fff", position: "sticky", top: 0, whiteSpace: "nowrap", cursor: "pointer" };

      return (
        <div>
          {/* Stats + Registrar Pago button */}
          <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap", alignItems: "stretch" }}>
            <div style={{ flex: "1 1 100px", background: "#F9FAFB", borderRadius: 8, padding: "10px 14px", border: "1px solid #E5E7EB" }}>
              <div style={{ fontSize: 9, fontWeight: 600, color: "#6B7280" }}>TOTAL</div>
              <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "monospace" }}>{fmt(totalPend + totalPag)}</div>
            </div>
            <div style={{ flex: "1 1 100px", background: "#ECFDF5", borderRadius: 8, padding: "10px 14px", border: "1px solid #A7F3D0" }}>
              <div style={{ fontSize: 9, fontWeight: 600, color: "#065F46" }}>COBRADO</div>
              <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "monospace", color: "#059669" }}>{fmt(totalPag)}</div>
              <div style={{ fontSize: 9, color: "#9CA3AF" }}>{pagCount} pedidos</div>
            </div>
            <div style={{ flex: "1 1 100px", background: "#FEF2F2", borderRadius: 8, padding: "10px 14px", border: "1px solid #FECACA" }}>
              <div style={{ fontSize: 9, fontWeight: 600, color: "#991B1B" }}>PENDIENTE</div>
              <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "monospace", color: "#DC2626" }}>{fmt(totalPend)}</div>
              <div style={{ fontSize: 9, color: "#9CA3AF" }}>{pendCount} pedidos</div>
            </div>
            <button onClick={() => { setShowPagoModal(true); setPagoSearch(""); setPagoSel(null); }} style={{ background: "#059669", color: "#fff", border: "none", borderRadius: 8, padding: "0 20px", cursor: "pointer", fontSize: 13, fontWeight: 700, fontFamily: "inherit", whiteSpace: "nowrap" }}>
              💰 Registrar Pago
            </button>
          </div>

          {/* Search + filter */}
          <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
            <div style={{ position: "relative", flex: "1 1 200px" }}>
              <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "#9CA3AF" }}><I.Search /></span>
              <input value={busqueda} onChange={e => setBusqueda(e.target.value)} placeholder="Buscar folio, cliente, descripción..." autoComplete="off" style={{ width: "100%", padding: "7px 10px", paddingLeft: 28, borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, outline: "none", boxSizing: "border-box", fontFamily: "inherit", background: "#FAFAFA" }} />
            </div>
            <div style={{ display: "flex", gap: 2, background: "#F3F4F6", borderRadius: 6, padding: 2 }}>
              {[["todos","Todos"],["pendientes",`Pendientes (${pendCount})`],["pagados",`Pagados (${pagCount})`]].map(([k,l]) => (
                <button key={k} onClick={() => setFiltro(k)} style={{ padding: "5px 10px", borderRadius: 5, border: "none", background: filtro===k?"#fff":"transparent", boxShadow: filtro===k?"0 1px 2px rgba(0,0,0,.1)":"none", cursor: "pointer", fontSize: 10, fontWeight: filtro===k?700:500, fontFamily: "inherit", color: filtro===k?"#374151":"#9CA3AF", whiteSpace: "nowrap" }}>{l}</button>
              ))}
            </div>
          </div>

          {/* Bitacora table */}
          <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 6 }}>{lista.length} pedido{lista.length!==1?"s":""}</div>
          <div style={{ background: "#fff", borderRadius: 9, border: "1px solid #E5E7EB", overflow: periodoTipo === "semana" ? "visible" : "auto", maxHeight: periodoTipo === "semana" ? "none" : "45vh" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: "inherit" }}>
              <thead><tr>
                <th onClick={() => toggle("id")} style={th}>Folio{arr("id")}</th>
                <th onClick={() => toggle("proveedor")} style={th}>Proveedor{arr("proveedor")}</th>
                <th onClick={() => toggle("cliente")} style={th}>Cliente{arr("cliente")}</th>
                <th style={th}>Mercancía</th>
                <th style={th}>Empaque</th>
                <th style={th}>Estado</th>
                <th onClick={() => toggle(isMerc?"costoMercancia":"costoFlete")} style={{...th, color: isMerc?"#FCA5A5":"#93C5FD"}}>{isMerc?"👻 Costo":"🚛 Flete"}{arr(isMerc?"costoMercancia":"costoFlete")}</th>
                <th style={th}>Pagó</th>
              </tr></thead>
              <tbody>{(periodoTipo === "semana" ? lista : lista.slice(0,100)).map((f, i) => {
                const td = { padding: "4px 8px", borderBottom: "1px solid #F3F4F6" };
                const go = () => { if (editCell) return; setDetailMode("full"); navigate("detail", f.id, view); };
                const monto = isMerc ? (f.totalVenta||f.costoMercancia) : (f.costoFlete||0);
                const abono = isMerc ? (f.abonoMercancia||0) : (f.abonoFlete||0);
                const pagado = isMerc ? f.clientePago : f.fletePagado;
                const desconocido = isMerc ? f.costoDesconocido : f.fleteDesconocido;
                return (
                  <tr key={f.id} style={{ background: i%2===0?"#fff":"#FAFBFC" }} onMouseEnter={e => e.currentTarget.style.background="#EFF6FF"} onMouseLeave={e => e.currentTarget.style.background=i%2===0?"#fff":"#FAFBFC"}>
                    <td onClick={() => goDelayed2(go)} style={{ ...td, fontFamily: "monospace", color: "#1A2744", fontSize: 10, fontWeight: 600, cursor: "pointer" }}>{f.id}</td>
                    <td style={{ ...td, color: "#D97706", fontWeight: 600 }}><EC f={f} field="proveedor" select={[...new Set(data.fantasmas.map(x=>x.proveedor).filter(Boolean))].sort()} /></td>
                    <td style={{ ...td, fontWeight: 600 }}><EC f={f} field="cliente" select={[...new Set([...(data.clientes||[]),...data.fantasmas.map(x=>x.cliente).filter(Boolean)])].sort()} /></td>
                    <td style={{ ...td, maxWidth: 130 }}><EC f={f} field="descripcion" /></td>
                    <td style={td}><div style={{ display: "flex", gap: 4, alignItems: "center" }}><EC f={f} field="cantBultos" numeric style={{ width: 30 }} /><EC f={f} field="empaque" select={EMPAQUES} /></div></td>
                    <td onClick={go} style={{ ...td, padding: "6px 4px", cursor: "pointer" }}><Badge estado={f.estado} /></td>
                    <td style={td}><EC f={f} field={isMerc?"costoMercancia":"costoFlete"} numeric style={{ color: desconocido?"#D97706":isMerc?"#DC2626":"#2563EB", fontFamily: "monospace", fontWeight: 700, textAlign: "right" }} /></td>
                    <td onClick={go} style={{ ...td, textAlign: "center", cursor: "pointer" }}>
                      {pagado ? <span style={{ background: "#D1FAE5", color: "#065F46", padding: "3px 8px", borderRadius: 10, fontSize: 10, fontWeight: 700 }}>✅ PAGADO</span>
                        : abono > 0 ? <span style={{ background: "#FEF3C7", color: "#92400E", padding: "3px 8px", borderRadius: 10, fontSize: 9, fontWeight: 700 }}>⚠️ {fmt(abono)}</span>
                        : desconocido ? <span style={{ background: "#FEF3C7", color: "#92400E", padding: "3px 8px", borderRadius: 10, fontSize: 9, fontWeight: 700 }}>❓ POR DEFINIR</span>
                        : <span style={{ background: "#FEE2E2", color: "#991B1B", padding: "3px 8px", borderRadius: 10, fontSize: 10, fontWeight: 700 }}>❌ PENDIENTE</span>}
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>

          {/* Week movements */}
          {semMovs.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 8 }}>📋 Movimientos del período ({semMovs.length})</div>
              <div style={{ background: "#fff", borderRadius: 8, border: "1px solid #E5E7EB", overflow: periodoTipo === "semana" ? "visible" : "auto", maxHeight: periodoTipo === "semana" ? "none" : "30vh" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: "inherit" }}>
                  <thead><tr>
                    {["Fecha","Folio","Cliente","Detalle","Monto"].map(h => <th key={h} style={{ padding: "6px 8px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", background: "#374151", color: "#fff", whiteSpace: "nowrap" }}>{h}</th>)}
                    <th style={{ padding: "6px 8px", background: "#374151", width: 30 }}></th>
                  </tr></thead>
                  <tbody>{semMovs.map((m, i) => {
                    // Clean up concepto for display
                    const detalle = (m.concepto||"")
                      .replace(/^👻 Pago mercancía — /, "")
                      .replace(/^🚛 Pago flete — /, "")
                      .replace(/\$[\d,.]+ USD/, "").replace(/\$[\d,.]+ MXN @[\d.]+/, "")
                      .replace(/^ — /, "").trim() || (isMerc ? "Pago mercancía" : "Pago flete");
                    const montoDisplay = m.montoMXN > 0 ? `${fmt(m.monto)} + ${m.montoMXN ? `$${m.montoMXN} MXN` : ""}` : fmt(m.monto);
                    return (
                    <tr key={m.id} style={{ background: i%2===0?"#fff":"#FAFBFC" }}>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid #F3F4F6", color: "#6B7280", whiteSpace: "nowrap" }}>{m.fecha}</td>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid #F3F4F6", fontFamily: "monospace", fontSize: 10, color: "#1A2744" }}>{m.folio}</td>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid #F3F4F6", fontWeight: 600 }}>{m.cliente}</td>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid #F3F4F6", color: "#6B7280", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{detalle || "—"}</td>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid #F3F4F6", fontFamily: "monospace", fontWeight: 700, color: m.monto > 0 ? "#059669" : "#9CA3AF", textAlign: "right", whiteSpace: "nowrap" }}>{montoDisplay}</td>
                      <td style={{ padding: "4px 6px", borderBottom: "1px solid #F3F4F6", textAlign: "center" }}>
                        <button onClick={async () => { if (!await showConfirm(`¿Eliminar pago?

${m.cliente} — ${m.concepto} — ${fmt(m.monto)}`)) return; const f = data.fantasmas.find(x => x.id === m.folio); if (!f) return;
              const newMovs = (f.movimientos||[]).filter(x => x.id !== m.id);
              const diff = m.montoUSD || (m.montoMXN && m.tipoCambio ? Math.round(m.montoMXN / m.tipoCambio * 100) / 100 : 0) || m.monto || 0;
              let upd = {};
              if ((m.concepto||"").includes("mercancía")) {
                const na = Math.max(0,(f.abonoMercancia||0)-diff);
                upd = { abonoMercancia: na, clientePago: na >= (f.totalVenta||f.costoMercancia), movimientos: newMovs };
              } else {
                const na = Math.max(0,(f.abonoFlete||0)-diff);
                upd = { abonoFlete: na, fletePagado: na >= (f.costoFlete||0), movimientos: newMovs };
              }
              // Also remove from gastosBodega
              const nd = { ...data,
                fantasmas: data.fantasmas.map(x => x.id !== m.folio ? x : { ...x, ...upd }),
                gastosBodega: (data.gastosBodega||[]).filter(g => !(g.concepto||"").includes(m.folio) || !((g.categoria||"").includes("COBRO")))
              };
              // More precise: remove the specific gastosBodega entry by id proximity
              persist(nd); }} style={{ background: "none", border: "none", color: "#D1D5DB", cursor: "pointer", padding: 2 }} onMouseEnter={e=>e.currentTarget.style.color="#DC2626"} onMouseLeave={e=>e.currentTarget.style.color="#D1D5DB"}><I.Trash /></button>
                      </td>
                    </tr>
                    );
                  })}</tbody>
                </table>
              </div>
            </div>
          )}

          {/* Pago Modal */}
          {showPagoModal && (
            <Modal title={`💰 Registrar pago — ${isMerc ? "👻 Mercancía" : "🚛 Flete"}`} onClose={() => setShowPagoModal(false)} w={500}>
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#374151", marginBottom: 6 }}>Buscar pedido pendiente</div>
                <div style={{ position: "relative", marginBottom: 8 }}>
                  <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "#9CA3AF" }}><I.Search /></span>
                  <input autoFocus value={pagoSearch} onChange={e => { setPagoSearch(e.target.value); setPagoSel(null); }} placeholder="Folio, cliente, proveedor..." style={{ width: "100%", padding: "8px 10px 8px 28px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 12, outline: "none", boxSizing: "border-box", fontFamily: "inherit" }} />
                </div>
                <div style={{ maxHeight: 180, overflowY: "auto", border: "1px solid #E5E7EB", borderRadius: 6 }}>
                  {pagoSearched.length === 0 && <div style={{ padding: 16, textAlign: "center", color: "#9CA3AF", fontSize: 11 }}>No hay pendientes</div>}
                  {pagoSearched.map(f => {
                    const debe = isMerc ? ((f.totalVenta||f.costoMercancia)-(f.abonoMercancia||0)) : ((f.costoFlete||0)-(f.abonoFlete||0));
                    const sel = pagoSel?.fId === f.id;
                    return (
                      <div key={f.id} onClick={() => { setPagoSel({ fId: f.id }); setPagoMonto(String(debe > 0 ? debe : "")); }} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: sel ? "#EFF6FF" : "#fff", borderBottom: "1px solid #F3F4F6", cursor: "pointer", borderLeft: sel ? "3px solid #2563EB" : "3px solid transparent" }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <span style={{ fontSize: 10, fontFamily: "monospace", color: "#6B7280" }}>{f.id}</span>
                            <strong style={{ fontSize: 12 }}>{f.cliente}</strong>
                            {f.proveedor && <span style={{ fontSize: 10, color: "#D97706" }}>{f.proveedor}</span>}
                          </div>
                          <div style={{ fontSize: 10, color: "#6B7280" }}>{f.descripcion}</div>
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, fontFamily: "monospace", color: "#DC2626" }}>{fmt(debe > 0 ? debe : (isMerc ? f.costoMercancia : f.costoFlete))}</div>
                          {(isMerc ? f.abonoMercancia : f.abonoFlete) > 0 && <div style={{ fontSize: 9, color: "#D97706" }}>Abono: {fmt(isMerc ? f.abonoMercancia : f.abonoFlete)}</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              {pagoSel && (() => {
                const f = data.fantasmas.find(x => x.id === pagoSel.fId);
                const debe = f ? (isMerc ? ((f.totalVenta||f.costoMercancia)-(f.abonoMercancia||0)) : ((f.costoFlete||0)-(f.abonoFlete||0))) : 0;
                return (
                  <div style={{ borderTop: "1px solid #E5E7EB", paddingTop: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#374151", marginBottom: 8 }}>Registrar pago para <strong>{f?.cliente}</strong> — Debe: <span style={{ color: "#DC2626", fontFamily: "monospace" }}>{fmt(debe)}</span></div>
                    <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                      <Fld label="Monto USD"><Inp type="number" value={pagoMonto} onChange={e => setPagoMonto(e.target.value)} placeholder="0.00" /></Fld>
                      <Fld label="Monto MXN"><Inp type="number" value={pagoMotoMXN} onChange={e => setPagoMontoMXN(e.target.value)} placeholder="0.00" /></Fld>
                      <Fld label="T/C"><Inp type="number" value={pagoTC} onChange={e => setPagoTC(e.target.value)} placeholder="17.50" /></Fld>
                    </div>
                    <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                      <Fld label="Fecha"><Inp type="date" value={pagoFecha} onChange={e => setPagoFecha(e.target.value)} /></Fld>
                      <Fld label="Nota"><Inp value={pagoNota} onChange={e => setPagoNota(e.target.value)} placeholder="Efectivo, transferencia..." /></Fld>
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
                      <Btn v="secondary" onClick={() => setPagoSel(null)}>Cancelar</Btn>
                      <Btn disabled={!(parseFloat(pagoMonto)>0) && !(parseFloat(pagoMotoMXN)>0) && !(pagoSel && !isMerc && (() => { const pf = data.fantasmas.find(x=>x.id===pagoSel.fId); return pf && (pf.costoFlete||0)===0; })())} onClick={registrarPago} style={{ background: "#059669" }}>💰 Registrar</Btn>
                    </div>
                  </div>
                );
              })()}
            </Modal>
          )}
        </div>
      );
    };

      const eliminarGasto = async (gId) => { const g = gastos.find(x => x.id === gId); if (!g) return; if (!await showConfirm(`¿Eliminar movimiento?\n\n${g.concepto || "?"} — ${fmt(g.monto || 0)}`)) return; persist({ ...data, gastosBodega: gastos.filter(g => g.id !== gId) }); };

      return (
        <div>
          {/* Sub-tabs */}
          <div style={{ display: "flex", gap: 3, background: "#F3F4F6", borderRadius: 8, padding: 3, marginBottom: 14 }}>
            <button onClick={() => setSubTab("clientes")} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: subTab === "clientes" ? "#fff" : "transparent", boxShadow: subTab === "clientes" ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 11, fontWeight: subTab === "clientes" ? 700 : 500, fontFamily: "inherit", color: subTab === "clientes" ? "#1A2744" : "#6B7280" }}>💰 Pagos Clientes</button>
            <button onClick={() => setSubTab("comisiones")} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: subTab === "comisiones" ? "#fff" : "transparent", boxShadow: subTab === "comisiones" ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 11, fontWeight: subTab === "comisiones" ? 700 : 500, fontFamily: "inherit", color: subTab === "comisiones" ? "#7C3AED" : "#6B7280" }}>
              💼 Comisiones{data.fantasmas.filter(f => f.comisionPendiente && !f.comisionCobrada && f.estado !== "CERRADO").length > 0 && <span style={{ background: "#7C3AED", color: "#fff", fontSize: 9, padding: "1px 5px", borderRadius: 8, fontWeight: 700, marginLeft: 4 }}>{data.fantasmas.filter(f => f.comisionPendiente && !f.comisionCobrada && f.estado !== "CERRADO").length}</span>}
            </button>
            <button onClick={() => setSubTab("sobres")} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: subTab === "sobres" ? "#fff" : "transparent", boxShadow: subTab === "sobres" ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 11, fontWeight: subTab === "sobres" ? 700 : 500, fontFamily: "inherit", color: subTab === "sobres" ? "#7C3AED" : "#6B7280" }}>📨 Sobres</button>
            <button onClick={() => setSubTab("resumen")} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: subTab === "resumen" ? "#fff" : "transparent", boxShadow: subTab === "resumen" ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 11, fontWeight: subTab === "resumen" ? 700 : 500, fontFamily: "inherit", color: subTab === "resumen" ? "#1A2744" : "#6B7280" }}>📊 Resumen</button>
          </div>

          {subTab === "comisiones" && (() => {
            const pendientes = data.fantasmas.filter(f => f.comisionPendiente && !f.comisionCobrada && f.estado !== "CERRADO");
            const cobradas = data.fantasmas.filter(f => f.comisionCobrada);
            const totalPend = pendientes.reduce((s, f) => s + (f.comisionMonto || 0), 0);
            const totalCob = cobradas.reduce((s, f) => s + (f.comisionMonto || 0), 0);
            return (
              <div>
                <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 140px", background: "#FEF3C7", borderRadius: 10, padding: "14px 18px", border: "2px solid #FDE68A" }}>
                    <div style={{ fontSize: 9, fontWeight: 600, color: "#92400E", textTransform: "uppercase" }}>💼 Pendientes</div>
                    <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "monospace", color: "#D97706" }}>{fmt(totalPend)}</div>
                    <div style={{ fontSize: 9, color: "#9CA3AF" }}>{pendientes.length} comisión{pendientes.length !== 1 ? "es" : ""}</div>
                  </div>
                  <div style={{ flex: "1 1 140px", background: "#ECFDF5", borderRadius: 10, padding: "14px 18px", border: "1px solid #A7F3D0" }}>
                    <div style={{ fontSize: 9, fontWeight: 600, color: "#065F46", textTransform: "uppercase" }}>✅ Cobradas</div>
                    <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "monospace", color: "#059669" }}>{fmt(totalCob)}</div>
                    <div style={{ fontSize: 9, color: "#9CA3AF" }}>{cobradas.length} cobrada{cobradas.length !== 1 ? "s" : ""}</div>
                  </div>
                </div>
                {pendientes.length === 0 ? (
                  <div style={{ textAlign: "center", padding: 32, color: "#9CA3AF" }}><div style={{ fontSize: 28, marginBottom: 8 }}>✅</div><p style={{ fontSize: 12 }}>No hay comisiones pendientes.</p></div>
                ) : (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, color: "#374151" }}>Comisiones pendientes de cobrar</div>
                    {pendientes.map(f => (
                      <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "#fff", borderRadius: 8, border: "1px solid #E9D5FF", marginBottom: 6 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 9, color: "#9CA3AF", fontFamily: "monospace" }}>{f.id}</span>
                            <strong style={{ fontSize: 12 }}>{f.cliente}</strong>
                            <span style={{ fontSize: 10, color: "#6B7280" }}>{f.descripcion}</span>
                          </div>
                          <div style={{ fontSize: 10, color: "#9CA3AF", marginTop: 2 }}>
                            Pedido: {fmt(f.costoMercancia)} · Comisión: {fmt(f.comisionMonto)}
                          </div>
                        </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "monospace", color: "#7C3AED" }}>{fmt(f.comisionMonto)}</div>
                          <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                            <button onClick={() => {
                              updF(f.id, { comisionCobrada: true, comisionPendiente: false, cobrarComision: true, historial: [...(f.historial || []), { fecha: today(), accion: `💼 Comisión cobrada: ${fmt(f.comisionMonto)}`, quien: role }] });
                            }} style={{ padding: "4px 10px", borderRadius: 6, border: "none", background: "#7C3AED", color: "#fff", fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>✓ Cobrada</button>
                            <button onClick={() => {
                              updF(f.id, { cobrarComision: false, comisionPendiente: false, comisionMonto: 0, totalVenta: f.costoMercancia, historial: [...(f.historial || []), { fecha: today(), accion: `❌ Comisión eliminada`, quien: role }] });
                            }} style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #E5E7EB", background: "#fff", color: "#9CA3AF", fontSize: 10, cursor: "pointer", fontFamily: "inherit" }} title="Eliminar comisión">✕</button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {cobradas.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#6B7280", marginBottom: 8 }}>Historial cobradas ({cobradas.length})</div>
                    {cobradas.slice(0, 10).map(f => (
                      <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", background: "#F9FAFB", borderRadius: 8, border: "1px solid #E5E7EB", marginBottom: 4 }}>
                        <div style={{ flex: 1 }}>
                          <span style={{ fontSize: 9, color: "#9CA3AF", fontFamily: "monospace", marginRight: 6 }}>{f.id}</span>
                          <strong style={{ fontSize: 11 }}>{f.cliente}</strong>
                        </div>
                        <span style={{ fontFamily: "monospace", fontSize: 11, color: "#059669", fontWeight: 700 }}>{fmt(f.comisionMonto)} ✓</span>
                        <button onClick={() => {
                          updF(f.id, { cobrarComision: false, comisionPendiente: false, comisionCobrada: false, comisionMonto: 0, totalVenta: f.costoMercancia, historial: [...(f.historial || []), { fecha: today(), accion: `❌ Comisión eliminada`, quien: role }] });
                        }} style={{ background: "none", border: "none", cursor: "pointer", color: "#D1D5DB", fontSize: 12, padding: 2 }} title="Eliminar comisión" onMouseEnter={e => e.currentTarget.style.color="#DC2626"} onMouseLeave={e => e.currentTarget.style.color="#D1D5DB"}>✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          {subTab === "clientes" && (
            <div>
              {/* Sub-sub tabs: Fantasmas vs Fletes */}
              <div style={{ display: "flex", gap: 3, background: "#F3F4F6", borderRadius: 8, padding: 3, marginBottom: 12 }}>
                <button onClick={() => setPagoTab("mercancia")} style={{ flex: 1, padding: "8px 14px", borderRadius: 6, border: "none", background: pagoTab === "mercancia" ? "#fff" : "transparent", boxShadow: pagoTab === "mercancia" ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 12, fontWeight: pagoTab === "mercancia" ? 700 : 500, fontFamily: "inherit", color: pagoTab === "mercancia" ? "#DC2626" : "#6B7280" }}>👻 Fantasmas (Mercancía)</button>
                <button onClick={() => setPagoTab("flete")} style={{ flex: 1, padding: "8px 14px", borderRadius: 6, border: "none", background: pagoTab === "flete" ? "#fff" : "transparent", boxShadow: pagoTab === "flete" ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 12, fontWeight: pagoTab === "flete" ? 700 : 500, fontFamily: "inherit", color: pagoTab === "flete" ? "#2563EB" : "#6B7280" }}>🚛 Fletes</button>
              </div>
              <PagosList />

              {/* Edit movement modal */}
              {editMov && (
                <Modal title="✏️ Editar movimiento" onClose={() => setEditMov(null)} w={400}>
                  {(() => {
                    const f = data.fantasmas.find(x => x.id === editMov.fId);
                    return f ? <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 10 }}><strong>{f.id}</strong> · {f.cliente} · {f.descripcion}</div> : null;
                  })()}
                  <div style={{ display: "flex", gap: 8 }}>
                    <Fld label="Monto"><Inp type="number" value={editMov.monto} onChange={e => setEditMov({ ...editMov, monto: e.target.value })} /></Fld>
                    <Fld label="Fecha"><Inp type="date" value={editMov.fecha} onChange={e => setEditMov({ ...editMov, fecha: e.target.value })} /></Fld>
                  </div>
                  <Fld label="Nota"><Inp value={editMov.nota} onChange={e => setEditMov({ ...editMov, nota: e.target.value })} placeholder="Nota..." /></Fld>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5E7EB" }}>
                    <Btn v="secondary" onClick={() => setEditMov(null)}>Cancelar</Btn>
                    <Btn onClick={() => {
                      const f = data.fantasmas.find(x => x.id === editMov.fId);
                      if (!f) return;
                      const oldMov = (f.movimientos || []).find(x => x.id === editMov.movId);
                      if (!oldMov) return;
                      const newMonto = parseFloat(editMov.monto) || 0;
                      const diff = newMonto - oldMov.monto;
                      const isMerc2 = (oldMov.concepto || "").toLowerCase().includes("mercancía");
                      const newConcepto = isMerc2 ? `👻 Pago mercancía${editMov.nota ? " — " + editMov.nota : ""}` : `🚛 Pago flete${editMov.nota ? " — " + editMov.nota : ""}`;
                      const newMovs = (f.movimientos || []).map(x => x.id !== editMov.movId ? x : { ...x, monto: newMonto, fecha: editMov.fecha, concepto: newConcepto });
                      let upd = { movimientos: newMovs };
                      if (isMerc2) {
                        const na = Math.max(0, (f.abonoMercancia || 0) + diff);
                        upd.abonoMercancia = na; upd.clientePago = na >= (f.totalVenta || f.costoMercancia); upd.clientePagoMonto = na;
                      } else {
                        const na = Math.max(0, (f.abonoFlete || 0) + diff);
                        upd.abonoFlete = na; upd.fletePagado = na >= (f.costoFlete || 0);
                      }
                      upd.historial = [...(f.historial || []), { fecha: today(), accion: `✏️ Pago editado: ${fmt(oldMov.monto)} → ${fmt(newMonto)}`, quien: role }];
                      persist({ ...data, fantasmas: data.fantasmas.map(x => x.id !== editMov.fId ? x : { ...x, ...upd, fechaActualizacion: today() }) });
                      setEditMov(null);
                    }}>Guardar</Btn>
                  </div>
                </Modal>
              )}
              {showCobro && (
                <Modal title={`💰 Registrar pago de ${cobForm.tipo === "mercancia" ? "mercancía (fantasma)" : "flete"}`} onClose={() => { setShowCobro(false) }} w={500}>
                  <Fld label="Buscar pedido"><div style={{ position: "relative" }}><span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "#9CA3AF" }}><I.Search /></span><input value={cobSearch} onChange={e => setCobSearch(e.target.value)} placeholder="Folio, cliente..." autoComplete="off" style={{ width: "100%", padding: "8px 10px", paddingLeft: 28, borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 12, outline: "none", boxSizing: "border-box", fontFamily: "inherit", background: "#FAFAFA" }} />{cobSearch && <button onClick={() => setCobSearch("")} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#9CA3AF", fontSize: 12 }}>✕</button>}</div></Fld>
                  <div style={{ maxHeight: 200, overflow: "auto", marginBottom: 8, border: "1px solid #E5E7EB", borderRadius: 8 }}>{(() => { const isMerc = cobForm.tipo === "mercancia"; const pf = data.fantasmas.filter(f => { if (f.estado === "CERRADO") return false; if (isMerc && f.clientePago) return false; if (!isMerc && (f.fletePagado || (!f.costoFlete && !f.fleteDesconocido))) return false; if (cobSearch) { const s = cobSearch.toLowerCase(); return f.cliente.toLowerCase().includes(s) || f.descripcion.toLowerCase().includes(s) || f.id.toLowerCase().includes(s) || (f.proveedor||"").toLowerCase().includes(s); } return true; }); if (pf.length === 0) return <div style={{ padding: 16, textAlign: "center", color: "#9CA3AF", fontSize: 11 }}>No hay pedidos pendientes</div>; return pf.map(f => { const d = isMerc ? (f.costoMercancia-(f.abonoMercancia||0)) : (f.costoFlete-(f.abonoFlete||0)); const sel = cobForm.pedidoId === f.id; return <div key={f.id} onClick={() => { setCobForm({...cobForm, pedidoId: f.id, monto: String(d)}); setCobSearch(""); }} style={{ padding: "8px 12px", cursor: "pointer", background: sel ? "#EFF6FF" : "#fff", borderBottom: "1px solid #F3F4F6", borderLeft: sel ? "3px solid #2563EB" : "3px solid transparent" }} onMouseEnter={e => { if (!sel) e.currentTarget.style.background="#FAFBFC"; }} onMouseLeave={e => { if (!sel) e.currentTarget.style.background="#fff"; }}><div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}><span style={{ fontSize: 9, color: "#9CA3AF", fontFamily: "monospace", fontWeight: 700 }}>{f.id}</span><strong style={{ fontSize: 11 }}>{f.cliente}</strong>{sel && <span style={{ fontSize: 8, background: "#2563EB", color: "#fff", padding: "1px 5px", borderRadius: 3, fontWeight: 700 }}>✓</span>}<span style={{ marginLeft: "auto", fontWeight: 700, fontSize: 11, color: isMerc ? "#DC2626" : "#2563EB" }}>Debe: {fmt(d)}</span></div><div style={{ fontSize: 10, color: "#6B7280" }}>{f.descripcion} · {f.cantBultos||1} {f.empaque||"bulto"}{(f.cantBultos||1)>1?"s":""}</div></div>; }); })()}</div>
                  {cobForm.pedidoId && (() => { const pf = data.fantasmas.find(x => x.id === cobForm.pedidoId); if (!pf) return null; const isMerc = cobForm.tipo === "mercancia"; const tot = isMerc ? pf.costoMercancia : (pf.costoFlete||0); const ab = isMerc ? (pf.abonoMercancia||0) : (pf.abonoFlete||0); return <div style={{ background: "#F9FAFB", borderRadius: 6, padding: "8px 12px", marginBottom: 8, border: "1px solid #E5E7EB", fontSize: 11 }}><strong>{pf.id}</strong> · {pf.cliente} · Total: {fmt(tot)} · Abonado: {fmt(ab)} · <strong style={{ color: "#DC2626" }}>Debe: {fmt(tot-ab)}</strong></div>; })()}
                  <div style={{ display: "flex", gap: 8 }}><Fld label="🇺🇸 Monto en USD"><Inp type="number" value={cobForm.monto} onChange={e => setCobForm({...cobForm, monto: e.target.value})} placeholder="0.00" /></Fld><Fld label="Fecha"><Inp type="date" value={cobForm.fecha} onChange={e => setCobForm({...cobForm, fecha: e.target.value})} /></Fld></div>
                  <div style={{ background: "#FEF3C7", borderRadius: 8, padding: "10px 12px", border: "1px solid #FDE68A", marginBottom: 8 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#92400E", marginBottom: 6 }}>🇲🇽 ¿También recibiste pesos?</div>
                    <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                      <Fld label="Monto MXN"><Inp type="number" value={cobForm.montoMXN || ""} onChange={e => setCobForm({...cobForm, montoMXN: e.target.value})} placeholder="0.00" /></Fld>
                      <Fld label="Tipo de cambio"><Inp type="number" value={cobForm.tipoCambio || ""} onChange={e => setCobForm({...cobForm, tipoCambio: e.target.value})} placeholder="17.50" /></Fld>
                    </div>
                    {cobForm.montoMXN && cobForm.tipoCambio && parseFloat(cobForm.tipoCambio) > 0 && (
                      <div style={{ fontSize: 11, color: "#065F46", fontWeight: 600, marginTop: 4 }}>= {fmt(parseFloat(cobForm.montoMXN) / parseFloat(cobForm.tipoCambio))} USD</div>
                    )}
                  </div>
                  {(() => {
                    const usd = parseFloat(cobForm.monto) || 0;
                    const mxn = parseFloat(cobForm.montoMXN) || 0;
                    const tc = parseFloat(cobForm.tipoCambio) || 0;
                    const mxnToUsd = tc > 0 ? mxn / tc : 0;
                    const totalUSD = usd + mxnToUsd;
                    return totalUSD > 0 ? (
                      <div style={{ background: "#ECFDF5", borderRadius: 6, padding: "8px 12px", border: "1px solid #A7F3D0", marginBottom: 8, fontSize: 11 }}>
                        <strong style={{ color: "#065F46" }}>Total abono: {fmt(totalUSD)} USD</strong>
                        {usd > 0 && <span style={{ color: "#6B7280" }}> ({fmt(usd)} USD</span>}
                        {mxnToUsd > 0 && <span style={{ color: "#6B7280" }}>{usd > 0 ? " + " : " ("}{fmt(mxn)} MXN → {fmt(mxnToUsd)} USD</span>}
                        {(usd > 0 || mxnToUsd > 0) && <span style={{ color: "#6B7280" }}>)</span>}
                      </div>
                    ) : null;
                  })()}
                  <Fld label="Nota"><Inp value={cobForm.nota} onChange={e => setCobForm({...cobForm, nota: e.target.value})} placeholder="Efectivo, transferencia..." /></Fld>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5E7EB" }}><Btn v="secondary" onClick={() => { setShowCobro(false) }}>Cancelar</Btn><Btn disabled={!cobForm.pedidoId || (!(parseFloat(cobForm.monto) > 0) && !(parseFloat(cobForm.montoMXN) > 0))} onClick={() => { const fId = cobForm.pedidoId; const usd = parseFloat(cobForm.monto) || 0; const mxn = parseFloat(cobForm.montoMXN) || 0; const tc = parseFloat(cobForm.tipoCambio) || 0; const mxnToUsd = tc > 0 ? Math.round(mxn / tc * 100) / 100 : 0; const totalUSD = usd + mxnToUsd; const f = data.fantasmas.find(x => x.id === fId); if (!f || totalUSD <= 0) return; const isMerc = cobForm.tipo === "mercancia"; const detalle = [usd > 0 ? `${fmt(usd)} USD` : "", mxnToUsd > 0 ? `${fmt(mxn)} MXN @${tc}` : ""].filter(Boolean).join(" + "); const mov = { id: Date.now(), tipo: "Entrada", concepto: isMerc ? `👻 Pago mercancía — ${detalle}${cobForm.nota ? " — " + cobForm.nota : ""}` : `🚛 Pago flete — ${detalle}${cobForm.nota ? " — " + cobForm.nota : ""}`, monto: totalUSD, montoUSD: usd, montoMXN: mxn || null, tipoCambio: tc || null, fecha: cobForm.fecha }; let upd = {}; if (isMerc) { const na = (f.abonoMercancia||0)+totalUSD; upd = { abonoMercancia: na, clientePago: na >= f.costoMercancia, clientePagoMonto: na }; } else { const na = (f.abonoFlete||0)+totalUSD; upd = { abonoFlete: na, fletePagado: na >= (f.costoFlete||0) }; } upd.movimientos = [...(f.movimientos||[]), mov]; upd.historial = [...(f.historial||[]), { fecha: cobForm.fecha, accion: `💰 Pago ${cobForm.tipo}: ${fmt(totalUSD)} (${detalle})${cobForm.nota ? " — " + cobForm.nota : ""}`, quien: role }]; upd.fechaActualizacion = today(); let nd = { ...data, fantasmas: data.fantasmas.map(x => x.id !== fId ? x : { ...x, ...upd }) }; const label = isMerc ? "PAGO FANTASMA" : "PAGO FLETE"; if (usd > 0) { nd.gastosBodega = [...(nd.gastosBodega || []), { id: Date.now() + 10, concepto: `${label} ${fId} (USD)`, monto: usd, moneda: "USD", categoria: isMerc ? "COBRO FANTASMA" : "COBRO FLETE", fecha: cobForm.fecha, nota: f.cliente, tipoMov: "ingreso" }]; } if (mxn > 0) { nd.gastosBodega = [...(nd.gastosBodega || []), { id: Date.now() + 11, concepto: `${label} ${fId} (MXN)`, monto: mxn, moneda: "MXN", categoria: isMerc ? "COBRO FANTASMA" : "COBRO FLETE", fecha: cobForm.fecha, nota: `${f.cliente} · @${tc} = ${fmt(mxnToUsd)} USD`, tipoMov: "ingreso" }]; } persist(nd); setShowCobro(false); setCobForm({...cobForm, pedidoId: "", monto: "", montoMXN: "", tipoCambio: "", nota: ""}); }} style={{ background: "#059669" }}>💰 Registrar pago</Btn></div>
                </Modal>
              )}
            </div>
          )}

          {subTab === "sobres" && (
            <div>
              {(() => {
                const allF = data.fantasmas.filter(f => f.estado !== "CERRADO");
                const enCamino = allF.filter(f => f.dineroStatus === "DINERO_CAMINO");
                const listos = allF.filter(f => f.dineroStatus === "SOBRE_LISTO");
                const recibidos = allF.filter(f => f.dineroStatus === "DINERO_USA");
                const envios = data.envios || [];
                // Group en camino by sobreOrigen
                const porAdolfo = enCamino.filter(f => f.sobreOrigen === "adolfo");
                const porAdmin = enCamino.filter(f => f.sobreOrigen === "admin");
                const totalEnCamino = enCamino.reduce((s, f) => s + (f.totalVenta || f.costoMercancia || 0), 0);
                const totalListos = listos.reduce((s, f) => s + (f.totalVenta || f.costoMercancia || 0), 0);
                return (<>
                  <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                    <div style={{ flex: "1 1 140px", background: "#DBEAFE", borderRadius: 10, padding: "14px 18px", border: "2px solid #93C5FD" }}>
                      <div style={{ fontSize: 9, fontWeight: 600, color: "#1E40AF" }}>📋 LISTOS PARA ENVIAR</div>
                      <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "monospace", color: "#2563EB" }}>{listos.length}</div>
                      <div style={{ fontSize: 9, color: "#6B7280" }}>{fmt(totalListos)}</div>
                    </div>
                    <div style={{ flex: "1 1 140px", background: "#E0E7FF", borderRadius: 10, padding: "14px 18px", border: "2px solid #C7D2FE" }}>
                      <div style={{ fontSize: 9, fontWeight: 600, color: "#3730A3" }}>📨 EN CAMINO A USA</div>
                      <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "monospace", color: "#6366F1" }}>{enCamino.length}</div>
                      <div style={{ fontSize: 9, color: "#6B7280" }}>{fmt(totalEnCamino)}</div>
                    </div>
                    <div style={{ flex: "1 1 140px", background: "#D1FAE5", borderRadius: 10, padding: "14px 18px", border: "2px solid #A7F3D0" }}>
                      <div style={{ fontSize: 9, fontWeight: 600, color: "#065F46" }}>✅ RECIBIDOS EN USA</div>
                      <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "monospace", color: "#059669" }}>{recibidos.length}</div>
                    </div>
                  </div>

                  {/* Listos para enviar */}
                  {listos.length > 0 && (<>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#2563EB", marginBottom: 6 }}>📋 Listos para enviar ({listos.length})</div>
                    {listos.map(f => (
                      <div key={f.id} onClick={() => setSel(f)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#fff", borderRadius: 6, border: "1px solid #BFDBFE", marginBottom: 3, fontSize: 11, cursor: "pointer" }}>
                        <span style={{ fontSize: 14 }}>📋</span>
                        <strong style={{ flex: 1 }}>{f.cliente}</strong>
                        <span style={{ color: "#6B7280", fontSize: 10 }}>{f.descripcion}</span>
                        <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#2563EB" }}>{fmt(f.totalVenta || f.costoMercancia)}</span>
                      </div>
                    ))}
                  </>)}

                  {/* En camino */}
                  {enCamino.length > 0 && (<>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#6366F1", marginBottom: 6, marginTop: 14 }}>📨 En camino a USA ({enCamino.length})</div>
                    {porAdmin.length > 0 && <div style={{ fontSize: 10, fontWeight: 600, color: "#92400E", marginBottom: 4 }}>💼 Enviados desde Admin ({porAdmin.length})</div>}
                    {porAdmin.map(f => (
                      <div key={f.id} onClick={() => setSel(f)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#F5F3FF", borderRadius: 6, border: "1px solid #E9D5FF", marginBottom: 3, fontSize: 11, cursor: "pointer" }}>
                        <span style={{ fontSize: 14 }}>📨</span>
                        <strong style={{ flex: 1 }}>{f.cliente}</strong>
                        <span style={{ color: "#6B7280", fontSize: 10 }}>{f.descripcion}</span>
                        <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#7C3AED" }}>{fmt(f.totalVenta || f.costoMercancia)}</span>
                        <span style={{ fontSize: 9, padding: "2px 6px", background: "#FEF3C7", borderRadius: 4, color: "#92400E" }}>💼 Admin</span>
                      </div>
                    ))}
                    {porAdolfo.length > 0 && <div style={{ fontSize: 10, fontWeight: 600, color: "#1E40AF", marginBottom: 4, marginTop: 6 }}>🇲🇽 Enviados desde Adolfo ({porAdolfo.length})</div>}
                    {porAdolfo.map(f => (
                      <div key={f.id} onClick={() => setSel(f)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#EFF6FF", borderRadius: 6, border: "1px solid #BFDBFE", marginBottom: 3, fontSize: 11, cursor: "pointer" }}>
                        <span style={{ fontSize: 14 }}>📨</span>
                        <strong style={{ flex: 1 }}>{f.cliente}</strong>
                        <span style={{ color: "#6B7280", fontSize: 10 }}>{f.descripcion}</span>
                        <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#2563EB" }}>{fmt(f.totalVenta || f.costoMercancia)}</span>
                        <span style={{ fontSize: 9, padding: "2px 6px", background: "#DBEAFE", borderRadius: 4, color: "#1E40AF" }}>🇲🇽 Adolfo</span>
                      </div>
                    ))}
                    {enCamino.filter(f => !f.sobreOrigen).length > 0 && enCamino.filter(f => !f.sobreOrigen).map(f => (
                      <div key={f.id} onClick={() => setSel(f)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#fff", borderRadius: 6, border: "1px solid #E5E7EB", marginBottom: 3, fontSize: 11, cursor: "pointer" }}>
                        <span style={{ fontSize: 14 }}>📨</span>
                        <strong style={{ flex: 1 }}>{f.cliente}</strong>
                        <span style={{ color: "#6B7280", fontSize: 10 }}>{f.descripcion}</span>
                        <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#6366F1" }}>{fmt(f.totalVenta || f.costoMercancia)}</span>
                      </div>
                    ))}
                  </>)}

                  {/* Historial de envíos */}
                  {envios.length > 0 && (<>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 6, marginTop: 14 }}>📜 Historial de envíos ({envios.length})</div>
                    {[...envios].reverse().map((e, i) => (
                      <div key={i} style={{ background: "#F9FAFB", borderRadius: 6, border: "1px solid #E5E7EB", padding: "8px 12px", marginBottom: 4 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11 }}>
                          <span style={{ fontWeight: 700 }}>📨 Envío {envios.length - i}</span>
                          <span style={{ color: "#9CA3AF", fontSize: 10 }}>{e.fecha || ""}</span>
                          <span style={{ fontSize: 9, padding: "2px 6px", background: e.origen === "admin" ? "#FEF3C7" : "#DBEAFE", borderRadius: 4, color: e.origen === "admin" ? "#92400E" : "#1E40AF" }}>{e.origen === "admin" ? "💼 Admin" : "🇲🇽 Adolfo"}</span>
                        </div>
                        <div style={{ fontSize: 10, color: "#6B7280", marginTop: 3 }}>{(e.pedidos || []).length} pedidos · {fmt((e.pedidos || []).reduce((s, p) => s + (p.monto || 0), 0))}</div>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                          {(e.pedidos || []).map((p, j) => <span key={j} style={{ fontSize: 9, background: "#E5E7EB", borderRadius: 4, padding: "2px 6px" }}>{p.cliente || "?"}</span>)}
                        </div>
                      </div>
                    ))}
                  </>)}

                  {listos.length === 0 && enCamino.length === 0 && envios.length === 0 && (
                    <div style={{ textAlign: "center", padding: 30, color: "#9CA3AF", fontSize: 11 }}>No hay sobres activos ni historial de envíos.</div>
                  )}
                </>);
              })()}
            </div>
          )}


          {subTab === "resumen" && (
            <div>
              <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 140px", background: "#ECFDF5", borderRadius: 8, padding: "12px 16px", border: "1px solid #A7F3D0" }}>
                  <div style={{ fontSize: 10, color: "#065F46", fontWeight: 600 }}>INGRESOS (PAGOS RECIBIDOS)</div>
                  <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "monospace", color: "#059669" }}>{fmt(totalCobrado)}</div>
                </div>
                <div style={{ flex: "1 1 140px", background: "#FFF7ED", borderRadius: 8, padding: "12px 16px", border: "1px solid #FED7AA" }}>
                  <div style={{ fontSize: 10, color: "#92400E", fontWeight: 600 }}>MERC. POR RECIBIR</div>
                  <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "monospace", color: "#D97706" }}>{fmt(totalPendMerc)}</div>
                </div>
                <div style={{ flex: "1 1 140px", background: "#EFF6FF", borderRadius: 8, padding: "12px 16px", border: "1px solid #BFDBFE" }}>
                  <div style={{ fontSize: 10, color: "#1E40AF", fontWeight: 600 }}>FLETE POR RECIBIR</div>
                  <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "monospace", color: "#2563EB" }}>{fmt(totalPendFlete)}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      );
    };

    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>🇲🇽 Bodega TJ</h2>
          <div style={{ display: "flex", gap: 3, background: "#F3F4F6", borderRadius: 8, padding: 3, overflow: "auto" }}>
            {[
              { k: "recibir", l: "📥 Pedido Recibido", c: enviosPend },
              { k: "entregados", l: "📦 Pedido Entregado", c: enBodegaCount },
            ].map(t => (
              <button key={t.k} onClick={() => setTab(t.k)} style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: tab === t.k ? "#fff" : "transparent", boxShadow: tab === t.k ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 11, fontWeight: tab === t.k ? 700 : 500, fontFamily: "inherit", color: tab === t.k ? "#1A2744" : "#6B7280", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                {t.l}{t.c > 0 && <span style={{ background: tab === t.k ? "#1A2744" : "#D1D5DB", color: "#fff", fontSize: 9, padding: "1px 5px", borderRadius: 8, fontWeight: 700 }}>{t.c}</span>}
              </button>
            ))}
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            <button onClick={() => setTab("transferencias")} style={{ padding: "6px 14px", borderRadius: 8, border: tab === "transferencias" ? "2px solid #7C3AED" : "1px solid #D1D5DB", background: tab === "transferencias" ? "#F5F3FF" : "#fff", cursor: "pointer", fontSize: 11, fontWeight: tab === "transferencias" ? 700 : 500, fontFamily: "inherit", color: tab === "transferencias" ? "#7C3AED" : "#6B7280", display: "flex", alignItems: "center", gap: 4 }}>🏦 Transferencias</button>
            <button onClick={() => setTab("efectivo")} style={{ padding: "6px 14px", borderRadius: 8, border: tab === "efectivo" ? "2px solid #059669" : "1px solid #D1D5DB", background: tab === "efectivo" ? "#ECFDF5" : "#fff", cursor: "pointer", fontSize: 11, fontWeight: tab === "efectivo" ? 700 : 500, fontFamily: "inherit", color: tab === "efectivo" ? "#065F46" : "#6B7280", display: "flex", alignItems: "center", gap: 4 }}>💰 Efectivo</button>
          </div>
        </div>
        {tab === "recibir" && <RecibirTJ />}

        {tab === "entregados" && <EntregadosTJ />}
        <div style={{ display: tab === "efectivo" ? "block" : "none" }}><FlujoEfectivo /></div>
        <div style={{ display: tab === "transferencias" ? "block" : "none" }}><TransferenciasTJ /></div>
      </div>
    );
  };

  // ============ ADMIN EFECTIVO ============
  const AdminEfectivo = () => {
    const [efMoneda, setEfMoneda] = useState("ALL");
    const showMov = showMovApp; const setShowMov = setShowMovApp;
    const [movForm, setMovForm] = usePersistedForm("movForm", { tipo: "ingreso", destino: "ADMIN", concepto: "", monto: "", montoUSD: "", montoMXN: "", fecha: today(), nota: "", moneda: "USD", tipoCambio: "" });
    const DESTINOS = [{ k: "ADMIN", l: "💼 Caja Admin", color: "#1A2744" }, { k: "BODEGA_USA", l: "🇺🇸 Bodega USA", color: "#2563EB" }, { k: "BODEGA_TJ", l: "🇲🇽 Bodega TJ", color: "#059669" }];

    const movs = filterByDate(data.gastosAdmin || [], "fecha");
    const byDest = (dest, tipo) => movs.filter(m => m.destino === dest && (tipo ? m.tipoMov === tipo : true));

    // Saldos separados USD y MXN (con arrastre) — supports combined USD+MXN movements
    const prevAdm = calcSaldoAnterior(data.gastosAdmin || [], "fecha");
    const ingUSD = movs.filter(m => m.tipoMov === "ingreso").reduce((s, m) => s + (m.montoUSD || (m.moneda !== "MXN" ? m.monto : 0) || 0), 0);
    const egrUSD = movs.filter(m => m.tipoMov === "egreso").reduce((s, m) => s + (m.montoUSD || (m.moneda !== "MXN" ? m.monto : 0) || 0), 0);
    const saldoUSD = prevAdm.usd + ingUSD - egrUSD;
    const ingMXN = movs.filter(m => m.tipoMov === "ingreso").reduce((s, m) => s + (m.montoMXN || (m.moneda === "MXN" ? m.monto : 0) || 0), 0);
    const egrMXN = movs.filter(m => m.tipoMov === "egreso").reduce((s, m) => s + (m.montoMXN || (m.moneda === "MXN" ? m.monto : 0) || 0), 0);
    const saldoMXN = prevAdm.mxn + ingMXN - egrMXN;
    const usdMovs = movs; // kept for compatibility
    const mxnMovs = movs; // kept for compatibility
    const fmtMXN = (n) => "$" + (n || 0).toLocaleString("en-US", { minimumFractionDigits: 2 }) + " MXN";

    const eliminarMov = async (mId) => {
      const m = (data.gastosAdmin || []).find(x => x.id === mId);
      if (!m) return;
      const desc = `${m.tipoMov === "ingreso" ? "Ingreso" : "Egreso"}: ${m.concepto || "?"} — ${fmt(m.monto || 0)}`;
      if (!await showConfirm(`¿Estás seguro de eliminar este movimiento?\n\n${desc}\n\nEsto puede afectar sobres, adelantos y pedidos vinculados.`)) return;
      const ref = m?.cambioRef;
      let nd = { ...data, gastosAdmin: (data.gastosAdmin || []).filter(x => x.id !== mId && x.id !== ref) };

      // If it's an ADELANTO egreso → remove linked adelantosAdmin entry + mark pedido
      const isAdelanto = (m.concepto || "").startsWith("ADELANTO ");
      if (isAdelanto || m.adelantoRef) {
        // Remove the adelanto entry that references this movement
        nd.adelantosAdmin = (nd.adelantosAdmin || []).filter(a => a.movRef !== mId && a.id !== m.adelantoRef);
        // Also remove recovery income if exists
        nd.gastosAdmin = nd.gastosAdmin.filter(x => x.adelantoRef !== m.adelantoRef);
        // Revert pedido.adelantoAdmin flag if no more adelantos for that pedido
        if (isAdelanto) {
          const pedId = (m.concepto || "").replace("ADELANTO ", "").split(" ")[0];
          const stillHas = nd.adelantosAdmin.some(a => a.pedidoId === pedId && !a.recuperado);
          if (!stillHas) nd.fantasmas = (nd.fantasmas || []).map(f => f.id !== pedId ? f : { ...f, adelantoAdmin: false });
        }
      }

      // If it's a SOBRE USA egreso → revert linked pedidos dineroStatus + remove adelanto
      if ((m.concepto || "").startsWith("SOBRE USA")) {
        const fIdMatch = (m.concepto || "").match(/F-\d+/);
        const fId = fIdMatch ? fIdMatch[0] : null;
        // Also find via adelantoRef cross-reference
        const adelantoLinked = fId ? null : (nd.adelantosAdmin || []).find(a => a.movRef === mId);
        const targetId = fId || adelantoLinked?.pedidoId || null;
        nd.adelantosAdmin = (nd.adelantosAdmin || []).filter(a => !(a.movRef === mId));
        nd.fantasmas = (nd.fantasmas || []).map(f => {
          const matches = f.id === targetId || (!targetId && f.dineroStatus === "DINERO_CAMINO" && f.sobreOrigen === "admin");
          if (!matches) return f;
          const nuevoStatus = (f.clientePago || (f.abonoMercancia || 0) > 0) ? "SOBRE_LISTO" : "SIN_FONDOS";
          return { ...f, dineroStatus: nuevoStatus, sobreOrigen: null, adelantoAdmin: false, historial: [...(f.historial || []), { fecha: today(), accion: "↩ Sobre deshecho — movimiento eliminado de Caja Admin", quien: "Admin" }] };
        });
      }

      // If it's a RECUPERADO ADELANTO ingreso → mark adelanto as not recovered
      if ((m.concepto || "").startsWith("RECUPERADO ADELANTO") && m.adelantoRef) {
        nd.adelantosAdmin = (nd.adelantosAdmin || []).map(a => a.id !== m.adelantoRef ? a : { ...a, recuperado: false, fechaRecuperacion: null, montoRecuperado: null });
      }

      persist(nd);
    };

    const registrar = () => {
      const montoUSD = parseFloat(movForm.montoUSD) || 0;
      const montoMXN = parseFloat(movForm.montoMXN) || 0;
      if (!movForm.concepto || (montoUSD <= 0 && montoMXN <= 0)) return;

      // Transfer to fondo
      if (movForm.tipo === "a_fondo" && movForm.fondoKey) {
        const monto = montoUSD > 0 ? montoUSD : montoMXN;
        const moneda = montoUSD > 0 ? "USD" : "MXN";
        const g = { id: Date.now(), concepto: `A FONDO: ${movForm.concepto.toUpperCase()}`, monto, moneda, montoUSD, montoMXN, destino: "FONDO", fecha: movForm.fecha, nota: movForm.nota, tipoMov: "egreso" };
        const nd = { ...data, gastosAdmin: [...(data.gastosAdmin || []), g] };
        nd.fondos = { ...(nd.fondos || {}), [movForm.fondoKey]: ((nd.fondos || {})[movForm.fondoKey] || 0) + monto };
        const fm = { ...(nd.fondosMovs || {}) };
        if (!fm[movForm.fondoKey]) fm[movForm.fondoKey] = [];
        fm[movForm.fondoKey] = [...fm[movForm.fondoKey], { f: movForm.fecha, m: monto, d: `Desde Admin: ${movForm.concepto.toUpperCase()}` }];
        nd.fondosMovs = fm;
        persist(nd);
        setShowMov(false);
        return;
      }

      const isEnvio = movForm.tipo === "envio";
      const isRecibir = movForm.tipo === "recibir";
      let tipoMov = movForm.tipo;
      if (isEnvio) tipoMov = "egreso";
      if (isRecibir) tipoMov = "ingreso";

      // Save as ONE movement with both montoUSD and montoMXN
      const g = {
        id: Date.now(),
        concepto: movForm.concepto.toUpperCase(),
        monto: montoUSD > 0 ? montoUSD : montoMXN,
        moneda: montoUSD > 0 ? "USD" : "MXN",
        montoUSD: montoUSD || 0,
        montoMXN: montoMXN || 0,
        destino: isEnvio ? movForm.destino : "ADMIN",
        origen: isRecibir ? movForm.destino : null,
        fecha: movForm.fecha,
        nota: movForm.nota,
        tipoMov
      };
      let nd = { ...data, gastosAdmin: [...(data.gastosAdmin || []), g] };

      if (isEnvio) {
        const ingBodega = { id: Date.now() + 1, concepto: `FONDO ADMIN: ${movForm.concepto.toUpperCase()}`, monto: montoUSD > 0 ? montoUSD : montoMXN, moneda: montoUSD > 0 ? "USD" : "MXN", montoUSD: montoUSD || 0, montoMXN: montoMXN || 0, categoria: "FONDO DUEÑOS", fecha: movForm.fecha, nota: movForm.nota, tipoMov: "ingreso" };
        if (movForm.destino === "BODEGA_USA") nd.gastosUSA = [...(nd.gastosUSA || []), ingBodega];
        else nd.gastosBodega = [...(nd.gastosBodega || []), ingBodega];
      }
      if (isRecibir) {
        const egrBodega = { id: Date.now() + 2, concepto: `ENTREGA A ADMIN: ${movForm.concepto.toUpperCase()}`, monto: montoUSD > 0 ? montoUSD : montoMXN, moneda: montoUSD > 0 ? "USD" : "MXN", montoUSD: montoUSD || 0, montoMXN: montoMXN || 0, categoria: "ENTREGA ADMIN", fecha: movForm.fecha, nota: movForm.nota, tipoMov: "gasto" };
        if (movForm.destino === "BODEGA_USA") nd.gastosUSA = [...(nd.gastosUSA || []), egrBodega];
        else nd.gastosBodega = [...(nd.gastosBodega || []), egrBodega];
        const pedRec = movForm.pedidosRec || {};
        const monto = montoUSD > 0 ? montoUSD : montoMXN;
        const moneda = montoUSD > 0 ? "USD" : "MXN";
        Object.keys(pedRec).filter(k => pedRec[k]).forEach(fId => {
          const tipo = pedRec[fId];
          nd.fantasmas = nd.fantasmas.map(f => f.id !== fId ? f : { ...f, [tipo === "flete" ? "fleteEntregadoAdmin" : "fantasmaEntregadoAdmin"]: true, fechaActualizacion: today(), historial: [...(f.historial || []), { fecha: today(), accion: `📥 ${tipo === "flete" ? "Flete" : "Fantasma"} entregado a Admin (${moneda === "MXN" ? fmtMXN(monto) + " MXN" : fmt(monto) + " USD"})`, quien: role }] });
        });
      }
      persist(nd);
      setShowMov(false);
    };

    const RecibSelector = () => {
      const recSearch = (movForm.recSearch || "").toLowerCase();
      const matchSearch = (f) => !recSearch || f.cliente.toLowerCase().includes(recSearch) || f.id.toLowerCase().includes(recSearch) || f.descripcion.toLowerCase().includes(recSearch) || (f.proveedor || "").toLowerCase().includes(recSearch);
      const fletesCobraods = data.fantasmas.filter(f => f.fletePagado && !f.fleteEntregadoAdmin && f.costoFlete > 0);
      const fantasmasCobrados = data.fantasmas.filter(f => f.clientePago && !f.fantasmaEntregadoAdmin);
      const fletesFiltered = fletesCobraods.filter(matchSearch);
      const fantasmasFiltered = fantasmasCobrados.filter(matchSearch);
      const pedRec = movForm.pedidosRec || {};
      const selIds = Object.keys(pedRec).filter(k => pedRec[k]);
      const totalSel = selIds.reduce((s, id) => { const f = data.fantasmas.find(x => x.id === id); return s + (pedRec[id] === "flete" ? (f?.costoFlete || 0) : (f?.costoMercancia || 0)); }, 0);
      const updateSel = (nr) => { const ids2 = Object.keys(nr).filter(k => nr[k]); const t = ids2.reduce((s2, id) => { const ff = data.fantasmas.find(x => x.id === id); return s2 + (nr[id] === "flete" ? (ff?.costoFlete || 0) : (ff?.costoMercancia || 0)); }, 0); const conc = ids2.length > 0 ? ids2.map(id => `${nr[id] === "flete" ? "FLETE" : "FANTASMA"} ${id}`).join(", ") : ""; setMovForm({ ...movForm, pedidosRec: nr, monto: String(Math.round(t * 100) / 100), concepto: conc }); };
      return (
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}><div style={{ fontSize: 11, fontWeight: 700 }}>Selecciona los pedidos que te entrega</div>{selIds.length > 0 && <span style={{ fontSize: 10, color: "#7C3AED", fontWeight: 600 }}>{selIds.length} sel.</span>}</div>
          <div style={{ position: "relative", marginBottom: 8 }}><span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "#9CA3AF" }}><I.Search /></span><input value={movForm.recSearch || ""} onChange={e => setMovForm({ ...movForm, recSearch: e.target.value })} placeholder="Buscar folio, cliente, mercancía..." autoComplete="off" style={{ width: "100%", padding: "8px 10px", paddingLeft: 28, borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, outline: "none", boxSizing: "border-box", fontFamily: "inherit", background: "#FAFAFA" }} />{movForm.recSearch && <button onClick={() => setMovForm({ ...movForm, recSearch: "" })} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#9CA3AF", fontSize: 11 }}>✕</button>}</div>
          {fletesFiltered.length > 0 && (<div style={{ marginBottom: 6 }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}><div style={{ fontSize: 10, fontWeight: 600, color: "#2563EB" }}>🚛 Fletes cobrados ({fletesFiltered.length})</div><button onClick={() => { const nr = { ...pedRec }; fletesFiltered.forEach(f => nr[f.id] = "flete"); updateSel(nr); }} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 9, color: "#2563EB", fontFamily: "inherit", textDecoration: "underline" }}>Seleccionar todos</button></div><div style={{ maxHeight: 140, overflow: "auto", border: "1px solid #E5E7EB", borderRadius: 6 }}>{fletesFiltered.map(f => { const sel = pedRec[f.id] === "flete"; return (<label key={`fl-${f.id}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", cursor: "pointer", background: sel ? "#EFF6FF" : "#fff", borderBottom: "1px solid #F3F4F6", fontSize: 11 }}><input type="checkbox" checked={sel} onChange={e => { const nr = { ...pedRec }; if (e.target.checked) nr[f.id] = "flete"; else delete nr[f.id]; updateSel(nr); }} style={{ accentColor: "#2563EB" }} /><span style={{ fontFamily: "monospace", fontSize: 9, color: "#9CA3AF" }}>{f.id}</span><strong>{f.cliente}</strong><span style={{ flex: 1, color: "#6B7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 100 }}>{f.descripcion}</span><span style={{ fontFamily: "monospace", fontWeight: 600, color: "#2563EB" }}>{fmt(f.costoFlete)}</span></label>); })}</div></div>)}
          {fantasmasFiltered.length > 0 && (<div style={{ marginBottom: 6 }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}><div style={{ fontSize: 10, fontWeight: 600, color: "#DC2626" }}>👻 Fantasmas cobrados ({fantasmasFiltered.length})</div><button onClick={() => { const nr = { ...pedRec }; fantasmasFiltered.forEach(f => nr[f.id] = "fantasma"); updateSel(nr); }} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 9, color: "#DC2626", fontFamily: "inherit", textDecoration: "underline" }}>Seleccionar todos</button></div><div style={{ maxHeight: 140, overflow: "auto", border: "1px solid #E5E7EB", borderRadius: 6 }}>{fantasmasFiltered.map(f => { const sel = pedRec[f.id] === "fantasma"; return (<label key={`fa-${f.id}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", cursor: "pointer", background: sel ? "#FEF2F2" : "#fff", borderBottom: "1px solid #F3F4F6", fontSize: 11 }}><input type="checkbox" checked={sel} onChange={e => { const nr = { ...pedRec }; if (e.target.checked) nr[f.id] = "fantasma"; else delete nr[f.id]; updateSel(nr); }} style={{ accentColor: "#DC2626" }} /><span style={{ fontFamily: "monospace", fontSize: 9, color: "#9CA3AF" }}>{f.id}</span><strong>{f.cliente}</strong><span style={{ flex: 1, color: "#6B7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 100 }}>{f.descripcion}</span><span style={{ fontFamily: "monospace", fontWeight: 600, color: "#DC2626" }}>{fmt(f.costoMercancia)}</span></label>); })}</div></div>)}
          {selIds.length > 0 && <div style={{ fontSize: 11, fontWeight: 700, color: "#7C3AED", padding: "6px 10px", background: "#F5F3FF", borderRadius: 6 }}>{selIds.length} pedido{selIds.length > 1 ? "s" : ""} · Total: {fmt(totalSel)}</div>}
          {fletesCobraods.length === 0 && fantasmasCobrados.length === 0 && <div style={{ textAlign: "center", padding: 16, color: "#9CA3AF", fontSize: 11 }}>No hay cobros pendientes de entrega.</div>}
        </div>
      );
    };


    const [efSearch, setEfSearch] = useState("");
    const [efTipo, setEfTipo] = useState("ALL");
    const [editEfCell, setEditEfCell] = useState(null); // { id, field, val }

    const saveEfCell = () => {
      if (!editEfCell) return;
      const { id, field, val } = editEfCell;
      const movs2 = data.gastosAdmin || [];
      const m = movs2.find(x => x.id === id);
      if (!m) { setEditEfCell(null); return; }
      let parsed = val.trim();
      if (field === "monto" || field === "montoUSD" || field === "montoMXN") parsed = parseFloat(val) || 0;
      if (String(m[field] ?? "") === String(parsed)) { setEditEfCell(null); return; }
      const updated = movs2.map(x => x.id !== id ? x : { ...x, [field]: parsed });
      persist({ ...data, gastosAdmin: updated });
      setEditEfCell(null);
    };

    const EfCell = ({ m, field, style = {}, type = "text" }) => {
      const isEditing = editEfCell?.id === m.id && editEfCell?.field === field;
      if (isEditing) return (
        <input autoFocus type={type} value={editEfCell.val}
          onChange={e => setEditEfCell({ ...editEfCell, val: e.target.value })}
          onBlur={saveEfCell}
          onKeyDown={e => { if (e.key === "Enter") saveEfCell(); if (e.key === "Escape") setEditEfCell(null); }}
          onClick={e => e.stopPropagation()}
          style={{ width: "100%", fontSize: 11, border: "2px solid #2563EB", borderRadius: 4, padding: "2px 4px", fontFamily: type === "number" ? "monospace" : "inherit", background: "#EFF6FF", outline: "none", ...style }} />
      );
      return (
        <span onDoubleClick={e => { e.stopPropagation(); setEditEfCell({ id: m.id, field, val: String(m[field] ?? "") }); }}
          title="Doble click para editar"
          style={{ cursor: "cell", display: "block", minHeight: 16, ...style }}>
          {m[field] ?? "—"}
        </span>
      );
    };
    const efS = efSearch.toLowerCase();
    const filteredMovs = movs.filter(m => (efMoneda === "ALL" || m.moneda === efMoneda || (efMoneda === "USD" && m.moneda !== "MXN")) && (efTipo === "ALL" || m.tipoMov === efTipo) && (!efS || (m.concepto || "").toLowerCase().includes(efS) || (m.nota || "").toLowerCase().includes(efS) || (m.destino || "").toLowerCase().includes(efS) || (m.origen || "").toLowerCase().includes(efS)));
    const sortedMovs = [...filteredMovs].sort((a, b) => new Date(b.fecha) - new Date(a.fecha) || b.id - a.id);

    return (
      <div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
          <div style={{ display: "flex", gap: 4 }}>
            <Btn sz="sm" onClick={() => { setMovForm({ tipo: "ingreso", destino: "ADMIN", concepto: "", monto: "", montoUSD: "", montoMXN: "", fecha: today(), nota: "", moneda: "USD", tipoCambio: "" }); setShowMov(true); }} style={{ background: "#059669" }}>💰 Ingreso</Btn>
            <Btn sz="sm" onClick={() => { setMovForm({ tipo: "egreso", destino: "ADMIN", concepto: "", monto: "", montoUSD: "", montoMXN: "", fecha: today(), nota: "", moneda: "USD", tipoCambio: "" }); setShowMov(true); }} style={{ background: "#DC2626" }}>💸 Gasto</Btn>
            <Btn sz="sm" onClick={() => { setMovForm({ tipo: "envio", destino: "BODEGA_USA", concepto: "", monto: "", montoUSD: "", montoMXN: "", fecha: today(), nota: "", moneda: "USD", tipoCambio: "" }); setShowMov(true); }} style={{ background: "#2563EB" }}>📤 Enviar</Btn>
            <Btn sz="sm" onClick={() => { setMovForm({ tipo: "recibir", destino: "BODEGA_TJ", concepto: "", monto: "", montoUSD: "", montoMXN: "", fecha: today(), nota: "", moneda: "USD", tipoCambio: "", pedidosRec: {}, recSearch: "" }); setShowMov(true); }} style={{ background: "#7C3AED" }}>📥 Recibir</Btn>
            <Btn sz="sm" onClick={() => { setMovForm({ tipo: "cambio", concepto: "", monto: "", montoUSD: "", montoMXN: "", fecha: today(), nota: "", moneda: "USD", tipoCambio: "" }); setShowMov(true); }} style={{ background: "#7C3AED" }}>💱 Cambio</Btn>
          </div>
        </div>

        {/* Saldos separados */}
        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 180px", background: "#EFF6FF", borderRadius: 10, padding: "16px 20px", border: "2px solid #BFDBFE" }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: "#1E40AF", textTransform: "uppercase" }}>🇺🇸 Caja USD</div>
            <div style={{ fontSize: 26, fontWeight: 700, fontFamily: "monospace", color: saldoUSD >= 0 ? "#1A2744" : "#DC2626" }}>{fmt(saldoUSD)}</div>
            <div style={{ fontSize: 9, color: "#6B7280" }}>+{fmt(ingUSD)} ingresos · -{fmt(egrUSD)} salidas</div>
          </div>
          <div style={{ flex: "1 1 180px", background: "#FEF3C7", borderRadius: 10, padding: "16px 20px", border: "2px solid #FDE68A" }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: "#92400E", textTransform: "uppercase" }}>🇲🇽 Caja MXN</div>
            <div style={{ fontSize: 26, fontWeight: 700, fontFamily: "monospace", color: saldoMXN >= 0 ? "#92400E" : "#DC2626" }}>{fmtMXN(saldoMXN)}</div>
            <div style={{ fontSize: 9, color: "#6B7280" }}>+{fmtMXN(ingMXN)} ingresos · -{fmtMXN(egrMXN)} salidas</div>
          </div>
        </div>

        {/* Adelantos summary link */}
        {(data.adelantosAdmin || []).filter(a => !a.recuperado).length > 0 && <div onClick={() => setFinTab("adelantos")} style={{ background: "#FEF3C7", borderRadius: 8, padding: "10px 14px", border: "1px solid #FDE68A", marginBottom: 14, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}><div><span style={{ fontSize: 11, fontWeight: 700, color: "#92400E" }}>💸 {(data.adelantosAdmin || []).filter(a => !a.recuperado).length} adelantos pendientes</span><span style={{ fontSize: 11, color: "#D97706", marginLeft: 6 }}>{fmt((data.adelantosAdmin || []).filter(a => !a.recuperado).reduce((s, a) => s + (a.monto || 0), 0))}</span></div><span style={{ fontSize: 10, color: "#D97706" }}>Ver →</span></div>}


        {/* Movements list */}
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Movimientos</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
          <div style={{ position: "relative", flex: "1 1 200px" }}><span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "#9CA3AF" }}><I.Search /></span><input value={efSearch} onChange={e => setEfSearch(e.target.value)} placeholder="Buscar concepto, nota..." autoFocus={!!efSearch} autoComplete="off" style={{ width: "100%", padding: "8px 10px", paddingLeft: 28, borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, outline: "none", boxSizing: "border-box", fontFamily: "inherit", background: "#FAFAFA" }} /></div>
          <div style={{ display: "flex", gap: 2, background: "#F3F4F6", borderRadius: 6, padding: 2 }}>
            <button onClick={() => setEfMoneda("ALL")} style={{ padding: "5px 10px", borderRadius: 5, border: "none", background: efMoneda === "ALL" ? "#fff" : "transparent", boxShadow: efMoneda === "ALL" ? "0 1px 2px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 10, fontWeight: efMoneda === "ALL" ? 700 : 500, fontFamily: "inherit", color: efMoneda === "ALL" ? "#374151" : "#9CA3AF" }}>Todos</button>
            <button onClick={() => setEfMoneda("USD")} style={{ padding: "5px 10px", borderRadius: 5, border: "none", background: efMoneda === "USD" ? "#fff" : "transparent", boxShadow: efMoneda === "USD" ? "0 1px 2px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 10, fontWeight: efMoneda === "USD" ? 700 : 500, fontFamily: "inherit", color: efMoneda === "USD" ? "#1A2744" : "#9CA3AF" }}>🇺🇸 USD</button>
            <button onClick={() => setEfMoneda("MXN")} style={{ padding: "5px 10px", borderRadius: 5, border: "none", background: efMoneda === "MXN" ? "#fff" : "transparent", boxShadow: efMoneda === "MXN" ? "0 1px 2px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 10, fontWeight: efMoneda === "MXN" ? 700 : 500, fontFamily: "inherit", color: efMoneda === "MXN" ? "#92400E" : "#9CA3AF" }}>🇲🇽 MXN</button>
          </div>
          <div style={{ display: "flex", gap: 2, background: "#F3F4F6", borderRadius: 6, padding: 2 }}>
            <button onClick={() => setEfTipo("ALL")} style={{ padding: "5px 10px", borderRadius: 5, border: "none", background: efTipo === "ALL" ? "#fff" : "transparent", boxShadow: efTipo === "ALL" ? "0 1px 2px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 10, fontWeight: efTipo === "ALL" ? 700 : 500, fontFamily: "inherit", color: efTipo === "ALL" ? "#374151" : "#9CA3AF" }}>Todos</button>
            <button onClick={() => setEfTipo("ingreso")} style={{ padding: "5px 10px", borderRadius: 5, border: "none", background: efTipo === "ingreso" ? "#fff" : "transparent", boxShadow: efTipo === "ingreso" ? "0 1px 2px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 10, fontWeight: efTipo === "ingreso" ? 700 : 500, fontFamily: "inherit", color: efTipo === "ingreso" ? "#059669" : "#9CA3AF" }}>💰 Ingresos</button>
            <button onClick={() => setEfTipo("egreso")} style={{ padding: "5px 10px", borderRadius: 5, border: "none", background: efTipo === "egreso" ? "#fff" : "transparent", boxShadow: efTipo === "egreso" ? "0 1px 2px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 10, fontWeight: efTipo === "egreso" ? 700 : 500, fontFamily: "inherit", color: efTipo === "egreso" ? "#DC2626" : "#9CA3AF" }}>💸 Gastos</button>
          </div>
        </div>
        {sortedMovs.length === 0 && (prevAdm.usd === 0 && prevAdm.mxn === 0) ? <p style={{ color: "#9CA3AF", fontSize: 11, textAlign: "center", padding: 30 }}>Sin movimientos.</p> : (
          <div style={{ overflowX: "auto" }}>
            {/* Excel-style table header */}
            <div style={{ display: "grid", gridTemplateColumns: "90px 80px 1fr 110px 110px 28px", gap: 0, background: "#F3F4F6", color: "#374151", borderRadius: "8px 8px 0 0", padding: "6px 10px", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
              <div>Fecha</div>
              <div>Tipo</div>
              <div>Concepto</div>
              <div style={{ textAlign: "right", color: "#059669" }}>🇺🇸 USD</div>
              <div style={{ textAlign: "right", color: "#D97706" }}>🇲🇽 MXN</div>
              <div></div>
            </div>
            <div style={{ border: "1px solid #E5E7EB", borderTop: "none", borderRadius: "0 0 8px 8px", overflow: "hidden" }}>
              {/* Saldo anterior row */}
              {periodoTipo !== "global" && (prevAdm.usd !== 0 || prevAdm.mxn !== 0) && (
                <div style={{ display: "grid", gridTemplateColumns: "70px 80px 1fr 110px 110px 28px", gap: 0, padding: "6px 10px", background: "#F9FAFB", borderBottom: "2px dashed #D1D5DB", fontSize: 11 }}>
                  <div style={{ color: "#9CA3AF", fontSize: 9 }}>—</div>
                  <div style={{ fontSize: 9, color: "#6B7280", fontWeight: 600 }}>ANTERIOR</div>
                  <div style={{ color: "#6B7280", fontWeight: 600 }}>Saldo anterior al período</div>
                  <div style={{ textAlign: "right", fontFamily: "monospace", fontWeight: 700, color: prevAdm.usd >= 0 ? "#059669" : "#DC2626" }}>{prevAdm.usd !== 0 ? fmt(prevAdm.usd) : ""}</div>
                  <div style={{ textAlign: "right", fontFamily: "monospace", fontWeight: 700, color: prevAdm.mxn >= 0 ? "#D97706" : "#DC2626" }}>{prevAdm.mxn !== 0 ? fmtMXN(prevAdm.mxn) : ""}</div>
                  <div></div>
                </div>
              )}
              {sortedMovs.map((m, idx) => {
                const isIng = m.tipoMov === "ingreso";
                const isMXN = m.moneda === "MXN";
                const dest = DESTINOS.find(d => d.k === m.destino);
                const tipoLabel = isIng ? (m.origen ? `← ${m.origen === "BODEGA_USA" ? "USA" : "TJ"}` : "INGRESO") : m.destino !== "ADMIN" ? `→ ${dest?.l?.replace(/[🇺🇸🇲🇽💼]/g,"").trim() || m.destino}` : "GASTO";
                return (
                  <div key={m.id} style={{ display: "grid", gridTemplateColumns: "90px 80px 1fr 110px 110px 28px", gap: 0, padding: "5px 10px", background: idx % 2 === 0 ? "#fff" : "#FAFAFA", borderBottom: "1px solid #F3F4F6", fontSize: 11, alignItems: "center" }}>
                    <div><EfCell m={m} field="fecha" type="date" style={{ fontSize: 10, color: "#6B7280" }} /></div>
                    <div style={{ fontSize: 9, background: isIng ? "#D1FAE5" : "#FEE2E2", color: isIng ? "#065F46" : "#991B1B", padding: "1px 5px", borderRadius: 3, fontWeight: 700, display: "inline-block" }}>{tipoLabel}</div>
                    <div style={{ overflow: "hidden" }}>
                      <EfCell m={m} field="concepto" style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} />
                      {(() => {
                        const folioMatch = (m.concepto||"").match(/\b(F-\d+)\b/);
                        const linkedId = m.gananciaPedidoId || (m.adelantoRef && (data.adelantosAdmin||[]).find(a => a.id === m.adelantoRef)?.pedidoId) || folioMatch?.[1];
                        const linkedPedido = linkedId ? data.fantasmas.find(f => f.id === linkedId) : null;
                        return linkedPedido ? <span onClick={() => { navigate("detail", linkedPedido.id, view); setDetailMode("full"); }} style={{ marginLeft: 6, fontSize: 9, background: "#EFF6FF", color: "#2563EB", border: "1px solid #BFDBFE", borderRadius: 4, padding: "1px 6px", cursor: "pointer", fontWeight: 700 }}>→ {linkedPedido.id}</span> : null;
                      })()}
                      <EfCell m={m} field="nota" style={{ fontSize: 9, color: "#9CA3AF" }} />
                    </div>
                    <div>{!isMXN && <EfCell m={m} field="montoUSD" type="number" style={{ textAlign: "right", fontFamily: "monospace", fontWeight: 700, color: isIng ? "#059669" : "#DC2626" }} />}</div>
                    <div>{isMXN && <EfCell m={m} field="monto" type="number" style={{ textAlign: "right", fontFamily: "monospace", fontWeight: 700, color: isIng ? "#D97706" : "#DC2626" }} />}</div>
                    <div><button onClick={() => eliminarMov(m.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#D1D5DB", padding: 2 }} onMouseEnter={e => e.currentTarget.style.color = "#DC2626"} onMouseLeave={e => e.currentTarget.style.color = "#D1D5DB"}><I.Trash /></button></div>
                  </div>
                );
              })}
              {/* Totals row */}
              <div style={{ display: "grid", gridTemplateColumns: "70px 80px 1fr 110px 110px 28px", gap: 0, padding: "8px 10px", background: "#F3F4F6", color: "#374151", borderRadius: "0 0 8px 8px", fontSize: 11, fontWeight: 700 }}>
                <div></div><div></div>
                <div style={{ fontSize: 10, color: "#94A3B8" }}>SALDO PERÍODO</div>
                <div style={{ textAlign: "right", fontFamily: "monospace", color: saldoUSD >= 0 ? "#059669" : "#DC2626" }}>{fmt(saldoUSD)}</div>
                <div style={{ textAlign: "right", fontFamily: "monospace", color: saldoMXN >= 0 ? "#D97706" : "#DC2626" }}>{fmtMXN(saldoMXN)}</div>
                <div></div>
              </div>
            </div>
          </div>
        )}
        {showMov && (
          <Modal title={movForm.tipo === "ingreso" ? "💰 Registrar ingreso" : movForm.tipo === "egreso" ? "💸 Registrar gasto" : movForm.tipo === "envio" ? "📤 Enviar a bodega" : movForm.tipo === "cambio" ? "💱 Cambio de moneda" : "📥 Recibir de bodega"} onClose={() => { setShowMov(false) }} w={480}>
            {/* Cambio de moneda */}
            {movForm.tipo === "cambio" && (
              <div>
                <Fld label="Dirección del cambio">
                  <div style={{ display: "flex", gap: 3 }}>
                    <button onClick={() => setMovForm({ ...movForm, moneda: "USD" })} style={{ flex: 1, padding: "10px 12px", borderRadius: 8, border: movForm.moneda === "USD" ? "2px solid #2563EB" : "1px solid #D1D5DB", background: movForm.moneda === "USD" ? "#EFF6FF" : "#fff", cursor: "pointer", textAlign: "center" }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: movForm.moneda === "USD" ? "#1E40AF" : "#6B7280" }}>🇺🇸 → 🇲🇽</div>
                      <div style={{ fontSize: 10, color: "#9CA3AF" }}>Dólares a pesos</div>
                    </button>
                    <button onClick={() => setMovForm({ ...movForm, moneda: "MXN" })} style={{ flex: 1, padding: "10px 12px", borderRadius: 8, border: movForm.moneda === "MXN" ? "2px solid #D97706" : "1px solid #D1D5DB", background: movForm.moneda === "MXN" ? "#FEF3C7" : "#fff", cursor: "pointer", textAlign: "center" }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: movForm.moneda === "MXN" ? "#92400E" : "#6B7280" }}>🇲🇽 → 🇺🇸</div>
                      <div style={{ fontSize: 10, color: "#9CA3AF" }}>Pesos a dólares</div>
                    </button>
                  </div>
                </Fld>
                <div style={{ display: "flex", gap: 8 }}>
                  <Fld label={movForm.moneda === "USD" ? "Entrego USD" : "Entrego MXN"}><Inp type="number" value={movForm.monto} onChange={e => setMovForm({ ...movForm, monto: e.target.value })} placeholder="0.00" /></Fld>
                  <Fld label="Tipo de cambio"><Inp type="number" value={movForm.tipoCambio || ""} onChange={e => setMovForm({ ...movForm, tipoCambio: e.target.value })} placeholder="17.50" /></Fld>
                </div>
                {movForm.monto && movForm.tipoCambio && parseFloat(movForm.tipoCambio) > 0 && (
                  <div style={{ background: "#ECFDF5", borderRadius: 8, padding: "10px 14px", border: "1px solid #A7F3D0", marginBottom: 8, textAlign: "center" }}>
                    <div style={{ fontSize: 11, color: "#6B7280" }}>Recibo:</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: "#059669" }}>{movForm.moneda === "USD" ? "$" + (parseFloat(movForm.monto) * parseFloat(movForm.tipoCambio)).toLocaleString("en-US", {minimumFractionDigits: 2}) + " MXN" : fmt(parseFloat(movForm.monto) / parseFloat(movForm.tipoCambio))}</div>
                  </div>
                )}
                <Fld label="Fecha"><Inp type="date" value={movForm.fecha} onChange={e => setMovForm({ ...movForm, fecha: e.target.value })} /></Fld>
                <Fld label="Nota (opcional)"><Inp value={movForm.nota} onChange={e => setMovForm({ ...movForm, nota: e.target.value })} placeholder="Casa de cambio, lugar..." /></Fld>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5E7EB" }}>
                  <Btn v="secondary" onClick={() => { setShowMov(false) }}>Cancelar</Btn>
                  <Btn disabled={!(parseFloat(movForm.monto) > 0) || !(parseFloat(movForm.tipoCambio) > 0)} onClick={() => {
                    const mo = parseFloat(movForm.monto);
                    const tc = parseFloat(movForm.tipoCambio);
                    const esUSDaMXN = movForm.moneda === "USD";
                    const montoDestino = esUSDaMXN ? Math.round(mo * tc * 100) / 100 : Math.round(mo / tc * 100) / 100;
                    const cambioId = Date.now();
                    const egreso = { id: cambioId, concepto: `CAMBIO ${esUSDaMXN ? "USD→MXN" : "MXN→USD"} @${tc}`, monto: mo, moneda: esUSDaMXN ? "USD" : "MXN", destino: "ADMIN", fecha: movForm.fecha, nota: movForm.nota, tipoMov: "egreso", cambioRef: cambioId + 1 };
                    const ingreso = { id: cambioId + 1, concepto: `CAMBIO ${esUSDaMXN ? "USD→MXN" : "MXN→USD"} @${tc}`, monto: montoDestino, moneda: esUSDaMXN ? "MXN" : "USD", destino: "ADMIN", fecha: movForm.fecha, nota: movForm.nota, tipoMov: "ingreso", cambioRef: cambioId };
                    persist({ ...data, gastosAdmin: [...(data.gastosAdmin || []), egreso, ingreso] });
                    setShowMov(false);
                  }} style={{ background: "#7C3AED" }}>💱 Registrar cambio</Btn>
                </div>
              </div>
            )}
            {movForm.tipo !== "cambio" && <><Fld label="Tipo">
              <div style={{ display: "flex", gap: 3 }}>
                <button onClick={() => setMovForm({ ...movForm, tipo: "ingreso", destino: "ADMIN" })} style={{ flex: 1, padding: "8px 12px", borderRadius: 6, border: movForm.tipo === "ingreso" ? "2px solid #059669" : "1px solid #D1D5DB", background: movForm.tipo === "ingreso" ? "#ECFDF5" : "#fff", color: movForm.tipo === "ingreso" ? "#065F46" : "#6B7280", fontWeight: movForm.tipo === "ingreso" ? 700 : 500, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>💰 Ingreso</button>
                <button onClick={() => setMovForm({ ...movForm, tipo: "egreso", destino: "ADMIN" })} style={{ flex: 1, padding: "8px 12px", borderRadius: 6, border: movForm.tipo === "egreso" ? "2px solid #DC2626" : "1px solid #D1D5DB", background: movForm.tipo === "egreso" ? "#FEF2F2" : "#fff", color: movForm.tipo === "egreso" ? "#DC2626" : "#6B7280", fontWeight: movForm.tipo === "egreso" ? 700 : 500, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>💸 Gasto</button>
                <button onClick={() => setMovForm({ ...movForm, tipo: "envio", destino: "BODEGA_USA" })} style={{ flex: 1, padding: "8px 12px", borderRadius: 6, border: movForm.tipo === "envio" ? "2px solid #2563EB" : "1px solid #D1D5DB", background: movForm.tipo === "envio" ? "#EFF6FF" : "#fff", color: movForm.tipo === "envio" ? "#2563EB" : "#6B7280", fontWeight: movForm.tipo === "envio" ? 700 : 500, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>📤 Enviar</button>
                <button onClick={() => setMovForm({ ...movForm, tipo: "recibir", destino: "BODEGA_TJ" })} style={{ flex: 1, padding: "8px 12px", borderRadius: 6, border: movForm.tipo === "recibir" ? "2px solid #7C3AED" : "1px solid #D1D5DB", background: movForm.tipo === "recibir" ? "#F5F3FF" : "#fff", color: movForm.tipo === "recibir" ? "#7C3AED" : "#6B7280", fontWeight: movForm.tipo === "recibir" ? 700 : 500, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>📥 Recibir</button>
                <button onClick={() => setMovForm({ ...movForm, tipo: "a_fondo", destino: "ADMIN" })} style={{ flex: 1, padding: "8px 12px", borderRadius: 6, border: movForm.tipo === "a_fondo" ? "2px solid #D97706" : "1px solid #D1D5DB", background: movForm.tipo === "a_fondo" ? "#FEF3C7" : "#fff", color: movForm.tipo === "a_fondo" ? "#92400E" : "#6B7280", fontWeight: movForm.tipo === "a_fondo" ? 700 : 500, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>🏦 A fondo</button>
              </div>
            </Fld>
            {(movForm.tipo === "envio" || movForm.tipo === "recibir") && (
              <Fld label={movForm.tipo === "envio" ? "Destino" : "Recibir de"}>
                <div style={{ display: "flex", gap: 3 }}>
                  <button onClick={() => setMovForm({ ...movForm, destino: "BODEGA_USA", pedidosRec: {} })} style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: movForm.destino === "BODEGA_USA" ? "2px solid #2563EB" : "1px solid #D1D5DB", background: movForm.destino === "BODEGA_USA" ? "#EFF6FF" : "#fff", color: movForm.destino === "BODEGA_USA" ? "#2563EB" : "#6B7280", fontWeight: movForm.destino === "BODEGA_USA" ? 700 : 500, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>🇺🇸 Bodega USA</button>
                  <button onClick={() => setMovForm({ ...movForm, destino: "BODEGA_TJ", pedidosRec: {} })} style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: movForm.destino === "BODEGA_TJ" ? "2px solid #059669" : "1px solid #D1D5DB", background: movForm.destino === "BODEGA_TJ" ? "#ECFDF5" : "#fff", color: movForm.destino === "BODEGA_TJ" ? "#059669" : "#6B7280", fontWeight: movForm.destino === "BODEGA_TJ" ? 700 : 500, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>🇲🇽 Bodega TJ</button>
                </div>
              </Fld>
            )}
            {/* Pedido selection for recibir - select which fletes/fantasmas Adolfo is handing over */}
            {movForm.tipo === "recibir" && <RecibSelector />}
            {movForm.tipo === "a_fondo" && (
              <Fld label="Selecciona fondo">
                <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                  {[{k:"comisiones",l:"🤝 Comisiones",c:"#7C3AED"},{k:"ganancias",l:"💰 Ganancias",c:"#059669"},{k:"deudaClientes",l:"👥 Deuda Clientes",c:"#D97706"},{k:"gastosMensuales",l:"🏠 Gastos Mensuales",c:"#2563EB"}, ...(data.fondosCustom || []).map(cf => ({k:cf.k,l:"📁 "+cf.nombre,c:cf.color}))].map(fo => (
                    <button key={fo.k} onClick={() => setMovForm({ ...movForm, fondoKey: fo.k, concepto: movForm.concepto || fo.l.toUpperCase() })} style={{ flex: "1 1 45%", padding: "8px 10px", borderRadius: 6, border: movForm.fondoKey === fo.k ? `2px solid ${fo.c}` : "1px solid #D1D5DB", background: movForm.fondoKey === fo.k ? "#F5F3FF" : "#fff", color: movForm.fondoKey === fo.k ? fo.c : "#6B7280", fontWeight: movForm.fondoKey === fo.k ? 700 : 500, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>{fo.l}</button>
                  ))}
                </div>
              </Fld>
            )}
            <Fld label="Concepto *"><Inp value={movForm.concepto} onChange={e => setMovForm({ ...movForm, concepto: e.target.value.toUpperCase() })} placeholder={movForm.tipo === "envio" ? "SOBRE, FONDO SEMANAL..." : "DESCRIPCIÓN..."} style={{ textTransform: "uppercase" }} /></Fld>
            {/* Monto USD y MXN al mismo tiempo */}
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              <Fld label="🇺🇸 Monto USD">
                <div style={{ position: "relative" }}>
                  <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "#059669", fontWeight: 700, fontSize: 13 }}>$</span>
                  <Inp type="number" value={movForm.montoUSD || ""} onChange={e => setMovForm({ ...movForm, montoUSD: e.target.value, monto: e.target.value, moneda: "USD" })} placeholder="0.00" style={{ paddingLeft: 24 }} />
                </div>
              </Fld>
              <Fld label="🇲🇽 Monto MXN">
                <div style={{ position: "relative" }}>
                  <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "#D97706", fontWeight: 700, fontSize: 13 }}>$</span>
                  <Inp type="number" value={movForm.montoMXN || ""} onChange={e => setMovForm({ ...movForm, montoMXN: e.target.value, monto: movForm.montoUSD ? movForm.montoUSD : e.target.value, moneda: movForm.montoUSD ? "USD" : "MXN" })} placeholder="0.00" style={{ paddingLeft: 24 }} />
                </div>
              </Fld>
              <Fld label="Fecha"><Inp type="date" value={movForm.fecha} onChange={e => setMovForm({ ...movForm, fecha: e.target.value })} /></Fld>
            </div>
            {/* Preview */}
            {((parseFloat(movForm.montoUSD) > 0) || (parseFloat(movForm.montoMXN) > 0)) && (
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                {parseFloat(movForm.montoUSD) > 0 && <div style={{ flex: 1, background: "#ECFDF5", borderRadius: 8, padding: "8px 12px", border: "1px solid #A7F3D0", textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: "#6B7280", fontWeight: 600 }}>USD</div>
                  <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "monospace", color: "#059669" }}>{fmt(parseFloat(movForm.montoUSD))}</div>
                </div>}
                {parseFloat(movForm.montoMXN) > 0 && <div style={{ flex: 1, background: "#FEF3C7", borderRadius: 8, padding: "8px 12px", border: "1px solid #FDE68A", textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: "#6B7280", fontWeight: 600 }}>MXN</div>
                  <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "monospace", color: "#D97706" }}>${parseFloat(movForm.montoMXN).toLocaleString("en-US", { minimumFractionDigits: 2 })}</div>
                </div>}
              </div>
            )}
            <Fld label="Nota"><Inp value={movForm.nota} onChange={e => setMovForm({ ...movForm, nota: e.target.value })} placeholder="Detalle..." /></Fld>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5E7EB" }}>
              <Btn v="secondary" onClick={() => { setShowMov(false) }}>Cancelar</Btn>
              <Btn disabled={!movForm.concepto || !(parseFloat(movForm.monto) > 0) || (movForm.tipo === "a_fondo" && !movForm.fondoKey)} onClick={registrar} style={{ background: movForm.tipo === "ingreso" ? "#059669" : movForm.tipo === "envio" ? "#2563EB" : movForm.tipo === "recibir" ? "#7C3AED" : movForm.tipo === "a_fondo" ? "#D97706" : "#DC2626" }}>{movForm.tipo === "ingreso" ? "💰 Registrar ingreso" : movForm.tipo === "envio" ? "📤 Enviar" : movForm.tipo === "recibir" ? "📥 Recibir" : movForm.tipo === "a_fondo" ? "🏦 Transferir a fondo" : "💸 Registrar gasto"}</Btn>
            </div></>}
          </Modal>
        )}
      </div>
    );
  };

  // ============ ADMIN TRANSFERENCIAS ============
  const AdminTransferencias = () => {
    const [atSearch2, setAtSearch2] = useState("");
    const [atFCuenta2, setAtFCuenta2] = useState("ALL");
    const CUENTAS_ADM = [
      { id: "scotiabank", banco: "SCOTIABANK", titular: "Cinthia Jazmin Ramos Leon", color: "#DC2626", uso: "flete", tag: "FLETES" },
      { id: "banorte", banco: "BANORTE", titular: "Ismael Ochoa", color: "#DC2626", uso: "flete", tag: "FLETES" },
      { id: "azteca_cinthia", banco: "BANCO AZTECA", titular: "Cinthia Jazmin Ramos Leon", color: "#2563EB", uso: "fantasma", tag: "MERCANCÍA" },
      { id: "azteca_ismael", banco: "BANCO AZTECA", titular: "Ismael Ochoa Duran", color: "#2563EB", uso: "fantasma", tag: "MERCANCÍA" },
    ];
    const allTrans = data.transferencias || [];
    const filtered = filterByDate(allTrans, "fecha");
    const pendientes = filtered.filter(t => !t.confirmada && !t.noRecibida);
    const confirmadas = filtered.filter(t => t.confirmada);
    const noRecibidas = filtered.filter(t => t.noRecibida);
    const viewList = atTab === "pendientes" ? pendientes : atTab === "confirmadas" ? confirmadas : atTab === "norecibidas" ? noRecibidas : filtered;
    const s2 = atSearch2.toLowerCase();
    const list = viewList.filter(t => !s2 || (t.cliente||"").toLowerCase().includes(s2) || (t.pedidoId||"").toLowerCase().includes(s2) || (t.banco||"").toLowerCase().includes(s2) || (t.nota||"").toLowerCase().includes(s2)).filter(t => atFCuenta2 === "ALL" || t.cuentaId === atFCuenta2);
    const fmtMXN2 = (n) => "$" + (n||0).toLocaleString("en-US",{minimumFractionDigits:2});
    const totalMXN = list.reduce((s,t) => s+(t.montoMXN||0),0);
    const totalUSD = list.reduce((s,t) => s+(t.montoUSD||0),0);
    const cTotals = CUENTAS_ADM.map(c => { const ts = allTrans.filter(t => t.cuentaId === c.id); const conf = ts.filter(t => t.confirmada); const pend = ts.filter(t => !t.confirmada && !t.noRecibida); return { ...c, saldoMXN: conf.reduce((s,t)=>s+(t.montoMXN||0),0), saldoUSD: conf.reduce((s,t)=>s+(t.montoUSD||0),0), countAll: ts.length, pendCount: pend.length, pendMXN: pend.reduce((s,t)=>s+(t.montoMXN||0),0) }; });
    const confirmarT = (id) => {
      const t = allTrans.find(x => x.id === id);
      if (!t) return;
      let nd = { ...data, transferencias: allTrans.map(x => x.id !== id ? x : { ...x, confirmada: true, noRecibida: false, fechaConfirmacion: today(), confirmadaPor: role }) };
      const montoUSD = t.montoUSD || 0;
      const pedido = data.fantasmas.find(f => f.id === t.pedidoId);
      if (t.tipo === "flete") {
        const nuevoAbono = (pedido?.abonoFlete || 0) + montoUSD;
        nd.fantasmas = nd.fantasmas.map(f => f.id !== t.pedidoId ? f : {
          ...f, abonoFlete: nuevoAbono,
          fletePagado: nuevoAbono >= (f.costoFlete || 0),
          transferenciaPendiente: false,
          dineroStatus: f.clientePago ? (nuevoAbono >= (f.costoFlete||0) ? "TODO_PAGADO" : "FANTASMA_PAGADO") : f.dineroStatus,
          fechaActualizacion: today(),
          historial: [...(f.historial || []), { fecha: today(), accion: `✅ Transferencia flete confirmada: ${fmt(montoUSD)} → ${t.banco}`, quien: role }]
        });
        if (pedido) nd.gastosBodega = [...(nd.gastosBodega||[]), { id: Date.now(), concepto: `PAGO FLETE TRANS ${t.pedidoId}`, monto: montoUSD, moneda: "USD", categoria: "COBRO FLETE", fecha: today(), nota: pedido.cliente, tipoMov: "ingreso" }];
      } else {
        const nuevoAbono = (pedido?.abonoMercancia || 0) + montoUSD;
        const fleteOk = pedido ? (pedido.fletePagado || !!pedido.soloRecoger) : false;
        const mercOk = nuevoAbono >= (pedido?.totalVenta || pedido?.costoMercancia || 0);
        nd.fantasmas = nd.fantasmas.map(f => f.id !== t.pedidoId ? f : {
          ...f, abonoMercancia: nuevoAbono,
          clientePago: mercOk,
          clientePagoMonto: nuevoAbono,
          transferenciaPendiente: false,
          dineroStatus: mercOk ? (fleteOk ? "TODO_PAGADO" : "FANTASMA_PAGADO") : "SIN_FONDOS",
          fechaActualizacion: today(),
          historial: [...(f.historial || []), { fecha: today(), accion: `✅ Transferencia fantasma confirmada: ${fmt(montoUSD)} → ${t.banco}`, quien: role }]
        });
        if (pedido) nd.gastosBodega = [...(nd.gastosBodega||[]), { id: Date.now(), concepto: `PAGO FANTASMA TRANS ${t.pedidoId}`, monto: montoUSD, moneda: "USD", categoria: "COBRO FANTASMA", fecha: today(), nota: pedido.cliente, tipoMov: "ingreso" }];
      }
      persist(nd);
    };
    const desconfirmarT = (id) => {
      const t = allTrans.find(x => x.id === id);
      if (!t) return;
      let nd = { ...data, transferencias: allTrans.map(x => x.id !== id ? x : { ...x, confirmada: false, fechaConfirmacion: null }) };
      const montoUSD = t.montoUSD || 0;
      const pedido = data.fantasmas.find(f => f.id === t.pedidoId);
      if (t.tipo === "flete") {
        const nuevoAbono = Math.max(0, (pedido?.abonoFlete || 0) - montoUSD);
        nd.fantasmas = nd.fantasmas.map(f => f.id !== t.pedidoId ? f : { ...f, abonoFlete: nuevoAbono, fletePagado: nuevoAbono >= (f.costoFlete||0), dineroStatus: f.clientePago ? "FANTASMA_PAGADO" : f.dineroStatus });
        nd.gastosBodega = (nd.gastosBodega||[]).filter(g => !((g.concepto||"").includes(t.pedidoId) && g.categoria === "COBRO FLETE" && (g.concepto||"").includes("TRANS")));
      } else {
        const nuevoAbono = Math.max(0, (pedido?.abonoMercancia || 0) - montoUSD);
        nd.fantasmas = nd.fantasmas.map(f => f.id !== t.pedidoId ? f : { ...f, abonoMercancia: nuevoAbono, clientePago: false, clientePagoMonto: nuevoAbono, dineroStatus: "TRANS_PENDIENTE" });
        nd.gastosBodega = (nd.gastosBodega||[]).filter(g => !((g.concepto||"").includes(t.pedidoId) && g.categoria === "COBRO FANTASMA" && (g.concepto||"").includes("TRANS")));
      }
      persist(nd);
    };
    const noRecibidaT = (id) => persist({...data, transferencias: allTrans.map(t => t.id !== id ? t : {...t, noRecibida: true, confirmada: false, fechaNoRecibida: today()})});
    const revertirT = (id) => persist({...data, transferencias: allTrans.map(t => t.id !== id ? t : {...t, noRecibida: false, fechaNoRecibida: null})});

    return (
      <div>
        <h3 style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 700 }}>Transferencias — Admin</h3>
        <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 130px", background: "#FEF2F2", borderRadius: 8, padding: "12px 16px", border: pendientes.length > 0 ? "2px solid #FECACA" : "1px solid #FECACA" }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: "#991B1B" }}>POR CONFIRMAR</div>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "monospace", color: "#DC2626" }}>{pendientes.length}</div>
            <div style={{ fontSize: 9, color: "#9CA3AF" }}>{fmtMXN2(pendientes.reduce((s,t)=>s+(t.montoMXN||0),0))} MXN</div>
          </div>
          <div style={{ flex: "1 1 130px", background: "#ECFDF5", borderRadius: 8, padding: "12px 16px", border: "1px solid #A7F3D0" }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: "#065F46" }}>CONFIRMADAS</div>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "monospace", color: "#059669" }}>{confirmadas.length}</div>
            <div style={{ fontSize: 9, color: "#9CA3AF" }}>{fmtMXN2(confirmadas.reduce((s,t)=>s+(t.montoMXN||0),0))} MXN</div>
          </div>
          <div style={{ flex: "1 1 130px", background: "#F5F3FF", borderRadius: 8, padding: "12px 16px", border: "1px solid #E9D5FF" }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: "#7C3AED" }}>TOTAL PERIODO</div>
            <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "monospace", color: "#7C3AED" }}>{fmtMXN2(filtered.reduce((s,t)=>s+(t.montoMXN||0),0))}</div>
            <div style={{ fontSize: 9, color: "#9CA3AF" }}>{fmt(filtered.reduce((s,t)=>s+(t.montoUSD||0),0))} USD</div>
          </div>
        </div>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Saldo por cuenta</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 6, marginBottom: 14 }}>
          {cTotals.map(c => (
            <div key={c.id} onClick={() => setAtFCuenta2(atFCuenta2 === c.id ? "ALL" : c.id)} style={{ background: atFCuenta2 === c.id ? (c.uso === "flete" ? "#FEF2F2" : "#EFF6FF") : "#fff", borderRadius: 8, padding: "10px 14px", border: atFCuenta2 === c.id ? "2px solid " + c.color : "1px solid #E5E7EB", cursor: "pointer" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 3 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: c.color }}>{c.banco}</span>
                <span style={{ fontSize: 8, background: c.uso === "flete" ? "#FEE2E2" : "#DBEAFE", color: c.uso === "flete" ? "#991B1B" : "#1E40AF", padding: "1px 4px", borderRadius: 2, fontWeight: 600 }}>{c.tag}</span>
              </div>
              <div style={{ fontSize: 9, color: "#6B7280" }}>{c.titular}</div>
              <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "monospace", color: c.color }}>{fmtMXN2(c.saldoMXN)}</div>
              <div style={{ fontSize: 9, color: "#6B7280" }}>{fmt(c.saldoUSD)} USD conf.</div>
              {c.pendCount > 0 && <div style={{ fontSize: 9, color: "#DC2626", fontWeight: 600 }}>{c.pendCount} pend.</div>}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 3, background: "#F3F4F6", borderRadius: 8, padding: 3, marginBottom: 8 }}>
          {[{k:"pendientes",l:"Por confirmar ("+pendientes.length+")",c:"#D97706"},{k:"confirmadas",l:"Confirmadas ("+confirmadas.length+")",c:"#059669"},{k:"norecibidas",l:"No recibidas ("+noRecibidas.length+")",c:"#DC2626"},{k:"todas",l:"Todas ("+filtered.length+")",c:"#374151"}].map(t => (
            <button key={t.k} onClick={() => setAtTab(t.k)} style={{ flex: 1, padding: "5px 10px", borderRadius: 5, border: "none", background: atTab === t.k ? "#fff" : "transparent", boxShadow: atTab === t.k ? "0 1px 2px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 10, fontWeight: atTab === t.k ? 700 : 500, fontFamily: "inherit", color: atTab === t.k ? t.c : "#9CA3AF" }}>{t.l}</button>
          ))}
        </div>
        <div style={{ position: "relative", marginBottom: 8 }}><span style={{ position: "absolute", left: 7, top: "50%", transform: "translateY(-50%)", color: "#9CA3AF" }}><I.Search /></span><input value={atSearch2} onChange={e => setAtSearch2(e.target.value)} placeholder="Buscar folio, cliente, banco..." autoComplete="off" style={{ width: "100%", padding: "7px 10px", paddingLeft: 26, borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, outline: "none", boxSizing: "border-box", fontFamily: "inherit", background: "#FAFAFA" }} /></div>
        <div style={{ fontSize: 10, color: "#9CA3AF", marginBottom: 6 }}>{list.length} transferencias</div>
        {list.length === 0 ? <div style={{ textAlign: "center", padding: 20, color: "#9CA3AF", fontSize: 11 }}>Sin transferencias.</div> :
          <div style={{ maxHeight: 400, overflow: "auto" }}>
            {list.sort((a,b) => new Date(b.fecha)-new Date(a.fecha)||b.id-a.id).map(t => {
              const pf = data.fantasmas.find(f => f.id === t.pedidoId);
              const isPend = !t.confirmada && !t.noRecibida;
              return (
                <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", background: t.noRecibida ? "#FEF2F2" : isPend ? "#FFF7ED" : "#fff", borderRadius: 6, border: t.noRecibida ? "2px solid #FECACA" : isPend ? "2px solid #FDE68A" : "1px solid #E5E7EB", marginBottom: 3, fontSize: 11, flexWrap: "wrap" }}>
                  <span style={{ color: "#9CA3AF", fontSize: 9 }}>{fmtD(t.fecha)}</span>
                  <span style={{ fontSize: 9, background: t.tipo === "flete" ? "#DBEAFE" : "#FEE2E2", color: t.tipo === "flete" ? "#1E40AF" : "#991B1B", padding: "1px 5px", borderRadius: 3, fontWeight: 600 }}>{t.tipo === "flete" ? "FLETE" : "FANTASMA"}</span>
                  <span style={{ fontFamily: "monospace", fontSize: 9, color: "#9CA3AF" }}>{t.pedidoId}</span>
                  <strong>{t.cliente || pf?.cliente || ""}</strong>
                  <span style={{ fontSize: 9, color: "#6B7280", background: "#F3F4F6", padding: "1px 4px", borderRadius: 3 }}>{t.banco}</span>
                  <span style={{ flex: 1 }} />
                  {t.montoMXN > 0 && <span style={{ fontFamily: "monospace", fontWeight: 600, color: "#7C3AED" }}>{fmtMXN2(t.montoMXN)}</span>}
                  {t.tipoCambio > 0 && <span style={{ fontSize: 9, color: "#9CA3AF" }}>@{t.tipoCambio}</span>}
                  <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#059669" }}>{fmt(t.montoUSD)}</span>
                  {isPend && <div style={{ display: "flex", gap: 2 }}><button onClick={() => confirmarT(t.id)} style={{ padding: "3px 8px", borderRadius: 5, border: "2px solid #059669", background: "#ECFDF5", color: "#065F46", fontWeight: 700, fontSize: 10, cursor: "pointer", fontFamily: "inherit" }}>✅</button><button onClick={() => noRecibidaT(t.id)} style={{ padding: "3px 8px", borderRadius: 5, border: "2px solid #DC2626", background: "#FEF2F2", color: "#991B1B", fontWeight: 700, fontSize: 10, cursor: "pointer", fontFamily: "inherit" }}>❌</button></div>}
                  {t.noRecibida && <div style={{ display: "flex", gap: 2, alignItems: "center" }}><span style={{ padding: "2px 6px", borderRadius: 4, background: "#FEE2E2", color: "#991B1B", fontWeight: 700, fontSize: 9 }}>NO RECIBIDA</span><button onClick={() => revertirT(t.id)} style={{ padding: "2px 6px", borderRadius: 4, border: "1px solid #D1D5DB", background: "#fff", color: "#6B7280", fontSize: 9, cursor: "pointer", fontFamily: "inherit" }}>↩</button></div>}
                  {t.confirmada && <div style={{ display: "flex", gap: 2, alignItems: "center" }}><span style={{ padding: "2px 6px", borderRadius: 4, background: "#D1FAE5", color: "#065F46", fontWeight: 700, fontSize: 9 }}>CONFIRMADA</span><button onClick={() => desconfirmarT(t.id)} style={{ padding: "2px 6px", borderRadius: 4, border: "1px solid #D1D5DB", background: "#fff", color: "#6B7280", fontSize: 9, cursor: "pointer", fontFamily: "inherit" }}>↩</button></div>}
                </div>
              );
            })}
          </div>
        }
      </div>
    );
  };

  // ============ ADMIN ADELANTOS (standalone tab) ============

  // ============ ADMIN ADELANTOS (standalone tab) ============
  const AdminAdelantos = () => {
    const [adelSearch, setAdelSearch] = useState("");
    const showAdelanto = showAdelantoApp; const setShowAdelanto = setShowAdelantoApp;
    const [showRecuperar, setShowRecuperar] = useModalState("showRecuperar", null);
    const [adelTab, setAdelTab] = useState("pendientes");
    const [recForm, setRecForm] = usePersistedForm("recForm", { monto: "", montoMXN: "", tipoCambio: "", fecha: today(), nota: "" });

    const [adelForm, setAdelForm] = usePersistedForm("adelForm", { pedidoId: "", monto: "", fecha: today(), nota: "", pedSearch: "" });

    const adelantos = data.adelantosAdmin || [];
    const adelantosPend = adelantos.filter(a => !a.recuperado);
    const adelantosRec = adelantos.filter(a => a.recuperado);
    const totalPend = adelantosPend.reduce((s, a) => s + (a.monto || 0), 0);
    const totalRec = adelantosRec.reduce((s, a) => s + (a.montoRecuperado || a.monto || 0), 0);

    const admMovs = data.gastosAdmin || [];
    const admUSD = admMovs.filter(m => m.moneda !== "MXN");
    const saldoAdmin = admUSD.filter(m => m.tipoMov === "ingreso").reduce((s, m) => s + (m.montoUSD || m.monto || 0), 0) - admUSD.filter(m => m.tipoMov === "egreso").reduce((s, m) => s + (m.montoUSD || m.monto || 0), 0);

    const adelS = adelSearch.toLowerCase();
    const filtPend = adelantosPend.filter(a => { const pf = data.fantasmas.find(x => x.id === a.pedidoId); return !adelS || (a.pedidoId || "").toLowerCase().includes(adelS) || (pf?.cliente || "").toLowerCase().includes(adelS) || (pf?.descripcion || "").toLowerCase().includes(adelS); });
    const filtRec = adelantosRec.filter(a => { const pf = data.fantasmas.find(x => x.id === a.pedidoId); return !adelS || (a.pedidoId || "").toLowerCase().includes(adelS) || (pf?.cliente || "").toLowerCase().includes(adelS); });

    const VIA_LABELS = { transferencia: "🏦 Transferencia", adolfo: "👤 Pagó a Adolfo (Bodega TJ)", efectivo: "💵 Efectivo" };
    const VIA_COLORS = { transferencia: "#2563EB", adolfo: "#7C3AED", efectivo: "#059669" };

    return (
      <div>
        {/* Header */}
        <div style={{ background: "#FEF3C7", borderRadius: 10, padding: "12px 16px", marginBottom: 14, border: "1px solid #FDE68A" }}>
          <div style={{ fontSize: 11, color: "#92400E", lineHeight: 1.5 }}>
            💡 <strong>¿Qué es un adelanto?</strong> Cuando mandas dinero de Administración para comprar la mercancía de un cliente antes de que te pague. El adelanto queda pendiente hasta que el cliente pague — ya sea por transferencia o entregándole el dinero a Adolfo en Bodega TJ.
          </div>
        </div>

        {/* Stats */}
        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 140px", background: "#FEF2F2", borderRadius: 10, padding: "14px 18px", border: "2px solid #FECACA" }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: "#991B1B", textTransform: "uppercase" }}>⏳ Pendientes de cobrar</div>
            <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "monospace", color: "#DC2626" }}>{fmt(totalPend)}</div>
            <div style={{ fontSize: 9, color: "#9CA3AF" }}>{adelantosPend.length} adelanto{adelantosPend.length !== 1 ? "s" : ""}</div>
          </div>
          <div style={{ flex: "1 1 140px", background: "#ECFDF5", borderRadius: 10, padding: "14px 18px", border: "1px solid #A7F3D0" }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: "#065F46", textTransform: "uppercase" }}>✅ Recuperados</div>
            <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "monospace", color: "#059669" }}>{fmt(totalRec)}</div>
            <div style={{ fontSize: 9, color: "#9CA3AF" }}>{adelantosRec.length} adelanto{adelantosRec.length !== 1 ? "s" : ""}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Btn onClick={() => { setAdelForm({ pedidoId: "", monto: "", fecha: today(), nota: "", pedSearch: "" }); setShowAdelanto(true); }} style={{ background: "#D97706" }}>💸 Nuevo adelanto</Btn>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 3, background: "#F3F4F6", borderRadius: 8, padding: 3, marginBottom: 12 }}>
          <button onClick={() => setAdelTab("pendientes")} style={{ flex: 1, padding: "7px 12px", borderRadius: 6, border: "none", background: adelTab === "pendientes" ? "#fff" : "transparent", boxShadow: adelTab === "pendientes" ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 11, fontWeight: adelTab === "pendientes" ? 700 : 500, fontFamily: "inherit", color: adelTab === "pendientes" ? "#DC2626" : "#6B7280" }}>
            ⏳ Pendientes{adelantosPend.length > 0 && <span style={{ marginLeft: 5, background: "#DC2626", color: "#fff", borderRadius: 8, padding: "1px 6px", fontSize: 9, fontWeight: 700 }}>{adelantosPend.length}</span>}
          </button>
          <button onClick={() => setAdelTab("pagados")} style={{ flex: 1, padding: "7px 12px", borderRadius: 6, border: "none", background: adelTab === "pagados" ? "#fff" : "transparent", boxShadow: adelTab === "pagados" ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 11, fontWeight: adelTab === "pagados" ? 700 : 500, fontFamily: "inherit", color: adelTab === "pagados" ? "#059669" : "#6B7280" }}>
            ✅ Pagados ({adelantosRec.length})
          </button>
        </div>

        {/* Search */}
        <div style={{ position: "relative", marginBottom: 10 }}>
          <span style={{ position: "absolute", left: 7, top: "50%", transform: "translateY(-50%)", color: "#9CA3AF" }}><I.Search /></span>
          <input value={adelSearch} onChange={e => setAdelSearch(e.target.value)} placeholder="Buscar folio, cliente..." autoComplete="off" style={{ width: "100%", padding: "7px 10px", paddingLeft: 26, borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, outline: "none", boxSizing: "border-box", fontFamily: "inherit", background: "#FAFAFA" }} />
        </div>

        {/* Pendientes tab */}
        {adelTab === "pendientes" && (
          filtPend.length === 0
            ? <div style={{ textAlign: "center", padding: 40, color: "#9CA3AF" }}><div style={{ fontSize: 32, marginBottom: 8 }}>✅</div><p style={{ fontSize: 12 }}>No hay adelantos pendientes.</p></div>
            : filtPend.map(a => {
                const pf = data.fantasmas.find(x => x.id === a.pedidoId);
                return (
                  <div key={a.id} style={{ background: "#fff", borderRadius: 8, border: "1px solid #FECACA", borderLeft: "4px solid #DC2626", padding: "12px 14px", marginBottom: 8 }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 3 }}>
                          <span style={{ fontSize: 9, fontFamily: "monospace", color: "#9CA3AF", fontWeight: 700 }}>{a.pedidoId}</span>
                          <strong style={{ fontSize: 13 }}>{pf?.cliente || "—"}</strong>
                          <span style={{ fontSize: 10, color: "#6B7280" }}>{pf?.descripcion || a.nota || ""}</span>
                        </div>
                        <div style={{ fontSize: 10, color: "#9CA3AF" }}>Adelantado el {fmtD(a.fecha)}</div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "monospace", color: "#DC2626" }}>{fmt(a.monto)}</div>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 10, justifyContent: "flex-end" }}>
                      <button onClick={async () => { if (!await showConfirm(`¿Eliminar adelanto de ${fmt(a.monto)}?`)) return; persist({ ...data, adelantosAdmin: adelantos.filter(x => x.id !== a.id), gastosAdmin: (data.gastosAdmin || []).filter(m => m.id !== a.movRef && m.adelantoRef !== a.id) }); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#D1D5DB", padding: 4 }} onMouseEnter={e => e.currentTarget.style.color = "#DC2626"} onMouseLeave={e => e.currentTarget.style.color = "#D1D5DB"}><I.Trash /></button>
                      <Btn sz="sm" onClick={() => {
                        const pf2 = data.fantasmas.find(x => x.id === a.pedidoId);
                        const transAmt = (data.transferencias||[]).filter(t => t.pedidoId === a.pedidoId && t.confirmada && t.tipo === "fantasma").reduce((s,t) => s+(t.montoUSD||0), 0);
                        const abonoTotal = pf2?.abonoMercancia || 0;
                        const cashAmt = Math.max(0, Math.round((abonoTotal - transAmt)*100)/100);
                        setRecForm({ montoTrans: transAmt > 0 ? String(transAmt) : "", monto: cashAmt > 0 ? String(cashAmt) : "", montoMXN: "", tipoCambio: "", fecha: today(), nota: "" });
                        setShowRecuperar(a.id);
                      }} style={{ background: "#059669" }}>💰 Marcar como cobrado</Btn>
                    </div>
                  </div>
                );
              })
        )}

        {/* Pagados tab */}
        {adelTab === "pagados" && (
          filtRec.length === 0
            ? <div style={{ textAlign: "center", padding: 40, color: "#9CA3AF" }}><div style={{ fontSize: 32, marginBottom: 8 }}>📭</div><p style={{ fontSize: 12 }}>No hay adelantos pagados aún.</p></div>
            : filtRec.map(a => {
                const pf = data.fantasmas.find(x => x.id === a.pedidoId);
                const viaLabel = VIA_LABELS[a.viaRecuperacion] || a.viaRecuperacion || "—";
                const viaColor = VIA_COLORS[a.viaRecuperacion] || "#6B7280";
                return (
                  <div key={a.id} style={{ background: "#F9FAFB", borderRadius: 8, border: "1px solid #E5E7EB", borderLeft: "4px solid #059669", padding: "12px 14px", marginBottom: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 2 }}>
                          <span style={{ fontSize: 9, fontFamily: "monospace", color: "#9CA3AF", fontWeight: 700 }}>{a.pedidoId}</span>
                          <strong style={{ fontSize: 12 }}>{pf?.cliente || "—"}</strong>
                        </div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <span style={{ fontSize: 10, background: "#ECFDF5", color: viaColor, padding: "1px 6px", borderRadius: 4, fontWeight: 600, border: `1px solid ${viaColor}22` }}>{viaLabel}</span>
                          <span style={{ fontSize: 10, color: "#9CA3AF" }}>Cobrado el {fmtD(a.fechaRecuperacion)}</span>
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "monospace", color: "#059669" }}>{fmt(a.montoRecuperado || a.monto)}</div>
                        {a.detalleRecuperacion && <div style={{ fontSize: 9, color: "#9CA3AF" }}>{a.detalleRecuperacion}</div>}
                      </div>
                    </div>
                  </div>
                );
              })
        )}

        {/* Modal nuevo adelanto */}
        {showAdelanto && (
          <Modal title="💸 Nuevo adelanto" onClose={() => { setShowAdelanto(false) }} w={480}>
            <div style={{ fontSize: 11, color: "#92400E", background: "#FEF3C7", padding: "8px 12px", borderRadius: 6, marginBottom: 12, border: "1px solid #FDE68A" }}>
              Registra aquí cuando mandas dinero de Admin para comprar mercancía de un cliente antes de que pague.
            </div>
            <Fld label="Pedido *">
              <div style={{ position: "relative", marginBottom: 4 }}>
                <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "#9CA3AF" }}><I.Search /></span>
                <input value={adelForm.pedSearch} onChange={e => setAdelForm({ ...adelForm, pedSearch: e.target.value })} placeholder="Buscar folio, cliente..." autoComplete="off" style={{ width: "100%", padding: "7px 10px", paddingLeft: 28, borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, outline: "none", boxSizing: "border-box", fontFamily: "inherit", background: "#FAFAFA" }} />
              </div>
              <div style={{ maxHeight: 140, overflow: "auto", border: "1px solid #E5E7EB", borderRadius: 6 }}>
                {(() => {
                  let peds = data.fantasmas.filter(f => f.estado !== "CERRADO" && !f.clientePago);
                  if (adelForm.pedSearch) { const s = adelForm.pedSearch.toLowerCase(); peds = peds.filter(f => f.cliente.toLowerCase().includes(s) || f.id.toLowerCase().includes(s) || f.descripcion.toLowerCase().includes(s)); }
                  if (peds.length === 0) return <div style={{ padding: 12, textAlign: "center", color: "#9CA3AF", fontSize: 11 }}>No hay pedidos sin pagar</div>;
                  return peds.slice(0, 12).map(f => {
                    const sel = adelForm.pedidoId === f.id;
                    return <div key={f.id} onClick={() => setAdelForm({ ...adelForm, pedidoId: f.id, monto: String(f.costoMercancia), pedSearch: "" })} style={{ padding: "6px 10px", cursor: "pointer", background: sel ? "#ECFDF5" : "#fff", borderBottom: "1px solid #F3F4F6", borderLeft: sel ? "3px solid #059669" : "3px solid transparent" }}>
                      <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                        <span style={{ fontSize: 9, fontFamily: "monospace", color: "#9CA3AF", fontWeight: 700 }}>{f.id}</span>
                        <strong style={{ fontSize: 11 }}>{f.cliente}</strong>
                        {sel && <span style={{ fontSize: 8, background: "#059669", color: "#fff", padding: "1px 5px", borderRadius: 3 }}>✓</span>}
                        <span style={{ marginLeft: "auto", fontWeight: 600, fontSize: 10, color: "#DC2626" }}>{fmt(f.costoMercancia)}</span>
                      </div>
                      <div style={{ fontSize: 10, color: "#6B7280" }}>{f.descripcion}</div>
                    </div>;
                  });
                })()}
              </div>
            </Fld>
            <div style={{ display: "flex", gap: 8 }}>
              <Fld label="Monto USD *"><Inp type="number" value={adelForm.monto} onChange={e => setAdelForm({ ...adelForm, monto: e.target.value })} placeholder="0.00" /></Fld>
              <Fld label="Fecha"><Inp type="date" value={adelForm.fecha} onChange={e => setAdelForm({ ...adelForm, fecha: e.target.value })} /></Fld>
            </div>
            {adelForm.pedidoId && adelantos.some(a => a.pedidoId === adelForm.pedidoId && !a.recuperado) && <div style={{ background: "#FEF3C7", borderRadius: 6, padding: "6px 10px", marginBottom: 6, fontSize: 11, color: "#92400E", fontWeight: 600 }}>⚠️ Este pedido ya tiene un adelanto activo pendiente de cobrar — no se puede crear otro</div>}
              {parseFloat(adelForm.monto) > saldoAdmin && <div style={{ background: "#FEE2E2", borderRadius: 6, padding: "6px 10px", marginBottom: 6, fontSize: 11, color: "#991B1B", fontWeight: 600 }}>⚠️ Saldo insuficiente — tienes {fmt(saldoAdmin)} USD</div>}
            <Fld label="Nota (opcional)"><Inp value={adelForm.nota} onChange={e => setAdelForm({ ...adelForm, nota: e.target.value })} placeholder="Detalle..." /></Fld>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5E7EB" }}>
              <Btn v="secondary" onClick={() => { setShowAdelanto(false) }}>Cancelar</Btn>
              <Btn disabled={!adelForm.pedidoId || !(parseFloat(adelForm.monto) > 0) || adelantos.some(a => a.pedidoId === adelForm.pedidoId && !a.recuperado)} onClick={() => {
                const monto = parseFloat(adelForm.monto) || 0;
                const refId = Date.now();
                const a = { id: refId, pedidoId: adelForm.pedidoId, monto, fecha: adelForm.fecha, nota: adelForm.nota, recuperado: false, movRef: refId + 1 };
                const egr = { id: refId + 1, concepto: `ADELANTO ${adelForm.pedidoId} — ${(() => { const pf = data.fantasmas.find(x => x.id === adelForm.pedidoId); return pf ? pf.cliente + (pf.descripcion ? " · " + pf.descripcion : "") : ""; })()}`, monto, montoUSD: monto, montoMXN: 0, moneda: "USD", destino: "ADMIN", fecha: adelForm.fecha, nota: adelForm.nota, tipoMov: "egreso", adelantoRef: refId };
                let nd = { ...data, adelantosAdmin: [...adelantos, a], gastosAdmin: [...(data.gastosAdmin || []), egr] };
                nd.fantasmas = nd.fantasmas.map(f => f.id !== adelForm.pedidoId ? f : { ...f, adelantoAdmin: true, fechaActualizacion: today(), historial: [...(f.historial || []), { fecha: adelForm.fecha, accion: `💸 Admin adelantó ${fmt(monto)}`, quien: role }] });
                persist(nd);
                setShowAdelanto(false);
              }} style={{ background: "#D97706" }}>💸 Registrar adelanto</Btn>
            </div>
          </Modal>
        )}

        {/* Modal cobrar adelanto */}
        {showRecuperar && (() => {
          const adel = adelantos.find(a => a.id === showRecuperar);
          if (!adel) return null;
          const pf = data.fantasmas.find(x => x.id === adel.pedidoId);
          const totalPedido = pf ? (pf.totalVenta || pf.costoMercancia || 0) : adel.monto;
          const abonoActual = pf ? (pf.abonoMercancia || 0) : 0;
          // $0 adelantos (soloRecoger, costo $0) are always "complete" — nothing to recover
          const esAdelantoZero = adel.monto === 0 || adel.monto == null;

          // What was already paid via confirmed transfers
          const transConfirmadas = (data.transferencias || []).filter(t => t.pedidoId === adel.pedidoId && t.confirmada && t.tipo === "fantasma");
          const transTotal = transConfirmadas.reduce((s, t) => s + (t.montoUSD || 0), 0);

          // What was paid in cash via Bodega TJ (movimientos with concepto "mercancía")
          const movsBodega = (pf?.movimientos || []).filter(m => (m.concepto||"").toLowerCase().includes("mercancía") || (m.concepto||"").toLowerCase().includes("mercancia"));
          const efectivoAdolfo = movsBodega.reduce((s, m) => s + (m.montoUSD || m.monto || 0), 0);

          // Effective: cash = abonoActual - transTotal
          const efectivoCash = Math.max(0, Math.round((abonoActual - transTotal) * 100) / 100);

          const totalRecibido = abonoActual;
          const faltante = esAdelantoZero ? 0 : Math.max(0, totalPedido - totalRecibido);
          const pagadoCompleto = esAdelantoZero || totalRecibido >= totalPedido || (pf?.clientePago && totalRecibido >= totalPedido * 0.999);
          const hayPagosParciales = !esAdelantoZero && totalRecibido > 0 && !pagadoCompleto;

          // Pre-fill form when opening (if fields are empty)
          const transPreFill = transTotal > 0 ? String(Math.round(transTotal * 100) / 100) : "";
          const cashPreFill = efectivoCash > 0 ? String(efectivoCash) : "";

          return (
            <Modal title="💰 Cobrar adelanto" onClose={() => setShowRecuperar(null)} w={480}>
              {/* Resumen */}
              <div style={{ background: "#F9FAFB", borderRadius: 8, padding: "10px 14px", marginBottom: 12, border: "1px solid #E5E7EB", fontSize: 11 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span><strong>{adel.pedidoId}</strong> · {pf?.cliente || "—"}</span>
                  <span style={{ color: "#D97706", fontWeight: 700 }}>Adelantado: {fmt(adel.monto)}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, fontSize: 10 }}>
                  <div style={{ background: "#fff", borderRadius: 6, padding: "6px 8px", border: "1px solid #E5E7EB" }}>
                    <div style={{ color: "#9CA3AF", marginBottom: 2 }}>Total pedido</div>
                    <div style={{ fontWeight: 700 }}>{fmt(totalPedido)}</div>
                  </div>
                  <div style={{ background: transTotal > 0 ? "#EFF6FF" : "#fff", borderRadius: 6, padding: "6px 8px", border: "1px solid #BFDBFE" }}>
                    <div style={{ color: "#2563EB", marginBottom: 2 }}>🏦 Trans. confirmada</div>
                    <div style={{ fontWeight: 700, color: "#1D4ED8" }}>{transTotal > 0 ? fmt(transTotal) : "—"}</div>
                  </div>
                  <div style={{ background: efectivoCash > 0 ? "#F5F3FF" : "#fff", borderRadius: 6, padding: "6px 8px", border: "1px solid #E9D5FF" }}>
                    <div style={{ color: "#6D28D9", marginBottom: 2 }}>💵 Efectivo (Adolfo)</div>
                    <div style={{ fontWeight: 700, color: "#5B21B6" }}>{efectivoCash > 0 ? fmt(efectivoCash) : "—"}</div>
                  </div>
                </div>
                {faltante > 0 && <div style={{ marginTop: 8, color: "#DC2626", fontSize: 10, fontWeight: 600 }}>⚠ Falta recibir: {fmt(faltante)}</div>}
              </div>

              {!pagadoCompleto ? (
                <div style={{ background: "#FEF2F2", borderRadius: 8, padding: "14px 16px", border: "1px solid #FECACA" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#DC2626", marginBottom: 6 }}>⛔ Pago incompleto — no puedes cobrar el adelanto</div>
                  {hayPagosParciales ? (
                    <div style={{ fontSize: 11, color: "#7F1D1D" }}>
                      El cliente ha pagado <strong>{fmt(totalRecibido)}</strong> de <strong>{fmt(totalPedido)}</strong> — falta <strong>{fmt(faltante)}</strong>.
                      <div style={{ marginTop: 6 }}>Registra el resto en <strong>Bodega TJ → Pagos Clientes</strong> o confirma la transferencia pendiente.</div>
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, color: "#7F1D1D" }}>
                      El cliente aún no ha pagado.
                      <div style={{ marginTop: 6 }}>• Que Adolfo registre el pago en <strong>Bodega TJ → Pagos Clientes</strong></div>
                      <div>• O confirma una <strong>transferencia</strong> de este pedido</div>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div style={{ background: "#ECFDF5", borderRadius: 6, padding: "8px 12px", marginBottom: 12, border: "1px solid #A7F3D0", fontSize: 11, color: "#065F46", fontWeight: 600 }}>
                    ✅ Pago completo — confirma cómo recuperaste el adelanto
                  </div>

                  {/* Transferencia — read-only, pre-filled, does NOT create gastosAdmin ingreso */}
                  <div style={{ background: "#EFF6FF", borderRadius: 8, border: "1px solid #BFDBFE", padding: "10px 14px", marginBottom: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#1D4ED8", marginBottom: 4 }}>🏦 Vía transferencia bancaria</div>
                    <div style={{ fontSize: 10, color: "#3B82F6", marginBottom: 8 }}>Ya registrado en el sistema — no crea nuevo ingreso en Caja Admin</div>
                    <Fld label="Monto transferido (USD)">
                      <Inp type="number"
                        value={recForm.montoTrans || ""}
                        onChange={e => setRecForm({ ...recForm, montoTrans: e.target.value })}
                        placeholder="0.00" />
                    </Fld>
                    {transTotal > 0 && (recForm.montoTrans === undefined || recForm.montoTrans === "") &&
                      <div style={{ fontSize: 10, color: "#2563EB", marginTop: 4 }}>💡 Auto-llenado: {fmt(transTotal)} de transferencias confirmadas</div>}
                  </div>

                  {/* Efectivo — ONLY this creates gastosAdmin ingreso */}
                  <div style={{ background: "#F5F3FF", borderRadius: 8, border: "1px solid #E9D5FF", padding: "10px 14px", marginBottom: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#6D28D9", marginBottom: 4 }}>💵 Efectivo entregado por Adolfo / en mano</div>
                    <div style={{ fontSize: 10, color: "#7C3AED", marginBottom: 8 }}>Solo este monto se registra como ingreso en Caja Admin</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <Fld label="USD en efectivo">
                        <Inp type="number"
                          value={recForm.monto || ""}
                          onChange={e => setRecForm({ ...recForm, monto: e.target.value })}
                          placeholder="0.00" />
                      </Fld>
                      <Fld label="MXN en efectivo">
                        <Inp type="number" value={recForm.montoMXN || ""} onChange={e => setRecForm({ ...recForm, montoMXN: e.target.value })} placeholder="0.00" />
                      </Fld>
                    </div>
                    {parseFloat(recForm.montoMXN) > 0 && (
                      <Fld label="T. Cambio">
                        <Inp type="number" value={recForm.tipoCambio || ""} onChange={e => setRecForm({ ...recForm, tipoCambio: e.target.value })} placeholder="17.50" />
                      </Fld>
                    )}
                    {recForm.montoMXN && recForm.tipoCambio && parseFloat(recForm.tipoCambio) > 0 &&
                      <div style={{ fontSize: 11, color: "#065F46", fontWeight: 600, marginTop: 4 }}>= {fmt(parseFloat(recForm.montoMXN) / parseFloat(recForm.tipoCambio))} USD</div>}
                    {efectivoCash > 0 && !recForm.monto &&
                      <div style={{ fontSize: 10, color: "#7C3AED", marginTop: 4 }}>💡 Según los pagos de Bodega TJ: {fmt(efectivoCash)} USD en efectivo</div>}
                  </div>

                  {/* Resumen total */}
                  {(() => {
                    const trans = parseFloat(recForm.montoTrans) || 0;
                    const ef = parseFloat(recForm.monto) || 0;
                    const mxn = parseFloat(recForm.montoMXN) || 0;
                    const tc = parseFloat(recForm.tipoCambio) || 0;
                    const mxnUsd = tc > 0 ? Math.round(mxn / tc * 100) / 100 : 0;
                    const total = trans + ef + mxnUsd;
                    if (total <= 0) return null;
                    const diff = Math.abs(total - adel.monto);
                    return (
                      <div style={{ background: diff < 0.01 ? "#ECFDF5" : "#FEF3C7", borderRadius: 6, padding: "8px 12px", border: `1px solid ${diff < 0.01 ? "#A7F3D0" : "#FDE68A"}`, marginBottom: 8, fontSize: 11 }}>
                        <strong>Total confirmado: {fmt(total)}</strong> (Trans: {fmt(trans)} + Efectivo: {fmt(ef + mxnUsd)}) · Adelanto original: {fmt(adel.monto)}
                        {diff >= 0.01 && <span style={{ color: "#92400E" }}> · ⚠ Diferencia: {fmt(diff)}</span>}
                      </div>
                    );
                  })()}

                  <Fld label="Fecha"><Inp type="date" value={recForm.fecha} onChange={e => setRecForm({ ...recForm, fecha: e.target.value })} /></Fld>
                  <Fld label="Nota (opcional)"><Inp value={recForm.nota} onChange={e => setRecForm({ ...recForm, nota: e.target.value })} placeholder="Detalle..." /></Fld>
                </>
              )}

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5E7EB" }}>
                <Btn v="secondary" onClick={() => setShowRecuperar(null)}>Cancelar</Btn>
                {pagadoCompleto && (() => {
                  const trans = parseFloat(recForm.montoTrans) || 0;
                  const ef = parseFloat(recForm.monto) || 0;
                  const mxn = parseFloat(recForm.montoMXN) || 0;
                  const tc = parseFloat(recForm.tipoCambio) || 0;
                  const mxnUsd = tc > 0 ? Math.round(mxn / tc * 100) / 100 : 0;
                  const total = trans + ef + mxnUsd;
                  const partes = [trans > 0 ? `${fmt(trans)} trans` : "", ef > 0 ? `${fmt(ef)} efec USD` : "", mxnUsd > 0 ? `${fmt(mxn)} MXN@${tc}` : ""].filter(Boolean).join(" + ");
                  const vias = [trans > 0 ? "transferencia" : "", (ef > 0 || mxnUsd > 0) ? "efectivo" : ""].filter(Boolean).join("+");
                  return (
                    <Btn disabled={total <= 0 && adel.monto > 0} onClick={() => {
                      const newAdel = adelantos.map(a => a.id !== showRecuperar ? a : { ...a, recuperado: true, fechaRecuperacion: recForm.fecha, viaRecuperacion: vias, montoRecuperado: total, montoTrans: trans, montoEfectivo: ef + mxnUsd, detalleRecuperacion: partes, nota: recForm.nota });
                      let nd = { ...data, adelantosAdmin: newAdel };
                      // ONLY cash creates gastosAdmin ingreso — transfers are already in the system
                      if (ef > 0) nd.gastosAdmin = [...(nd.gastosAdmin||[]), { id: Date.now(), concepto: `RECUPERADO ADELANTO ${adel.pedidoId} (efectivo USD) — ${pf?.cliente||""}`, monto: ef, montoUSD: ef, montoMXN: 0, moneda: "USD", destino: "ADMIN", fecha: recForm.fecha, nota: recForm.nota, tipoMov: "ingreso", adelantoRef: adel.id }];
                      if (mxnUsd > 0) nd.gastosAdmin = [...(nd.gastosAdmin||[]), { id: Date.now()+1, concepto: `RECUPERADO ADELANTO ${adel.pedidoId} (efectivo MXN) — ${pf?.cliente||""}`, monto: mxnUsd, montoUSD: mxnUsd, montoMXN: mxn, moneda: "MIXTO", tipoCambio: tc, destino: "ADMIN", fecha: recForm.fecha, nota: recForm.nota, tipoMov: "ingreso", adelantoRef: adel.id }];
                      nd.fantasmas = nd.fantasmas.map(f => f.id !== adel.pedidoId ? f : { ...f, adelantoRecuperado: true, fechaActualizacion: today(), historial: [...(f.historial||[]), { fecha: recForm.fecha, accion: `💰 Adelanto cobrado: ${fmt(total)} (${partes})`, quien: role }] });
                      persist(nd);
                      setShowRecuperar(null);
                      setAdelTab("pagados");
                    }} style={{ background: "#059669" }}>✅ Confirmar cobro</Btn>
                  );
                })()}
              </div>
            </Modal>
          );
        })()}
      </div>
    );
  };

  // ============ CUENTAS ============
  const CuentasPage = () => {
    const [cuentasTab, setCuentasTab] = useState("cobrar");
    const [fondoModal, setFondoModal] = useState(null); // { key, label, color, tipo: "agregar"|"retirar" }
    const [fondoMonto, setFondoMonto] = useState("");
    const [cxpExpand, setCxpExpand] = useState(null);
    const [cxpSort, setCxpSort] = useState("alfa");
    const [cxpFilter, setCxpFilter] = useState("pendientes");
    const [cxpSearch, setCxpSearch] = useState("");
    const [abonarCxpModal, setAbonarCxpModal] = useState(null); // {fantasma, tipo:"flete"|"merc"}
    const [cobrarSearch, setCobrarSearch] = useState("");
    const [cobrarCat, setCobrarCat] = useState("negocio");
    const act = data.fantasmas.filter(f => f.estado !== "CERRADO");
    const fondos = data.fondos || { ganancias: 0, gastosMensuales: 0, comisiones: 0, deudaClientes: 0 };

    // Por cobrar: clients that owe us
    const porCobrarMerc = act.filter(f => !f.clientePago && f.costoMercancia > 0);
    const porCobrarFlete = act.filter(f => !f.fletePagado && (f.costoFlete > 0 || f.fleteDesconocido));
    const totalCobrarMerc = porCobrarMerc.reduce((s, f) => s + (f.costoMercancia - (f.abonoMercancia || 0)), 0);
    const totalCobrarFlete = porCobrarFlete.reduce((s, f) => s + ((f.costoFlete || 0) - (f.abonoFlete || 0)), 0);

    // Por pagar: what we owe (proveedores + deuda clientes)
    const porPagarProv = act.filter(f => !f.proveedorPagado && f.costoMercancia > 0);
    const totalPagarProv = porPagarProv.reduce((s, f) => s + (f.costoMercancia - (f.abonoProveedor || 0)), 0);
    const deudaClientesTotal = fondos.deudaClientes || 0;

    const updateFondo = (key, val) => persist({ ...data, fondos: { ...fondos, [key]: val } });
    const addToFondo = (key, monto, desc, fecha) => {
      const newFondos = { ...fondos, [key]: (fondos[key] || 0) + monto };
      const fm = { ...(data.fondosMovs || {}) };
      if (!fm[key]) fm[key] = [];
      fm[key] = [...fm[key], { f: fecha || today(), m: monto, d: desc || (monto > 0 ? "Ingreso" : "Retiro") }];
      persist({ ...data, fondos: newFondos, fondosMovs: fm });
    };

    return (
      <div>
        <h2 style={{ margin: "0 0 14px", fontSize: 16, fontWeight: 700 }}>📒 Cuentas</h2>
        <div style={{ display: "flex", gap: 3, background: "#F3F4F6", borderRadius: 8, padding: 3, marginBottom: 14 }}>
          {[{ k: "cobrar", l: "💵 Por cobrar", c: "#059669" }, { k: "pagar", l: "💸 Por pagar", c: "#DC2626" }, { k: "fondos", l: "🏦 Fondos", c: "#7C3AED" }, { k: "corte", l: "✂️ Corte", c: "#2563EB" }].map(t => (
            <button key={t.k} onClick={() => setCuentasTab(t.k)} style={{ flex: 1, padding: "6px 14px", borderRadius: 6, border: "none", background: cuentasTab === t.k ? "#fff" : "transparent", boxShadow: cuentasTab === t.k ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 11, fontWeight: cuentasTab === t.k ? 700 : 500, fontFamily: "inherit", color: cuentasTab === t.k ? t.c : "#6B7280" }}>{t.l}</button>
          ))}
        </div>

        {cuentasTab === "cobrar" && (
          <div>
            {/* Category sub-tabs */}
            <div style={{ display: "flex", gap: 3, background: "#F3F4F6", borderRadius: 8, padding: 3, marginBottom: 14 }}>
              {[["negocio","🏪 Negocio"],["empleados","👷 Empleados"]].map(([k,l]) => (
                <button key={k} onClick={() => setCobrarCat(k)} style={{ flex: 1, padding: "6px 14px", borderRadius: 6, border: "none", background: cobrarCat === k ? "#fff" : "transparent", boxShadow: cobrarCat === k ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 11, fontWeight: cobrarCat === k ? 700 : 500, fontFamily: "inherit", color: cobrarCat === k ? "#059669" : "#6B7280" }}>{l}</button>
              ))}
            </div>

            {cobrarCat === "negocio" && (<>
            <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 180px", background: "#ECFDF5", borderRadius: 10, padding: "16px 20px", border: "2px solid #A7F3D0" }}>
                <div style={{ fontSize: 9, fontWeight: 600, color: "#065F46" }}>👻 MERCANCÍA POR COBRAR</div>
                <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "monospace", color: "#059669" }}>{fmt(totalCobrarMerc)}</div>
                <div style={{ fontSize: 9, color: "#6B7280" }}>{porCobrarMerc.length} pedidos</div>
              </div>
              <div style={{ flex: "1 1 180px", background: "#EFF6FF", borderRadius: 10, padding: "16px 20px", border: "2px solid #BFDBFE" }}>
                <div style={{ fontSize: 9, fontWeight: 600, color: "#1E40AF" }}>🚛 FLETES POR COBRAR</div>
                <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "monospace", color: "#2563EB" }}>{fmt(totalCobrarFlete)}</div>
                <div style={{ fontSize: 9, color: "#6B7280" }}>{porCobrarFlete.length} pedidos</div>
              </div>
              <div style={{ flex: "1 1 180px", background: "#FEF3C7", borderRadius: 10, padding: "16px 20px", border: "2px solid #FDE68A" }}>
                <div style={{ fontSize: 9, fontWeight: 600, color: "#92400E" }}>📊 TOTAL POR COBRAR</div>
                <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "monospace", color: "#D97706" }}>{fmt(totalCobrarMerc + totalCobrarFlete)}</div>
              </div>
            </div>
            {/* Search bar */}
            <input value={cobrarSearch} onChange={e => setCobrarSearch(e.target.value)} placeholder="🔍 Buscar por cliente..." style={{ width: "100%", padding: "7px 12px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, outline: "none", marginBottom: 10, boxSizing: "border-box" }} />
            {/* Fletes pendientes */}
            {(() => { const flFilt = cobrarSearch ? porCobrarFlete.filter(f => f.cliente.toLowerCase().includes(cobrarSearch.toLowerCase())) : porCobrarFlete; return (<>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>🚛 Fletes pendientes ({flFilt.length})</div>
            {flFilt.length === 0 && <div style={{ textAlign: "center", padding: 20, color: "#9CA3AF", fontSize: 11 }}>No hay fletes pendientes.</div>}
            {flFilt.sort((a,b) => a.cliente.localeCompare(b.cliente)).map(f => {
              const montoFlete = (f.costoFlete || 0) - (f.abonoFlete || 0);
              return (
                <div key={f.id + "_fl"} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#fff", borderRadius: 6, border: "1px solid #E5E7EB", marginBottom: 3, fontSize: 11 }}>
                  <strong style={{ minWidth: 80 }}>{f.cliente}</strong>
                  <span style={{ color: "#9CA3AF", fontSize: 9 }}>F{f.folio || f.id.slice(0,6)}</span>
                  <span style={{ flex: 1, color: "#6B7280", fontSize: 10 }}>{f.descripcion || ""}</span>
                  <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#2563EB" }}>{fmt(montoFlete)}</span>
                  <button onClick={() => setAbonarCxpModal({ fantasma: f, tipo: "flete", monto: montoFlete })} style={{ padding: "3px 8px", borderRadius: 5, border: "1px solid #E9D5FF", background: "#F5F3FF", color: "#7C3AED", fontSize: 9, cursor: "pointer", fontFamily: "inherit", fontWeight: 600, whiteSpace: "nowrap" }}>↪ Abonar a CxP</button>
                </div>
              );
            })}
            </>); })()}
            {/* Mercancía pendiente */}
            {(() => { const mcFilt = cobrarSearch ? porCobrarMerc.filter(f => f.cliente.toLowerCase().includes(cobrarSearch.toLowerCase())) : porCobrarMerc; return (<>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, marginTop: 14 }}>👻 Mercancía pendiente ({mcFilt.length})</div>
            {mcFilt.length === 0 && <div style={{ textAlign: "center", padding: 20, color: "#9CA3AF", fontSize: 11 }}>No hay mercancía pendiente.</div>}
            {mcFilt.sort((a,b) => a.cliente.localeCompare(b.cliente)).map(f => {
              const montoMerc = f.costoMercancia - (f.abonoMercancia || 0);
              return (
                <div key={f.id + "_mc"} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#fff", borderRadius: 6, border: "1px solid #E5E7EB", marginBottom: 3, fontSize: 11 }}>
                  <strong style={{ minWidth: 80 }}>{f.cliente}</strong>
                  <span style={{ color: "#9CA3AF", fontSize: 9 }}>F{f.folio || f.id.slice(0,6)}</span>
                  <span style={{ flex: 1, color: "#6B7280", fontSize: 10 }}>{f.descripcion || ""}</span>
                  <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#DC2626" }}>{fmt(montoMerc)}</span>
                </div>
              );
            })}
            </>); })()}
            {/* Modal: Assign flete to CxP */}
            {abonarCxpModal && (
              <Modal title={`↪ Abonar flete a cuenta por pagar`} onClose={() => setAbonarCxpModal(null)} w={400}>
                <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 10 }}>
                  Flete de <strong>{abonarCxpModal.fantasma.cliente}</strong> por <strong style={{ color: "#2563EB" }}>{fmt(abonarCxpModal.monto)}</strong>
                </div>
                <div style={{ fontSize: 10, fontWeight: 600, marginBottom: 6 }}>Selecciona la cuenta a abonar:</div>
                <div style={{ maxHeight: 250, overflow: "auto" }}>
                  {(data.cuentasPorPagar || []).filter(c => (c.deuda - (c.abonado || 0)) > 0).sort((a,b) => a.cliente.localeCompare(b.cliente)).map(c => {
                    const debe = c.deuda - (c.abonado || 0);
                    return (
                      <div key={c.id} onClick={() => {
                        const monto = abonarCxpModal.monto;
                        const fId = abonarCxpModal.fantasma.id;
                        // 1. Mark flete as paid on the fantasma
                        const newFantasmas = data.fantasmas.map(ff => ff.id !== fId ? ff : { ...ff, fletePagado: true, fletePagadoCxp: c.cliente });
                        // 2. Add abono to the CxP account
                        const newCxp = (data.cuentasPorPagar || []).map(cc => cc.id !== c.id ? cc : {
                          ...cc,
                          abonado: (cc.abonado || 0) + monto,
                          movs: [...(cc.movs || []), { f: new Date().toISOString().slice(0,10), t: "I", d: `Flete ${abonarCxpModal.fantasma.cliente} F${abonarCxpModal.fantasma.folio || abonarCxpModal.fantasma.id.slice(0,6)}`, m: monto }]
                        });
                        persist({ ...data, fantasmas: newFantasmas, cuentasPorPagar: newCxp });
                        setAbonarCxpModal(null);
                      }} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#fff", borderRadius: 6, border: "1px solid #E5E7EB", marginBottom: 3, fontSize: 11, cursor: "pointer" }}>
                        <strong style={{ flex: 1 }}>{c.cliente}</strong>
                        <span style={{ fontFamily: "monospace", color: "#DC2626", fontSize: 10 }}>Debe {fmt(debe)}</span>
                        <span style={{ color: "#7C3AED", fontWeight: 600, fontSize: 10 }}>→ Asignar</span>
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5E7EB" }}>
                  <Btn v="secondary" onClick={() => setAbonarCxpModal(null)}>Cancelar</Btn>
                </div>
              </Modal>
            )}
            </>)}

            {cobrarCat === "empleados" && (
              <div>
                {(() => {
                  const empCxc = data.cuentasPorCobrarEmp || [];
                  const empPendientes = empCxc.filter(c => (c.deuda - (c.abonado || 0)) > 0);
                  const totalEmpDeuda = empPendientes.reduce((s, c) => s + (c.deuda - (c.abonado || 0)), 0);
                  let empFiltered = cobrarSearch ? empCxc.filter(c => c.cliente.toLowerCase().includes(cobrarSearch.toLowerCase())) : empCxc;
                  empFiltered = [...empFiltered].sort((a,b) => a.cliente.localeCompare(b.cliente));
                  return (<>
                    <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                      <div style={{ flex: "1 1 180px", background: "#FEF3C7", borderRadius: 10, padding: "16px 20px", border: "2px solid #FDE68A" }}>
                        <div style={{ fontSize: 9, fontWeight: 600, color: "#92400E" }}>👷 NOS DEBEN EMPLEADOS</div>
                        <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "monospace", color: "#D97706" }}>{fmt(totalEmpDeuda)}</div>
                        <div style={{ fontSize: 9, color: "#6B7280" }}>{empPendientes.length} pendientes</div>
                      </div>
                    </div>
                    <input value={cobrarSearch} onChange={e => setCobrarSearch(e.target.value)} placeholder="🔍 Buscar empleado..." style={{ width: "100%", padding: "7px 12px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, outline: "none", marginBottom: 10, boxSizing: "border-box" }} />
                    <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6 }}>Cuentas ({empFiltered.length})</div>
                    {empFiltered.length === 0 && <div style={{ textAlign: "center", padding: 30, color: "#9CA3AF", fontSize: 11 }}>No hay cuentas de empleados aún. Pásame los datos y las agrego.</div>}
                    {empFiltered.map(c => {
                      const debe = Math.max(0, c.deuda - (c.abonado || 0));
                      const isPagada = debe <= 0;
                      const pct = c.deuda > 0 ? Math.round((c.abonado || 0) / c.deuda * 100) : 0;
                      return (
                        <div key={c.id}>
                        <div onClick={() => setCxpExpand(cxpExpand === "e"+c.id ? null : "e"+c.id)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: cxpExpand === "e"+c.id ? "#F5F3FF" : isPagada ? "#ECFDF5" : "#fff", borderRadius: 6, border: cxpExpand === "e"+c.id ? "2px solid #E9D5FF" : isPagada ? "1px solid #A7F3D0" : "1px solid #E5E7EB", marginBottom: cxpExpand === "e"+c.id ? 0 : 3, borderBottomLeftRadius: cxpExpand === "e"+c.id ? 0 : 6, borderBottomRightRadius: cxpExpand === "e"+c.id ? 0 : 6, fontSize: 11, cursor: "pointer" }}>
                          <span style={{ color: "#9CA3AF", fontSize: 10 }}>{cxpExpand === "e"+c.id ? "▼" : "▶"}</span>
                          <strong style={{ flex: 1, minWidth: 80 }}>{c.cliente}</strong>
                          {c.nota && <span style={{ fontSize: 9, color: "#9CA3AF", maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.nota}</span>}
                          <div style={{ width: 50, height: 4, background: "#E5E7EB", borderRadius: 2 }}><div style={{ width: `${Math.min(pct,100)}%`, height: "100%", background: isPagada ? "#059669" : "#F59E0B", borderRadius: 2 }} /></div>
                          <span style={{ fontSize: 9, color: isPagada ? "#059669" : "#6B7280" }}>{pct}%</span>
                          {isPagada ? <span style={{ fontFamily: "monospace", color: "#059669", fontWeight: 700 }}>✓ {fmt(c.deuda)}</span> : <>
                            {(c.abonado||0) > 0 && <span style={{ fontFamily: "monospace", color: "#059669", fontSize: 10 }}>+{fmt(c.abonado)}</span>}
                            <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#D97706" }}>{fmt(debe)}</span>
                            <button onClick={(e) => { e.stopPropagation(); setFondoModal({ key: "emp_"+c.id, label: c.cliente, color: "#D97706", tipo: "abono_emp" }); setFondoMonto(""); }} style={{ padding: "3px 8px", borderRadius: 5, border: "1px solid #FDE68A", background: "#FEF3C7", color: "#92400E", fontSize: 9, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>💰 Cobrar</button>
                          </>}
                        </div>
                        {cxpExpand === "e"+c.id && (
                          <div style={{ background: "#FAFBFC", border: "1px solid #E5E7EB", borderTop: "none", borderRadius: "0 0 6px 6px", padding: "8px 12px", marginBottom: 3 }}>
                            {(c.movs || []).length > 0 ? (
                              <div style={{ maxHeight: 200, overflow: "auto" }}>
                                {(() => { let saldo = 0; return c.movs.map((mv, i) => { saldo += mv.m; return (
                                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 0", borderBottom: "1px solid #F3F4F6", fontSize: 10 }}>
                                    {mv.f && <span style={{ color: "#9CA3AF", minWidth: 60 }}>{mv.f.slice(5)}</span>}
                                    {!mv.f && <span style={{ minWidth: 60 }} />}
                                    <span style={{ fontSize: 9, fontWeight: 600, color: mv.m < 0 ? "#DC2626" : "#059669", minWidth: 50 }}>{mv.m < 0 ? "DEUDA" : "COBRO"}</span>
                                    <span style={{ flex: 1, color: "#6B7280" }}>{mv.d || "—"}</span>
                                    <span style={{ fontFamily: "monospace", fontWeight: 600, color: mv.m < 0 ? "#DC2626" : "#059669" }}>{mv.m < 0 ? "-" : "+"}{fmt(Math.abs(mv.m))}</span>
                                    <span style={{ fontFamily: "monospace", fontSize: 9, color: saldo >= 0 ? "#059669" : "#DC2626", minWidth: 70, textAlign: "right" }}>{fmt(saldo)}</span>
                                  </div>
                                ); }); })()}
                              </div>
                            ) : <div style={{ fontSize: 10, color: "#9CA3AF", textAlign: "center", padding: 8 }}>Sin movimientos registrados</div>}
                          </div>
                        )}
                        </div>
                      );
                    })}
                  </>);
                })()}
              </div>
            )}
          </div>
        )}

        {cuentasTab === "pagar" && (
          <div>
            {(() => {
              const cxp = data.cuentasPorPagar || [];
              const allPendientes = cxp.filter(c => (c.deuda - (c.abonado || 0)) > 0);
              const allPagadas = cxp.filter(c => (c.deuda - (c.abonado || 0)) <= 0);
              const totalDeuda = allPendientes.reduce((s, c) => s + (c.deuda - (c.abonado || 0)), 0);
              const totalAbonado = cxp.reduce((s, c) => s + (c.abonado || 0), 0);
              // Filter
              let filtered = cxpFilter === "pagadas" ? allPagadas : cxpFilter === "pendientes" ? allPendientes : cxp;
              // Search
              if (cxpSearch) filtered = filtered.filter(c => c.cliente.toLowerCase().includes(cxpSearch.toLowerCase()));
              // Sort
              const sortFn = { deuda_desc: (a,b) => (b.deuda-(b.abonado||0)) - (a.deuda-(a.abonado||0)), deuda_asc: (a,b) => (a.deuda-(a.abonado||0)) - (b.deuda-(b.abonado||0)), alfa: (a,b) => a.cliente.localeCompare(b.cliente), avance: (a,b) => { const pa = a.deuda>0?(a.abonado||0)/a.deuda:1; const pb = b.deuda>0?(b.abonado||0)/b.deuda:1; return pb-pa; } }[cxpSort] || ((a,b)=>0);
              filtered = [...filtered].sort(sortFn);
              return (<>
                <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 160px", background: "#FEF2F2", borderRadius: 10, padding: "16px 20px", border: "2px solid #FECACA" }}>
                    <div style={{ fontSize: 9, fontWeight: 600, color: "#991B1B" }}>👥 DEUDA TOTAL</div>
                    <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "monospace", color: "#DC2626" }}>{fmt(totalDeuda)}</div>
                    <div style={{ fontSize: 9, color: "#6B7280" }}>{allPendientes.length} cuentas pendientes</div>
                  </div>
                  <div style={{ flex: "1 1 160px", background: "#ECFDF5", borderRadius: 10, padding: "16px 20px", border: "1px solid #A7F3D0" }}>
                    <div style={{ fontSize: 9, fontWeight: 600, color: "#065F46" }}>✅ ABONADO</div>
                    <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "monospace", color: "#059669" }}>{fmt(totalAbonado)}</div>
                  </div>
                  <div style={{ flex: "1 1 160px", background: "#FEF2F2", borderRadius: 10, padding: "16px 20px", border: "1px solid #FECACA" }}>
                    <div style={{ fontSize: 9, fontWeight: 600, color: "#991B1B" }}>🏭 DEUDA PROVEEDORES</div>
                    <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "monospace", color: "#DC2626" }}>{fmt(totalPagarProv)}</div>
                    <div style={{ fontSize: 9, color: "#6B7280" }}>{porPagarProv.length} pedidos</div>
                  </div>
                </div>
                {/* Controls bar */}
                <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <input value={cxpSearch} onChange={e => setCxpSearch(e.target.value)} placeholder="🔍 Buscar cliente..." style={{ flex: "1 1 140px", padding: "6px 10px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 11, outline: "none" }} />
                  <div style={{ display: "flex", borderRadius: 6, overflow: "hidden", border: "1px solid #D1D5DB" }}>
                    {[["pendientes","Pendientes"],["pagadas","Pagadas"],["todas","Todas"]].map(([k,l]) => (
                      <button key={k} onClick={() => setCxpFilter(k)} style={{ padding: "5px 10px", fontSize: 10, fontWeight: 600, border: "none", cursor: "pointer", fontFamily: "inherit", background: cxpFilter === k ? "#7C3AED" : "#fff", color: cxpFilter === k ? "#fff" : "#6B7280" }}>{l}</button>
                    ))}
                  </div>
                  <select value={cxpSort} onChange={e => setCxpSort(e.target.value)} style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 10, background: "#fff", cursor: "pointer", fontFamily: "inherit" }}>
                    <option value="deuda_desc">Mayor deuda</option>
                    <option value="deuda_asc">Menor deuda</option>
                    <option value="alfa">A → Z</option>
                    <option value="avance">% Avance</option>
                  </select>
                </div>
                <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6, color: "#374151" }}>
                  {cxpFilter === "pagadas" ? "✅ Pagadas" : cxpFilter === "pendientes" ? "💸 Pendientes" : "📋 Todas"} ({filtered.length})
                </div>
                {filtered.length === 0 && <div style={{ textAlign: "center", padding: 30, color: "#9CA3AF", fontSize: 11 }}>No hay cuentas que coincidan.</div>}
                {filtered.map(c => {
                  const debe = Math.max(0, c.deuda - (c.abonado || 0));
                  const pct = c.deuda > 0 ? Math.round((c.abonado || 0) / c.deuda * 100) : 0;
                  const isPagada = debe <= 0;
                  return (
                    <div key={c.id}>
                    <div onClick={() => setCxpExpand(cxpExpand === c.id ? null : c.id)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: cxpExpand === c.id ? "#F5F3FF" : isPagada ? "#ECFDF5" : "#fff", borderRadius: 6, border: cxpExpand === c.id ? "2px solid #E9D5FF" : isPagada ? "1px solid #A7F3D0" : "1px solid #E5E7EB", marginBottom: cxpExpand === c.id ? 0 : 3, borderBottomLeftRadius: cxpExpand === c.id ? 0 : 6, borderBottomRightRadius: cxpExpand === c.id ? 0 : 6, fontSize: 11, cursor: "pointer" }}>
                      <span style={{ color: "#9CA3AF", fontSize: 10 }}>{cxpExpand === c.id ? "▼" : "▶"}</span>
                      <strong style={{ flex: 1, minWidth: 80 }}>{c.cliente}</strong>
                      {c.nota && <span style={{ fontSize: 9, color: "#9CA3AF", maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.nota}</span>}
                      <div style={{ width: 50, height: 4, background: "#E5E7EB", borderRadius: 2 }}><div style={{ width: `${Math.min(pct,100)}%`, height: "100%", background: isPagada ? "#059669" : "#F59E0B", borderRadius: 2 }} /></div>
                      <span style={{ fontSize: 9, color: isPagada ? "#059669" : "#6B7280", fontWeight: isPagada ? 700 : 400 }}>{pct}%</span>
                      {isPagada ? <span style={{ fontFamily: "monospace", color: "#059669", fontWeight: 700 }}>✓ {fmt(c.deuda)}</span> : <>
                        {(c.abonado || 0) > 0 && <span style={{ fontFamily: "monospace", color: "#059669", fontSize: 10 }}>+{fmt(c.abonado)}</span>}
                        <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#DC2626" }}>{fmt(debe)}</span>
                        <button onClick={(e) => { e.stopPropagation(); setFondoModal({ key: c.id, label: c.cliente, color: "#059669", tipo: "abono_cxp" }); setFondoMonto(""); }} style={{ padding: "3px 8px", borderRadius: 5, border: "1px solid #A7F3D0", background: "#ECFDF5", color: "#065F46", fontSize: 9, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>💰 Abonar</button>
                      </>}
                    </div>
                    {cxpExpand === c.id && (
                      <div style={{ background: "#FAFBFC", border: "1px solid #E5E7EB", borderTop: "none", borderRadius: "0 0 6px 6px", padding: "8px 12px", marginBottom: 3 }}>
                        {(c.movs || []).length > 0 ? (
                          <div style={{ maxHeight: 200, overflow: "auto" }}>
                            {(() => { let saldo = 0; return c.movs.map((mv, i) => { saldo += mv.m; return (
                              <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 0", borderBottom: "1px solid #F3F4F6", fontSize: 10 }}>
                                {mv.f && <span style={{ color: "#9CA3AF", minWidth: 60 }}>{mv.f.slice(5)}</span>}
                                {!mv.f && <span style={{ minWidth: 60 }} />}
                                <span style={{ fontSize: 9, fontWeight: 600, color: mv.m < 0 ? "#DC2626" : "#059669", minWidth: 50 }}>{mv.m < 0 ? "EGRESO" : "INGRESO"}</span>
                                <span style={{ flex: 1, color: "#6B7280" }}>{mv.d || "—"}</span>
                                <span style={{ fontFamily: "monospace", fontWeight: 600, color: mv.m < 0 ? "#DC2626" : "#059669" }}>{mv.m < 0 ? "-" : "+"}{fmt(Math.abs(mv.m))}</span>
                                <span style={{ fontFamily: "monospace", fontSize: 9, color: saldo >= 0 ? "#059669" : "#DC2626", minWidth: 70, textAlign: "right" }}>{fmt(saldo)}</span>
                                {mv.m > 0 && <button onClick={() => { const cxpId = c.id; const movIdx = i; const movMonto = mv.m; const cxpCliente = c.cliente; const curCxp = data.cuentasPorPagar || []; const acct = curCxp.find(x => x.id === cxpId); if (!acct) return; const newMovs = (acct.movs||[]).filter((_,j) => j !== movIdx); const newAbonado = Math.max(0, (acct.abonado||0) - movMonto); let nd = { ...data, cuentasPorPagar: curCxp.map(cc => cc.id !== cxpId ? cc : { ...cc, abonado: newAbonado, movs: newMovs }) }; if ((mv.d||"").toLowerCase().includes("flete")) { nd.fantasmas = (nd.fantasmas||[]).map(ff => ff.fletePagadoCxp === cxpCliente ? { ...ff, fletePagado: false, fletePagadoCxp: null, historial: [...(ff.historial||[]), {fecha:today(),accion:"Flete desmarcado (abono eliminado)",quien:"Admin"}] } : ff); } persist(nd); }} style={{ background: "#FEE2E2", border: "1px solid #FECACA", borderRadius: 4, cursor: "pointer", color: "#DC2626", padding: "1px 5px", fontSize: 10, lineHeight: 1, flexShrink: 0, fontFamily: "inherit" }} title="Eliminar abono">🗑</button>}
                              </div>
                            ); }); })()}
                          </div>
                        ) : <div style={{ fontSize: 10, color: "#9CA3AF", textAlign: "center", padding: 8 }}>Sin movimientos registrados</div>}
                      </div>
                    )}
                    </div>
                  );
                })}
              </>);
            })()}
          </div>
        )}

        {cuentasTab === "fondos" && (
          <div>
            {(() => {
              const defaultFondos = [
                { k: "ganancias", l: "💰 Ganancias", c: "#059669", bg: "#ECFDF5", bc: "#A7F3D0" },
                { k: "gastosMensuales", l: "🏠 Gastos Mensuales", c: "#2563EB", bg: "#EFF6FF", bc: "#BFDBFE" },
                { k: "comisiones", l: "🤝 Comisiones", c: "#7C3AED", bg: "#F5F3FF", bc: "#E9D5FF" },
                { k: "deudaClientes", l: "👥 Deuda Clientes", c: "#D97706", bg: "#FEF3C7", bc: "#FDE68A" },
              ];
              const customFondos = (data.fondosCustom || []).map(cf => ({
                k: cf.k, l: cf.emoji + " " + cf.nombre, c: cf.color, bg: cf.bg, bc: cf.bc, custom: true
              }));
              const allFondos = [...defaultFondos, ...customFondos];
              const totalAll = allFondos.reduce((s, f) => s + (fondos[f.k] || 0), 0);
              return (<>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700 }}>🏦 Fondos</div>
                <button onClick={() => setFondoModal({ tipo: "crear_fondo" })} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #E9D5FF", background: "#F5F3FF", color: "#7C3AED", fontSize: 10, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>+ Nueva cuenta</button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8, marginBottom: 14 }}>
              {allFondos.map(f => (
                <div key={f.k} style={{ background: cxpExpand === "fondo_"+f.k ? "#fff" : f.bg, borderRadius: 10, padding: "16px 20px", border: `2px solid ${f.bc}`, cursor: "pointer" }} onClick={() => setCxpExpand(cxpExpand === "fondo_"+f.k ? null : "fondo_"+f.k)}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontSize: 10, fontWeight: 600, color: f.c, textTransform: "uppercase" }}>{f.l}</div>
                    {f.custom && <button onClick={async (e) => { e.stopPropagation(); if (await showConfirm("¿Eliminar esta cuenta?")) { persist({ ...data, fondosCustom: (data.fondosCustom||[]).filter(x => x.k !== f.k) }); } }} style={{ background: "none", border: "none", cursor: "pointer", color: "#D1D5DB", fontSize: 12, padding: 0 }}>×</button>}
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "monospace", color: f.c }}>{fmt(fondos[f.k] || 0)}</div>
                  <div style={{ display: "flex", gap: 3, marginTop: 8 }}>
                    <button onClick={(e) => { e.stopPropagation(); setFondoModal({ key: f.k, label: f.l, color: f.c, tipo: "agregar" }); setFondoMonto(""); }} style={{ padding: "3px 8px", borderRadius: 5, border: `1px solid ${f.bc}`, background: "#fff", color: f.c, fontSize: 10, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>+ Agregar</button>
                    <button onClick={(e) => { e.stopPropagation(); setFondoModal({ key: f.k, label: f.l, color: f.c, tipo: "retirar" }); setFondoMonto(""); }} style={{ padding: "3px 8px", borderRadius: 5, border: "1px solid #D1D5DB", background: "#fff", color: "#6B7280", fontSize: 10, cursor: "pointer", fontFamily: "inherit" }}>- Retirar</button>
                  </div>
                  <div style={{ fontSize: 9, color: "#9CA3AF", marginTop: 4 }}>{cxpExpand === "fondo_"+f.k ? "▼ Ver movimientos" : "▶ Ver movimientos"}</div>
                </div>
              ))}
              </div>
              {/* Expanded fondo movements */}
              {allFondos.map(ff => {
                if (cxpExpand !== "fondo_"+ff.k) return null;
                const movs = (data.fondosMovs || {})[ff.k] || [];
                return (
                  <div key={ff.k}>
                  <div style={{ background: "#FAFBFC", borderRadius: 8, border: "1px solid #E5E7EB", padding: "12px 16px", marginBottom: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: ff.c, marginBottom: 8 }}>{ff.l} — Movimientos</div>
                    {movs.length === 0 && <div style={{ fontSize: 10, color: "#9CA3AF", textAlign: "center", padding: 12 }}>Sin movimientos registrados</div>}
                    {movs.length > 0 && (
                      <div style={{ maxHeight: 250, overflow: "auto" }}>
                        {[...movs].reverse().map((mv, i) => (
                          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 0", borderBottom: "1px solid #F3F4F6", fontSize: 10 }}>
                            <span style={{ color: "#9CA3AF", minWidth: 55 }}>{mv.f ? mv.f.slice(5) : ""}</span>
                            <span style={{ fontSize: 9, fontWeight: 600, color: mv.m < 0 ? "#DC2626" : "#059669", minWidth: 45 }}>{mv.m < 0 ? "RETIRO" : "INGRESO"}</span>
                            <span style={{ flex: 1, color: "#6B7280" }}>{mv.d || "—"}</span>
                            <span style={{ fontFamily: "monospace", fontWeight: 600, color: mv.m < 0 ? "#DC2626" : "#059669" }}>{mv.m < 0 ? "-" : "+"}{fmt(Math.abs(mv.m))}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* Gastos periódicos table - only for gastosMensuales */}
                  {ff.k === "gastosMensuales" && (() => {
                    const defaultGP = [
                      { id: 1, nombre: "PLACAS", costoUnit: 750, unidades: 8 },
                      { id: 2, nombre: "USER FEE", costoUnit: 943, unidades: 8 },
                      { id: 3, nombre: "ASEGURANZA USA", costoUnit: 1567, unidades: 8 },
                      { id: 4, nombre: "ASEGURANZA MEXICANA", costoUnit: 5000, unidades: 8 },
                      { id: 5, nombre: "OTROS", costoUnit: 0, unidades: 0, montoFijo: 1000 },
                    ];
                    const defaultGM = [
                      { id: 101, nombre: "TOTALPLAY", montoPesos: 1300 },
                      { id: 102, nombre: "CFE", montoPesos: 8000 },
                      { id: 103, nombre: "AGUA", montoPesos: 1500, fechaPago: "6 DE CADA MES" },
                      { id: 104, nombre: "CONCORDIA", montoDlls: 424, fechaPago: "10 DE CADA MES" },
                      { id: 105, nombre: "BODEGA USA", montoDlls: 2750, fechaPago: "3 DE CADA MES" },
                      { id: 106, nombre: "BANY SISTEMA", montoPesos: 489 },
                      { id: 107, nombre: "ASEGURANZA", montoDlls: 1290, fechaPago: "3 DE CADA MES" },
                      { id: 108, nombre: "IMSS, SAT E INFONAVIT", montoPesos: 25000 },
                    ];
                    const gp = data.gastosPeriodicos || defaultGP;
                    const gm = data.gastosMensualesList || defaultGM;
                    const updGP = (newGP) => persist({ ...data, gastosPeriodicos: newGP });
                    const updGM = (newGM) => persist({ ...data, gastosMensualesList: newGM });
                    const tc = data.tipoCambioGastos || 18.5;
                    const totalAnual = gp.reduce((s, g) => s + (g.montoFijo || (g.costoUnit * g.unidades)), 0);
                    const porSemana = totalAnual / 52;
                    const totalMensDlls = gm.reduce((s, g) => s + (g.montoDlls || 0), 0);
                    const totalMensPesos = gm.reduce((s, g) => s + (g.montoPesos || 0), 0);
                    const totalMensUSD = totalMensDlls + (totalMensPesos / tc);
                    const totalMensualSemanal = totalMensUSD / 4;
                    const metaSemanal = porSemana + totalMensualSemanal;
                    return (<>
                      {/* Gastos periódicos anuales */}
                      <div style={{ background: "#EFF6FF", borderRadius: 8, border: "1px solid #BFDBFE", padding: "12px 16px", marginBottom: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: "#1E40AF" }}>📋 Gastos periódicos anuales</div>
                          <button onClick={() => updGP([...gp, { id: Date.now(), nombre: "", costoUnit: 0, unidades: 1 }])} style={{ padding: "3px 8px", borderRadius: 5, border: "1px solid #BFDBFE", background: "#fff", color: "#2563EB", fontSize: 9, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>+ Agregar</button>
                        </div>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                          <thead><tr style={{ borderBottom: "2px solid #BFDBFE" }}>
                            <th style={{ textAlign: "left", padding: "4px 6px", color: "#1E40AF", fontSize: 10 }}>CONCEPTO</th>
                            <th style={{ textAlign: "right", padding: "4px 6px", color: "#1E40AF", fontSize: 10 }}>COSTO UNIT.</th>
                            <th style={{ textAlign: "right", padding: "4px 6px", color: "#1E40AF", fontSize: 10 }}>UNIDADES</th>
                            <th style={{ textAlign: "right", padding: "4px 6px", color: "#1E40AF", fontSize: 10 }}>MONTO</th>
                            <th style={{ width: 20 }}></th>
                          </tr></thead>
                          <tbody>{gp.map(g => (
                            <tr key={g.id} style={{ borderBottom: "1px solid #DBEAFE" }}>
                              <td style={{ padding: "4px 6px" }}><input defaultValue={g.nombre} onBlur={e => updGP(gp.map(x => x.id !== g.id ? x : { ...x, nombre: e.target.value.toUpperCase() }))} style={{ border: "none", background: "transparent", fontSize: 11, fontWeight: 600, width: "100%", fontFamily: "inherit", outline: "none" }} placeholder="CONCEPTO..." /></td>
                              <td style={{ padding: "4px 6px", textAlign: "right" }}><input defaultValue={g.montoFijo != null ? "" : g.costoUnit || ""} onBlur={e => updGP(gp.map(x => x.id !== g.id ? x : { ...x, costoUnit: parseFloat(e.target.value) || 0, montoFijo: undefined }))} style={{ border: "none", background: "transparent", fontSize: 11, fontFamily: "monospace", width: "100%", textAlign: "right", outline: "none" }} placeholder="0" /></td>
                              <td style={{ padding: "4px 6px", textAlign: "right" }}><input defaultValue={g.montoFijo != null ? "" : g.unidades || ""} onBlur={e => updGP(gp.map(x => x.id !== g.id ? x : { ...x, unidades: parseInt(e.target.value) || 0, montoFijo: undefined }))} style={{ border: "none", background: "transparent", fontSize: 11, fontFamily: "monospace", width: "100%", textAlign: "right", outline: "none" }} placeholder="0" /></td>
                              <td style={{ padding: "4px 6px", textAlign: "right", fontFamily: "monospace", fontWeight: 600, color: "#1E40AF" }}>{fmt(g.montoFijo || (g.costoUnit * g.unidades))}</td>
                              <td><button onClick={() => updGP(gp.filter(x => x.id !== g.id))} style={{ background: "none", border: "none", cursor: "pointer", color: "#D1D5DB", fontSize: 14, padding: "0 2px", lineHeight: 1 }} onMouseEnter={e => e.currentTarget.style.color = "#DC2626"} onMouseLeave={e => e.currentTarget.style.color = "#D1D5DB"}>×</button></td>
                            </tr>
                          ))}</tbody>
                        </table>
                        <div style={{ borderTop: "2px solid #1E40AF", marginTop: 6, paddingTop: 6 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 700, color: "#1E40AF" }}>
                            <span>TOTAL ANUAL</span><span style={{ fontFamily: "monospace" }}>{fmt(totalAnual)}</span>
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#6B7280" }}>
                            <span>Semanal (÷52)</span><span style={{ fontFamily: "monospace" }}>{fmt(porSemana)}</span>
                          </div>
                        </div>
                      </div>

                      {/* Gastos mensuales */}
                      <div style={{ background: "#FEF3C7", borderRadius: 8, border: "1px solid #FDE68A", padding: "12px 16px", marginBottom: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: "#92400E" }}>🏠 Gastos mensuales fijos</div>
                          <button onClick={() => updGM([...gm, { id: Date.now(), nombre: "", montoDlls: 0, montoPesos: 0 }])} style={{ padding: "3px 8px", borderRadius: 5, border: "1px solid #FDE68A", background: "#fff", color: "#92400E", fontSize: 9, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>+ Agregar</button>
                        </div>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                          <thead><tr style={{ borderBottom: "2px solid #FDE68A" }}>
                            <th style={{ textAlign: "left", padding: "4px 6px", color: "#92400E", fontSize: 10 }}>FECHA PAGO</th>
                            <th style={{ textAlign: "left", padding: "4px 6px", color: "#92400E", fontSize: 10 }}>CONCEPTO</th>
                            <th style={{ textAlign: "right", padding: "4px 6px", color: "#92400E", fontSize: 10 }}>DLLS</th>
                            <th style={{ textAlign: "right", padding: "4px 6px", color: "#92400E", fontSize: 10 }}>PESOS</th>
                            <th style={{ width: 20 }}></th>
                          </tr></thead>
                          <tbody>{gm.map(g => (
                            <tr key={g.id} style={{ borderBottom: "1px solid #FDE68A" }}>
                              <td style={{ padding: "4px 6px" }}><input defaultValue={g.fechaPago || ""} onBlur={e => updGM(gm.map(x => x.id !== g.id ? x : { ...x, fechaPago: e.target.value.toUpperCase() }))} style={{ border: "none", background: "transparent", fontSize: 10, fontWeight: 600, width: "100%", fontFamily: "inherit", outline: "none" }} placeholder="—" /></td>
                              <td style={{ padding: "4px 6px" }}><input defaultValue={g.nombre} onBlur={e => updGM(gm.map(x => x.id !== g.id ? x : { ...x, nombre: e.target.value.toUpperCase() }))} style={{ border: "none", background: "transparent", fontSize: 11, fontWeight: 600, width: "100%", fontFamily: "inherit", outline: "none" }} placeholder="CONCEPTO..." /></td>
                              <td style={{ padding: "4px 6px", textAlign: "right" }}><input defaultValue={g.montoDlls || ""} onBlur={e => updGM(gm.map(x => x.id !== g.id ? x : { ...x, montoDlls: parseFloat(e.target.value) || 0 }))} style={{ border: "none", background: "transparent", fontSize: 11, fontFamily: "monospace", width: "100%", textAlign: "right", outline: "none" }} placeholder="0" /></td>
                              <td style={{ padding: "4px 6px", textAlign: "right" }}><input defaultValue={g.montoPesos || ""} onBlur={e => updGM(gm.map(x => x.id !== g.id ? x : { ...x, montoPesos: parseFloat(e.target.value) || 0 }))} style={{ border: "none", background: "transparent", fontSize: 11, fontFamily: "monospace", width: "100%", textAlign: "right", outline: "none" }} placeholder="0" /></td>
                              <td><button onClick={() => updGM(gm.filter(x => x.id !== g.id))} style={{ background: "none", border: "none", cursor: "pointer", color: "#D1D5DB", fontSize: 14, padding: "0 2px", lineHeight: 1 }} onMouseEnter={e => e.currentTarget.style.color = "#DC2626"} onMouseLeave={e => e.currentTarget.style.color = "#D1D5DB"}>×</button></td>
                            </tr>
                          ))}</tbody>
                        </table>
                        <div style={{ borderTop: "2px solid #92400E", marginTop: 6, paddingTop: 6 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                            <span style={{ fontSize: 10, fontWeight: 600, color: "#92400E" }}>💱 Tipo de cambio:</span>
                            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                              <span style={{ fontSize: 10, color: "#6B7280" }}>$1 USD =</span>
                              <input defaultValue={tc} onBlur={e => persist({ ...data, tipoCambioGastos: parseFloat(e.target.value) || 18.5 })} style={{ width: 50, padding: "3px 6px", borderRadius: 4, border: "1px solid #FDE68A", fontSize: 11, fontFamily: "monospace", textAlign: "right", outline: "none", background: "#fff" }} />
                              <span style={{ fontSize: 10, color: "#6B7280" }}>MXN</span>
                            </div>
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#92400E" }}>
                            <span>Total DLLS</span><span style={{ fontFamily: "monospace", fontWeight: 700 }}>{fmt(totalMensDlls)}</span>
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#92400E" }}>
                            <span>Total Pesos</span><span style={{ fontFamily: "monospace", fontWeight: 700 }}>${totalMensPesos.toLocaleString("en-US", {minimumFractionDigits:2})}</span>
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#92400E", background: "#FEF9C3", borderRadius: 4, padding: "3px 6px", marginTop: 2 }}>
                            <span>Pesos en USD (@{tc})</span><span style={{ fontFamily: "monospace", fontWeight: 700 }}>{fmt(totalMensPesos / tc)}</span>
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 700, color: "#92400E", marginTop: 4 }}>
                            <span>TOTAL MENSUAL USD</span><span style={{ fontFamily: "monospace" }}>{fmt(totalMensUSD)}</span>
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#6B7280", marginTop: 2 }}>
                            <span>Semanal (÷4)</span><span style={{ fontFamily: "monospace" }}>{fmt(totalMensualSemanal)}</span>
                          </div>
                        </div>
                      </div>

                      {/* Meta semanal total */}
                      <div style={{ background: "#059669", borderRadius: 8, padding: "12px 16px", marginBottom: 10, textAlign: "center" }}>
                        <div style={{ fontSize: 10, fontWeight: 600, color: "#D1FAE5" }}>🎯 META SEMANAL TOTAL</div>
                        <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "monospace", color: "#fff" }}>{fmt(metaSemanal)}</div>
                        <div style={{ fontSize: 9, color: "#A7F3D0" }}>Anuales ({fmt(porSemana)}/sem) + Mensuales ({fmt(totalMensualSemanal)}/sem)</div>
                      </div>
                    </>);
                  })()}
                  </div>
                );
              })}
              <div style={{ background: "#F9FAFB", borderRadius: 8, padding: "12px 16px", border: "1px solid #E5E7EB" }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>Total en fondos</div>
                <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "monospace", color: "#1A2744" }}>{fmt(totalAll)}</div>
              </div>
              </>);
            })()}
            {fondoModal && fondoModal.tipo === "crear_fondo" && (
              <Modal title="+ Nueva cuenta / fondo" onClose={() => setFondoModal(null)} w={360}>
                <Fld label="Nombre"><Inp value={fondoMonto || ""} onChange={e => setFondoMonto(e.target.value)} placeholder="Ej: Ahorro, Inversión..." autoFocus /></Fld>
                <div style={{ fontSize: 10, fontWeight: 600, marginBottom: 6 }}>Color</div>
                <div style={{ display: "flex", gap: 4, marginBottom: 10, flexWrap: "wrap" }}>
                  {[["#059669","#ECFDF5","#A7F3D0"],["#2563EB","#EFF6FF","#BFDBFE"],["#7C3AED","#F5F3FF","#E9D5FF"],["#D97706","#FEF3C7","#FDE68A"],["#DC2626","#FEF2F2","#FECACA"],["#0891B2","#ECFEFF","#A5F3FC"],["#4F46E5","#EEF2FF","#C7D2FE"],["#DB2777","#FDF2F8","#FBCFE8"]].map(([c,bg,bc]) => (
                    <div key={c} onClick={() => setFondoModal({ ...fondoModal, selColor: c, selBg: bg, selBc: bc })} style={{ width: 28, height: 28, borderRadius: 6, background: bg, border: `2px solid ${fondoModal.selColor === c ? c : bc}`, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {fondoModal.selColor === c && <div style={{ width: 12, height: 12, borderRadius: 3, background: c }} />}
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5E7EB" }}>
                  <Btn v="secondary" onClick={() => setFondoModal(null)}>Cancelar</Btn>
                  <Btn disabled={!fondoMonto} onClick={() => {
                    const nombre = fondoMonto.trim();
                    if (!nombre) return;
                    const k = "custom_" + nombre.toLowerCase().replace(/[^a-z0-9]/g, "_") + "_" + Date.now();
                    const c = fondoModal.selColor || "#7C3AED";
                    const bg = fondoModal.selBg || "#F5F3FF";
                    const bc = fondoModal.selBc || "#E9D5FF";
                    const emoji = "📁";
                    persist({ ...data, fondosCustom: [...(data.fondosCustom || []), { k, nombre, emoji, color: c, bg, bc }] });
                    setFondoModal(null); setFondoMonto("");
                  }} style={{ background: "#7C3AED" }}>Crear cuenta</Btn>
                </div>
              </Modal>
            )}
            {fondoModal && fondoModal.tipo !== "crear_fondo" && (
              <Modal title={fondoModal.tipo === "abono_cxp" ? `💰 Abonar a ${fondoModal.label}` : fondoModal.tipo === "abono_emp" ? `💰 Cobrar a ${fondoModal.label}` : `${fondoModal.tipo === "agregar" ? "+" : "-"} ${fondoModal.tipo === "agregar" ? "Agregar a" : "Retirar de"} ${fondoModal.label}`} onClose={() => setFondoModal(null)} w={360}>
                {fondoModal.tipo === "retirar" && <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 8 }}>Disponible: <strong style={{ color: fondoModal.color }}>{fmt(fondos[fondoModal.key] || 0)}</strong></div>}
                {fondoModal.tipo === "abono_cxp" && (() => { const c = (data.cuentasPorPagar||[]).find(x => x.id === fondoModal.key); return c ? <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 8 }}>Deuda: {fmt(c.deuda)} · Abonado: {fmt(c.abonado||0)} · <strong style={{ color: "#DC2626" }}>Debe: {fmt(c.deuda-(c.abonado||0))}</strong></div> : null; })()}
                {fondoModal.tipo === "abono_emp" && (() => { const empId = parseInt(fondoModal.key.replace("emp_","")); const c = (data.cuentasPorCobrarEmp||[]).find(x => x.id === empId); return c ? <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 8 }}>Deuda: {fmt(c.deuda)} · Cobrado: {fmt(c.abonado||0)} · <strong style={{ color: "#D97706" }}>Debe: {fmt(c.deuda-(c.abonado||0))}</strong></div> : null; })()}
                <div style={{ display: "flex", gap: 8 }}>
                  <div style={{ flex: 1 }}><Fld label="Monto"><Inp type="number" value={fondoMonto} onChange={e => setFondoMonto(e.target.value)} placeholder="0.00" autoFocus /></Fld></div>
                  <div style={{ flex: 1 }}><Fld label="Fecha"><Inp type="date" value={fondoModal.fecha || today()} onChange={e => setFondoModal({ ...fondoModal, fecha: e.target.value })} /></Fld></div>
                </div>
                <Fld label="Descripción"><Inp value={fondoModal.desc || ""} onChange={e => setFondoModal({ ...fondoModal, desc: e.target.value })} placeholder="Detalle del movimiento..." /></Fld>
                {fondoModal.tipo === "retirar" && parseFloat(fondoMonto) > (fondos[fondoModal.key] || 0) && <div style={{ fontSize: 11, color: "#DC2626", marginBottom: 6 }}>⚠️ Monto mayor al disponible</div>}
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5E7EB" }}>
                  <Btn v="secondary" onClick={() => setFondoModal(null)}>Cancelar</Btn>
                  <Btn disabled={!(parseFloat(fondoMonto) > 0)} onClick={() => { const v = parseFloat(fondoMonto); const desc = fondoModal.desc || ""; const fecha = fondoModal.fecha || today(); if (fondoModal.tipo === "abono_cxp") { persist({ ...data, cuentasPorPagar: (data.cuentasPorPagar||[]).map(c => c.id !== fondoModal.key ? c : { ...c, abonado: (c.abonado||0) + v, movs: [...(c.movs||[]), {f:fecha,t:"I",d:desc || "Abono",m:v}] }) }); } else if (fondoModal.tipo === "abono_emp") { const empId = parseInt(fondoModal.key.replace("emp_","")); persist({ ...data, cuentasPorCobrarEmp: (data.cuentasPorCobrarEmp||[]).map(c => c.id !== empId ? c : { ...c, abonado: (c.abonado||0) + v, movs: [...(c.movs||[]), {f:fecha,t:"I",d:desc || "Cobro",m:v}] }) }); } else if (fondoModal.tipo === "agregar") addToFondo(fondoModal.key, v, desc || "Ingreso"); else addToFondo(fondoModal.key, -v, desc || "Retiro"); setFondoModal(null); }} style={{ background: (fondoModal.tipo === "abono_cxp" || fondoModal.tipo === "abono_emp") ? "#059669" : fondoModal.tipo === "agregar" ? "#059669" : "#DC2626" }}>{fondoModal.tipo === "abono_cxp" ? "💰 Abonar" : fondoModal.tipo === "abono_emp" ? "💰 Cobrar" : fondoModal.tipo === "agregar" ? "+ Agregar" : "- Retirar"}</Btn>
                </div>
              </Modal>
            )}
          </div>
        )}

        {cuentasTab === "corte" && (
          <div>
            {(() => {
              const now = new Date();
              const corteOffset = data.corteOffset || 0;
              const getWeek = (offset) => {
                const d = new Date(now);
                d.setDate(d.getDate() + offset * 7);
                const day = d.getDay();
                const mon = new Date(d); mon.setDate(d.getDate() - ((day + 6) % 7));
                const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
                mon.setHours(0,0,0,0); sun.setHours(23,59,59,999);
                return { start: mon, end: sun, label: `${mon.toLocaleDateString("es-MX",{day:"numeric",month:"short"})} — ${sun.toLocaleDateString("es-MX",{day:"numeric",month:"short",year:"numeric"})}` };
              };
              const week = getWeek(corteOffset);
              const inWeek = (fecha) => { if (!fecha) return false; const d = new Date(fecha); return d >= week.start && d <= week.end; };

              // INGRESOS: fletes generados (creados) en la semana — el flete es nuestro ingreso
              const fletesGenerados = data.fantasmas.filter(f => f.costoFlete > 0 && inWeek(f.fechaCreacion));
              const totalFletes = fletesGenerados.reduce((s, f) => s + (f.costoFlete || 0), 0);

              // GASTOS: only real expenses, NOT transfers between bodegas
              // Admin: egresos that are NOT envios to bodegas (those are transfers) and NOT "A FONDO"
              const gastosAdmWeek = (data.gastosAdmin || []).filter(g => inWeek(g.fecha) && g.tipoMov === "egreso" && g.destino !== "BODEGA_USA" && g.destino !== "BODEGA_TJ" && g.destino !== "FONDO");
              // USA: only actual gastos (not fondos received from admin)
              const gastosUSAWeek = (data.gastosUSA || []).filter(g => inWeek(g.fecha) && (g.tipoMov === "gasto" || g.tipoMov === "egreso") && !(g.concepto || "").startsWith("FONDO ADMIN"));
              // TJ: only actual gastos (not fondos received from admin)
              const gastosTJWeek = (data.gastosBodega || []).filter(g => inWeek(g.fecha) && g.tipoMov !== "ingreso" && !(g.concepto || "").startsWith("FONDO ADMIN"));
              const totalGastosAdm = gastosAdmWeek.reduce((s, g) => s + (g.monto || 0), 0);
              const totalGastosUSA = gastosUSAWeek.reduce((s, g) => s + (g.monto || 0), 0);
              const totalGastosTJ = gastosTJWeek.reduce((s, g) => s + (g.monto || 0), 0);
              const totalGastos = totalGastosAdm + totalGastosUSA + totalGastosTJ;

              const totalIngresos = totalFletes;
              const ganancia = totalIngresos - totalGastos;

              const cortes = data.cortesHistorial || [];
              const corteSemana = cortes.find(c => c.weekLabel === week.label);
              const guardarCorte = () => {
                const corte = { id: Date.now(), weekLabel: week.label, fecha: today(), totalFletes, totalIngresos, totalGastosAdm, totalGastosUSA, totalGastosTJ, totalGastos, ganancia, fletes: fletesGenerados.length };
                persist({ ...data, cortesHistorial: [...cortes.filter(c => c.weekLabel !== week.label), corte] });
              };

              return (<>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginBottom: 14 }}>
                  <button onClick={() => persist({ ...data, corteOffset: corteOffset - 1 })} style={{ background: "none", border: "1px solid #D1D5DB", borderRadius: 6, padding: "6px 10px", cursor: "pointer", fontSize: 14 }}>←</button>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#1E40AF" }}>✂️ Corte Semanal</div>
                    <div style={{ fontSize: 12, color: "#6B7280" }}>{week.label}</div>
                    {corteOffset === 0 && <span style={{ fontSize: 9, background: "#DBEAFE", color: "#1E40AF", padding: "1px 6px", borderRadius: 3, fontWeight: 600 }}>Semana actual</span>}
                  </div>
                  <button onClick={() => persist({ ...data, corteOffset: Math.min(0, corteOffset + 1) })} disabled={corteOffset >= 0} style={{ background: "none", border: "1px solid #D1D5DB", borderRadius: 6, padding: "6px 10px", cursor: corteOffset >= 0 ? "default" : "pointer", fontSize: 14, opacity: corteOffset >= 0 ? 0.3 : 1 }}>→</button>
                </div>

                <div style={{ background: "#ECFDF5", borderRadius: 10, padding: "14px 18px", border: "2px solid #A7F3D0", marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#065F46", marginBottom: 8 }}>📈 INGRESOS (Fletes generados)</div>
                  {[
                    { k: "fletes", l: "🚛 Fletes generados", n: fletesGenerados.length, t: totalFletes, items: fletesGenerados.map(f => ({ label: f.cliente, desc: f.descripcion, monto: f.costoFlete, fecha: f.fechaCreacion })) },
                  ].map(row => (
                    <div key={row.k}>
                      <div onClick={() => setCorteExp(corteExp === row.k ? null : row.k)} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "6px 0", borderBottom: "1px solid #A7F3D0", cursor: "pointer" }}>
                        <span>{corteExp === row.k ? "▼" : "▶"} {row.l} ({row.n})</span>
                        <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#059669" }}>{fmt(row.t)}</span>
                      </div>
                      {corteExp === row.k && row.items.length > 0 && (
                        <div style={{ background: "#D1FAE5", borderRadius: 6, padding: "6px 10px", marginBottom: 4 }}>
                          {row.items.map((it, j) => (
                            <div key={j} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, padding: "3px 0", borderBottom: "1px solid #A7F3D0" }}>
                              {it.fecha && <span style={{ color: "#9CA3AF", minWidth: 50 }}>{it.fecha.slice(5)}</span>}
                              <span style={{ fontWeight: 600 }}>{it.label}</span>
                              <span style={{ flex: 1, color: "#6B7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.desc}</span>
                              <span style={{ fontFamily: "monospace", color: "#059669", flexShrink: 0 }}>{fmt(it.monto)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {corteExp === row.k && row.items.length === 0 && <div style={{ fontSize: 10, color: "#6B7280", padding: "4px 10px" }}>Sin fletes esta semana</div>}
                    </div>
                  ))}
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 700, padding: "6px 0", color: "#059669" }}>
                    <span>TOTAL INGRESOS</span><span style={{ fontFamily: "monospace" }}>{fmt(totalIngresos)}</span>
                  </div>
                </div>

                <div style={{ background: "#FEF2F2", borderRadius: 10, padding: "14px 18px", border: "2px solid #FECACA", marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#991B1B", marginBottom: 8 }}>📉 GASTOS</div>
                  {[
                    { k: "g_adm", l: "💼 Admin", n: gastosAdmWeek.length, t: totalGastosAdm, items: gastosAdmWeek.map(g => ({ label: g.concepto, monto: g.monto, fecha: g.fecha })) },
                    { k: "g_usa", l: "🇺🇸 Bodega USA", n: gastosUSAWeek.length, t: totalGastosUSA, items: gastosUSAWeek.map(g => ({ label: g.concepto, monto: g.monto, fecha: g.fecha })) },
                    { k: "g_tj", l: "🇲🇽 Bodega TJ", n: gastosTJWeek.length, t: totalGastosTJ, items: gastosTJWeek.map(g => ({ label: g.concepto, monto: g.monto, fecha: g.fecha })) },
                  ].map(row => (
                    <div key={row.k}>
                      <div onClick={() => setCorteExp(corteExp === row.k ? null : row.k)} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "6px 0", borderBottom: "1px solid #FECACA", cursor: "pointer" }}>
                        <span>{corteExp === row.k ? "▼" : "▶"} {row.l} ({row.n})</span>
                        <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#DC2626" }}>{fmt(row.t)}</span>
                      </div>
                      {corteExp === row.k && row.items.length > 0 && (
                        <div style={{ background: "#FEE2E2", borderRadius: 6, padding: "6px 10px", marginBottom: 4 }}>
                          {row.items.map((it, j) => (
                            <div key={j} style={{ display: "flex", justifyContent: "space-between", fontSize: 10, padding: "2px 0", borderBottom: "1px solid #FECACA" }}>
                              {it.fecha && <span style={{ color: "#9CA3AF", minWidth: 50 }}>{it.fecha.slice(5)}</span>}
                              <span style={{ flex: 1, fontWeight: 600 }}>{it.label}</span>
                              <span style={{ fontFamily: "monospace", color: "#DC2626", flexShrink: 0 }}>{fmt(it.monto)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {corteExp === row.k && row.items.length === 0 && <div style={{ fontSize: 10, color: "#6B7280", padding: "4px 10px" }}>Sin movimientos</div>}
                    </div>
                  ))}
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 700, padding: "6px 0", color: "#DC2626" }}>
                    <span>TOTAL GASTOS</span><span style={{ fontFamily: "monospace" }}>{fmt(totalGastos)}</span>
                  </div>
                </div>

                <div style={{ background: ganancia >= 0 ? "#059669" : "#DC2626", borderRadius: 10, padding: "16px 20px", marginBottom: 14, textAlign: "center" }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: "rgba(255,255,255,.7)" }}>{ganancia >= 0 ? "💰 GANANCIA DE LA SEMANA" : "⚠️ PÉRDIDA DE LA SEMANA"}</div>
                  <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "monospace", color: "#fff" }}>{fmt(Math.abs(ganancia))}</div>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,.6)" }}>Ingresos {fmt(totalIngresos)} − Gastos {fmt(totalGastos)}</div>
                </div>

                <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
                  {corteSemana ? (
                    <div style={{ background: "#DBEAFE", borderRadius: 8, padding: "10px 20px", border: "1px solid #93C5FD", textAlign: "center" }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#1E40AF" }}>✅ Corte guardado</div>
                      <div style={{ fontSize: 10, color: "#6B7280" }}>Ganancia registrada: {fmt(corteSemana.ganancia)}</div>
                      <button onClick={guardarCorte} style={{ marginTop: 6, padding: "4px 12px", borderRadius: 5, border: "1px solid #93C5FD", background: "#fff", color: "#2563EB", fontSize: 10, cursor: "pointer", fontFamily: "inherit" }}>↻ Actualizar</button>
                    </div>
                  ) : (
                    <button onClick={guardarCorte} style={{ padding: "10px 24px", borderRadius: 8, border: "none", background: "#2563EB", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>✂️ Guardar corte</button>
                  )}
                </div>

                {cortes.length > 0 && (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: "#374151" }}>📜 Historial de cortes</div>
                    {[...cortes].reverse().map(c => (
                      <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#fff", borderRadius: 6, border: "1px solid #E5E7EB", marginBottom: 3, fontSize: 11 }}>
                        <span style={{ color: "#9CA3AF", fontSize: 10, minWidth: 55 }}>{c.fecha}</span>
                        <span style={{ flex: 1, fontWeight: 600 }}>{c.weekLabel}</span>
                        <span style={{ fontFamily: "monospace", color: "#059669", fontSize: 10 }}>+{fmt(c.totalIngresos)}</span>
                        <span style={{ fontFamily: "monospace", color: "#DC2626", fontSize: 10 }}>-{fmt(c.totalGastos)}</span>
                        <span style={{ fontFamily: "monospace", fontWeight: 700, color: c.ganancia >= 0 ? "#059669" : "#DC2626" }}>{fmt(c.ganancia)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>);
            })()}
          </div>
        )}

      </div>
    );
  };

  // ============ ADMIN FINANZAS (wrapper) ============
  const AdminFinanzas = () => {
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>💰 Finanzas</h2>
          <div style={{ display: "flex", gap: 3, background: "#F3F4F6", borderRadius: 8, padding: 3 }}>
            {[
              { k: "efectivo", l: "💵 Efectivo", c: "#059669" },
              { k: "transferencias", l: "🏦 Transferencias", c: "#7C3AED" },
              { k: "adelantos", l: "💸 Adelantos", c: "#D97706" },
              { k: "ganancias", l: "⭐ Ganancias", c: "#9333EA" },
            ].map(t => (
              <button key={t.k} onClick={() => setFinTab(t.k)} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: finTab === t.k ? "#fff" : "transparent", boxShadow: finTab === t.k ? "0 1px 3px rgba(0,0,0,.1)" : "none", cursor: "pointer", fontSize: 11, fontWeight: finTab === t.k ? 700 : 500, fontFamily: "inherit", color: finTab === t.k ? t.c : "#6B7280" }}>{t.l}</button>
            ))}
          </div>
        </div>
        <div style={{ display: finTab === "efectivo" ? "block" : "none" }}><AdminEfectivo /></div>
        <div style={{ display: finTab === "transferencias" ? "block" : "none" }}><AdminTransferencias /></div>
        <div style={{ display: finTab === "adelantos" ? "block" : "none" }}><AdminAdelantos /></div>
        {finTab === "ganancias" && (() => {
          // Todos los pedidos especiales activos (no cerrados, no separados)
          const todosEspeciales = data.fantasmas.filter(f => f.pedidoEspecial && !f.gananciaSeparada && f.estado !== "CERRADO");
          const porSeparar = todosEspeciales.filter(f => {
            const precioVenta = f.totalVenta || f.costoMercancia || 0;
            return f.clientePago || (f.abonoMercancia || 0) >= precioVenta;
          });
          const enProceso = todosEspeciales.filter(f => {
            const precioVenta = f.totalVenta || f.costoMercancia || 0;
            return !f.clientePago && (f.abonoMercancia || 0) < precioVenta;
          });
          const historial = [...(data.bitacoraGanancias || [])].reverse();
          const totalPorSeparar = porSeparar.reduce((s, f) => s + (f.gananciaEspecial || 0), 0);
          const totalSep = historial.reduce((s, g) => s + (g.ganancia || 0), 0);

          const separar = (fId) => {
            const f = data.fantasmas.find(x => x.id === fId);
            if (!f) return;
            const ganancia = f.gananciaEspecial || (f.costoMercancia - (f.costoReal || 0)) || 0;
            const registro = { id: Date.now(), pedidoId: fId, cliente: f.cliente, descripcion: f.descripcion, costoReal: f.costoReal, precioVenta: f.costoMercancia, ganancia, fecha: today() };
            persist({ ...data, fantasmas: data.fantasmas.map(x => x.id !== fId ? x : { ...x, gananciaSeparada: true, fechaGananciaSeparada: today() }), bitacoraGanancias: [...(data.bitacoraGanancias || []), registro], gastosAdmin: [...(data.gastosAdmin || []), { id: Date.now() + 1, concepto: `⭐ GANANCIA ${fId} — ${(() => { const pf = data.fantasmas.find(x => x.id === fId); return pf?.cliente || ""; })()}`, monto: registro.ganancia, montoUSD: registro.ganancia, montoMXN: 0, moneda: "USD", destino: "ADMIN", fecha: today(), nota: registro.descripcion || "", tipoMov: "ingreso", gananciaPedidoId: fId }] });
          };

          const renderEspecial = (f, canSeparar) => {
            const ganancia = f.gananciaEspecial || (f.costoMercancia - (f.costoReal || 0)) || 0;
            const precioVenta = f.totalVenta || f.costoMercancia || 0;
            const abonado = f.abonoMercancia || 0;
            const debe = precioVenta - abonado;
            const ds = f.dineroStatus || "SIN_FONDOS";
            const dc = DINERO_COLORS[ds] || DINERO_COLORS["SIN_FONDOS"];
            return (
              <div key={f.id} style={{ background: "#fff", padding: "12px 14px", borderRadius: 8, border: `1px solid ${canSeparar ? "#A7F3D0" : "#E9D5FF"}`, marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
                      <span style={{ fontSize: 9, fontFamily: "monospace", color: "#9CA3AF" }}>{f.id}</span>
                      <strong style={{ fontSize: 13 }}>{f.cliente}</strong>
                      <span style={{ fontSize: 11, color: "#6B7280" }}>{f.descripcion}</span>
                      <Badge estado={f.estado} />
                    </div>
                    {/* Dinero status */}
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
                      <span style={{ background: dc.bg, color: dc.text, fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 10 }}>{DINERO_STATUS[ds]}</span>
                      {f.clientePago
                        ? <span style={{ fontSize: 10, color: "#059669", fontWeight: 700 }}>✓ Cliente pagó {fmt(precioVenta)}</span>
                        : abonado > 0
                          ? <span style={{ fontSize: 10, color: "#D97706" }}>Abonado {fmt(abonado)} · Debe {fmt(debe)}</span>
                          : <span style={{ fontSize: 10, color: "#DC2626" }}>Sin pago — debe {fmt(debe)}</span>
                      }
                    </div>
                    {/* Costos */}
                    <div style={{ display: "flex", gap: 12, fontSize: 11, flexWrap: "wrap" }}>
                      <span style={{ color: "#9CA3AF" }}>Costo real: <strong style={{ fontFamily: "monospace", color: "#374151" }}>{fmt(f.costoReal || 0)}</strong></span>
                      <span style={{ color: "#9CA3AF" }}>Precio venta: <strong style={{ fontFamily: "monospace", color: "#374151" }}>{fmt(precioVenta)}</strong></span>
                      <span style={{ fontWeight: 700, color: "#059669" }}>Ganancia: {fmt(ganancia)}</span>
                    </div>
                  </div>
                  {canSeparar && (
                    <button onClick={() => separar(f.id)} style={{ background: "#059669", border: "none", color: "#fff", padding: "9px 14px", borderRadius: 7, cursor: "pointer", fontSize: 11, fontWeight: 700, fontFamily: "inherit", whiteSpace: "nowrap", flexShrink: 0 }}>
                      ✅ Separar {fmt(ganancia)}
                    </button>
                  )}
                </div>
              </div>
            );
          };

          return (
            <div>
              {/* Por separar - cliente ya pagó */}
              {porSeparar.length > 0 && (
                <div style={{ background: "#F0FDF4", borderRadius: 9, border: "2px solid #A7F3D0", padding: 16, marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#059669" }}>✅ Listos para separar ({porSeparar.length})</h3>
                    <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 14, color: "#059669" }}>{fmt(totalPorSeparar)}</span>
                  </div>
                  {porSeparar.map(f => renderEspecial(f, true))}
                </div>
              )}

              {/* En proceso - aún no pagados */}
              <div style={{ background: "#FDF4FF", borderRadius: 9, border: "2px solid #E9D5FF", padding: 16, marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#7C3AED" }}>⭐ Pedidos especiales en proceso ({enProceso.length})</h3>
                  <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 12, color: "#7C3AED" }}>
                    Ganancia esperada: {fmt(enProceso.reduce((s, f) => s + (f.gananciaEspecial || 0), 0))}
                  </span>
                </div>
                {enProceso.length === 0
                  ? <div style={{ textAlign: "center", padding: "12px 0", color: "#9CA3AF", fontSize: 12 }}>No hay pedidos especiales pendientes de cobro</div>
                  : enProceso.map(f => renderEspecial(f, false))
                }
              </div>

              {/* Historial de separadas */}
              <div style={{ background: "#fff", borderRadius: 9, border: "1px solid #E5E7EB", padding: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#059669" }}>📒 Historial de ganancias separadas</h3>
                  <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 14, color: "#059669" }}>{fmt(totalSep)}</span>
                </div>
                {historial.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "16px 0", color: "#9CA3AF", fontSize: 12 }}>Aún no has separado ninguna ganancia</div>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead><tr style={{ background: "#F9FAFB" }}>
                      <th style={{ padding: "6px 10px", textAlign: "left", fontWeight: 600, color: "#6B7280", fontSize: 10 }}>Folio</th>
                      <th style={{ padding: "6px 10px", textAlign: "left", fontWeight: 600, color: "#6B7280", fontSize: 10 }}>Cliente</th>
                      <th style={{ padding: "6px 10px", textAlign: "left", fontWeight: 600, color: "#6B7280", fontSize: 10 }}>Mercancía</th>
                      <th style={{ padding: "6px 10px", textAlign: "right", fontWeight: 600, color: "#6B7280", fontSize: 10 }}>Costo real</th>
                      <th style={{ padding: "6px 10px", textAlign: "right", fontWeight: 600, color: "#6B7280", fontSize: 10 }}>Vendido</th>
                      <th style={{ padding: "6px 10px", textAlign: "right", fontWeight: 600, color: "#059669", fontSize: 10 }}>Ganancia</th>
                      <th style={{ padding: "6px 10px", textAlign: "center", fontWeight: 600, color: "#6B7280", fontSize: 10 }}>Fecha</th>
                    </tr></thead>
                    <tbody>{historial.map((g, i) => (
                      <tr key={g.id} style={{ background: i % 2 === 0 ? "#fff" : "#FAFBFC", borderBottom: "1px solid #F3F4F6" }}>
                        <td style={{ padding: "7px 10px", fontFamily: "monospace", fontSize: 10, color: "#9CA3AF" }}>{g.pedidoId}</td>
                        <td style={{ padding: "7px 10px", fontWeight: 600 }}>{g.cliente}</td>
                        <td style={{ padding: "7px 10px", color: "#6B7280" }}>{g.descripcion}</td>
                        <td style={{ padding: "7px 10px", textAlign: "right", fontFamily: "monospace" }}>{fmt(g.costoReal)}</td>
                        <td style={{ padding: "7px 10px", textAlign: "right", fontFamily: "monospace" }}>{fmt(g.precioVenta)}</td>
                        <td style={{ padding: "7px 10px", textAlign: "right", fontFamily: "monospace", fontWeight: 700, color: "#059669" }}>{fmt(g.ganancia)}</td>
                        <td style={{ padding: "7px 10px", textAlign: "center", color: "#6B7280", fontSize: 10 }}>{fmtD(g.fecha)}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                )}
              </div>
            </div>
          );
        })()}
      </div>
    );
  };

  // ============ ROLE NAV CONFIG ============
  const ALL_NAV = [
    { k: "ventas",      l: "Pedidos",     i: <I.Dollar /> },
    { k: "bodegausa",   l: "Bodega USA",  i: <I.Box />    },
    { k: "bodegatj",    l: "Bodega TJ",   i: <I.Truck />  },
    { k: "bitacora",    l: "Bitácora",    i: <I.List />   },
    { k: "clientes",    l: "Clientes",    i: <I.Users />  },
    { k: "proveedores", l: "Proveedores", i: <I.Store />  },
  ];
  const allowed = ROLE_NAV[role] || [];
  const navItems = ALL_NAV.filter(n => allowed.includes(n.k));

  // ============ LAYOUT ============
  return (
    <AppCtx.Provider value={{ data, persist, updF, addF, role, today, fmt, fmtD, view, navigate, setDetailMode, detailMode, filterByDate, showConfirm, getDateRange, periodoTipo, periodoOffset, setPeriodoTipo, setPeriodoOffset, Modal, Btn, Fld, Inp, I, Stat, Badge, DBadge, AutoInp, TIPOS_MERCANCIA, selId, setSelId, confirm, setConfirm, tjTab, setTjTab, usaTab, setUsaTab, finTab, setFinTab, pagoTabApp, setPagoTabApp, flujoSubTabApp, setFlujoSubTabApp, showTransApp, setShowTransApp, tFormTipo, setTFormTipo, showNew, setShowNew, editPedidoId, setEditPedidoId, showMovApp, setShowMovApp, showGastoApp, setShowGastoApp, showCobroApp, setShowCobroApp, showGastoUSAApp, setShowGastoUSAApp, showAdelantoApp, setShowAdelantoApp, showColchon, setShowColchon, bitSk, setBitSk, bitSd, setBitSd, bitModo, setBitModo, bitTab, setBitTab, bitFProv, setBitFProv, bitFCli, setBitFCli, bitFVend, setBitFVend, bitSearch, setBitSearch, bitPagoMerc, setBitPagoMerc, bitPagoFlete, setBitPagoFlete, bitEstado, setBitEstado, menuOpen, setMenuOpen }}>
    <div onMouseMove={onUserActivity} onKeyDown={onUserActivity} onTouchStart={onUserActivity} style={{ minHeight: "100vh", background: "#F8F9FB", fontFamily: "'DM Sans', 'Segoe UI', -apple-system, sans-serif", color: "#111827" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet" />
      <header style={{ background: "#1A2744", color: "#fff", padding: "0 16px", display: "flex", alignItems: "center", height: 48, gap: 10, position: "sticky", top: 0, zIndex: 100, boxShadow: "0 2px 8px rgba(0,0,0,.15)" }}>
        {/* Hamburger button - mobile */}
        <button onClick={() => setMenuOpen(o => !o)} style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", padding: "4px 6px", borderRadius: 6, display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }}>
          <span style={{ display: "block", width: 18, height: 2, background: "#fff", borderRadius: 2 }} />
          <span style={{ display: "block", width: 18, height: 2, background: "#fff", borderRadius: 2 }} />
          <span style={{ display: "block", width: 18, height: 2, background: "#fff", borderRadius: 2 }} />
        </button>
        {/* Logo */}
        <button onClick={() => { navigate("home"); setMenuOpen(false); }} style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontFamily: "inherit", fontSize: 14, fontWeight: 700, padding: 0, flexShrink: 0 }}>
          <span style={{ fontSize: 18 }}>👻</span> OchoaTransport
        </button>
        {/* Current view label - shows active section */}
        <span style={{ background: "rgba(255,255,255,.1)", padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600, flex: 1, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {navItems.find(n => n.k === view)?.l || ROLE_NAMES[role]}
        </span>
        {/* Online users indicator */}
        {onlineUsers.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
            {onlineUsers.map(u => (
              <div key={u.user} title={`${u.user} — ${u.label} (en línea)`} style={{ display: "flex", alignItems: "center", gap: 3, background: "rgba(16,185,129,0.2)", border: "1px solid rgba(16,185,129,0.4)", borderRadius: 10, padding: "2px 7px" }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#10B981", display: "inline-block", flexShrink: 0 }} />
                <span style={{ fontSize: 9, fontWeight: 600, color: "#6EE7B7", whiteSpace: "nowrap" }}>{u.label}</span>
              </div>
            ))}
          </div>
        )}
        {/* Save status indicator */}
        {saveStatus === "saving" && <span style={{ fontSize: 9, color: "#94A3B8", flexShrink: 0 }}>💾...</span>}
        {saveStatus === "error" && <span style={{ fontSize: 9, background: "#DC2626", color: "#fff", padding: "2px 6px", borderRadius: 3, flexShrink: 0 }}>❌ Firebase error</span>}
        {saveStatus === "local" && <span style={{ fontSize: 9, background: "#D97706", color: "#fff", padding: "2px 6px", borderRadius: 3, flexShrink: 0 }}>⚠️ Solo local</span>}
        {/* Right side */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {stats.pend > 0 && <span style={{ background: "#DC2626", color: "#fff", padding: "1px 7px", borderRadius: 8, fontSize: 9, fontWeight: 600 }}>{stats.pend}</span>}
          <button onClick={() => { 
            if (currentUser) setDoc(doc(db, "presence", currentUser), { user: currentUser, role, online: false, lastSeen: Date.now() });
            setRole(null); setCurrentUser(null); setLoginUser(""); setLoginPass(""); setView("main"); setMenuOpen(false); 
            try { localStorage.removeItem("ot_role"); localStorage.removeItem("ot_user"); } catch {} 
          }} style={{ background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.15)", color: "#94A3B8", padding: "4px 10px", borderRadius: 5, cursor: "pointer", fontSize: 10, fontWeight: 600, fontFamily: "inherit" }}>Salir</button>
        </div>
      </header>

      {/* Mobile slide-down menu */}
      {menuOpen && (
        <div style={{ position: "fixed", top: 48, left: 0, right: 0, background: "#1A2744", zIndex: 99, boxShadow: "0 8px 24px rgba(0,0,0,.3)", borderBottom: "1px solid rgba(255,255,255,.1)" }} onClick={() => setMenuOpen(false)}>
          <div style={{ padding: "8px 0" }}>
            {/* User info */}
            <div style={{ padding: "8px 18px 12px", borderBottom: "1px solid rgba(255,255,255,.08)", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ background: ROLE_COLORS[role], padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>{ROLE_NAMES[role]}</span>
              <span style={{ color: "#94A3B8", fontSize: 11 }}>{currentUser}</span>
              {(role === "usa" || role === "admin") && <button onClick={e => { e.stopPropagation(); setShowColchon(true); setMenuOpen(false); }} style={{ marginLeft: "auto", background: "rgba(255,255,255,.1)", border: "none", color: "#fff", padding: "3px 8px", borderRadius: 5, cursor: "pointer", fontSize: 10, fontWeight: 600, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 3 }}><I.Shield /> Colchón</button>}
            </div>
            {/* Nav items */}
            {navItems.map(n => (
              <button key={n.k} onClick={() => { navigate(n.k, null, view); setFEst("ALL"); setSearch(""); setMenuOpen(false); }}
                style={{ width: "100%", background: view === n.k ? "rgba(255,255,255,.1)" : "transparent", border: "none", color: view === n.k ? "#fff" : "#94A3B8", padding: "13px 18px", cursor: "pointer", fontSize: 14, fontWeight: view === n.k ? 700 : 400, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 12, textAlign: "left", borderLeft: view === n.k ? "3px solid #60A5FA" : "3px solid transparent" }}>
                {n.i} {n.l}
              </button>
            ))}
            {/* Admin extra */}
            {role === "admin" && (
              <>
                <div style={{ height: 1, background: "rgba(255,255,255,.08)", margin: "4px 0" }} />
                <button onClick={() => { navigate("main", null); setMenuOpen(false); }} style={{ width: "100%", background: view === "main" ? "rgba(255,255,255,.1)" : "transparent", border: "none", color: view === "main" ? "#fff" : "#94A3B8", padding: "13px 18px", cursor: "pointer", fontSize: 14, fontWeight: 400, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 12, textAlign: "left", borderLeft: view === "main" ? "3px solid #60A5FA" : "3px solid transparent" }}>
                  📊 Dashboard
                </button>
                <button onClick={() => { navigate("finanzas", null); setMenuOpen(false); }} style={{ width: "100%", background: view === "finanzas" ? "rgba(255,255,255,.1)" : "transparent", border: "none", color: view === "finanzas" ? "#fff" : "#94A3B8", padding: "13px 18px", cursor: "pointer", fontSize: 14, fontWeight: 400, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 12, textAlign: "left", borderLeft: view === "finanzas" ? "3px solid #60A5FA" : "3px solid transparent" }}>
                  💰 Finanzas
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {/* Backdrop to close menu */}
      {menuOpen && <div style={{ position: "fixed", inset: 0, top: 48, zIndex: 98 }} onClick={() => setMenuOpen(false)} />}
      {/* Period filter bar */}
      <div style={{ background: "#fff", borderBottom: "1px solid #E5E7EB", padding: "6px 16px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", position: "sticky", top: 48, zIndex: 99 }}>
        <span style={{ fontSize: 10, color: "#6B7280", fontWeight: 600 }}>📅 Período:</span>
        <div style={{ display: "flex", gap: 2, background: "#F3F4F6", borderRadius: 6, padding: 2 }}>
          {[
            { k: "global", l: "Global" },
            { k: "año", l: "Año" },
            { k: "mes", l: "Mes" },
            { k: "semana", l: "Semana" },
          ].map(p => (
            <button key={p.k} onClick={() => { setPeriodoTipo(p.k); setPeriodoOffset(0); }} style={{ padding: "4px 10px", borderRadius: 5, border: "none", background: periodoTipo === p.k ? "#1A2744" : "transparent", color: periodoTipo === p.k ? "#fff" : "#6B7280", fontWeight: periodoTipo === p.k ? 700 : 500, fontSize: 10, cursor: "pointer", fontFamily: "inherit" }}>{p.l}</button>
          ))}
        </div>
        {periodoTipo !== "global" && (
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button onClick={() => setPeriodoOffset(o => o - 1)} style={{ background: "#F3F4F6", border: "none", borderRadius: 4, padding: "3px 8px", cursor: "pointer", fontSize: 12, fontFamily: "inherit", color: "#374151" }}>←</button>
            <span style={{ fontSize: 11, fontWeight: 600, color: "#1A2744", minWidth: 120, textAlign: "center" }}>{periodoLabel()}</span>
            <button onClick={() => setPeriodoOffset(o => o + 1)} disabled={periodoOffset >= 0} style={{ background: periodoOffset >= 0 ? "#F9FAFB" : "#F3F4F6", border: "none", borderRadius: 4, padding: "3px 8px", cursor: periodoOffset >= 0 ? "not-allowed" : "pointer", fontSize: 12, fontFamily: "inherit", color: periodoOffset >= 0 ? "#D1D5DB" : "#374151" }}>→</button>
            <button onClick={() => setPeriodoOffset(0)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 9, color: "#6B7280", fontFamily: "inherit", textDecoration: "underline" }}>Hoy</button>
          </div>
        )}
        {role === "admin" && <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}><button onClick={() => { navigate(prevView, null); }} style={{ padding: "5px 14px", borderRadius: 8, border: view === "main" ? "2px solid #1A2744" : "1px solid #D1D5DB", background: view === "main" ? "#EFF6FF" : "#fff", cursor: "pointer", fontSize: 11, fontWeight: view === "main" ? 700 : 500, fontFamily: "inherit", color: view === "main" ? "#1A2744" : "#6B7280", display: "flex", alignItems: "center", gap: 4 }}>📊 Dashboard</button><button onClick={() => { navigate("finanzas"); setSelId(null); }} style={{ padding: "5px 14px", borderRadius: 8, border: view === "finanzas" ? "2px solid #059669" : "1px solid #D1D5DB", background: view === "finanzas" ? "#ECFDF5" : "#fff", cursor: "pointer", fontSize: 11, fontWeight: view === "finanzas" ? 700 : 500, fontFamily: "inherit", color: view === "finanzas" ? "#065F46" : "#6B7280", display: "flex", alignItems: "center", gap: 4 }}>💰 Finanzas</button></div>}
      </div>
      <main style={{ maxWidth: 1400, margin: "0 auto", padding: "18px 24px" }}>
        {/* Botón atrás — aparece en todas las pantallas excepto home */}
        {view !== "main" && view !== "detail" && view !== "home" && (
          <button onClick={() => { navigate("home"); setSelId(null) }} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: "#6B7280", cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 500, marginBottom: 12, padding: "4px 0" }}>
            ← Inicio
          </button>
        )}
        {view === "main" && role === "admin" && <Dashboard />}
        {view === "main" && role !== "admin" && <ListView />}
        {view === "list" && <ListView />}
        {view === "detail" && <DetailView />}
        {view === "ventas" && <Ventas />}
        {view === "bodegausa" && <BodegaUSA />}
        {view === "bodegatj" && <BodegaTJ />}
        {view === "bitacora" && <Bitacora />}
        {view === "finanzas" && <AdminFinanzas />}
        <div style={{ display: view === "cuentas" ? "block" : "none" }}><CuentasPage /></div>
        <div style={{ display: view === "envios" ? "block" : "none" }}><Envios /></div>
        {view === "recoleccion" && <Recoleccion />}
        <div style={{ display: view === "clientes" ? "block" : "none" }}><Clientes /></div>
        <div style={{ display: view === "proveedores" ? "block" : "none" }}><Proveedores /></div>
      </main>
      <NewForm showNew={showNew} data={data} addF={addF} updateF={updF} editPedido={editPedidoId ? data.fantasmas.find(x => x.id === editPedidoId) || null : null} role={role} setShowNew={(v) => { setShowNew(v); if (!v) setEditPedidoId(null); }} today={today} fmt={fmt} fmtD={fmtD} Modal={Modal} Btn={Btn} Fld={Fld} Inp={Inp} AutoInp={AutoInp} I={I} navigate={navigate} TIPOS_MERCANCIA={TIPOS_MERCANCIA} />
      {showColchon && <ColchonModal />}
      {/* Global dialog modal - replaces window.alert and window.confirm */}
      {dialog && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: "#fff", borderRadius: 14, padding: 28, maxWidth: 400, width: "100%", boxShadow: "0 20px 60px rgba(0,0,0,.3)", fontFamily: "inherit" }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 12, color: "#1A2744" }}>{dialog.title}</div>
            <div style={{ fontSize: 13, color: "#374151", marginBottom: 24, lineHeight: 1.6, whiteSpace: "pre-line" }}>{dialog.msg}</div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              {dialog.type === "confirm" && (
                <button onClick={dialog.onCancel} style={{ padding: "8px 18px", borderRadius: 8, border: "1px solid #D1D5DB", background: "#F9FAFB", color: "#374151", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
              )}
              <button onClick={dialog.onOk} style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: "#1A2744", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                {dialog.type === "confirm" ? "Sí, confirmar" : "Entendido"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </AppCtx.Provider>
  );
}
