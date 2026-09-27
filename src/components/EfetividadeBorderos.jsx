import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando } from "../ui/estados";

// EFETIVIDADE 2026/2 POR BORDERÔ
//
// Mesmo dado da visão consolidada de 2026/2, quebrado pelo BORDERÔ que trouxe o
// título para a cobrança. Uma pergunta só: cada remessa que entrou, o que virou?
//
// ENTRADA aqui é entrada NA CARTEIRA (a remessa que trouxe o título), nunca
// entrada financeira de acordo.
//
// O recorte é do TÍTULO, pelo semestre do título (série do Prime, com o
// vencimento como retaguarda) — nunca pela data de importação nem pelo semestre
// do cadastro do aluno. A régua das faixas é a mesma da Efetividade 2026/1.
// Quem decide tudo isso é o banco: esta tela não calcula, só desenha.
//
// CANCELADO e ACORDO CANCELADO são dois conceitos e nunca se somam:
//   Cancelados        = a COBRANÇA do título saiu da base.
//   Acordos cancelados = o acordo caiu; o título segue na carteira e o que já
//                        havia sido convertido continua convertido.

const moeda = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 });
const moedaCurta = (v) => {
  const n = Number(v || 0);
  if (Math.abs(n) >= 1e6) return "R$ " + (n / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + " mi";
  if (Math.abs(n) >= 1e3) return "R$ " + (n / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 0 }) + " mil";
  return moeda(n);
};
const num = (v) => Number(v || 0).toLocaleString("pt-BR");
const dia = (v) => (v ? new Date(String(v).length === 10 ? v + "T12:00:00" : v).toLocaleDateString("pt-BR") : "—");
const horario = (v) =>
  v ? new Date(v).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—";
const pct = (parte, todo, casas = 1) =>
  Number(todo) > 0
    ? (Number(parte) / Number(todo) * 100).toLocaleString("pt-BR",
        { minimumFractionDigits: casas, maximumFractionDigits: casas }) + "%"
    : "—";

// Cor por PAPEL, sempre em token — o tema escuro troca o valor e a tela
// acompanha. Os papéis são os mesmos da visão consolidada: âmbar é conferência,
// vermelho é o que segue em aberto, cinza é o que saiu da base.
const COR = {
  entradas: "var(--rv-azul)",
  recuperado: "var(--rv-verde-ok)",
  convertido: "var(--rv-roxo)",
  conferencia: "var(--rv-ambar)",
  cancelado: "var(--rv-texto-suave)",
  saldo: "var(--rv-vermelho)",
};

// Ícone discreto: traço fino, herda a cor do card, nunca compete com o número.
function Icone({ nome, cor }) {
  const comum = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: cor,
                  strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };
  const traco = {
    entradas: <path d="M12 5v14M5 12l7 7 7-7" />,
    recuperado: <><path d="M12 1v22" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></>,
    convertido: <><path d="M4 17 10 11l4 4 6-6" /><path d="M14 5h6v6" /></>,
    conferencia: <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>,
    cancelado: <><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></>,
    saldo: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  }[nome];
  return <svg {...comum}>{traco}</svg>;
}

