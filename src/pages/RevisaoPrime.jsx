// REVISÃO PRIME × CRM — a tela que faltava.
//
// A tabela `revisao_prime_aluno` existe desde 04/09, tem 17.279 linhas e é
// recalculada por cron todo fim de semana. Nunca teve tela. Em 09/09/2026 ela
// já apontava, desde o sábado anterior, que **671 alunos somam R$ 2.364.753,61
// em títulos que o CRM cobra e o Prime já liquidou** — e ninguém tinha por onde
// ver. O problema nunca foi detectar; era não haver janela.
//
// PARA QUEM: gestão. A RLS da tabela (`revisao_prime_aluno_gestao_le`) já
// resolve isso sozinha — quem não é gestão recebe zero linha, sem precisar de
// checagem no cliente.
//
// POR QUE NÃO VIRA FILA DE OPERADOR: dar baixa a partir do Prime é PROIBIDO
// aqui. Acordo cancelado devolve a dívida e o Prime não reverte, então uma
// baixa automática apagaria dívida viva. Esta tela mostra e exporta; quem baixa
// é gente, pelo número do título, no fluxo normal.
import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

const FONTE = "'Sora','Inter',system-ui,sans-serif";
const moeda = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const num = (v) => Number(v || 0).toLocaleString("pt-BR");
// ATENÇÃO ao fuso: `new Date("2026-09-05")` é meia-noite UTC e, no nosso fuso,
// volta um dia — a tela mostraria 04/09. Então data pura é formatada pelo texto,
// sem passar por Date; só o timestamp completo usa toLocaleDateString.
const dataBR = (v) => {
  if (!v) return "—";
  const texto = String(v);
  const soData = texto.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(soData) && !texto.includes("T")) {
    const [ano, mes, dia] = soData.split("-");
    return `${dia}/${mes}/${ano}`;
  }
  return new Date(v).toLocaleDateString("pt-BR");
};

// As colunas que a tabela guarda e que respondem "o que conferir e quanto vale".
const CAMPOS = [
  "aluno_id", "nome", "cpf_mascarado", "operador", "caso_codigo", "unidade",
  "situacao_crm", "saldo_crm",
  "crm_abertos_liquidados_no_prime_n", "crm_abertos_liquidados_no_prime_valor",
  "p195_abertos_fora_do_crm_n", "p195_abertos_fora_do_crm_valor",
  "p195_ultima_liquidacao", "portador_prime", "resumo", "calculado_em",
  "extrato_coletado_em",
].join(", ");

const VISOES = [
  {
    id: "cobrando_pago",
    titulo: "O CRM cobra, o Prime já liquidou",
    explica: "Títulos abertos no CRM que o Prime registra como pagos. É cobrança indevida enquanto ninguém confere.",
    coluna: "crm_abertos_liquidados_no_prime_n",
    colunaValor: "crm_abertos_liquidados_no_prime_valor",
  },
  {
    id: "fora_do_crm",
    titulo: "O Prime tem, o CRM não",
    explica: "Títulos abertos no portador 195 (ReATIVA) que não existem no CRM. É dívida que ninguém está cobrando.",
    coluna: "p195_abertos_fora_do_crm_n",
    colunaValor: "p195_abertos_fora_do_crm_valor",
  },
];

