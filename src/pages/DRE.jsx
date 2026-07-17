import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";

const MESES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const DONO = "amanda.seibel@aelbra.com.br";

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function pct(v) {
  return (Number(v || 0)).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";
}
function paraNumero(v) {
  let t = String(v ?? "").replace("R$", "").replace(/\s/g, "").trim();
  const tv = t.includes(","), tp = t.includes(".");
  if (tv && tp) t = t.replace(/\./g, "").replace(",", ".");
  else if (tv) t = t.replace(",", ".");
  return Number(t) || 0;
}
function comp(ano, mes1a12) {
  return `${ano}-${String(mes1a12).padStart(2, "0")}-01`;
}

export default function DRE() {
  const [email, setEmail] = useState(null);
  const [ano, setAno] = useState(new Date().getFullYear());
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [aba, setAba] = useState("dre");
  const [mesSel, setMesSel] = useState(new Date().getMonth() + 1);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data?.user?.email || ""));
  }, []);

  async function carregar() {
    setCarregando(true);
    const { data, error } = await supabase.rpc("dre_dados", { p_ano: ano });
    setDados(error ? null : data);
    setCarregando(false);
  }
  useEffect(() => {
    if (email === DONO) carregar();
    else setCarregando(false);
    // eslint-disable-next-line
  }, [email, ano]);

  const mesAtual = { ano: new Date().getFullYear(), mes: new Date().getMonth() + 1 };
  const meses = dados?.meses || [];
  const funcionarios = dados?.funcionarios || [];
  const categorias = dados?.categorias || [];
  const folhaDet = dados?.folha_detalhe || [];
  const despDet = dados?.despesa_detalhe || [];

  const totais = useMemo(() => {
    const f = meses.reduce((s, m) => s + Number(m.faturamento || 0), 0);
    const fo = meses.reduce((s, m) => s + Number(m.folha_total || 0), 0);
    const d = meses.reduce((s, m) => s + Number(m.despesas_total || 0), 0);
    return { fat: f, folha: fo, desp: d, lucro: f - fo - d };
  }, [meses]);

  if (carregando) return <div style={s.wrap}><p style={s.muted}>Carregando DRE...</p></div>;
  if (email !== DONO) {
    return (
      <div style={s.wrap}>
        <h1 style={s.h1}>DRE</h1>
        <div style={s.aviso}>Acesso restrito. Esta área é exclusiva da gerência.</div>
      </div>
    );
  }

  return (
    <div style={s.wrap}>
      <div style={s.head}>
        <div>
          <h1 style={s.h1}>DRE — Demonstrativo mensal</h1>
          <p style={s.sub}>Faturamento (honorários recuperados) − despesas = lucro. Privado.</p>
        </div>
        <div style={s.anoBox}>
          <button style={s.botIcon} onClick={() => setAno((a) => a - 1)}>◀</button>
          <strong style={{ fontSize: 18 }}>{ano}</strong>
          <button style={s.botIcon} onClick={() => setAno((a) => a + 1)}>▶</button>
        </div>
      </div>

      <div style={s.abas}>
        {[["dre", "DRE"], ["faturamento", "Faturamento"], ["funcionarios", "Funcionários"], ["folha", "Folha do mês"], ["despesas", "Despesas do mês"]].map(([k, r]) => (
          <button key={k} style={aba === k ? s.abaAtiva : s.aba} onClick={() => setAba(k)}>{r}</button>
        ))}
      </div>

      {msg && <div style={s.msg}>{msg}</div>}

      {aba === "dre" && (
        <>
          <div style={s.kpis}>
            <Kpi rot="Faturamento (ano)" val={moeda(totais.fat)} cor="#16a34a" />
            <Kpi rot="Folha (ano)" val={moeda(totais.folha)} cor="#f59e0b" />
            <Kpi rot="Despesas (ano)" val={moeda(totais.desp)} cor="#ef4444" />
            <Kpi rot="Lucro (ano)" val={moeda(totais.lucro)} cor={totais.lucro >= 0 ? "#0ea5e9" : "#ef4444"} />
          </div>
          <div style={s.card}>
            <div style={s.tblScroll}>
              <table style={s.tbl}>
                <thead>
                  <tr>
                    <th style={s.th}>Mês</th>
                    <th style={s.thR}>Faturamento</th>
                    <th style={s.thR}>Folha</th>
                    <th style={s.thR}>Despesas</th>
                    <th style={s.thR}>Lucro</th>
                    <th style={s.thR}>Margem</th>
                  </tr>
                </thead>
                <tbody>
                  {meses.map((m) => {
                    const parcial = ano === mesAtual.ano && m.mes === mesAtual.mes;
                    const futuro = ano > mesAtual.ano || (ano === mesAtual.ano && m.mes > mesAtual.mes);
                    const margem = Number(m.faturamento) > 0 ? (Number(m.lucro) / Number(m.faturamento)) * 100 : 0;
                    return (
                      <tr key={m.mes} style={futuro ? { opacity: 0.45 } : null}>
                        <td style={s.td}>{MESES[m.mes - 1]}{parcial ? <span style={s.tag}>parcial</span> : ""}</td>
                        <td style={s.tdR}>{moeda(m.faturamento)}</td>
                        <td style={s.tdR}>{moeda(m.folha_total)}</td>
                        <td style={s.tdR}>{moeda(m.despesas_total)}</td>
                        <td style={{ ...s.tdR, color: Number(m.lucro) >= 0 ? "#0f7a4f" : "#b91c1c", fontWeight: 700 }}>{moeda(m.lucro)}</td>
                        <td style={s.tdR}>{pct(margem)}</td>
                      </tr>
                    );
                  })}
                  <tr style={s.totalRow}>
                    <td style={s.td}><strong>Total {ano}</strong></td>
                    <td style={s.tdR}><strong>{moeda(totais.fat)}</strong></td>
                    <td style={s.tdR}><strong>{moeda(totais.folha)}</strong></td>
                    <td style={s.tdR}><strong>{moeda(totais.desp)}</strong></td>
                    <td style={{ ...s.tdR, color: totais.lucro >= 0 ? "#0f7a4f" : "#b91c1c" }}><strong>{moeda(totais.lucro)}</strong></td>
                    <td style={s.tdR}><strong>{pct(totais.fat > 0 ? (totais.lucro / totais.fat) * 100 : 0)}</strong></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p style={s.muted}>Faturamento vem dos honorários recuperados (atual + histórico). Você pode corrigir em "Faturamento".</p>
          </div>
        </>
      )}

      {aba === "faturamento" && (
        <FaturamentoTab ano={ano} meses={meses} onSalvo={(m) => { setMsg(m); carregar(); }} />
      )}
      {aba === "funcionarios" && (
        <FuncionariosTab funcionarios={funcionarios} onSalvo={(m) => { setMsg(m); carregar(); }} />
      )}
      {aba === "folha" && (
        <FolhaTab ano={ano} mesSel={mesSel} setMesSel={setMesSel} funcionarios={funcionarios} folhaDet={folhaDet} onSalvo={(m) => { setMsg(m); carregar(); }} />
      )}
      {aba === "despesas" && (
        <DespesasTab ano={ano} mesSel={mesSel} setMesSel={setMesSel} categorias={categorias} despDet={despDet} onSalvo={(m) => { setMsg(m); carregar(); }} />
      )}
    </div>
  );
}

