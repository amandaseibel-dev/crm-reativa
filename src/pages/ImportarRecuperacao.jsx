import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { podeVerTudo } from "../utils/operadores";

// Importa relatorios de recuperacao (padrao Santander) para a tabela
// historica recuperacao_historica, isolada do operacional.
const CDN_XLSX = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function num(v) {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  let t = String(v).replace("R$", "").replace(/\s/g, "").trim();
  const tv = t.includes(","), tp = t.includes(".");
  if (tv && tp) t = t.replace(/\./g, "").replace(",", ".");
  else if (tv) t = t.replace(",", ".");
  return Number(t) || 0;
}
function codUnidade(u) {
  const m = String(u || "").match(/\(([^)]+)\)\s*$/);
  return m ? m[1].trim() : String(u || "").trim().slice(0, 40);
}
function paraDataISO(v) {
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  const s = String(v || "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    let a = m[3]; if (a.length === 2) a = "20" + a;
    return `${a}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

export default function ImportarRecuperacao() {
  const [email, setEmail] = useState("");
  const [libOk, setLibOk] = useState(false);
  const [linhas, setLinhas] = useState([]);
  const [nomeArquivo, setNomeArquivo] = useState("");
  const [erro, setErro] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState("");
  const [existentes, setExistentes] = useState({});

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data?.user?.email || ""));
    if (window.XLSX) { setLibOk(true); return; }
    const s = document.createElement("script");
    s.src = CDN_XLSX;
    s.onload = () => setLibOk(true);
    s.onerror = () => setErro("Não consegui carregar a biblioteca de leitura de planilha.");
    document.body.appendChild(s);
  }, []);

  const podeUsar = podeVerTudo(email);

  async function aoEscolher(e) {
    setErro(""); setMsg(""); setLinhas([]); setExistentes({});
    const file = e.target.files?.[0];
    if (!file) return;
    setNomeArquivo(file.name);
    try {
      const buf = await file.arrayBuffer();
      const wb = window.XLSX.read(buf, { type: "array", cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
      const out = [];
      for (const r of rows) {
        const c0 = String(r[0] || "");
        if (c0.startsWith("Data de Pagamento") || c0.startsWith("Número de t") || c0.startsWith("Numero de t")) continue;
        const nomeRaw = String(r[1] || "");
        if (!nomeRaw.includes(" - ")) continue;
        const dISO = paraDataISO(r[9]);
        if (!dISO) continue;
        const nome = nomeRaw.split(" - ").slice(1).join(" - ").trim();
        out.push({
          competencia: dISO.slice(0, 7) + "-01",
          data_pagamento: dISO,
          aluno_nome: nome,
          valor_pago: num(r[10]),
          valor_honorario: num(r[8]),
          unidade: codUnidade(r[0]),
          operador_nome: String(r[3] || "").trim(),
          origem: "IMPORTACAO_RETROATIVA",
        });
      }
      if (out.length === 0) { setErro("Não encontrei linhas de pagamento nesse arquivo. Confira se é o relatório Santander."); return; }
      setLinhas(out);
      // checa competencias ja existentes
      const comps = [...new Set(out.map((x) => x.competencia))];
      const { data } = await supabase
        .from("recuperacao_historica")
        .select("competencia")
        .in("competencia", comps);
      const cont = {};
      (data || []).forEach((d) => { cont[d.competencia] = (cont[d.competencia] || 0) + 1; });
      setExistentes(cont);
    } catch (err) {
      setErro("Erro ao ler a planilha: " + err.message);
    }
  }

  const resumo = useMemo(() => {
    const by = {};
    let vt = 0, ht = 0;
    linhas.forEach((l) => {
      const m = l.competencia.slice(0, 7);
      by[m] = by[m] || { qt: 0, v: 0, h: 0 };
      by[m].qt += 1; by[m].v += l.valor_pago; by[m].h += l.valor_honorario;
      vt += l.valor_pago; ht += l.valor_honorario;
    });
    return { by, vt, ht, qt: linhas.length };
  }, [linhas]);

  const temOverlap = Object.keys(existentes).length > 0;

  async function importar() {
    if (!linhas.length) return;
    setSalvando(true); setErro(""); setMsg("");
    try {
      const B = 200;
      for (let i = 0; i < linhas.length; i += B) {
        const parte = linhas.slice(i, i + B);
        const { error } = await supabase.from("recuperacao_historica").insert(parte);
        if (error) throw error;
      }
      setMsg(`Importado com sucesso: ${linhas.length} pagamentos (${moeda(resumo.vt)} recuperado).`);
      setLinhas([]); setExistentes({}); setNomeArquivo("");
    } catch (err) {
      setErro("Erro ao importar: " + err.message);
    } finally {
      setSalvando(false);
    }
  }

  if (!podeUsar) {
    return (
      <div style={s.wrap}>
        <h1 style={s.h1}>Importar Recuperação</h1>
        <div style={s.aviso}>Acesso restrito à gestão.</div>
      </div>
    );
  }

  return (
    <div style={s.wrap}>
      <h1 style={s.h1}>Importar Recuperação (Santander)</h1>
      <p style={s.sub}>Suba o relatório .xlsx do Santander. Os dados entram na base histórica de recuperação (isolada do operacional). Confira a reconciliação antes de confirmar.</p>

      <div style={s.card}>
        <input type="file" accept=".xlsx,.xls" disabled={!libOk} onChange={aoEscolher} />
        {!libOk && !erro && <span style={s.muted}> carregando leitor de planilha...</span>}
        {nomeArquivo && <div style={{ marginTop: 8, fontSize: 13 }}>Arquivo: <strong>{nomeArquivo}</strong></div>}
      </div>

      {erro && <div style={s.erro}>{erro}</div>}
      {msg && <div style={s.ok}>{msg}</div>}

      {linhas.length > 0 && (
        <div style={s.card}>
          <h3 style={s.h3}>Reconciliação</h3>
          <table style={s.tbl}>
            <thead><tr><th style={s.th}>Mês</th><th style={s.thR}>Pagamentos</th><th style={s.thR}>Recuperado</th><th style={s.thR}>Honorários</th><th style={s.th}>Já na base?</th></tr></thead>
            <tbody>
              {Object.keys(resumo.by).sort().map((m) => (
                <tr key={m}>
                  <td style={s.td}>{m}</td>
                  <td style={s.tdR}>{resumo.by[m].qt}</td>
                  <td style={s.tdR}>{moeda(resumo.by[m].v)}</td>
                  <td style={s.tdR}>{moeda(resumo.by[m].h)}</td>
                  <td style={s.td}>{existentes[m + "-01"] ? <span style={s.tagWarn}>{existentes[m + "-01"]} já carregados</span> : "não"}</td>
                </tr>
              ))}
              <tr style={s.totalRow}>
                <td style={s.td}><strong>Total</strong></td>
                <td style={s.tdR}><strong>{resumo.qt}</strong></td>
                <td style={s.tdR}><strong>{moeda(resumo.vt)}</strong></td>
                <td style={s.tdR}><strong>{moeda(resumo.ht)}</strong></td>
                <td style={s.td}></td>
              </tr>
            </tbody>
          </table>

          {temOverlap && (
            <div style={s.avisoInline}>
              Atenção: alguns meses já têm dados na base. Importar de novo vai <strong>somar</strong> (duplicar). Só confirme se for um arquivo diferente.
            </div>
          )}

          <button style={s.botao} onClick={importar} disabled={salvando}>
            {salvando ? "Importando..." : `Confirmar importação de ${resumo.qt} pagamentos`}
          </button>
        </div>
      )}
    </div>
  );
}

const s = {
  wrap: { padding: 24, fontFamily: "Arial, sans-serif" },
  h1: { margin: 0, color: "#0f172a" },
  sub: { color: "#64748b", fontSize: 13, margin: "6px 0 16px" },
  card: { background: "#fff", border: "1px solid #eef2f6", borderRadius: 14, padding: 18, marginBottom: 16 },
  h3: { margin: "0 0 12px", fontSize: 15, color: "#0f172a" },
  tbl: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "8px 10px", color: "#8a93a3", fontSize: 11, fontWeight: 700, textTransform: "uppercase", background: "#f8fafc", borderBottom: "1px solid #e3e7ee" },
  thR: { textAlign: "right", padding: "8px 10px", color: "#8a93a3", fontSize: 11, fontWeight: 700, textTransform: "uppercase", background: "#f8fafc", borderBottom: "1px solid #e3e7ee" },
  td: { padding: "8px 10px", borderBottom: "1px solid #f2f4f7" },
  tdR: { padding: "8px 10px", borderBottom: "1px solid #f2f4f7", textAlign: "right" },
  totalRow: { background: "#f8fafc" },
  tagWarn: { background: "#fef3c7", color: "#92400e", borderRadius: 6, padding: "2px 6px", fontSize: 12, fontWeight: 700 },
  botao: { marginTop: 14, background: "#16a34a", color: "#fff", border: "none", borderRadius: 8, padding: "11px 16px", cursor: "pointer", fontWeight: 700 },
  muted: { color: "#64748b", fontSize: 13 },
  erro: { background: "#fee2e2", border: "1px solid #fecaca", color: "#991b1b", padding: 12, borderRadius: 10, marginBottom: 16, fontSize: 13 },
  ok: { background: "#dcfce7", border: "1px solid #bfdbfe", color: "#166534", padding: 12, borderRadius: 10, marginBottom: 16, fontSize: 13, fontWeight: 600 },
  aviso: { background: "#fff3cd", border: "1px solid #ffe69c", color: "#664d03", padding: 16, borderRadius: 10 },
  avisoInline: { background: "#fff3cd", border: "1px solid #ffe69c", color: "#664d03", padding: 10, borderRadius: 8, marginTop: 12, fontSize: 12.5 },
};