export default function RevisaoPrime() {
  const [visao, setVisao] = useState(VISOES[0]);
  const [linhas, setLinhas] = useState([]);
  const [totais, setTotais] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");

  // A busca fica DENTRO do efeito, e o estado só é tocado no retorno da
  // promessa: efeito que chama setState de forma síncrona dispara renderização
  // em cascata. A guarda `vivo` evita que uma aba trocada depressa deixe na
  // tela o resultado da consulta anterior. Quem liga o "carregando" é o clique;
  // na primeira carga ele já nasce ligado.
  useEffect(() => {
    let vivo = true;
    supabase
      .from("revisao_prime_aluno")
      .select(CAMPOS)
      .gt(visao.coluna, 0)
      .order(visao.colunaValor, { ascending: false, nullsFirst: false })
      .limit(1000)
      .then(({ data, error }) => {
        if (!vivo) return;
        if (error) {
          setErro(error.message);
          setLinhas([]);
          setTotais(null);
        } else {
          const rows = data || [];
          setErro("");
          setLinhas(rows);
          setTotais({
            alunos: rows.length,
            titulos: rows.reduce((s, r) => s + Number(r[visao.coluna] || 0), 0),
            valor: rows.reduce((s, r) => s + Number(r[visao.colunaValor] || 0), 0),
            calculadoEm: rows[0]?.calculado_em || null,
            extratoEm: rows[0]?.extrato_coletado_em || null,
          });
        }
        setCarregando(false);
      });
    return () => { vivo = false; };
  }, [visao]);

  function exportarCsv() {
    const cab = ["Aluno", "CPF", "Operador", "Caso", "Unidade", "Situação CRM",
                 "Saldo CRM", "Títulos", "Valor", "Última liquidação"];
    const linhasCsv = linhas.map((r) => [
      r.nome, r.cpf_mascarado, r.operador || "", r.caso_codigo || "", r.unidade || "",
      r.situacao_crm || "", Number(r.saldo_crm || 0).toFixed(2),
      r[visao.coluna] || 0, Number(r[visao.colunaValor] || 0).toFixed(2),
      r.p195_ultima_liquidacao || "",
    ]);
    const csv = [cab, ...linhasCsv]
      .map((l) => l.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(";"))
      .join("\n");
    // BOM para o Excel abrir acentuação certa.
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `revisao-prime-${visao.id}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={S.pagina}>
      <div style={S.cabecalho}>
        <div>
          <h1 style={S.h1}>Revisão Prime × CRM</h1>
          <p style={S.sub}>
            Onde as duas fontes discordam. Recalculado por rotina todo fim de semana.
            {totais?.calculadoEm ? ` · Cálculo de ${dataBR(totais.calculadoEm)}` : ""}
            {totais?.extratoEm ? ` · Extrato do Prime de ${dataBR(totais.extratoEm)}` : ""}
          </p>
        </div>
        <button onClick={exportarCsv} disabled={!linhas.length} style={S.btn}>⬇ Exportar CSV</button>
      </div>

      <div style={S.abas}>
        {VISOES.map((v) => (
          <button
            key={v.id}
            onClick={() => { setCarregando(true); setVisao(v); }}
            style={v.id === visao.id ? S.abaAtiva : S.aba}
          >
            {v.titulo}
          </button>
        ))}
      </div>

      <p style={S.explica}>{visao.explica}</p>

      {erro ? <div style={S.erro}>Não foi possível carregar: {erro}</div> : null}

      {totais ? (
        <div style={S.cards}>
          <div style={S.card}><div style={S.cardRot}>Alunos</div><div style={S.cardVal}>{num(totais.alunos)}</div></div>
          <div style={S.card}><div style={S.cardRot}>Títulos</div><div style={S.cardVal}>{num(totais.titulos)}</div></div>
          <div style={S.card}><div style={S.cardRot}>Valor</div><div style={{ ...S.cardVal, color: "var(--rv-alerta)" }}>{moeda(totais.valor)}</div></div>
        </div>
      ) : null}

      {carregando ? <div style={S.vazio}>Carregando…</div> : null}
      {!carregando && !linhas.length && !erro ? (
        <div style={S.vazio}>Nenhuma divergência nesta visão. </div>
      ) : null}

      {linhas.length ? (
        <div style={S.tabelaScroll}>
          <table style={S.tabela}>
            <thead>
              <tr>
                <th style={S.th}>Aluno</th>
                <th style={S.th}>CPF</th>
                <th style={S.th}>Operador</th>
                <th style={S.th}>Caso</th>
                <th style={S.thN}>Saldo no CRM</th>
                <th style={S.thN}>Títulos</th>
                <th style={S.thN}>Valor</th>
                <th style={S.th}>Última liquidação</th>
              </tr>
            </thead>
            <tbody>
              {linhas.map((r) => (
                <tr key={r.aluno_id}>
                  <td style={S.td}>{r.nome}</td>
                  <td style={S.tdM}>{r.cpf_mascarado}</td>
                  <td style={S.td}>{r.operador || <span style={S.fraco}>sem operador</span>}</td>
                  <td style={S.tdM}>{r.caso_codigo || "—"}</td>
                  <td style={S.tdN}>{moeda(r.saldo_crm)}</td>
                  <td style={S.tdN}>{num(r[visao.coluna])}</td>
                  <td style={{ ...S.tdN, fontWeight: 600 }}>{moeda(r[visao.colunaValor])}</td>
                  <td style={S.tdM}>{dataBR(r.p195_ultima_liquidacao)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {linhas.length >= 1000 ? (
            <p style={S.nota}>Mostrando os 1.000 maiores. Exporte o CSV para ver todos.</p>
          ) : null}
        </div>
      ) : null}

      <p style={S.rodape}>
        Esta tela não dá baixa. Baixa a partir do Prime é proibida aqui — acordo cancelado
        devolve a dívida e o Prime não reverte. Confira pelo número do título e baixe pelo
        fluxo normal.
      </p>
    </div>
  );
}

const S = {
  pagina: { padding: 20, fontFamily: FONTE, maxWidth: 1500, margin: "0 auto" },
  cabecalho: { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 },
  h1: { margin: 0, fontSize: 22, color: "var(--rv-texto)" },
  sub: { margin: "4px 0 0", fontSize: 13, color: "var(--rv-texto-suave)" },
  btn: {
    padding: "8px 14px", borderRadius: "var(--rv-raio-pequeno, 8px)", cursor: "pointer",
    border: "1px solid var(--rv-borda)", background: "var(--rv-superficie)", color: "var(--rv-texto)", fontSize: 13,
  },
  abas: { display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" },
  aba: {
    padding: "8px 14px", borderRadius: "var(--rv-raio-pequeno, 8px)", cursor: "pointer", fontSize: 13,
    border: "1px solid var(--rv-borda)", background: "var(--rv-superficie)", color: "var(--rv-texto-suave)",
  },
  abaAtiva: {
    padding: "8px 14px", borderRadius: "var(--rv-raio-pequeno, 8px)", cursor: "pointer", fontSize: 13,
    border: "1px solid var(--rv-tinta)", background: "var(--rv-tinta)", color: "var(--rv-fundo)", fontWeight: 600,
  },
  explica: { margin: "12px 0 0", fontSize: 13.5, color: "var(--rv-texto-suave)", maxWidth: "70ch" },
  cards: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(190px,1fr))", gap: 12, marginTop: 16 },
  card: {
    background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)",
    borderRadius: "var(--rv-raio, 10px)", padding: "14px 16px",
  },
  cardRot: { fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--rv-texto-suave)" },
  cardVal: { fontSize: 24, fontWeight: 600, marginTop: 4, color: "var(--rv-texto)", fontVariantNumeric: "tabular-nums" },
  tabelaScroll: { overflowX: "auto", marginTop: 18 },
  tabela: { borderCollapse: "collapse", width: "100%", fontSize: 13, minWidth: 900 },
  th: {
    textAlign: "left", padding: "8px 10px", fontSize: 10.5, letterSpacing: ".08em",
    textTransform: "uppercase", color: "var(--rv-texto-suave)", fontWeight: 500,
    borderBottom: "1px solid var(--rv-borda)", whiteSpace: "nowrap",
  },
  thN: {
    textAlign: "right", padding: "8px 10px", fontSize: 10.5, letterSpacing: ".08em",
    textTransform: "uppercase", color: "var(--rv-texto-suave)", fontWeight: 500,
    borderBottom: "1px solid var(--rv-borda)", whiteSpace: "nowrap",
  },
  td: { padding: "8px 10px", borderBottom: "1px solid var(--rv-borda-suave)", color: "var(--rv-texto)" },
  tdM: {
    padding: "8px 10px", borderBottom: "1px solid var(--rv-borda-suave)",
    color: "var(--rv-texto-suave)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
  },
  tdN: {
    padding: "8px 10px", borderBottom: "1px solid var(--rv-borda-suave)", textAlign: "right",
    color: "var(--rv-texto)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
  },
  fraco: { color: "var(--rv-texto-suave)", fontStyle: "italic" },
  vazio: { marginTop: 18, padding: 16, fontSize: 14, color: "var(--rv-texto-suave)" },
  erro: {
    marginTop: 16, padding: "12px 14px", borderRadius: "var(--rv-raio, 10px)",
    border: "1px solid var(--rv-erro)", color: "var(--rv-erro)", fontSize: 13.5,
  },
  nota: { fontSize: 12.5, color: "var(--rv-texto-suave)", marginTop: 10 },
  rodape: {
    marginTop: 28, paddingTop: 16, borderTop: "1px solid var(--rv-borda-suave)",
    fontSize: 12.5, color: "var(--rv-texto-suave)", maxWidth: "80ch",
  },
};
