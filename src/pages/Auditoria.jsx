import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";

const MEU_EMAIL = "amanda.seibel" + "@" + "aelbra.com.br";

function fmtData(v) { if (!v) return "-"; const d = new Date(v); return d.toLocaleString("pt-BR"); }

const CONTROLES = [
  { icon: "🔒", titulo: "Acesso por perfil (RLS)", texto: "Todas as tabelas com dados têm trava por linha (Row Level Security). Cada usuário só vê o que o seu perfil permite." },
  { icon: "🚫", titulo: "Acesso anônimo bloqueado", texto: "A chave pública não lê nenhum dado sensível: alunos, pagamentos, acordos, usuários e financeiro retornam zero para quem não está logado." },
  { icon: "🗂️", titulo: "Documentos sensíveis privados", texto: "Comprovantes de pagamento e termos de acordo ficam em armazenamento privado, acessíveis só por link assinado a usuários autorizados." },
  { icon: "🧩", titulo: "Funções restritas", texto: "Consultas e relatórios que acessam dados só executam para usuários autenticados; o acesso público foi revogado." },
  { icon: "📝", titulo: "Auditoria completa", texto: "Toda criação, alteração e exclusão de dado financeiro ou cadastral é registrada com autor, data/hora e valores antes/depois." },
  { icon: "🔐", titulo: "Transporte criptografado", texto: "Todo o tráfego entre o sistema e o banco usa conexão criptografada (HTTPS/TLS)." },
  { icon: "⏰", titulo: "Controle de acesso por horário", texto: "O acesso é liberado por turno; fora do horário o sistema bloqueia e exige autorização da gestão. Toda tentativa fica registrada." },
];

