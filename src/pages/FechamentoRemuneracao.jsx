// ============================================================================
// Fechamento Mensal da Remuneracao dos Operadores  (rota /fechamento-remuneracao)
// Acesso EXCLUSIVO amanda.seibel@aelbra.com.br (gating no App.jsx + backend RLS).
// Consolida valor fixo, comissao (sobre honorarios), premiacoes e ajustes.
// Gera relatorios Excel (sintetico + analitico) com a logo oficial da Reativa.
// ============================================================================
import { useState, useCallback, useMemo } from "react";
import { supabase } from "../supabaseClient";
import { gerarExcelSintetico, gerarExcelAnalitico } from "../utils/fechamentoRemuneracaoExcel";

const BRL = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const PCT = (v) => `${Number(v || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;

function competenciaAtual() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
const primeiroDia = (mes) => `${mes}-01`;

function baixarBuffer(buffer, nome) {
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const TABS = [
  ["previa", "Prévia"],
  ["config", "Configuração"],
  ["premiacoes", "Premiações"],
  ["ajustes", "Ajustes"],
  ["reconciliacao", "Reconciliação"],
  ["versoes", "Fechamentos anteriores"],
];

export default function FechamentoRemuneracao() {
  const [mes, setMes] = useState(competenciaAtual());
  const [aba, setAba] = useState("previa");
  const [previa, setPrevia] = useState(null);
  const [lanc, setLanc] = useState({ config: [], premiacoes: [], ajustes: [] });
  const [versoes, setVersoes] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  const [msg, setMsg] = useState("");

  const competencia = primeiroDia(mes);

  const carregarPrevia = useCallback(async () => {
    setCarregando(true);
    setErro("");
    setMsg("");
    try {
      const [{ data: prev, error: e1 }, { data: lc, error: e2 }] = await Promise.all([
        supabase.rpc("calcular_fechamento_remuneracao", { p_competencia: competencia }),
        supabase.rpc("fechamento_listar_lancamentos", { p_competencia: competencia }),
      ]);
      if (e1) throw e1;
      if (e2) throw e2;
      const enriquecido = {
        ...prev,
        __premiacoes: lc?.premiacoes || [],
        __ajustes: lc?.ajustes || [],
      };
      setPrevia(enriquecido);
      setLanc(lc || { config: [], premiacoes: [], ajustes: [] });
    } catch (err) {
      setErro(err.message || "Falha ao calcular a prévia.");
    } finally {
      setCarregando(false);
    }
  }, [competencia]);

  const carregarVersoes = useCallback(async () => {
    const { data, error } = await supabase.rpc("consultar_fechamentos_remuneracao", {
      p_competencia: null,
    });
    if (!error) setVersoes(data || []);
  }, []);

  const meta = useMemo(
    () => ({
      competencia: mes,
      periodo: previa ? `${br(previa.periodo_inicio)} a ${br(previa.periodo_fim)}` : "",
      versao: "PRÉVIA",
      status: "EM_APURACAO",
      geradoEm: new Date().toLocaleString("pt-BR"),
      geradoPor: "amanda.seibel@aelbra.com.br",
    }),
    [mes, previa]
  );

  async function baixarSintetico() {
    if (!previa) return;
    setMsg("Gerando relatório sintético…");
    const buf = await gerarExcelSintetico(previa, meta);
    baixarBuffer(buf, `Fechamento_Sintetico_${mes.replace("-", "_")}_PREVIA.xlsx`);
    setMsg("Relatório sintético (prévia) gerado.");
  }
  async function baixarAnalitico() {
    if (!previa) return;
    setMsg("Gerando relatório analítico…");
    const { data, error } = await supabase.rpc("fechamento_analitico_pagamentos", {
      p_competencia: competencia,
    });
    if (error) {
      setErro(error.message);
      return;
    }
    const buf = await gerarExcelAnalitico(previa, data || [], meta);
    baixarBuffer(buf, `Fechamento_Analitico_${mes.replace("-", "_")}_PREVIA.xlsx`);
    setMsg("Relatório analítico (prévia) gerado.");
  }

  const totais = previa?.totais || {};
  const recon = previa?.reconciliacao || {};

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: "0 auto" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>💰 Fechamento Mensal da Remuneração</h1>
        <span style={{ fontSize: 13, color: "#6b7280" }}>
          Acesso exclusivo — Amanda gestora
        </span>
      </header>

      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", marginTop: 16, flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", fontSize: 13 }}>
          Competência (mês)
          <input type="month" value={mes} onChange={(e) => setMes(e.target.value)}
            style={{ padding: 8, borderRadius: 8, border: "1px solid #d1d5db" }} />
        </label>
        <button onClick={carregarPrevia} disabled={carregando}
          style={btn(true)}>
          {carregando ? "Calculando…" : "Calcular prévia"}
        </button>
        {previa && (
          <>
            <button onClick={baixarSintetico} style={btn(false)}>⬇ Sintético (prévia)</button>
            <button onClick={baixarAnalitico} style={btn(false)}>⬇ Analítico (prévia)</button>
          </>
        )}
      </div>

      {erro && <Aviso cor="#b91c1c" bg="#fee2e2">{erro}</Aviso>}
      {msg && <Aviso cor="#065f46" bg="#d1fae5">{msg}</Aviso>}

      {previa && (
        <BannerReconciliacao recon={recon} faixas={previa.faixas_configuradas} />
      )}

      {previa && <Indicadores totais={totais} />}

      <nav style={{ display: "flex", gap: 4, marginTop: 20, borderBottom: "1px solid #e5e7eb", flexWrap: "wrap" }}>
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => { setAba(id); if (id === "versoes") carregarVersoes(); }}
            style={tabBtn(aba === id)}>{label}</button>
        ))}
      </nav>

      <div style={{ marginTop: 16 }}>
        {aba === "previa" && <AbaPrevia previa={previa} />}
        {aba === "config" && <AbaConfig competencia={competencia} lanc={lanc} onChange={carregarPrevia} setErro={setErro} setMsg={setMsg} />}
        {aba === "premiacoes" && <AbaPremiacoes competencia={competencia} lanc={lanc} onChange={carregarPrevia} setErro={setErro} />}
        {aba === "ajustes" && <AbaAjustes competencia={competencia} lanc={lanc} onChange={carregarPrevia} setErro={setErro} />}
        {aba === "reconciliacao" && <AbaReconciliacao previa={previa} />}
        {aba === "versoes" && <AbaVersoes versoes={versoes} />}
      </div>
    </div>
  );
}

// ------- helpers de UI -------
const br = (d) => (d ? new Date(d + "T00:00:00").toLocaleDateString("pt-BR") : "");
const btn = (primary) => ({
  padding: "9px 16px", borderRadius: 8, border: "none", cursor: "pointer", fontWeight: 600,
  background: primary ? "#1e40af" : "#e5e7eb", color: primary ? "#fff" : "#111827",
});
const tabBtn = (ativo) => ({
  padding: "8px 14px", border: "none", cursor: "pointer", fontWeight: 600, fontSize: 14,
  background: "transparent", color: ativo ? "#1e40af" : "#6b7280",
  borderBottom: ativo ? "2px solid #1e40af" : "2px solid transparent",
});
function Aviso({ children, cor, bg }) {
  return <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 8, background: bg, color: cor }}>{children}</div>;
}

function BannerReconciliacao({ recon, faixas }) {
  const ok = recon?.ok && faixas;
  return (
    <div style={{
      marginTop: 16, padding: "12px 16px", borderRadius: 10,
      background: ok ? "#ecfdf5" : "#fef2f2", border: `1px solid ${ok ? "#a7f3d0" : "#fecaca"}`,
    }}>
      <strong style={{ color: ok ? "#065f46" : "#991b1b" }}>
        {ok ? "✅ Reconciliação com a Projeção: R$ 0,00 (bate)" : "⚠ Reconciliação/faixas com pendência"}
      </strong>
      <div style={{ fontSize: 13, color: "#374151", marginTop: 4 }}>
        Recuperado — dif {BRL(recon?.diff_recuperado)} · Honorários — dif {BRL(recon?.diff_honorario)}
        {!faixas && " · faixas de comissão NÃO configuradas para o mês"}
      </div>
    </div>
  );
}

function Indicadores({ totais }) {
  const cards = [
    ["Total fixo", totais.total_fixo], ["Recuperado", totais.total_recuperado],
    ["Honorários", totais.total_honorario], ["Comissões", totais.total_comissao],
    ["Premiações", totais.total_premiacao], ["Bônus", totais.total_bonus],
    ["Descontos", totais.total_desconto], ["TOTAL FINAL", totais.total_final],
    ["Sem operador (R$)", totais.valor_sem_operador],
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 10, marginTop: 14 }}>
      {cards.map(([k, v]) => (
        <div key={k} style={{
          padding: 12, borderRadius: 10, background: k === "TOTAL FINAL" ? "#1e40af" : "#f8fafc",
          color: k === "TOTAL FINAL" ? "#fff" : "#111827", border: "1px solid #e5e7eb",
        }}>
          <div style={{ fontSize: 12, opacity: 0.8 }}>{k}</div>
          <div style={{ fontSize: 17, fontWeight: 700 }}>{BRL(v)}</div>
        </div>
      ))}
    </div>
  );
}

function AbaPrevia({ previa }) {
  if (!previa) return <Vazio>Selecione a competência e clique em “Calcular prévia”.</Vazio>;
  const benef = (previa.beneficiarios || []).slice().sort((a, b) => Number(b.total_final) - Number(a.total_final));
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={tbl}>
        <thead>
          <tr>{["#", "Operador", "Valor fixo", "Pag.", "Recuperado", "Honorários", "Faixa", "%", "Comissão", "Premiações", "Bônus/Corr.", "Desc./Est.", "TOTAL FINAL", "Situação"].map((h) => <th key={h} style={th}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {benef.map((l, i) => (
            <tr key={l.email} style={{ background: i % 2 ? "#f9fafb" : "#fff" }}>
              <td style={td}>{i + 1}</td>
              <td style={td}>{l.nome || l.email}<br /><span style={{ fontSize: 11, color: "#9ca3af" }}>{l.email}</span></td>
              <td style={tdN}>{BRL(l.valor_fixo)}</td>
              <td style={tdC}>{l.qtd_pagamentos}</td>
              <td style={tdN}>{BRL(l.valor_recuperado)}</td>
              <td style={tdN}>{BRL(l.honorarios)}</td>
              <td style={td}>{l.faixa}</td>
              <td style={tdC}>{PCT(l.percentual)}</td>
              <td style={tdN}>{l.comissao == null ? "🚫" : BRL(l.comissao)}</td>
              <td style={tdN}>{BRL(l.premiacoes)}</td>
              <td style={tdN}>{BRL(Number(l.bonus || 0) + Number(l.correcoes || 0))}</td>
              <td style={tdN}>{BRL(Number(l.descontos || 0) + Number(l.estornos || 0))}</td>
              <td style={{ ...tdN, fontWeight: 700 }}>{BRL(l.total_final)}</td>
              <td style={{ ...td, fontSize: 12 }}>{l.situacao}{!l.elegivel_comissao && " (não elegível)"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(previa.nao_elegiveis || []).length > 0 && (
        <div style={{ marginTop: 12, fontSize: 13, color: "#6b7280" }}>
          <strong>Fora da remuneração (gestão com produção):</strong>{" "}
          {previa.nao_elegiveis.map((n) => `${n.email} (${BRL(n.valor_recuperado)})`).join(", ")}
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 13, color: "#6b7280" }}>
        Sem operador: {previa.sem_operador?.qtd} pagamento(s) · {BRL(previa.sem_operador?.valor_recuperado)} recuperado — sem comissão.
      </div>
    </div>
  );
}

function AbaConfig({ competencia, lanc, onChange, setErro, setMsg }) {
  const [form, setForm] = useState({
    email: "", nome: "", tipo_vinculo: "contratual", nome_exibicao_fixo: "Valor fixo contratual",
    valor_fixo: "0", elegivel_comissao: true, regra_comissao: "faixa", percentual_fixo: "",
    elegivel_premiacao: true, observacao: "",
  });
  async function salvar() {
    setErro("");
    const { error } = await supabase.rpc("fechamento_salvar_config", {
      p_competencia: competencia, p_email: form.email.trim().toLowerCase(), p_nome: form.nome,
      p_tipo_vinculo: form.tipo_vinculo, p_nome_exibicao_fixo: form.nome_exibicao_fixo,
      p_valor_fixo: Number(form.valor_fixo || 0), p_elegivel_comissao: form.elegivel_comissao,
      p_regra_comissao: form.regra_comissao, p_percentual_fixo: form.percentual_fixo ? Number(form.percentual_fixo) : null,
      p_elegivel_premiacao: form.elegivel_premiacao, p_observacao: form.observacao,
    });
    if (error) setErro(error.message);
    else { setMsg && setMsg("Configuração salva."); onChange(); }
  }
  return (
    <div>
      <h3>Configuração histórica do beneficiário (competência)</h3>
      <div style={grid2}>
        <Inp label="E-mail do beneficiário" v={form.email} on={(v) => setForm({ ...form, email: v })} />
        <Inp label="Nome" v={form.nome} on={(v) => setForm({ ...form, nome: v })} />
        <Sel label="Tipo de vínculo" v={form.tipo_vinculo} on={(v) => setForm({ ...form, tipo_vinculo: v })}
          opts={[["contratual", "Valor fixo contratual"], ["salario_base", "Salário base"], ["pro_labore", "Pró-labore"], ["outro", "Outro"]]} />
        <Inp label="Nome exibido do valor fixo" v={form.nome_exibicao_fixo} on={(v) => setForm({ ...form, nome_exibicao_fixo: v })} />
        <Inp label="Valor fixo (R$)" type="number" v={form.valor_fixo} on={(v) => setForm({ ...form, valor_fixo: v })} />
        <Sel label="Regra de comissão" v={form.regra_comissao} on={(v) => setForm({ ...form, regra_comissao: v })}
          opts={[["faixa", "Por faixa"], ["percentual_fixo", "Percentual fixo"], ["nenhuma", "Sem comissão"]]} />
        <Inp label="Percentual fixo (se aplicável)" type="number" v={form.percentual_fixo} on={(v) => setForm({ ...form, percentual_fixo: v })} />
        <Chk label="Elegível a comissão" v={form.elegivel_comissao} on={(v) => setForm({ ...form, elegivel_comissao: v })} />
        <Chk label="Elegível a premiação" v={form.elegivel_premiacao} on={(v) => setForm({ ...form, elegivel_premiacao: v })} />
      </div>
      <button onClick={salvar} style={btn(true)}>Salvar configuração</button>

      <Lista titulo="Configurações da competência" itens={lanc.config}
        cols={[["beneficiario_email", "E-mail"], ["tipo_vinculo", "Vínculo"], ["valor_fixo", "Fixo", BRL], ["regra_comissao", "Regra"], ["elegivel_comissao", "Comissão"], ["elegivel_premiacao", "Premiação"]]} />
    </div>
  );
}

function AbaPremiacoes({ competencia, lanc, onChange, setErro }) {
  const [f, setF] = useState({ email: "", nome: "", tipo: "premiacao_campanha", nome_campanha: "", criterio: "", valor: "", origem: "", descricao: "" });
  async function salvar() {
    setErro("");
    const { error } = await supabase.rpc("fechamento_registrar_premiacao", {
      p_competencia: competencia, p_email: f.email.trim().toLowerCase(), p_nome: f.nome, p_tipo: f.tipo,
      p_nome_campanha: f.nome_campanha, p_descricao: f.descricao, p_criterio: f.criterio,
      p_valor: Number(f.valor || 0), p_origem: f.origem,
    });
    if (error) setErro(error.message); else onChange();
  }
  async function excluir(id) {
    const { error } = await supabase.rpc("fechamento_excluir_premiacao", { p_id: id });
    if (error) setErro(error.message); else onChange();
  }
  return (
    <div>
      <h3>Premiações da competência</h3>
      <div style={grid2}>
        <Inp label="E-mail" v={f.email} on={(v) => setF({ ...f, email: v })} />
        <Inp label="Nome" v={f.nome} on={(v) => setF({ ...f, nome: v })} />
        <Sel label="Tipo" v={f.tipo} on={(v) => setF({ ...f, tipo: v })}
          opts={[["premiacao_campanha", "Campanha"], ["premio_ranking", "Ranking"], ["premio_meta", "Meta"], ["premio_individual", "Individual"], ["premio_equipe", "Equipe"], ["premio_extraordinario", "Extraordinário"], ["outro", "Outro"]]} />
        <Inp label="Campanha" v={f.nome_campanha} on={(v) => setF({ ...f, nome_campanha: v })} />
        <Inp label="Critério" v={f.criterio} on={(v) => setF({ ...f, criterio: v })} />
        <Inp label="Valor (R$)" type="number" v={f.valor} on={(v) => setF({ ...f, valor: v })} />
        <Inp label="Origem" v={f.origem} on={(v) => setF({ ...f, origem: v })} />
      </div>
      <button onClick={salvar} style={btn(true)}>Adicionar premiação</button>
      <Lista titulo="Premiações lançadas" itens={lanc.premiacoes} onDel={excluir}
        cols={[["beneficiario_email", "E-mail"], ["tipo", "Tipo"], ["nome_campanha", "Campanha"], ["valor", "Valor", BRL]]} />
    </div>
  );
}

function AbaAjustes({ competencia, lanc, onChange, setErro }) {
  const [f, setF] = useState({ email: "", nome: "", tipo: "bonus", natureza: "positivo", valor: "", motivo: "", documento_ref: "" });
  async function salvar() {
    setErro("");
    if (!f.motivo.trim()) { setErro("Motivo é obrigatório."); return; }
    const { error } = await supabase.rpc("fechamento_registrar_ajuste", {
      p_competencia: competencia, p_email: f.email.trim().toLowerCase(), p_nome: f.nome, p_tipo: f.tipo,
      p_natureza: f.natureza, p_valor: Number(f.valor || 0), p_motivo: f.motivo, p_documento_ref: f.documento_ref,
    });
    if (error) setErro(error.message); else onChange();
  }
  async function excluir(id) {
    const { error } = await supabase.rpc("fechamento_excluir_ajuste", { p_id: id });
    if (error) setErro(error.message); else onChange();
  }
  return (
    <div>
      <h3>Ajustes: bônus, correções, descontos e estornos</h3>
      <div style={grid2}>
        <Inp label="E-mail" v={f.email} on={(v) => setF({ ...f, email: v })} />
        <Inp label="Nome" v={f.nome} on={(v) => setF({ ...f, nome: v })} />
        <Sel label="Tipo" v={f.tipo} on={(v) => setF({ ...f, tipo: v, natureza: ["desconto", "estorno", "correcao_negativa"].includes(v) ? "negativo" : "positivo" })}
          opts={[["bonus", "Bônus"], ["correcao_positiva", "Correção +"], ["correcao_negativa", "Correção -"], ["desconto", "Desconto"], ["estorno", "Estorno"], ["outro", "Outro"]]} />
        <Inp label="Valor (R$, magnitude)" type="number" v={f.valor} on={(v) => setF({ ...f, valor: v })} />
        <Inp label="Motivo (obrigatório)" v={f.motivo} on={(v) => setF({ ...f, motivo: v })} />
        <Inp label="Documento/ref" v={f.documento_ref} on={(v) => setF({ ...f, documento_ref: v })} />
      </div>
      <button onClick={salvar} style={btn(true)}>Adicionar ajuste</button>
      <Lista titulo="Ajustes lançados" itens={lanc.ajustes} onDel={excluir}
        cols={[["beneficiario_email", "E-mail"], ["tipo", "Tipo"], ["natureza", "Natureza"], ["valor", "Valor", BRL], ["motivo", "Motivo"]]} />
    </div>
  );
}

function AbaReconciliacao({ previa }) {
  if (!previa) return <Vazio>Calcule a prévia primeiro.</Vazio>;
  const r = previa.reconciliacao || {};
  const linhas = [
    ["Valor recuperado", r.fechamento_recuperado_total, r.projecao_recuperado, r.diff_recuperado],
    ["Honorários", r.fechamento_honorario_total, r.projecao_honorario, r.diff_honorario],
  ];
  return (
    <table style={tbl}>
      <thead><tr>{["Indicador", "Fechamento", "Projeção", "Diferença"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
      <tbody>
        {linhas.map(([k, f, p, d]) => (
          <tr key={k}>
            <td style={td}>{k}</td><td style={tdN}>{BRL(f)}</td><td style={tdN}>{BRL(p)}</td>
            <td style={{ ...tdN, color: Number(d) === 0 ? "#065f46" : "#b91c1c", fontWeight: 700 }}>{BRL(d)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AbaVersoes({ versoes }) {
  if (!versoes.length) return <Vazio>Nenhum fechamento gravado ainda.</Vazio>;
  return (
    <table style={tbl}>
      <thead><tr>{["Competência", "Versão", "Status", "Total final", "Fechado por", "Fechado em", "Motivo"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
      <tbody>
        {versoes.map((v) => (
          <tr key={v.id}>
            <td style={td}>{v.competencia}</td><td style={tdC}>{v.versao}</td><td style={td}>{v.status}</td>
            <td style={tdN}>{BRL(v.total_final)}</td><td style={td}>{v.fechado_por || "—"}</td>
            <td style={td}>{v.fechado_em ? new Date(v.fechado_em).toLocaleString("pt-BR") : "—"}</td>
            <td style={td}>{v.motivo || ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ------- micro-componentes -------
function Inp({ label, v, on, type = "text" }) {
  return <label style={lbl}>{label}<input type={type} value={v} onChange={(e) => on(e.target.value)} style={inp} /></label>;
}
function Sel({ label, v, on, opts }) {
  return <label style={lbl}>{label}<select value={v} onChange={(e) => on(e.target.value)} style={inp}>{opts.map(([val, t]) => <option key={val} value={val}>{t}</option>)}</select></label>;
}
function Chk({ label, v, on }) {
  return <label style={{ ...lbl, flexDirection: "row", alignItems: "center", gap: 8 }}><input type="checkbox" checked={v} onChange={(e) => on(e.target.checked)} />{label}</label>;
}
function Lista({ titulo, itens, cols, onDel }) {
  if (!itens?.length) return <p style={{ color: "#9ca3af", marginTop: 16 }}>{titulo}: nenhum registro.</p>;
  return (
    <div style={{ marginTop: 20, overflowX: "auto" }}>
      <h4>{titulo}</h4>
      <table style={tbl}>
        <thead><tr>{cols.map(([, t]) => <th key={t} style={th}>{t}</th>)}{onDel && <th style={th}></th>}</tr></thead>
        <tbody>
          {itens.map((it) => (
            <tr key={it.id}>
              {cols.map(([c, , fmt]) => <td key={c} style={td}>{fmt ? fmt(it[c]) : String(it[c] ?? "")}</td>)}
              {onDel && <td style={td}><button onClick={() => onDel(it.id)} style={{ ...btn(false), padding: "4px 10px" }}>excluir</button></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Vazio({ children }) {
  return <p style={{ color: "#9ca3af", padding: 24, textAlign: "center" }}>{children}</p>;
}

const tbl = { borderCollapse: "collapse", width: "100%", fontSize: 13 };
const th = { background: "#1e40af", color: "#fff", padding: "8px 10px", textAlign: "left", position: "sticky", top: 0 };
const td = { padding: "6px 10px", borderBottom: "1px solid #f1f5f9" };
const tdN = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
const tdC = { ...td, textAlign: "center" };
const grid2 = { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 12, margin: "12px 0" };
const lbl = { display: "flex", flexDirection: "column", fontSize: 12, gap: 4, color: "#374151" };
const inp = { padding: 8, borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13 };