// Os seis indicadores. `grandeza` é o que o card mede; `base` é o denominador
// declarado do percentual — percentual sem base declarada se lê errado.
function montarCards(t) {
  const entrada = Number(t?.valor_original || 0);
  return [
    {
      chave: "entradas", indicador: "entradas", papel: "entradas",
      titulo: "Entradas", valor: moedaCurta(t?.valor_original),
      linhas: [num(t?.titulos) + " títulos recebidos para cobrança", num(t?.alunos) + " alunos únicos"],
      nota: "valor original · entrada na carteira, não entrada de acordo",
    },
    {
      chave: "recuperado", indicador: "recuperado", papel: "recuperado",
      titulo: "Recuperado", valor: moedaCurta(t?.recuperado),
      linhas: [num(t?.titulos_com_pagamento) + " títulos com pagamento",
               num(t?.titulos_liquidados) + " totalmente liquidados"],
      nota: pct(t?.recuperado, entrada) + " do valor original que entrou",
    },
    {
      chave: "convertido", indicador: "convertido", papel: "convertido",
      titulo: "Convertido", valor: moedaCurta(t?.convertido_valor),
      linhas: [num(t?.convertido_titulos) + " títulos convertidos",
               "por pagamento ou negociação"],
      nota: pct(t?.convertido_valor, entrada) + " do valor original que entrou",
    },
    {
      chave: "conferencia", indicador: "em_conferencia", papel: "conferencia",
      titulo: "Em conferência", valor: moedaCurta(t?.conferencia_valor),
      linhas: [num(t?.conferencia_titulos) + " títulos sem prova suficiente",
               "não entram em Convertido nem no saldo"],
      nota: pct(t?.conferencia_valor, entrada) + " do valor original que entrou",
    },
    {
      chave: "cancelado", indicador: "cancelado", papel: "cancelado",
      titulo: "Cancelados", valor: moedaCurta(t?.cancelado_valor),
      linhas: [num(t?.cancelado_titulos) + " títulos com a cobrança cancelada",
               num(t?.acordos_cancelados) + " acordos cancelados (conceito separado)"],
      nota: "cobrança cancelada sai da base; acordo cancelado não",
    },
    {
      chave: "saldo", indicador: "saldo", papel: "saldo",
      titulo: "Saldo a recuperar", valor: moedaCurta(t?.saldo_valor),
      linhas: [num(t?.saldo_titulos) + " títulos com saldo",
               moedaCurta(t?.sem_negociacao_valor) + " sem nenhuma negociação"],
      nota: pct(t?.saldo_valor, entrada) + " do valor original que entrou",
    },
  ];
}

