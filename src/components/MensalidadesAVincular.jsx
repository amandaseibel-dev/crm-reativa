import { useCallback, useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { S as A } from "../ui/estilosFila";

// Mensalidades que ainda não foram vinculadas ao acordo que as substituiu.
//
// POR QUE ESTA FILA EXISTE. Acordo importado do Prime não diz quais mensalidades
// ele cobriu. Quando ninguém faz o vínculo, as duas coisas ficam em aberto ao
// mesmo tempo -- o saldo do acordo E a mensalidade velha -- e a carteira conta
// duas vezes. Medido em 03/09/2026: onde o vínculo existe sobra 3,4% de
// mensalidade solta; onde não existe, sobram 71%.
//
// O QUE A LISTA MOSTRA é o par: de um lado a mensalidade em aberto, do outro o
// acordo (e o pagamento) que sugerem que ela já foi negociada. A decisão do
// vínculo continua sendo humana, e é feita no Financeiro da ficha do aluno --
// esta tela leva até lá, não vincula sozinha.
//
// QUEM NÃO APARECE: aluno sem acordo e sem pagamento nenhum. Esse é cobrança
// normal, não tratativa -- misturar os dois só faria a fila parecer maior.

const moeda = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const num = (v) => Number(v || 0).toLocaleString("pt-BR");
const data = (v) => (v ? new Date(v).toLocaleDateString("pt-BR") : "—");

const SITUACOES = [
  {
    chave: "ACORDO_E_PAGOU",
    rotulo: "Tem acordo e já pagou",
    cor: "#b91c1c",
    ajuda: "O aluno negociou e está pagando, mas a mensalidade antiga continua contando. É o caso mais claro de dívida em dobro.",
  },
  {
    chave: "ACORDO_SEM_PAGAR",
    rotulo: "Tem acordo, sem pagamento",
    cor: "#b45309",
    ajuda: "Existe acordo ativo cobrindo o período. A mensalidade solta provavelmente já está dentro dele.",
  },
  {
    chave: "PAGOU_SEM_ACORDO",
    rotulo: "Pagou, sem acordo",
    cor: "#1d4ed8",
    ajuda: "Entrou dinheiro e não há acordo. Aqui a conferência é da baixa: o pagamento cobriu esta mensalidade?",
  },
];

const POR_PAGINA = 100;

// A fila começa SEM recorte de período. Nasceu presa a 2026/1 e o recorte
// escondia metade do trabalho -- 724 alunos contra 1.125 no total, R$ 3,13 mi
// contra R$ 4,65 mi, com título de fevereiro de 2024 em diante. O semestre vira
// filtro, não limite.
const PERIODOS = [
  { chave: "TUDO", rotulo: "Todos os períodos", de: null, ate: null },
  { chave: "2026_1", rotulo: "2026/1", de: "2026-01-01", ate: "2026-06-30" },
  { chave: "2025", rotulo: "2025 e antes", de: null, ate: "2025-12-31" },
];

export default function MensalidadesAVincular({ aoAtualizarContagem }) {
  const [situacao, setSituacao] = useState("TODAS");
  const [periodo, setPeriodo] = useState("TUDO");
  const [pagina, setPagina] = useState(0);
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro("");
    try {
      const faixa = PERIODOS.find((x) => x.chave === periodo) || PERIODOS[0];
      const { data: d, error } = await supabase.rpc("confirmacao_a_vincular", {
        p_de: faixa.de,
        p_ate: faixa.ate,
        p_situacao: situacao,
        p_limite: POR_PAGINA,
        p_offset: pagina * POR_PAGINA,
      });
      if (error) throw error;
      setDados(d);
    } catch (e) {
      setErro(e?.message || String(e));
      setDados(null);
    } finally {
      setCarregando(false);
    }
  }, [situacao, pagina, periodo]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  // O badge da aba mostra a fila inteira, não a página nem o filtro aberto.
  const resumo = dados?.resumo || {};
  const totalGeral = SITUACOES.reduce((s, x) => s + Number(resumo[x.chave]?.alunos || 0), 0);
  useEffect(() => {
    if (aoAtualizarContagem && dados) aoAtualizarContagem(totalGeral);
  }, [aoAtualizarContagem, dados, totalGeral]);

  const itens = dados?.itens || [];
  const total = Number(dados?.total || 0);
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const valorTotal = SITUACOES.reduce((s, x) => s + Number(resumo[x.chave]?.valor || 0), 0);

  return (
    <>
      <div style={A.topo}>
        <div>
          <h1 style={A.titulo}>Mensalidades a vincular</h1>
          <p style={A.sub}>
            Mensalidades em aberto e sem vínculo, de quem já tem acordo ou já pagou.
            Enquanto o vínculo não é feito, a mesma dívida conta duas vezes na carteira.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {PERIODOS.map((f) => (
            <button
              key={f.chave}
              type="button"
              style={{ ...S.botaoPag, ...(periodo === f.chave ? S.cardAtivo : null) }}
              onClick={() => { setPeriodo(f.chave); setPagina(0); }}
            >
              {f.rotulo}
            </button>
          ))}
          <button type="button" style={A.btnGhost} onClick={carregar}>Atualizar</button>
        </div>
      </div>

      {erro && <div style={S.erro}>Não foi possível carregar: {erro}</div>}

      <div style={S.cards}>
        <button
          type="button"
          style={{ ...S.card, ...(situacao === "TODAS" ? S.cardAtivo : null) }}
          onClick={() => { setSituacao("TODAS"); setPagina(0); }}
        >
          <span style={S.cardRot}>Tudo a tratar</span>
          <span style={S.cardVal}>{num(totalGeral)}</span>
          <span style={S.cardNota}>{moeda(valorTotal)} em mensalidade</span>
        </button>
        {SITUACOES.map((s) => {
          const r = resumo[s.chave] || {};
          return (
            <button
              key={s.chave}
              type="button"
              title={s.ajuda}
              style={{ ...S.card, ...(situacao === s.chave ? S.cardAtivo : null) }}
              onClick={() => { setSituacao(s.chave); setPagina(0); }}
            >
              <span style={S.cardRot}>{s.rotulo}</span>
              <span style={{ ...S.cardVal, color: s.cor }}>{num(r.alunos)}</span>
              <span style={S.cardNota}>{moeda(r.valor)} · {num(r.titulos)} títulos</span>
            </button>
          );
        })}
      </div>

      {carregando && <div style={S.vazio}>Carregando…</div>}
      {!carregando && !erro && itens.length === 0 && (
        <div style={S.vazio}>Nenhuma mensalidade a vincular neste recorte.</div>
      )}

      {!carregando && itens.length > 0 && (
        <div style={S.rolagem}>
          <table style={S.tabela}>
            <thead>
              <tr>
                <th style={S.th}>Aluno</th>
                <th style={S.th}>Responsável</th>
                <th style={S.th}>Situação</th>
                <th style={S.thNum}>Mensalidade solta</th>
                <th style={S.thNum}>Títulos</th>
                <th style={S.thNum}>Acordo</th>
                <th style={S.thNum}>Já pagou</th>
                <th style={S.thNum}>Últ. pagto</th>
              </tr>
            </thead>
            <tbody>
              {itens.map((i) => {
                const s = SITUACOES.find((x) => x.chave === i.situacao);
                return (
                  <tr key={i.aluno_id}>
                    <td style={S.td}>
                      <a href={`/aluno?id=${i.aluno_id}`} style={S.link}>{i.nome || "(sem nome)"}</a>
                      <span style={S.nota}>{i.cpf || ""}</span>
                    </td>
                    <td style={S.td}>{i.responsavel}</td>
                    <td style={S.td}>
                      <span style={{ ...S.pill, color: s?.cor, borderColor: s?.cor }}>{s?.rotulo || i.situacao}</span>
                    </td>
                    <td style={S.tdNum}><b>{moeda(i.valor_mensalidade)}</b></td>
                    <td style={S.tdNum}>{num(i.titulos)}</td>
                    <td style={S.tdNum}>
                      {i.acordos > 0 ? (
                        <>
                          {moeda(i.saldo_acordo)}
                          <span style={S.nota}>
                            {i.acordos > 1 ? `${i.acordos} acordos` : `nº ${i.numero_acordo ?? "—"}`}
                            {i.acordos_com_parcela_paga > 0 ? " · com parcela paga" : ""}
                          </span>
                        </>
                      ) : "—"}
                    </td>
                    <td style={S.tdNum}>{i.valor_pago > 0 ? moeda(i.valor_pago) : "—"}</td>
                    <td style={S.tdNum}>{data(i.ultimo_pagamento)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {paginas > 1 && (
        <div style={S.paginacao}>
          <button type="button" style={S.botaoPag} disabled={pagina === 0} onClick={() => setPagina((p) => p - 1)}>
            ← Anterior
          </button>
          <span style={S.nota}>Página {pagina + 1} de {paginas} · {num(total)} alunos</span>
          <button type="button" style={S.botaoPag} disabled={pagina + 1 >= paginas} onClick={() => setPagina((p) => p + 1)}>
            Próxima →
          </button>
        </div>
      )}

      <p style={S.rodape}>
        O vínculo é feito na ficha do aluno, aba Financeiro — clique no nome para abrir. Esta tela
        aponta o que falta tratar; ela não vincula sozinha.
      </p>
    </>
  );
}

const S = {
  cards: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10, margin: "0 0 16px" },
  card: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 3, cursor: "pointer", textAlign: "left", font: "inherit" },
  cardAtivo: { borderColor: "#1e40af", boxShadow: "0 0 0 2px rgba(30,64,175,0.12)" },
  cardRot: { fontSize: 11.5, color: "#64748b", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" },
  cardVal: { fontSize: 21, fontWeight: 800, color: "#0f172a", lineHeight: 1.1 },
  cardNota: { fontSize: 11.5, color: "#94a3b8" },
  rolagem: { overflowX: "auto" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "9px 10px", color: "#94a3b8", fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", borderBottom: "1px solid #e2e8f0", whiteSpace: "nowrap" },
  thNum: { textAlign: "right", padding: "9px 10px", color: "#94a3b8", fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", borderBottom: "1px solid #e2e8f0", whiteSpace: "nowrap" },
  td: { padding: "8px 10px", borderBottom: "1px solid #f1f5f9", color: "#0f172a" },
  tdNum: { padding: "8px 10px", borderBottom: "1px solid #f1f5f9", color: "#0f172a", textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" },
  link: { color: "#1d4ed8", fontWeight: 600, textDecoration: "none" },
  nota: { fontSize: 11, color: "#94a3b8", marginLeft: 6, display: "inline-block" },
  pill: { fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", border: "1px solid", borderRadius: 999, padding: "1px 8px", whiteSpace: "nowrap" },
  vazio: { background: "#fff", border: "1px solid #eef2f6", borderRadius: 14, padding: 18, color: "#64748b", fontSize: 13.5 },
  erro: { background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", borderRadius: 12, padding: 14, fontSize: 13.5, marginBottom: 12 },
  paginacao: { display: "flex", alignItems: "center", justifyContent: "center", gap: 14, marginTop: 14 },
  botaoPag: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "6px 12px", fontSize: 13, cursor: "pointer" },
  rodape: { fontSize: 12, color: "#94a3b8", margin: "12px 0 0" },
};