function FaturamentoTab({ ano, meses, onSalvo }) {
  const [val, setVal] = useState({});
  async function salvar(mes) {
    const bruto = val[mes];
    const valor = bruto === "" || bruto == null ? null : paraNumero(bruto);
    const { error } = await supabase.from("dre_faturamento").upsert({ competencia: comp(ano, mes), valor }, { onConflict: "competencia" });
    onSalvo(error ? "Erro: " + error.message : `Faturamento de ${MESES[mes - 1]}/${ano} salvo.`);
  }
  return (
    <div style={s.card}>
      <p style={s.muted}>Deixe em branco para usar o valor automático (honorários recuperados). Preencha só para corrigir.</p>
      <table style={s.tbl}>
        <thead><tr><th style={s.th}>Mês</th><th style={s.thR}>Automático (honorários)</th><th style={s.thR}>Correção manual</th><th style={s.th}></th></tr></thead>
        <tbody>
          {meses.map((m) => (
            <tr key={m.mes}>
              <td style={s.td}>{MESES[m.mes - 1]}</td>
              <td style={s.tdR}>{moeda(m.faturamento_calc)}</td>
              <td style={s.tdR}>
                <input style={s.input} placeholder={m.faturamento_override != null ? "" : "auto"}
                  defaultValue={m.faturamento_override != null ? m.faturamento_override : ""}
                  onChange={(e) => setVal((v) => ({ ...v, [m.mes]: e.target.value }))} />
              </td>
              <td style={s.td}><button style={s.botVerde} onClick={() => salvar(m.mes)}>Salvar</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FuncionariosTab({ funcionarios, onSalvo }) {
  const [novo, setNovo] = useState({ nome: "", funcao: "", salario_base: "", ativo: true });
  async function adicionar() {
    if (!novo.nome.trim()) return onSalvo("Informe o nome.");
    const { error } = await supabase.from("dre_funcionario").insert({
      nome: novo.nome.trim(), funcao: novo.funcao || null, salario_base: paraNumero(novo.salario_base), ativo: novo.ativo,
    });
    if (!error) setNovo({ nome: "", funcao: "", salario_base: "", ativo: true });
    onSalvo(error ? "Erro: " + error.message : "Funcionário adicionado.");
  }
  async function atualizar(f, campo, valor) {
    const patch = campo === "salario_base" ? { salario_base: paraNumero(valor) } : { [campo]: valor };
    const { error } = await supabase.from("dre_funcionario").update(patch).eq("id", f.id);
    onSalvo(error ? "Erro: " + error.message : "Atualizado.");
  }
  return (
    <div style={s.card}>
      <div style={s.formLinha}>
        <input style={s.input} placeholder="Nome" value={novo.nome} onChange={(e) => setNovo({ ...novo, nome: e.target.value })} />
        <input style={s.input} placeholder="Função" value={novo.funcao} onChange={(e) => setNovo({ ...novo, funcao: e.target.value })} />
        <input style={s.input} placeholder="Salário base (Ex: 3000,00)" value={novo.salario_base} onChange={(e) => setNovo({ ...novo, salario_base: e.target.value })} />
        <button style={s.botVerde} onClick={adicionar}>Adicionar</button>
      </div>
      <table style={s.tbl}>
        <thead><tr><th style={s.th}>Nome</th><th style={s.th}>Função</th><th style={s.thR}>Salário base</th><th style={s.th}>Situação</th></tr></thead>
        <tbody>
          {funcionarios.map((f) => (
            <tr key={f.id} style={f.ativo ? null : { opacity: 0.6 }}>
              <td style={s.td}>{f.nome}{f.ativo ? "" : " (desligado)"}</td>
              <td style={s.td}>{f.funcao || "-"}</td>
              <td style={s.tdR}>
                <input style={{ ...s.input, width: 110 }} defaultValue={f.salario_base} onBlur={(e) => atualizar(f, "salario_base", e.target.value)} />
              </td>
              <td style={s.td}>
                <button style={f.ativo ? s.botCinza : s.botVerde} onClick={() => atualizar(f, "ativo", !f.ativo)}>
                  {f.ativo ? "Ativo (desligar)" : "Inativo (reativar)"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FolhaTab({ ano, mesSel, setMesSel, funcionarios, folhaDet, onSalvo }) {
  const mesStr = `${ano}-${String(mesSel).padStart(2, "0")}`;
  const [linhas, setLinhas] = useState({});
  const funcMes = funcionarios.filter((f) => f.ativo || folhaDet.some((x) => x.funcionario_id === f.id && x.mes === mesStr));
  useEffect(() => {
    const init = {};
    funcMes.forEach((f) => {
      const d = folhaDet.find((x) => x.funcionario_id === f.id && x.mes === mesStr);
      init[f.id] = { remuneracao: d ? d.remuneracao : f.salario_base, premiacao: d ? d.premiacao : 0 };
    });
    setLinhas(init);
    // eslint-disable-next-line
  }, [mesSel, ano, funcionarios.length, folhaDet.length]);

  async function salvar(f) {
    const l = linhas[f.id] || {};
    const { error } = await supabase.from("dre_folha").upsert({
      funcionario_id: f.id, competencia: comp(ano, mesSel),
      remuneracao: paraNumero(l.remuneracao), premiacao: paraNumero(l.premiacao),
    }, { onConflict: "funcionario_id,competencia" });
    onSalvo(error ? "Erro: " + error.message : `Folha de ${f.nome} salva.`);
  }
  return (
    <div style={s.card}>
      <MesPicker ano={ano} mesSel={mesSel} setMesSel={setMesSel} />
      <p style={s.muted}>A remuneração já vem do salário base — ajuste se precisar e lance a premiação.</p>
      <table style={s.tbl}>
        <thead><tr><th style={s.th}>Funcionário</th><th style={s.thR}>Remuneração</th><th style={s.thR}>Premiação</th><th style={s.th}></th></tr></thead>
        <tbody>
          {funcMes.map((f) => (
            <tr key={f.id} style={f.ativo ? null : { opacity: 0.6 }}>
              <td style={s.td}>{f.nome}</td>
              <td style={s.tdR}><input style={{ ...s.input, width: 110 }} value={linhas[f.id]?.remuneracao ?? ""} onChange={(e) => setLinhas((v) => ({ ...v, [f.id]: { ...v[f.id], remuneracao: e.target.value } }))} /></td>
              <td style={s.tdR}><input style={{ ...s.input, width: 110 }} value={linhas[f.id]?.premiacao ?? ""} onChange={(e) => setLinhas((v) => ({ ...v, [f.id]: { ...v[f.id], premiacao: e.target.value } }))} /></td>
              <td style={s.td}><button style={s.botVerde} onClick={() => salvar(f)}>Salvar</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DespesasTab({ ano, mesSel, setMesSel, categorias, despDet, onSalvo }) {
  const mesStr = `${ano}-${String(mesSel).padStart(2, "0")}`;
  const [val, setVal] = useState({});
  useEffect(() => {
    const init = {};
    categorias.forEach((c) => {
      const d = despDet.find((x) => x.categoria_id === c.id && x.mes === mesStr);
      init[c.id] = d ? d.valor : "";
    });
    setVal(init);
    // eslint-disable-next-line
  }, [mesSel, ano, categorias.length, despDet.length]);

  async function salvar(c) {
    const { error } = await supabase.from("dre_despesa").upsert({
      categoria_id: c.id, competencia: comp(ano, mesSel), valor: paraNumero(val[c.id]),
    }, { onConflict: "categoria_id,competencia" });
    onSalvo(error ? "Erro: " + error.message : `Despesa de ${c.nome} salva.`);
  }
  return (
    <div style={s.card}>
      <MesPicker ano={ano} mesSel={mesSel} setMesSel={setMesSel} />
      <table style={s.tbl}>
        <thead><tr><th style={s.th}>Categoria</th><th style={s.thR}>Valor</th><th style={s.th}></th></tr></thead>
        <tbody>
          {categorias.map((c) => (
            <tr key={c.id}>
              <td style={s.td}>{c.nome}</td>
              <td style={s.tdR}><input style={{ ...s.input, width: 130 }} placeholder="Ex: 1200,00" value={val[c.id] ?? ""} onChange={(e) => setVal((v) => ({ ...v, [c.id]: e.target.value }))} /></td>
              <td style={s.td}><button style={s.botVerde} onClick={() => salvar(c)}>Salvar</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MesPicker({ ano, mesSel, setMesSel }) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
      {MESES.map((m, i) => (
        <button key={m} style={mesSel === i + 1 ? s.mesAtivo : s.mes} onClick={() => setMesSel(i + 1)}>{m}</button>
      ))}
      <span style={{ alignSelf: "center", color: "#64748b", fontSize: 13 }}>de {ano}</span>
    </div>
  );
}

function Kpi({ rot, val, cor }) {
  return (
    <div style={s.kpi}>
      <span style={{ fontSize: 20, fontWeight: 800, color: cor }}>{val}</span>
      <span style={{ fontSize: 13, color: "#64748b", fontWeight: 600 }}>{rot}</span>
    </div>
  );
}

const s = {
  wrap: { padding: 24, fontFamily: "Arial, sans-serif" },
  head: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap", marginBottom: 16 },
  h1: { margin: 0, color: "#0f172a" },
  sub: { margin: "6px 0 0", color: "#64748b", fontSize: 13 },
  anoBox: { display: "flex", alignItems: "center", gap: 12, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "8px 14px" },
  botIcon: { background: "#f1f5f9", border: "none", borderRadius: 8, padding: "6px 10px", cursor: "pointer", fontWeight: 700 },
  abas: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 },
  aba: { background: "#fff", border: "1px solid #d1d5db", color: "#374151", padding: "8px 14px", borderRadius: 999, cursor: "pointer", fontSize: 13 },
  abaAtiva: { background: "#0ea5e9", border: "1px solid #0ea5e9", color: "#fff", padding: "8px 14px", borderRadius: 999, cursor: "pointer", fontSize: 13, fontWeight: 700 },
  kpis: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 16 },
  kpi: { background: "#fff", border: "1px solid #eef2f6", borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4 },
  card: { background: "#fff", border: "1px solid #eef2f6", borderRadius: 16, padding: 18, marginBottom: 16 },
  tblScroll: { overflowX: "auto" },
  tbl: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "8px 10px", color: "#8a93a3", fontSize: 11, fontWeight: 700, textTransform: "uppercase", background: "#f8fafc", borderBottom: "1px solid #e3e7ee" },
  thR: { textAlign: "right", padding: "8px 10px", color: "#8a93a3", fontSize: 11, fontWeight: 700, textTransform: "uppercase", background: "#f8fafc", borderBottom: "1px solid #e3e7ee" },
  td: { padding: "8px 10px", borderBottom: "1px solid #f2f4f7" },
  tdR: { padding: "8px 10px", borderBottom: "1px solid #f2f4f7", textAlign: "right" },
  totalRow: { background: "#f8fafc" },
  tag: { marginLeft: 8, fontSize: 10, background: "#fef3c7", color: "#92400e", borderRadius: 6, padding: "1px 6px", fontWeight: 700 },
  input: { padding: "7px 9px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13 },
  formLinha: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 },
  botVerde: { background: "#16a34a", color: "#fff", border: "none", borderRadius: 8, padding: "7px 14px", cursor: "pointer", fontWeight: 700, fontSize: 12 },
  botCinza: { background: "#e5e7eb", color: "#374151", border: "none", borderRadius: 8, padding: "7px 12px", cursor: "pointer", fontWeight: 700, fontSize: 12 },
  mes: { background: "#fff", border: "1px solid #d1d5db", color: "#374151", padding: "5px 10px", borderRadius: 8, cursor: "pointer", fontSize: 12 },
  mesAtivo: { background: "#0f172a", border: "1px solid #0f172a", color: "#fff", padding: "5px 10px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 700 },
  muted: { color: "#64748b", fontSize: 12.5, margin: "10px 0 0" },
  aviso: { background: "#fff3cd", border: "1px solid #ffe69c", color: "#664d03", padding: 16, borderRadius: 10 },
  msg: { background: "#dcfce7", border: "1px solid #bbf7d0", color: "#166534", padding: "10px 14px", borderRadius: 10, marginBottom: 12, fontSize: 13, fontWeight: 600 },
};