export default function EfetividadeBorderos() {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [selecionado, setSelecionado] = useState("todos");   // importacao_id ou "todos"
  const [detalhe, setDetalhe] = useState(null);              // { titulo, indicador, importacao_id, dados }

  useEffect(() => {
    let ativo = true;
    (async () => {
      const { data, error } = await supabase.rpc("carteira_2026_2_borderos");
      if (!ativo) return;
      if (error) setErro(error.message);
      setDados(data || null);
      setCarregando(false);
    })();
    return () => { ativo = false; };
  }, []);

  const borderos = useMemo(() => dados?.borderos || [], [dados]);
  // A lista do banco traz também o grupo dos títulos SEM importacao_id — ele
  // aparece como card ("Sem borderô identificado") porque o valor existe e tem de ser visto,
  // de ser visto, mas NÃO é remessa e não entra na contagem de borderôs. Medido em
  // produção em 27/09: 15 borderôs + 1 título órfão = 16 blocos.
  const orfao = useMemo(() => borderos.find((b) => !b.importacao_id) || null, [borderos]);
  const qtdBorderos = Number(dados?.total?.borderos || 0);
  const escolhido = selecionado === "todos"
    ? null
    : borderos.find((b) => (b.importacao_id || "sem-bordero") === selecionado) || null;
  // Selecionar um borderô troca o que os cards de cima medem: sem isso o
  // seletor mudaria a lista de baixo e deixaria o topo falando do semestre todo.
  const topo = escolhido || dados?.total;
  const cards = montarCards(topo);
  const visiveis = escolhido ? [escolhido] : borderos;

  async function abrirDetalhe(card, bordero) {
    const importacaoId = bordero ? bordero.importacao_id : (escolhido ? escolhido.importacao_id : null);
    const ondeTexto = bordero
      ? "Borderô " + (bordero.bordero_ref || "sem número")
      : escolhido ? "Borderô " + (escolhido.bordero_ref || "sem número") : "todos os borderôs de 2026/2";
    setDetalhe({ titulo: card.titulo, onde: ondeTexto, papel: card.papel, carregando: true, dados: null });
    const { data, error } = await supabase.rpc("carteira_2026_2_bordero_detalhe", {
      p_importacao_id: importacaoId,
      p_indicador: card.indicador,
      p_limite: 200,
      p_offset: 0,
    });
    setDetalhe({
      titulo: card.titulo, onde: ondeTexto, papel: card.papel,
      carregando: false, dados: data || null, erro: error?.message || "",
    });
  }

  if (carregando) return <Carregando />;
  if (erro) return <p style={S.erro}>{erro}</p>;
  if (!dados || !borderos.length) {
    return <p style={S.discreto}>Nenhum borderô com título de 2026/2.</p>;
  }

  const at = dados.atualizado_em || {};

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* ---- escolha do borderô + identidade do recorte ---- */}
      <div style={S.painelSeletor}>
        <div style={S.seletorBloco}>
          <span style={S.navRotulo}>Borderô</span>
          <select value={selecionado} onChange={(e) => setSelecionado(e.target.value)}
                  aria-label="Borderô de 2026/2" style={S.select}>
            <option value="todos">
              Todos os borderôs do semestre ({num(qtdBorderos)})
            </option>
            {borderos.map((b) => (
              <option key={b.importacao_id || "sem-bordero"} value={b.importacao_id || "sem-bordero"}>
                {b.bordero_ref ? "Borderô " + b.bordero_ref : "Sem borderô identificado"}
                {" · " + dia(b.bordero_entrada) + " · " + num(b.titulos) + " títulos · " + moedaCurta(b.valor_original)}
              </option>
            ))}
          </select>
        </div>
        <span style={S.chip}>2026/2 · semestre do título</span>
      </div>

      {/* Identidade do recorte escolhido, sempre no mesmo lugar. */}
      <p style={S.rodapeDiscreto}>
        {escolhido
          ? "Borderô " + (escolhido.bordero_ref || "sem número") + " · entrada em " + dia(escolhido.bordero_entrada)
            + " · " + num(escolhido.titulos) + " títulos · " + num(escolhido.alunos) + " alunos"
            + " · " + moeda(escolhido.valor_original) + " de valor original"
          : num(qtdBorderos) + " borderôs · " + num(dados.total?.titulos) + " títulos · "
            + num(dados.total?.alunos) + " alunos · " + moeda(dados.total?.valor_original)
            + " de valor original"}
        {" · dados atualizados em " + horario(dados.gerado_em)
          + " (situação no Prime coletada em " + horario(at.prime_coletado_em)
          + "; último borderô importado em " + dia(at.ultimo_bordero) + ")"}
      </p>

      {/* O título que entrou sem borderô: não dá para atribuí-lo a remessa
          nenhuma, então ele tem card próprio e sai da contagem de borderôs. */}
      {orfao && !escolhido ? (
        <p style={S.rodapeDiscreto}>
          {num(orfao.titulos)} título{Number(orfao.titulos) === 1 ? "" : "s"} de 2026/2
          ({moeda(orfao.valor_original)}) entrou sem borderô de origem: não há importação registrada para
          atribuí-lo a uma remessa. Aparece no card “Sem borderô identificado”, dentro dos totais do
          semestre — a origem não é inventada.
        </p>
      ) : null}

      {/* Onde o semestre é INFERIDO em vez de vir do Prime. Fica à vista porque
          é o único ponto do recorte que não é prova: sem série, o título entra
          em 2026/2 pelo vencimento. */}
      {Number(dados.total?.fallback_titulos || 0) > 0 ? (
        <p style={S.rodapeDiscreto}>
          {num(dados.total.fallback_titulos)} títulos ({moeda(dados.total.fallback_valor)},{" "}
          {pct(dados.total.fallback_valor, dados.total.valor_original)} do valor original) entram em 2026/2 pelo
          vencimento, por não terem série de cobrança no Prime. Nos demais o semestre vem da série.
        </p>
      ) : null}

      {/* ---- 1. OS SEIS CARDS DO RECORTE ---- */}
      <div style={S.gradeCards} role="group" aria-label="Indicadores do recorte">
        {cards.map((c) => (
          <button key={c.chave} type="button" onClick={() => abrirDetalhe(c, null)}
                  style={{ ...S.card, borderTop: "3px solid " + COR[c.papel] }}
                  title={"Ver os títulos que compõem " + c.titulo}>
            <span style={S.cardTopo}>
              <Icone nome={c.papel} cor={COR[c.papel]} />
              <span style={S.cardTitulo}>{c.titulo}</span>
            </span>
            <strong style={{ ...S.cardValor, color: COR[c.papel] }}>{c.valor}</strong>
            {c.linhas.map((l) => <span key={l} style={S.cardLinha}>{l}</span>)}
            <span style={S.cardNota}>{c.nota}</span>
            <span style={S.cardVer}>Ver títulos →</span>
          </button>
        ))}
      </div>

      {/* Motivo do cancelamento da cobrança — separado do acordo cancelado. */}
      <section style={S.cartao}>
        <div style={S.cartaoCabecalho}>
          <h2 style={S.h2}>Cancelados por motivo</h2>
          <span style={S.cartaoApoio}>cobrança cancelada · {num(dados.total?.cancelado_titulos)} títulos</span>
        </div>
        {(dados.cancelados_por_motivo || []).length ? (
          <div>
            {dados.cancelados_por_motivo.map((m) => (
              <div key={m.motivo} style={S.linhaMotivo}>
                <span style={S.linhaRotulo}>
                  <span style={{ ...S.ponto, background: COR.cancelado }} />{m.motivo}
                </span>
                <span style={S.linhaApoio}>{num(m.titulos)} títulos</span>
                <strong style={S.linhaValor}>{moeda(m.valor)}</strong>
              </div>
            ))}
          </div>
        ) : (
          <p style={S.discreto}>Nenhum título de 2026/2 com a cobrança cancelada.</p>
        )}
        <p style={S.discreto}>
          {num(dados.total?.acordos_cancelados)} acordos cancelados neste semestre
          ({moeda(dados.total?.acordos_cancelados_valor)} de valor original de títulos ligados a eles). Acordo
          cancelado não é cobrança cancelada: o título continua na carteira, e o que já havia sido convertido
          continua convertido — a conversão é histórica.
        </p>
      </section>

      {/* ---- 2. UM CARD POR BORDERÔ ---- */}
      <section>
        <div style={S.cartaoCabecalho}>
          <h2 style={S.h2}>{escolhido ? "Borderô selecionado" : "Borderô a borderô"}</h2>
          <span style={S.cartaoApoio}>
            {escolhido
              ? "mostre “Todos” no seletor para comparar"
              : num(qtdBorderos) + (qtdBorderos === 1 ? " remessa" : " remessas")
                + (orfao ? " + títulos sem borderô" : "")}
          </span>
        </div>
        <div style={S.gradeBorderos}>
          {visiveis.map((b) => {
            const entrada = Number(b.valor_original || 0);
            const recPct = entrada > 0 ? (Number(b.recuperado || 0) / entrada) * 100 : 0;
            const convPct = entrada > 0 ? (Number(b.convertido_valor || 0) / entrada) * 100 : 0;
            return (
              <article key={b.importacao_id || "sem-bordero"} style={S.bordero}
                       aria-label={b.bordero_ref ? "Borderô " + b.bordero_ref : "Sem borderô identificado"}>
                <header style={S.bordCabecalho}>
                  <div>
                    <strong style={S.bordNumero}>{b.bordero_ref ? "Borderô " + b.bordero_ref : "Sem borderô identificado"}</strong>
                    <span style={S.bordSelo}>2026/2</span>
                  </div>
                  <span style={S.bordEntrada}>entrou em {dia(b.bordero_entrada)}</span>
                </header>

                <div style={S.bordEntradaLinha}>
                  <span style={S.bordRotulo}>Entraram</span>
                  <span style={S.bordTexto}>
                    {num(b.titulos)} títulos · {num(b.alunos)} alunos · <strong>{moeda(b.valor_original)}</strong>
                  </span>
                </div>

                <div style={S.bordDestaque}>
                  <span style={S.bordRotulo}>Recuperado</span>
                  <strong style={{ ...S.bordValorGrande, color: COR.recuperado }}>{moedaCurta(b.recuperado)}</strong>
                  <span style={S.bordApoio}>
                    {num(b.titulos_com_pagamento)} com pagamento · {num(b.titulos_liquidados)} liquidados
                  </span>
                </div>

                {/* Barra dupla: recuperação sobre conversão, mesma base declarada. */}
                <div style={S.trilho} role="img"
                     aria-label={"Recuperado " + pct(b.recuperado, entrada) + " e convertido "
                                 + pct(b.convertido_valor, entrada) + " do valor original que entrou"}>
                  <div style={{ ...S.barra, width: Math.min(convPct, 100) + "%", background: COR.convertido,
                                opacity: 0.35 }} />
                  <div style={{ ...S.barra, width: Math.min(recPct, 100) + "%", background: COR.recuperado }} />
                </div>
                <div style={S.bordPcts}>
                  <span style={{ color: COR.recuperado }}>
                    <strong>{pct(b.recuperado, entrada)}</strong> recuperado
                  </span>
                  <span style={{ color: COR.convertido }}>
                    <strong>{pct(b.convertido_valor, entrada)}</strong> convertido
                  </span>
                </div>
                <span style={S.bordBase}>base dos dois percentuais: {moeda(entrada)} de valor original que entrou</span>

                <dl style={S.bordGrade}>
                  <div style={S.bordItem}>
                    <dt style={S.bordItemRotulo}>Convertido</dt>
                    <dd style={{ ...S.bordItemValor, color: COR.convertido }}>{moedaCurta(b.convertido_valor)}</dd>
                    <dd style={S.bordItemApoio}>{num(b.convertido_titulos)} títulos</dd>
                  </div>
                  <div style={S.bordItem}>
                    <dt style={S.bordItemRotulo}>Em conferência</dt>
                    <dd style={{ ...S.bordItemValor, color: COR.conferencia }}>{moedaCurta(b.conferencia_valor)}</dd>
                    <dd style={S.bordItemApoio}>{num(b.conferencia_titulos)} títulos</dd>
                  </div>
                  <div style={S.bordItem}>
                    <dt style={S.bordItemRotulo}>Cancelados</dt>
                    <dd style={{ ...S.bordItemValor, color: COR.cancelado }}>{moedaCurta(b.cancelado_valor)}</dd>
                    <dd style={S.bordItemApoio}>
                      {num(b.cancelado_titulos)} títulos · {num(b.acordos_cancelados)} acordos cancelados
                    </dd>
                  </div>
                  <div style={S.bordItem}>
                    <dt style={S.bordItemRotulo}>Saldo a recuperar</dt>
                    <dd style={{ ...S.bordItemValor, color: COR.saldo }}>{moedaCurta(b.saldo_valor)}</dd>
                    <dd style={S.bordItemApoio}>{num(b.saldo_titulos)} títulos com saldo</dd>
                  </div>
                </dl>

                <div style={S.bordAcoes}>
                  {montarCards(b).map((c) => (
                    <button key={c.chave} type="button" onClick={() => abrirDetalhe(c, b)} style={S.bordBotao}
                            title={"Ver os títulos de " + c.titulo + " do borderô "
                                   + (b.bordero_ref || "sem número")}>
                      <span style={{ ...S.ponto, background: COR[c.papel] }} />{c.titulo}
                    </button>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {detalhe ? <PainelDetalhe detalhe={detalhe} onFechar={() => setDetalhe(null)} /> : null}
    </div>
  );
}

// Detalhamento dos títulos de um indicador. A coluna de valor acompanha a
// grandeza do card que abriu o painel — Recuperado mostra o recuperado, Saldo
// mostra o saldo, os demais mostram o valor original.
function PainelDetalhe({ detalhe, onFechar }) {
  const d = detalhe.dados;
  const ind = d?.indicador;
  const colunaValor = ind === "recuperado" ? "recuperado" : ind === "saldo" ? "saldo" : "valor_original";
  const rotuloValor = ind === "recuperado" ? "Recuperado" : ind === "saldo" ? "Saldo" : "Valor original";
  return (
    <div style={S.sobreposicao} role="dialog" aria-modal="true" aria-label={"Títulos de " + detalhe.titulo}>
      <div style={S.painel}>
        <header style={S.painelCabecalho}>
          <div>
            <strong style={{ ...S.painelTitulo, color: COR[detalhe.papel] }}>{detalhe.titulo}</strong>
            <span style={S.painelOnde}>{detalhe.onde}</span>
          </div>
          <button type="button" onClick={onFechar} style={S.fechar} aria-label="Fechar">✕</button>
        </header>

        {detalhe.carregando ? <Carregando /> : detalhe.erro ? <p style={S.erro}>{detalhe.erro}</p> : (
          <>
            <p style={S.painelResumo}>
              {num(d?.total_titulos)} títulos · {moeda(d?.total_valor)}
              {Number(d?.total_titulos || 0) > (d?.linhas?.length || 0)
                ? " · mostrando os " + num(d?.linhas?.length) + " de maior valor original"
                : ""}
            </p>
            {(d?.linhas || []).length ? (
              <div style={S.tabelaRolagem}>
                <table style={S.tabela}>
                  <thead>
                    <tr>
                      <th style={S.th}>Aluno</th>
                      <th style={S.th}>CPF</th>
                      <th style={S.th}>Título</th>
                      <th style={S.th}>Venc.</th>
                      <th style={S.th}>Borderô</th>
                      <th style={S.th}>Situação</th>
                      <th style={{ ...S.th, textAlign: "right" }}>{rotuloValor}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.linhas.map((l, i) => (
                      <tr key={(l.documento || "") + "-" + i}>
                        <td style={S.td}>{l.aluno}</td>
                        <td style={S.tdFraco}>{l.cpf}</td>
                        <td style={S.tdFraco}>{l.documento}</td>
                        <td style={S.tdFraco}>{dia(l.vencimento)}</td>
                        <td style={S.tdFraco}>{l.bordero}</td>
                        <td style={S.td}>
                          {l.situacao}
                          {l.motivo_cancelamento ? " · " + l.motivo_cancelamento : ""}
                        </td>
                        <td style={{ ...S.td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {moeda(l[colunaValor])}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p style={S.discreto}>Nenhum título neste indicador.</p>}
            <p style={S.discreto}>
              CPF parcialmente oculto de propósito. O semestre de cada título vem da série do Prime; onde a série
              não existe, do vencimento.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

const S = {
  h2: { margin: 0, fontSize: 12.5, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
        color: "var(--rv-texto-fraco)" },
  erro: { color: "var(--rv-vermelho)", fontSize: 14, margin: 0 },
  discreto: { fontSize: 12.5, color: "var(--rv-texto-suave)", lineHeight: 1.6, margin: "8px 0 0" },
  rodapeDiscreto: { fontSize: 12.5, color: "var(--rv-texto-suave)", lineHeight: 1.6, margin: 0 },
  chip: { fontSize: 12, color: "var(--rv-texto-suave)", background: "var(--rv-fundo-suave)",
          borderRadius: 999, padding: "5px 12px", fontWeight: 600, whiteSpace: "nowrap" },
  ponto: { width: 8, height: 8, borderRadius: "50%", display: "inline-block", flex: "0 0 auto" },

  painelSeletor: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)",
                   borderRadius: 14, padding: "12px 16px", display: "flex", alignItems: "center",
                   justifyContent: "space-between", gap: 14, flexWrap: "wrap", boxShadow: "var(--rv-sombra)" },
  seletorBloco: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minWidth: 0, flex: "1 1 320px" },
  navRotulo: { fontSize: 11, color: "var(--rv-texto-fraco)", fontWeight: 700, textTransform: "uppercase",
               letterSpacing: "0.06em" },
  select: { flex: "1 1 260px", minWidth: 0, maxWidth: "100%", padding: "8px 12px", borderRadius: 10,
            border: "1px solid var(--rv-borda)", background: "var(--rv-fundo-suave)", color: "var(--rv-tinta)",
            fontSize: 13.5, fontFamily: "inherit", fontWeight: 600 },

  // ---- seis cards do recorte ----
  // minmax(200px, 1fr): em 375px de largura cai para uma coluna sem rolagem
  // horizontal, em vez de esticar o card para fora da tela.
  gradeCards: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 },
  card: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3, textAlign: "left",
          background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)", borderRadius: 14,
          padding: "14px 16px 12px", boxShadow: "var(--rv-sombra)", cursor: "pointer",
          fontFamily: "inherit", color: "var(--rv-tinta)" },
  cardTopo: { display: "flex", alignItems: "center", gap: 7 },
  cardTitulo: { fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
                color: "var(--rv-texto-fraco)" },
  cardValor: { fontSize: 27, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.15, marginTop: 4,
               fontFamily: "'Sora', Inter, sans-serif" },
  cardLinha: { fontSize: 12.5, color: "var(--rv-texto)", lineHeight: 1.5 },
  cardNota: { fontSize: 11.5, color: "var(--rv-texto-suave)", lineHeight: 1.5, marginTop: 4 },
  cardVer: { fontSize: 11.5, color: "var(--rv-azul)", fontWeight: 700, marginTop: 6 },

  cartao: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)", borderRadius: 14,
            padding: "14px 16px", boxShadow: "var(--rv-sombra)", display: "flex", flexDirection: "column", gap: 4 },
  cartaoCabecalho: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10,
                     flexWrap: "wrap", marginBottom: 8 },
  cartaoApoio: { fontSize: 11.5, color: "var(--rv-texto-suave)" },
  linhaMotivo: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                 padding: "7px 0", borderBottom: "1px solid var(--rv-borda-suave)" },
  linhaRotulo: { display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, flex: "1 1 200px", minWidth: 0 },
  linhaApoio: { fontSize: 12, color: "var(--rv-texto-suave)" },
  linhaValor: { fontSize: 13.5, fontWeight: 700, fontVariantNumeric: "tabular-nums" },

  // ---- um card por borderô ----
  gradeBorderos: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14 },
  bordero: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)", borderRadius: 16,
             padding: "16px 18px 14px", boxShadow: "var(--rv-sombra)", display: "flex",
             flexDirection: "column", gap: 10 },
  bordCabecalho: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10,
                   flexWrap: "wrap" },
  bordNumero: { fontSize: 19, fontWeight: 800, letterSpacing: "-0.01em",
                fontFamily: "'Sora', Inter, sans-serif" },
  bordSelo: { marginLeft: 8, fontSize: 11, fontWeight: 700, color: "var(--rv-azul-texto)",
              background: "var(--rv-azul-fundo)", border: "1px solid var(--rv-azul-borda)",
              borderRadius: 999, padding: "2px 8px" },
  bordEntrada: { fontSize: 12, color: "var(--rv-texto-suave)" },
  bordEntradaLinha: { display: "flex", flexDirection: "column", gap: 2 },
  bordRotulo: { fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
                color: "var(--rv-texto-fraco)" },
  bordTexto: { fontSize: 13.5, color: "var(--rv-texto)" },
  bordDestaque: { display: "flex", flexDirection: "column", gap: 2 },
  bordValorGrande: { fontSize: 30, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.1,
                     fontFamily: "'Sora', Inter, sans-serif" },
  bordApoio: { fontSize: 12.5, color: "var(--rv-texto-suave)" },
  trilho: { position: "relative", height: 9, borderRadius: 999, background: "var(--rv-fundo-suave)",
            overflow: "hidden" },
  barra: { position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 999 },
  bordPcts: { display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12.5 },
  bordBase: { fontSize: 11.5, color: "var(--rv-texto-suave)" },
  bordGrade: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10,
               margin: 0, paddingTop: 4, borderTop: "1px solid var(--rv-borda-suave)" },
  bordItem: { display: "flex", flexDirection: "column", gap: 1 },
  bordItemRotulo: { fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
                    color: "var(--rv-texto-fraco)" },
  bordItemValor: { margin: 0, fontSize: 16.5, fontWeight: 800, fontVariantNumeric: "tabular-nums" },
  bordItemApoio: { margin: 0, fontSize: 11.5, color: "var(--rv-texto-suave)", lineHeight: 1.45 },
  bordAcoes: { display: "flex", gap: 6, flexWrap: "wrap", paddingTop: 4,
               borderTop: "1px solid var(--rv-borda-suave)" },
  bordBotao: { display: "inline-flex", alignItems: "center", gap: 6, background: "var(--rv-fundo-suave)",
               border: "1px solid var(--rv-borda-suave)", borderRadius: 999, padding: "5px 11px",
               fontSize: 11.5, fontWeight: 600, color: "var(--rv-texto)", cursor: "pointer",
               fontFamily: "inherit" },

  // ---- painel de detalhe ----
  sobreposicao: { position: "fixed", inset: 0, background: "rgba(15, 23, 42, 0.55)", display: "flex",
                  alignItems: "flex-end", justifyContent: "center", padding: 16, zIndex: 60 },
  painel: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda)", borderRadius: 16,
            padding: "16px 18px", width: "min(980px, 100%)", maxHeight: "86vh", overflow: "auto",
            boxShadow: "var(--rv-sombra-elevada)", display: "flex", flexDirection: "column", gap: 8 },
  painelCabecalho: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  painelTitulo: { fontSize: 18, fontWeight: 800, display: "block",
                  fontFamily: "'Sora', Inter, sans-serif" },
  painelOnde: { fontSize: 12.5, color: "var(--rv-texto-suave)" },
  painelResumo: { margin: 0, fontSize: 13.5, fontWeight: 600 },
  fechar: { background: "none", border: "none", cursor: "pointer", fontSize: 18, lineHeight: 1,
            color: "var(--rv-texto-suave)", padding: 4, fontFamily: "inherit" },
  tabelaRolagem: { overflowX: "auto", marginTop: 4 },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 12.5 },
  th: { textAlign: "left", padding: "7px 8px", borderBottom: "1px solid var(--rv-borda)", fontSize: 11,
        fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rv-texto-fraco)",
        whiteSpace: "nowrap" },
  td: { padding: "7px 8px", borderBottom: "1px solid var(--rv-borda-suave)", verticalAlign: "top" },
  tdFraco: { padding: "7px 8px", borderBottom: "1px solid var(--rv-borda-suave)", verticalAlign: "top",
             color: "var(--rv-texto-suave)", whiteSpace: "nowrap" },
};