export default function Auditoria({ forcarAcesso = false }) {
  const [email, setEmail] = useState("");
  const [logs, setLogs] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [fUsuario, setFUsuario] = useState("");
  const [fTabela, setFTabela] = useState("");
  const [fOperacao, setFOperacao] = useState("");
  const [fDe, setFDe] = useState("");
  const [fAte, setFAte] = useState("");

  useEffect(() => { (async () => {
    const { data } = await supabase.auth.getUser();
    setEmail((data?.user?.email || "").toLowerCase());
  })(); }, []);

  async function carregar() {
    setCarregando(true);
    let q = supabase.from("audit_log").select("*").order("criado_em", { ascending: false }).limit(1000);
    if (fUsuario) q = q.ilike("usuario", "%" + fUsuario + "%");
    if (fTabela) q = q.eq("tabela", fTabela);
    if (fOperacao) q = q.eq("operacao", fOperacao);
    if (fDe) q = q.gte("criado_em", new Date(fDe).toISOString());
    if (fAte) q = q.lte("criado_em", new Date(fAte + "T23:59:59").toISOString());
    const { data } = await q;
    setLogs(Array.isArray(data) ? data : []);
    setCarregando(false);
  }
  useEffect(() => { if (email === MEU_EMAIL || forcarAcesso) carregar(); }, [email]);

  function exportarCSV() {
    const linhas = [["Data", "Usuário", "Tabela", "Operação", "Registro", "Antes", "Depois"]];
    logs.forEach(function (l) { linhas.push([fmtData(l.criado_em), l.usuario, l.tabela, l.operacao, l.registro_id || "", JSON.stringify(l.dados_antes || ""), JSON.stringify(l.dados_depois || "")]); });
    const csv = linhas.map(function (r) { return r.map(function (c) { return chr(34) + String(c).split(chr(34)).join(chr(34) + chr(34)) + chr(34); }).join(";"); }).join(nl());
    const blob = new Blob([bom() + csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "auditoria_reativa.csv"; a.click();
  }
  function chr(n){ return String.fromCharCode(n); }
  function nl(){ return chr(10); }
  function bom(){ return chr(65279); }

  const tabelas = useMemo(function () { return Array.from(new Set(logs.map(function (l) { return l.tabela; }))).sort(); }, [logs]);

  if (!forcarAcesso && email && email !== MEU_EMAIL) {
    return (<div style={S.wrap}><h1 style={S.h1}>Segurança e Auditoria</h1><div style={S.negado}>Acesso restrito. Esta área é exclusiva da gestão de segurança.</div></div>);
  }

  return (
    <div style={S.wrap}>
      <h1 style={S.h1}>🛡️ Segurança e Auditoria</h1>
      <p style={S.sub}>Controles de proteção de dados aplicados e registro completo de acessos e alterações.</p>
      <div style={S.grid}>
        {CONTROLES.map(function (c, i) { return (
          <div key={i} style={S.card}>
            <div style={S.cardIcon}>{c.icon}</div>
            <div style={S.cardTit}>{c.titulo}</div>
            <div style={S.cardTxt}>{c.texto}</div>
          </div>); })}
      </div>
      <h2 style={S.h2}>Registro de auditoria</h2>
      <div style={S.filtros}>
        <input style={S.inp} placeholder="Usuário" value={fUsuario} onChange={function (e) { setFUsuario(e.target.value); }} />
        <select style={S.inp} value={fTabela} onChange={function (e) { setFTabela(e.target.value); }}>
          <option value="">Todas as tabelas</option>
          {tabelas.map(function (t) { return <option key={t} value={t}>{t}</option>; })}
        </select>
        <select style={S.inp} value={fOperacao} onChange={function (e) { setFOperacao(e.target.value); }}>
          <option value="">Todas as ações</option>
          <option value="INSERT">Criação</option>
          <option value="UPDATE">Alteração</option>
          <option value="DELETE">Exclusão</option>
        </select>
        <input style={S.inp} type="date" value={fDe} onChange={function (e) { setFDe(e.target.value); }} />
        <input style={S.inp} type="date" value={fAte} onChange={function (e) { setFAte(e.target.value); }} />
        <button style={S.btn} onClick={carregar}>Filtrar</button>
        <button style={S.btnSec} onClick={exportarCSV}>Exportar CSV</button>
      </div>
      {carregando ? <p>Carregando...</p> : (
        <div style={S.tabelaWrap}>
          <table style={S.tabela}>
            <thead><tr>
              <th style={S.th}>Data/Hora</th><th style={S.th}>Usuário</th><th style={S.th}>Tabela</th><th style={S.th}>Ação</th><th style={S.th}>Registro</th>
            </tr></thead>
            <tbody>
              {logs.length === 0 && <tr><td style={S.td} colSpan={5}>Nenhum registro no filtro atual.</td></tr>}
              {logs.map(function (l) { return (
                <tr key={l.id}>
                  <td style={S.td}>{fmtData(l.criado_em)}</td>
                  <td style={S.td}>{l.usuario}</td>
                  <td style={S.td}>{l.tabela}</td>
                  <td style={S.td}><span style={Object.assign({}, S.badge, { background: l.operacao === "DELETE" ? "#fee2e2" : l.operacao === "UPDATE" ? "#fef9c3" : "#dcfce7" })}>{l.operacao}</span></td>
                  <td style={S.td}>{l.registro_id || "-"}</td>
                </tr>); })}
            </tbody>
          </table>
          <p style={S.rodape}>{logs.length} registro(s). Este log é somente-leitura e não pode ser alterado ou apagado pela operação.</p>
        </div>
      )}
    </div>
  );
}

const S = {
  wrap: { padding: "24px", maxWidth: 1100, margin: "0 auto" },
  h1: { fontSize: 26, fontWeight: 900, margin: "0 0 4px" },
  h2: { fontSize: 18, fontWeight: 800, margin: "28px 0 12px" },
  sub: { color: "#64748b", margin: "0 0 18px" },
  negado: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 16, borderRadius: 12, fontWeight: 700 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 },
  card: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: 16, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" },
  cardIcon: { fontSize: 26 },
  cardTit: { fontWeight: 800, margin: "6px 0 4px", color: "#0f172a" },
  cardTxt: { fontSize: 13, color: "#475569", lineHeight: 1.4 },
  filtros: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 },
  inp: { padding: "8px 10px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 13 },
  btn: { background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 700, cursor: "pointer" },
  btnSec: { background: "#0f172a", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 700, cursor: "pointer" },
  tabelaWrap: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "10px", background: "#f8fafc", color: "#64748b", fontSize: 11, textTransform: "uppercase", borderBottom: "1px solid #e5e7eb" },
  td: { padding: "9px 10px", borderBottom: "1px solid #f1f5f9", color: "#334155" },
  badge: { padding: "3px 8px", borderRadius: 999, fontSize: 11, fontWeight: 800, color: "#0f172a" },
  rodape: { padding: "10px", color: "#64748b", fontSize: 12 },
};
