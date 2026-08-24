// ============================================================================
// Fechamento Mensal da Remuneracao dos Operadores  (rota /fechamento-remuneracao)
// Acesso EXCLUSIVO amanda.seibel@aelbra.com.br (gating no App.jsx + backend RLS).
// Consolida valor fixo, comissao (sobre honorarios), premiacoes e ajustes.
// Gera relatorios Excel (sintetico + analitico) com a logo oficial da Reativa.
// ============================================================================
import { useState, useCallback, useMemo } from "react";
import * as XLSX from "xlsx";
import { supabase } from "../services/supabase";
import { gerarExcelSintetico, gerarExcelAnalitico } from "../utils/fechamentoRemuneracaoExcel";
import { gerarPdfOperador, gerarPdfsTodos } from "../utils/fechamentoRemuneracaoPdf";
import { emailPorNomeOperador, nomeOperadorPorEmail } from "../utils/operadores";

const BRL = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const PCT = (v) => `${Number(v || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;

function competenciaAtual() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
const primeiroDia = (mes) => `${mes}-01`;

// Lista de competências para o seletor (dropdown), do mês atual para trás.
// Substitui o <input type="month"> nativo, cujo widget do navegador dificultava
// escolher meses anteriores (junho/julho).
function mesesOpcoes(qtd = 24) {
  const hoje = new Date();
  const arr = [];
  for (let i = 0; i < qtd; i++) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
    arr.push([val, label]);
  }
  return arr;
}

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
  ["conferencia", "Conferência Prime"],
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
  async function baixarPdfsPorOperador() {
    if (!previa) return;
    setMsg("Gerando PDFs por operador…");
    const n = await gerarPdfsTodos(previa, mes);
    setMsg(n ? `${n} PDF(s) por operador gerado(s).` : "Nenhum operador na prévia.");
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
          <select value={mes} onChange={(e) => setMes(e.target.value)}
            style={{ padding: 8, borderRadius: 8, border: "1px solid #d1d5db", minWidth: 180, textTransform: "capitalize" }}>
            {mesesOpcoes().map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
        </label>
        <button onClick={carregarPrevia} disabled={carregando}
          style={btn(true)}>
          {carregando ? "Calculando…" : "Calcular prévia"}
        </button>
        {previa && (
          <>
            <button onClick={baixarSintetico} style={btn(false)}>⬇ Sintético (prévia)</button>
            <button onClick={baixarAnalitico} style={btn(false)}>⬇ Analítico (prévia)</button>
            <button onClick={baixarPdfsPorOperador} style={btn(false)}>⬇ PDFs por operador</button>
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
        {aba === "previa" && <AbaPrevia previa={previa} mes={mes} />}
        {aba === "config" && <AbaConfig competencia={competencia} lanc={lanc} onChange={carregarPrevia} setErro={setErro} setMsg={setMsg} />}
        {aba === "premiacoes" && <AbaPremiacoes competencia={competencia} lanc={lanc} onChange={carregarPrevia} setErro={setErro} />}
        {aba === "ajustes" && <AbaAjustes competencia={competencia} lanc={lanc} onChange={carregarPrevia} setErro={setErro} />}
        {aba === "reconciliacao" && <AbaReconciliacao previa={previa} />}
        {aba === "conferencia" && <AbaConferenciaPrime competencia={competencia} mes={mes} />}
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

function AbaPrevia({ previa, mes }) {
  if (!previa) return <Vazio>Selecione a competência e clique em “Calcular prévia”.</Vazio>;
  const benef = (previa.beneficiarios || []).slice().sort((a, b) => Number(b.total_final) - Number(a.total_final));
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={tbl}>
        <thead>
          <tr>{["#", "Operador", "Valor fixo", "Pag.", "Recuperado", "Honorários", "Faixa", "%", "Comissão", "Premiações", "Bônus/Corr.", "Desc./Est.", "TOTAL FINAL", "Situação", "PDF"].map((h) => <th key={h} style={th}>{h}</th>)}</tr>
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
              <td style={tdC}>
                <button onClick={() => gerarPdfOperador(l, previa, mes)}
                  title="Baixar PDF deste operador"
                  style={{ cursor: "pointer", border: "1px solid #d1d5db", background: "#fff", borderRadius: 6, padding: "3px 8px", fontSize: 12 }}>
                  ⬇ PDF
                </button>
              </td>
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

// ============================================================================
// Aba Conferência Prime (Ulbra) x Sistema — valida os VALORES parcela a parcela.
// Amanda exporta o relatório de pagamentos do Prime (mesmo layout Santander) e
// o sistema aponta divergências. Não altera nada; operador exibido é o do
// sistema. Chave = numero_parcela_completo (coluna E do extrato).
// ============================================================================
function numroP(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  const s = String(v).trim().replace(/\./g, "").replace(",", ".").replace(/[^0-9.-]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
function dataISOprime(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") { const d = XLSX.SSF.parse_date_code(v); return d ? `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}` : null; }
  if (typeof v === "string" && v.includes("/")) { const [dia, m, a] = v.split("/"); return `${a}-${String(m).padStart(2, "0")}-${String(dia).padStart(2, "0")}`; }
  return null;
}
// Layout Santander por posição: B(1) "matríc - nome" | C(2) título | D(3)
// operador NOME.SOBRENOME | E(4) parcela | I(8) honorário | J(9) data pagto | K(10) valor pago
function parsePrime(rows, mesRef) {
  const out = [];
  for (const r of rows) {
    const parcela = r[4] != null ? String(r[4]).trim() : "";
    if (!parcela) continue;
    const dISO = dataISOprime(r[9]);
    if (mesRef && dISO && dISO.slice(0, 7) !== mesRef) continue; // ignora linhas de outro mês
    let aluno = String(r[1] || "");
    const partes = aluno.split(" - ");
    if (partes.length > 1) aluno = partes.slice(1).join(" - ").trim();
    const email = emailPorNomeOperador(String(r[3] || ""));
    out.push({
      parcela,
      titulo: r[2] != null ? String(r[2]).trim() : null,
      valor_pago: numroP(r[10]),
      valor_honorario: numroP(r[8]),
      operador_email: email || null,
      operador_nome: email ? nomeOperadorPorEmail(email) : (String(r[3] || "").trim() || null),
      aluno_nome: aluno || null,
    });
  }
  return out;
}

function AbaConferenciaPrime({ competencia, mes }) {
  const [linhas, setLinhas] = useState(null);
  const [arquivo, setArquivo] = useState("");
  const [res, setRes] = useState(null);
  const [hist, setHist] = useState([]);
  const [erroC, setErroC] = useState("");
  const [msgC, setMsgC] = useState("");
  const [rodando, setRodando] = useState(false);

  const carregarHist = useCallback(async () => {
    const { data } = await supabase.rpc("fechamento_conferencia_listar", { p_competencia: competencia });
    setHist(data || []);
  }, [competencia]);

  async function aoEscolher(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setErroC(""); setMsgC(""); setRes(null); setLinhas(null);
    setArquivo(file.name);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array", cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
      const parsed = parsePrime(rows, mes);
      if (!parsed.length) { setErroC("Não encontrei linhas de pagamento nesse arquivo. Confirme que é o relatório de pagamentos do Prime (layout Santander) do mês selecionado."); return; }
      setLinhas(parsed);
      const vp = parsed.reduce((a, x) => a + x.valor_pago, 0);
      const vh = parsed.reduce((a, x) => a + x.valor_honorario, 0);
      setMsgC(`Arquivo lido: ${parsed.length.toLocaleString("pt-BR")} pagamentos · valor pago ${BRL(vp)} · honorário ${BRL(vh)}. Clique em "Rodar conferência".`);
    } catch (err) {
      setErroC("Erro ao ler a planilha: " + err.message);
    }
  }

  async function rodar() {
    if (!linhas) return;
    setRodando(true); setErroC(""); setMsgC("");
    try {
      const { data, error } = await supabase.rpc("fechamento_conferir_prime", {
        p_competencia: competencia, p_arquivo_nome: arquivo, p_linhas: linhas,
      });
      if (error) throw error;
      setRes(data);
      carregarHist();
    } catch (err) {
      setErroC(err.message || "Falha ao rodar a conferência.");
    } finally {
      setRodando(false);
    }
  }

  function baixarExcel() {
    if (!res) return;
    const wb = XLSX.utils.book_new();
    const t = res.totais || {};
    const resumo = [
      ["Conferência Prime × Sistema", ""],
      ["Competência", res.competencia],
      ["Arquivo Prime", res.arquivo_nome || ""],
      ["Resultado", res.bateu ? "BATEU (exato)" : "COM DIVERGÊNCIAS"],
      ["", ""],
      ["", "Prime", "Sistema", "Diferença (Sist - Prime)"],
      ["Valor pago", t.prime_valor, t.sistema_valor, t.diff_valor],
      ["Honorário", t.prime_honorario, t.sistema_honorario, t.diff_honorario],
      ["Qtd pagamentos", res.qtd_prime, res.qtd_sistema, ""],
      ["", "", "", ""],
      ["Só no Prime (sistema a menor)", res.qtd_so_prime],
      ["Só no sistema (sistema a maior)", res.qtd_so_sistema],
      ["Valor divergente", res.qtd_divergente],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resumo), "Resumo");
    const opRows = (res.resumo_por_operador || []).map((o) => ({
      Operador: o.operador_nome || o.operador_email, "Prime valor": o.prime_valor, "Sistema valor": o.sistema_valor,
      "Dif valor": o.diff_valor, "Prime honor.": o.prime_honorario, "Sistema honor.": o.sistema_honorario,
      "Dif honor.": o.diff_honorario, Bateu: o.bateu ? "OK" : "DIVERGE",
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(opRows), "Por operador");
    const mapDiv = (a) => (a || []).map((d) => ({
      Parcela: d.parcela, Título: d.titulo, Aluno: d.aluno_nome, Operador: d.operador_nome || d.operador_email,
      "Prime valor pago": d.prime_valor_pago, "Sistema valor pago": d.sistema_valor_pago, "Dif valor": d.diff_valor_pago,
      "Prime honor.": d.prime_honorario, "Sistema honor.": d.sistema_honorario, "Dif honor.": d.diff_honorario,
    }));
    const mapSo = (a) => (a || []).map((d) => ({
      Parcela: d.parcela, Título: d.titulo, Aluno: d.aluno_nome, Operador: d.operador_nome || d.operador_email,
      "Valor pago": d.valor_pago, Honorário: d.valor_honorario, Qtd: d.qtd,
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(mapSo(res.so_no_prime)), "Só no Prime");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(mapSo(res.so_no_sistema)), "Só no sistema");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(mapDiv(res.divergentes)), "Valor diferente");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    baixarBuffer(buf, `Conferencia_Prime_${(res.competencia || mes).replace("-", "_")}.xlsx`);
  }

  const t = res?.totais || {};
  return (
    <div>
      <div style={{ background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 10, padding: 16 }}>
        <p style={{ margin: "0 0 10px", fontSize: 13, color: "#374151" }}>
          Exporte o relatório de pagamentos do <b>Prime (Ulbra)</b> do mês <b>{mes}</b> e carregue aqui.
          O sistema confere <b>valor pago</b> e <b>honorário</b>, parcela a parcela. Nada é alterado — apenas aponta divergências.
          O operador exibido é sempre o do sistema.
        </p>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <input type="file" accept=".xlsx,.xls" onChange={aoEscolher} />
          <button onClick={rodar} disabled={!linhas || rodando} style={btn(true)}>
            {rodando ? "Conferindo…" : "Rodar conferência"}
          </button>
          {res && <button onClick={baixarExcel} style={btn(false)}>⬇ Excel de divergências</button>}
          <button onClick={carregarHist} style={{ ...btn(false), padding: "6px 12px" }}>Ver histórico</button>
        </div>
      </div>

      {erroC && <Aviso cor="#b91c1c" bg="#fee2e2">{erroC}</Aviso>}
      {msgC && <Aviso cor="#065f46" bg="#d1fae5">{msgC}</Aviso>}

      {res && (
        <>
          <div style={{
            marginTop: 16, padding: "14px 18px", borderRadius: 12, fontWeight: 700,
            background: res.bateu ? "#dcfce7" : "#fef2f2", color: res.bateu ? "#166534" : "#991b1b",
            border: `1px solid ${res.bateu ? "#86efac" : "#fecaca"}`,
          }}>
            {res.bateu
              ? "✅ BATEU — todos os valores do sistema conferem exatamente com o Prime."
              : `⚠️ DIVERGÊNCIAS: ${res.qtd_so_prime} só no Prime · ${res.qtd_so_sistema} só no sistema · ${res.qtd_divergente} com valor diferente.`}
            <div style={{ fontWeight: 500, fontSize: 13, marginTop: 6 }}>
              Diferença total — valor pago: <b>{BRL(t.diff_valor)}</b> · honorário: <b>{BRL(t.diff_honorario)}</b>
              &nbsp;(positivo = sistema a maior; negativo = sistema a menor)
            </div>
          </div>

          <table style={{ ...tbl, marginTop: 16 }}>
            <thead><tr>{["", "Prime", "Sistema", "Diferença"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              <tr><td style={td}>Valor pago</td><td style={tdN}>{BRL(t.prime_valor)}</td><td style={tdN}>{BRL(t.sistema_valor)}</td><td style={tdN}>{BRL(t.diff_valor)}</td></tr>
              <tr><td style={td}>Honorário</td><td style={tdN}>{BRL(t.prime_honorario)}</td><td style={tdN}>{BRL(t.sistema_honorario)}</td><td style={tdN}>{BRL(t.diff_honorario)}</td></tr>
              <tr><td style={td}>Pagamentos</td><td style={tdN}>{res.qtd_prime}</td><td style={tdN}>{res.qtd_sistema}</td><td style={tdN}>{res.qtd_sistema - res.qtd_prime}</td></tr>
            </tbody>
          </table>

          <TabelaConf titulo="Resumo por operador (só valores)" cols={[
            ["operador", "Operador"], ["pv", "Prime valor", BRL], ["sv", "Sistema valor", BRL], ["dv", "Dif valor", BRL],
            ["ph", "Prime honor.", BRL], ["sh", "Sistema honor.", BRL], ["dh", "Dif honor.", BRL], ["ok", "Bateu"],
          ]} linhas={(res.resumo_por_operador || []).map((o, i) => ({
            id: i, operador: o.operador_nome || o.operador_email, pv: o.prime_valor, sv: o.sistema_valor, dv: o.diff_valor,
            ph: o.prime_honorario, sh: o.sistema_honorario, dh: o.diff_honorario, ok: o.bateu ? "✅" : "⚠️",
          }))} />

          <DivBloco titulo={`Só no Prime — sistema está a MENOR (${res.qtd_so_prime})`} itens={res.so_no_prime} tipo="so" />
          <DivBloco titulo={`Só no sistema — sistema está a MAIOR (${res.qtd_so_sistema})`} itens={res.so_no_sistema} tipo="so" />
          <DivBloco titulo={`Valor diferente — mesma parcela, valores divergem (${res.qtd_divergente})`} itens={res.divergentes} tipo="div" />
        </>
      )}

      {hist.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <h4>Histórico de conferências</h4>
          <table style={tbl}>
            <thead><tr>{["Competência", "Rodada em", "Por", "Arquivo", "Resultado", "Só Prime", "Só sistema", "Divergente", "Dif valor", "Dif honor."].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {hist.map((h) => (
                <tr key={h.id}>
                  <td style={td}>{h.competencia}</td>
                  <td style={td}>{h.criado_em ? new Date(h.criado_em).toLocaleString("pt-BR") : "—"}</td>
                  <td style={td}>{h.criado_por}</td>
                  <td style={td}>{h.arquivo_nome || "—"}</td>
                  <td style={tdC}>{h.bateu ? "✅ Bateu" : "⚠️ Diverge"}</td>
                  <td style={tdN}>{h.qtd_so_prime}</td><td style={tdN}>{h.qtd_so_sistema}</td><td style={tdN}>{h.qtd_divergente}</td>
                  <td style={tdN}>{BRL(h.diff_valor)}</td><td style={tdN}>{BRL(h.diff_honorario)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TabelaConf({ titulo, cols, linhas }) {
  if (!linhas?.length) return null;
  return (
    <div style={{ marginTop: 20, overflowX: "auto" }}>
      <h4>{titulo}</h4>
      <table style={tbl}>
        <thead><tr>{cols.map(([, t]) => <th key={t} style={th}>{t}</th>)}</tr></thead>
        <tbody>
          {linhas.map((l) => (
            <tr key={l.id}>{cols.map(([c, , fmt]) => <td key={c} style={typeof l[c] === "number" || fmt === BRL ? tdN : td}>{fmt ? fmt(l[c]) : String(l[c] ?? "")}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DivBloco({ titulo, itens, tipo }) {
  if (!itens?.length) return <p style={{ color: "#16a34a", marginTop: 16, fontSize: 13 }}>✅ {titulo} — nenhuma.</p>;
  const amostra = itens.slice(0, 200);
  return (
    <div style={{ marginTop: 20, overflowX: "auto" }}>
      <h4 style={{ color: "#b91c1c" }}>{titulo}</h4>
      <table style={tbl}>
        <thead><tr>
          {["Parcela", "Título", "Aluno", "Operador"].map((h) => <th key={h} style={th}>{h}</th>)}
          {tipo === "div"
            ? ["Prime pago", "Sist. pago", "Dif pago", "Prime honor.", "Sist. honor.", "Dif honor."].map((h) => <th key={h} style={th}>{h}</th>)
            : ["Valor pago", "Honorário", "Qtd"].map((h) => <th key={h} style={th}>{h}</th>)}
        </tr></thead>
        <tbody>
          {amostra.map((d, i) => (
            <tr key={i}>
              <td style={td}>{d.parcela}</td><td style={td}>{d.titulo}</td><td style={td}>{d.aluno_nome}</td>
              <td style={td}>{d.operador_nome || d.operador_email || "—"}</td>
              {tipo === "div" ? (
                <>
                  <td style={tdN}>{BRL(d.prime_valor_pago)}</td><td style={tdN}>{BRL(d.sistema_valor_pago)}</td><td style={tdN}>{BRL(d.diff_valor_pago)}</td>
                  <td style={tdN}>{BRL(d.prime_honorario)}</td><td style={tdN}>{BRL(d.sistema_honorario)}</td><td style={tdN}>{BRL(d.diff_honorario)}</td>
                </>
              ) : (
                <>
                  <td style={tdN}>{BRL(d.valor_pago)}</td><td style={tdN}>{BRL(d.valor_honorario)}</td><td style={tdN}>{d.qtd}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {itens.length > amostra.length && <p style={{ color: "#6b7280", fontSize: 12 }}>Mostrando 200 de {itens.length}. Baixe o Excel para a lista completa.</p>}
    </div>
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
