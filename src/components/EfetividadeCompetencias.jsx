import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando } from "../ui/estados";

// EFETIVIDADE 2026/2 POR COMPETÊNCIA
//
// Mesmo dado da visão consolidada de 2026/2, quebrado pelo MÊS DE COMPETÊNCIA
// da mensalidade. Uma pergunta só: de cada mês que entrou em cobrança, o que
// virou?
//
// COMPETÊNCIA = mês do VENCIMENTO da mensalidade. Não é o borderô, que é
// artefato interno de importação e não identifica nada para quem lê (quatro
// borderôs caem em agosto/2026, quatro em julho), e não é a coluna
// `acordos_titulos.competencia`, que está nula em todos os títulos de 2026/2.
//
// ENTRADA aqui é entrada NA CARTEIRA de cobrança, nunca entrada financeira de
// acordo.
//
// O recorte é do TÍTULO, pelo semestre do título (série do Prime, com o
// vencimento como retaguarda) — nunca pela data de importação nem pelo semestre
// do cadastro do aluno. A régua das faixas é a mesma da Efetividade 2026/1.
// Quem decide tudo isso é o banco: esta tela não calcula, só desenha.
//
// CANCELADO e ACORDO CANCELADO são dois conceitos e nunca se somam:
//   Cancelados         = a COBRANÇA do título saiu da base.
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
// Contagem com o substantivo no número certo: com o dado real de produção a
// tela mostrava "1 títulos" e "1 acordos".
const conta = (v, um, varios) =>
  num(v) + " " + (Math.abs(Number(v || 0)) === 1 ? um : varios);
const dia = (v) => (v ? new Date(String(v).length === 10 ? v + "T12:00:00" : v).toLocaleDateString("pt-BR") : "—");
// Competência por extenso. Sempre com o ano: 2026/2 tem mensalidade vencendo em
// abril e em dezembro, e "agosto" sem ano convida a erro de leitura.
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho",
               "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const competenciaLonga = (v) => {
  if (!v) return "Sem competência";
  const d = new Date(String(v).slice(0, 10) + "T12:00:00");
  return MESES[d.getMonth()] + "/" + d.getFullYear();
};
const competenciaCurta = (v) => {
  if (!v) return "—";
  const d = new Date(String(v).slice(0, 10) + "T12:00:00");
  return MESES[d.getMonth()].slice(0, 3) + "/" + d.getFullYear();
};
// "venc. 05/08" quando o mês tem uma data só; "venc. 01/07 a 30/07" quando tem
// várias. O intervalo é informação real: julho tem 19 datas distintas.
const faixaVencimento = (b) =>
  Number(b?.datas_de_vencimento || 0) <= 1
    ? "venc. " + dia(b?.vencimento_de)
    : "venc. " + dia(b?.vencimento_de) + " a " + dia(b?.vencimento_ate);
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
// O SALDO NÃO É DÍVIDA LIMPA. O classificador calcula saldo = valor original -
// recuperado para TODO título não cancelado, então tudo que não foi pago entra
// aqui — inclusive o que está em conferência e o ajuste acadêmico, que ainda
// dependem de conciliação. As quatro parcelas abaixo somam o saldo exatamente,
// e três delas saem direto do painel; a quarta é o resíduo ainda não pago dos
// títulos já convertidos (negociado que não virou dinheiro).
// MEDIDO em produção em 27/09: 2.780.543,16 + 1.529.222,65 + 167.027,63 +
// 140.360,83 = 4.617.154,27, o saldo total.
function composicaoDoSaldo(t) {
  const residuo = Number(t?.convertido_valor || 0) - Number(t?.recuperado || 0);
  return [
    { chave: "sem_negociacao", rotulo: "Sem nenhuma negociação", papel: "saldo",
      indicador: "sem_negociacao", valor: Number(t?.sem_negociacao_valor || 0),
      apoio: conta(t?.sem_negociacao_titulos, "mensalidade", "mensalidades") },
    { chave: "conferencia", rotulo: "Em conferência, a conciliar", papel: "conferencia",
      indicador: "em_conferencia", valor: Number(t?.conferencia_valor || 0),
      apoio: conta(t?.conferencia_titulos, "mensalidade", "mensalidades") },
    { chave: "residuo", rotulo: "Negociado ainda não pago", papel: "convertido",
      indicador: "convertido", valor: residuo,
      apoio: "resíduo dos títulos já convertidos" },
    { chave: "academico", rotulo: "Ajuste acadêmico, a conciliar", papel: "cancelado",
      indicador: "academico", valor: Number(t?.academico_valor || 0),
      apoio: conta(t?.academico_titulos, "mensalidade", "mensalidades") },
  ];
}

function montarCards(t) {
  const entrada = Number(t?.valor_original || 0);
  return [
    {
      chave: "entradas", indicador: "entradas", papel: "entradas",
      titulo: "Entradas", valor: moedaCurta(t?.valor_original),
      linhas: [conta(t?.titulos, "mensalidade recebida", "mensalidades recebidas") + " para cobrança",
               conta(t?.alunos, "aluno único", "alunos únicos")],
      nota: "valor original · entrada na carteira, não entrada de acordo",
    },
    {
      chave: "recuperado", indicador: "recuperado", papel: "recuperado",
      titulo: "Recuperado por rateio", valor: moedaCurta(t?.recuperado),
      linhas: [conta(t?.titulos_com_pagamento, "mensalidade com pagamento", "mensalidades com pagamento"),
               conta(t?.titulos_liquidados, "totalmente liquidado", "totalmente liquidados")],
      nota: pct(t?.recuperado, entrada) + " do valor original que entrou",
      aviso: "principal proporcional às parcelas pagas do acordo — não é caixa recebido",
    },
    {
      chave: "convertido", indicador: "convertido", papel: "convertido",
      titulo: "Convertido", valor: moedaCurta(t?.convertido_valor),
      linhas: [conta(t?.convertido_titulos, "mensalidade convertida", "mensalidades convertidas"),
               "por pagamento ou negociação"],
      nota: pct(t?.convertido_valor, entrada) + " do valor original que entrou",
    },
    {
      chave: "conferencia", indicador: "em_conferencia", papel: "conferencia",
      titulo: "Em conferência", valor: moedaCurta(t?.conferencia_valor),
      linhas: [conta(t?.conferencia_titulos, "sem prova suficiente", "sem prova suficiente"),
               "não entram em Convertido"],
      nota: pct(t?.conferencia_valor, entrada) + " do valor original que entrou",
      aviso: "continuam dentro do saldo residual, porque ninguém confirmou o pagamento",
    },
    {
      chave: "cancelado", indicador: "cancelado", papel: "cancelado",
      titulo: "Cancelados", valor: moedaCurta(t?.cancelado_valor),
      linhas: [conta(t?.cancelado_titulos, "mensalidade com a cobrança cancelada",
                     "mensalidades com a cobrança cancelada"),
               conta(t?.acordos_cancelados, "acordo cancelado", "acordos cancelados")
                 + " (conceito separado)"],
      nota: "cobrança cancelada sai da base; acordo cancelado não",
    },
    {
      chave: "saldo", indicador: "saldo", papel: "saldo",
      titulo: "Saldo residual da carteira", valor: moedaCurta(t?.saldo_valor),
      linhas: [conta(t?.saldo_titulos, "mensalidade com saldo", "mensalidades com saldo"),
               "só " + moedaCurta(t?.sem_negociacao_valor) + " sem nenhuma negociação"],
      nota: pct(t?.saldo_valor, entrada) + " do valor original que entrou",
      aviso: "inclui conferência e ajuste acadêmico pendentes de conciliação — "
           + "não é saldo confirmado para cobrança",
    },
  ];
}

// Qual campo da competência cada card mede, e a linha de apoio de cada um.
// Ficam fora do componente para o card do mês ler a MESMA definição dos cards
// do topo, sem repetir rótulo nem fórmula.
const VALOR_DO_CARD = {
  entradas: "valor_original", recuperado: "recuperado", convertido: "convertido_valor",
  conferencia: "conferencia_valor", cancelado: "cancelado_valor", saldo: "saldo_valor",
};
const APOIO_DO_CARD = {
  entradas: (b) => conta(b.titulos, "mensalidade", "mensalidades"),
  recuperado: (b) => conta(b.titulos_com_pagamento, "com pagamento", "com pagamento"),
  convertido: (b) => conta(b.convertido_titulos, "mensalidade", "mensalidades"),
  conferencia: (b) => conta(b.conferencia_titulos, "mensalidade", "mensalidades"),
  cancelado: (b) => conta(b.cancelado_titulos, "mensalidade", "mensalidades") + " · "
                  + conta(b.acordos_cancelados, "acordo cancelado", "acordos cancelados"),
  saldo: (b) => conta(b.saldo_titulos, "com saldo", "com saldo"),
};
const tituloDetalhe = (c, b) =>
  "Ver os títulos de " + c.titulo + " com vencimento em " + competenciaLonga(b.competencia);

export default function EfetividadeCompetencias() {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [selecionado, setSelecionado] = useState("todos");   // competência (AAAA-MM-DD) ou "todos"
  const [detalhe, setDetalhe] = useState(null);              // { titulo, indicador, importacao_id, dados }

  useEffect(() => {
    let ativo = true;
    (async () => {
      const { data, error } = await supabase.rpc("carteira_2026_2_competencias");
      if (!ativo) return;
      if (error) setErro(error.message);
      setDados(data || null);
      setCarregando(false);
    })();
    return () => { ativo = false; };
  }, []);

  // Ordem CRONOLÓGICA crescente, decidida aqui e não no banco: é apresentação,
  // não regra. O painel devolve do mais recente para o mais antigo, o que
  // colocava dezembro/2026 (1 mensalidade) na frente de agosto (R$ 2,8 mi).
  // Lido como linha do tempo, o semestre se explica sozinho.
  const competencias = useMemo(
    () => [...(dados?.competencias || [])].sort(
      (x, y) => String(x.competencia).localeCompare(String(y.competencia))),
    [dados]);
  const qtdCompetencias = Number(dados?.total?.competencias || 0);
  const escolhido = selecionado === "todos"
    ? null
    : competencias.find((b) => String(b.competencia).slice(0, 10) === selecionado) || null;
  // Selecionar uma competência troca o que os cards de cima medem: sem isso o
  // seletor mudaria a lista de baixo e deixaria o topo falando do semestre todo.
  const topo = escolhido || dados?.total;
  const cards = montarCards(topo);
  const visiveis = escolhido ? [escolhido] : competencias;

  async function abrirDetalhe(card, competencia) {
    const alvo = competencia || escolhido;
    const ondeTexto = alvo
      ? "Vencimento em " + competenciaLonga(alvo.competencia)
      : "todos os meses de vencimento de 2026/2";
    setDetalhe({ titulo: card.titulo, onde: ondeTexto, papel: card.papel, carregando: true, dados: null });
    const { data, error } = await supabase.rpc("carteira_2026_2_competencia_detalhe", {
      p_competencia: alvo ? String(alvo.competencia).slice(0, 10) : null,
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
  if (!dados || !competencias.length) {
    return <p style={S.discreto}>Nenhuma mensalidade de 2026/2 em cobrança.</p>;
  }

  const at = dados.atualizado_em || {};
  // Mês anterior ao início do semestre (julho) presente na lista.
  const temVencimentoAntesDoSemestre = competencias.some(
    (b) => String(b.competencia).slice(0, 10) < "2026-07-01");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* ---- escolha da competência + identidade do recorte ---- */}
      <div style={S.painelSeletor}>
        <div style={S.seletorBloco}>
          <span style={S.navRotulo}>Mês de vencimento</span>
          <select value={selecionado} onChange={(e) => setSelecionado(e.target.value)}
                  aria-label="Mês de vencimento de 2026/2" style={S.select}>
            <option value="todos">
              Todos os meses de vencimento ({num(qtdCompetencias)})
            </option>
            {competencias.map((b) => (
              <option key={String(b.competencia)} value={String(b.competencia).slice(0, 10)}>
                {competenciaLonga(b.competencia)
                 + " · " + conta(b.titulos, "mensalidade", "mensalidades")
                 + " · " + moedaCurta(b.valor_original)}
              </option>
            ))}
          </select>
        </div>
        <span style={S.chip}>2026/2 · agrupado pelo mês de vencimento</span>
      </div>

      {/* Identidade do recorte escolhido, sempre no mesmo lugar. */}
      <p style={S.rodapeDiscreto}>
        {escolhido
          ? "Vencimento em " + competenciaLonga(escolhido.competencia) + " · " + faixaVencimento(escolhido)
            + " · " + conta(escolhido.titulos, "mensalidade", "mensalidades")
            + " · " + conta(escolhido.alunos, "aluno", "alunos")
            + " · " + moeda(escolhido.valor_original) + " de valor original"
          : conta(qtdCompetencias, "mês de vencimento", "meses de vencimento")
            + " (" + competenciaCurta(dados.total?.vencimento_de) + " a "
            + competenciaCurta(dados.total?.vencimento_ate) + ") · "
            + conta(dados.total?.titulos, "mensalidade", "mensalidades") + " · "
            + conta(dados.total?.alunos, "aluno", "alunos") + " · "
            + moeda(dados.total?.valor_original) + " de valor original"}
        {" · dados atualizados em " + horario(dados.gerado_em)
          + " (situação no Prime coletada em " + horario(at.prime_coletado_em)
          + "; última entrada na carteira em " + dia(at.ultima_entrada) + ")"}
      </p>

      {/* Por que um semestre que começa em julho tem mensalidade vencendo em
          abril. Sem isto a lista parece erro de recorte e alguém "conserta"
          excluindo os meses, tirando dívida real da carteira. */}
      {temVencimentoAntesDoSemestre ? (
        <p style={S.rodapeDiscreto}>
          O semestre 2026/2 começa em julho, mas a lista tem mensalidades vencendo antes disso. Não é erro de
          recorte: quem diz a que semestre a mensalidade pertence é a <strong>série de cobrança do Prime</strong>,
          não a data de vencimento. Medido em 27/09/2026: as 218 mensalidades com vencimento entre abril e junho
          (R$ 394.089,85) estão em 2026/2 porque a série do Prime as coloca lá — nenhuma entrou pela regra de
          vencimento. São dívida real do semestre e por isso não são excluídas.
        </p>
      ) : null}

      {/* Onde o semestre é INFERIDO em vez de vir do Prime. Fica à vista porque
          é o único ponto do recorte que não é prova: sem série, o título entra
          em 2026/2 pelo vencimento. */}
      {Number(dados.total?.fallback_titulos || 0) > 0 ? (
        <p style={S.rodapeDiscreto}>
          {conta(dados.total.fallback_titulos, "mensalidade", "mensalidades")} ({moeda(dados.total.fallback_valor)},{" "}
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
            {c.aviso ? <span style={S.cardAviso}>{c.aviso}</span> : null}
            <span style={S.cardVer}>Ver títulos →</span>
          </button>
        ))}
      </div>

      {/* Motivo do cancelamento da cobrança — separado do acordo cancelado. */}
      <section style={S.cartao}>
        <div style={S.cartaoCabecalho}>
          <h2 style={S.h2}>Cancelados por motivo</h2>
          <span style={S.cartaoApoio}>cobrança cancelada · {conta(dados.total?.cancelado_titulos, "título", "títulos")}</span>
        </div>
        {(dados.cancelados_por_motivo || []).length ? (
          <div>
            {dados.cancelados_por_motivo.map((m) => (
              <div key={m.motivo} style={S.linhaMotivo}>
                <span style={S.linhaRotulo}>
                  <span style={{ ...S.ponto, background: COR.cancelado }} />{m.motivo}
                </span>
                <span style={S.linhaApoio}>{conta(m.titulos, "título", "títulos")}</span>
                <strong style={S.linhaValor}>{moeda(m.valor)}</strong>
              </div>
            ))}
          </div>
        ) : (
          <p style={S.discreto}>Nenhum título de 2026/2 com a cobrança cancelada.</p>
        )}
        <p style={S.discreto}>
          {conta(dados.total?.acordos_cancelados, "acordo cancelado", "acordos cancelados")} neste semestre
          ({moeda(dados.total?.acordos_cancelados_valor)} de valor original de títulos ligados a eles). Acordo
          cancelado não é cobrança cancelada: o título continua na carteira, e o que já havia sido convertido
          continua convertido — a conversão é histórica.
        </p>
      </section>

      {/* Composição do saldo residual: o card de cima diz que não é dívida
          limpa; aqui se mostra de que ele é feito, com cada parte clicável. */}
      <section style={S.cartao}>
        <div style={S.cartaoCabecalho}>
          <h2 style={S.h2}>Composição do saldo residual</h2>
          <span style={S.cartaoApoio}>
            {moeda(topo?.saldo_valor)} · as quatro parcelas somam o saldo
          </span>
        </div>
        <div>
          {composicaoDoSaldo(topo).map((l) => {
            const base = Number(topo?.saldo_valor || 0);
            const share = base > 0 ? (l.valor / base) * 100 : 0;
            return (
              <button key={l.chave} type="button" style={S.linhaSaldo}
                      onClick={() => abrirDetalhe(
                        { titulo: l.rotulo, indicador: l.indicador, papel: l.papel }, null)}
                      title={"Ver os títulos de " + l.rotulo}>
                <span style={S.linhaTopoSaldo}>
                  <span style={S.linhaRotulo}>
                    <span style={{ ...S.ponto, background: COR[l.papel] }} />{l.rotulo}
                  </span>
                  <strong style={S.linhaValor}>{moeda(l.valor)}</strong>
                  <span style={{ ...S.linhaPctSaldo, color: COR[l.papel] }}>
                    {share.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%
                  </span>
                </span>
                <span style={S.linhaApoio}>{l.apoio}</span>
                <span style={S.trilho}>
                  <span style={{ ...S.barra, position: "relative", display: "block",
                                 width: Math.max(Math.min(share, 100), l.valor > 0 ? 0.6 : 0) + "%",
                                 height: "100%", background: COR[l.papel] }} />
                </span>
              </button>
            );
          })}
        </div>
        <p style={S.discreto}>
          Só {pct(topo?.sem_negociacao_valor, topo?.saldo_valor)} do saldo é dívida sem nenhuma negociação. O
          restante depende de conciliação (conferência e ajuste acadêmico) ou já foi negociado e ainda não virou
          pagamento. Por isso o total não é saldo confirmado para cobrança.
        </p>
      </section>

      {/* ---- 2. UM CARD POR MÊS DE VENCIMENTO ---- */}
      <section>
        <div style={S.cartaoCabecalho}>
          <h2 style={S.h2}>{escolhido ? "Mês selecionado" : "Mês a mês"}</h2>
          <span style={S.cartaoApoio}>
            {escolhido ? "mostre “Todos” no seletor para comparar"
                       : conta(qtdCompetencias, "mês de vencimento", "meses de vencimento")}
          </span>
        </div>
        <div style={S.gradeBorderos}>
          {visiveis.map((b) => {
            const entrada = Number(b.valor_original || 0);
            const recPct = entrada > 0 ? (Number(b.recuperado || 0) / entrada) * 100 : 0;
            const convPct = entrada > 0 ? (Number(b.convertido_valor || 0) / entrada) * 100 : 0;
            const cards = montarCards(b);
            return (
              <article key={String(b.competencia)} style={S.cartaoCompetencia}
                       aria-label={"Mensalidades com vencimento em " + competenciaLonga(b.competencia)}>
                <header style={S.compCabecalho}>
                  <div>
                    <strong style={S.compNumero}>{competenciaLonga(b.competencia)}</strong>
                    <span style={S.compSelo}>2026/2</span>
                  </div>
                  <span style={S.compEntrada}>{faixaVencimento(b)}</span>
                </header>

                <button type="button" style={S.compLinhaBotao} onClick={() => abrirDetalhe(cards[0], b)}
                        title={tituloDetalhe(cards[0], b)}>
                  <span style={S.compRotulo}>Entraram</span>
                  <span style={S.compTexto}>
                    {conta(b.titulos, "mensalidade", "mensalidades")} · {conta(b.alunos, "aluno", "alunos")} ·{" "}
                    <strong>{moeda(b.valor_original)}</strong>
                  </span>
                </button>

                <button type="button" style={S.compLinhaBotao} onClick={() => abrirDetalhe(cards[1], b)}
                        title={tituloDetalhe(cards[1], b)}>
                  <span style={S.compRotulo}>Recuperado</span>
                  <strong style={{ ...S.compValorGrande, color: COR.recuperado }}>{moedaCurta(b.recuperado)}</strong>
                  <span style={S.compApoio}>
                    {num(b.titulos_com_pagamento)} com pagamento · {num(b.titulos_liquidados)} liquidados
                  </span>
                </button>

                {/* Barra dupla: recuperação sobre conversão, mesma base declarada. */}
                <div style={S.trilho} role="img"
                     aria-label={"Recuperado " + pct(b.recuperado, entrada) + " e convertido "
                                 + pct(b.convertido_valor, entrada) + " do valor original que entrou"}>
                  <div style={{ ...S.barra, width: Math.min(convPct, 100) + "%", background: COR.convertido,
                                opacity: 0.35 }} />
                  <div style={{ ...S.barra, width: Math.min(recPct, 100) + "%", background: COR.recuperado }} />
                </div>
                <div style={S.compPcts}>
                  <span style={{ color: COR.recuperado }}>
                    <strong>{pct(b.recuperado, entrada)}</strong> recuperado
                  </span>
                  <span style={{ color: COR.convertido }}>
                    <strong>{pct(b.convertido_valor, entrada)}</strong> convertido
                  </span>
                </div>
                <span style={S.compBase}>base dos dois percentuais: {moeda(entrada)} de valor original que entrou</span>

                {/* O próprio número abre o detalhe. Antes havia uma fileira de
                    seis chips abaixo repetindo os mesmos rótulos: com 16 cards na
                    tela viravam 96 chips de ruído, e o número é o alvo natural. */}
                <div style={S.compGrade}>
                  {cards.slice(2).map((cc) => (
                    <button key={cc.chave} type="button" style={S.compItem}
                            onClick={() => abrirDetalhe(cc, b)} title={tituloDetalhe(cc, b)}>
                      <span style={S.compItemRotulo}>{cc.titulo}</span>
                      <strong style={{ ...S.compItemValor, color: COR[cc.papel] }}>
                        {moedaCurta(b[VALOR_DO_CARD[cc.chave]])}
                      </strong>
                      <span style={S.compItemApoio}>{APOIO_DO_CARD[cc.chave](b)}</span>
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
  // O campo `origem_importacao` depende da migration 20260928…; até ela ser
  // aplicada a coluna simplesmente não aparece, em vez de a tela mostrar vazio
  // e passar a impressão de que ninguém tem origem.
  const temOrigem = (d?.linhas || []).some((l) => "origem_importacao" in l);
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
                      <th style={S.th}>Mês venc.</th>
                      {temOrigem ? <th style={S.th}>Origem</th> : null}
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
                        <td style={S.tdFraco}>{competenciaCurta(l.competencia)}</td>
                        {temOrigem ? (
                          <td style={l.origem_importacao ? S.tdFraco : S.tdSemOrigem}>
                            {l.origem_importacao || "Sem importação de origem identificada"}
                          </td>
                        ) : null}
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
              não existe, do vencimento.{" "}
              {temOrigem
                ? "A coluna Origem mostra a importação que trouxe o título para a carteira; agrupar pelo mês de "
                  + "vencimento não substitui essa rastreabilidade."
                : ""}
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
  gradeCards: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(168px, 1fr))", gap: 12 },
  card: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3, textAlign: "left",
          background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)", borderRadius: 14,
          padding: "14px 16px 12px", boxShadow: "var(--rv-sombra)", cursor: "pointer",
          fontFamily: "inherit", color: "var(--rv-tinta)" },
  cardTopo: { display: "flex", alignItems: "flex-start", gap: 7, minHeight: 30 },
  cardTitulo: { fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
                color: "var(--rv-texto-fraco)", lineHeight: 1.3 },
  cardValor: { fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.15, marginTop: 2,
               fontFamily: "'Sora', Inter, sans-serif", whiteSpace: "nowrap" },
  cardLinha: { fontSize: 12.5, color: "var(--rv-texto)", lineHeight: 1.5 },
  cardNota: { fontSize: 11.5, color: "var(--rv-texto-suave)", lineHeight: 1.5, marginTop: 4 },
  // A ressalva não pode competir com o número, mas também não pode sumir: é ela
  // que impede a leitura errada do card.
  cardAviso: { fontSize: 11, color: "var(--rv-ambar-texto)", lineHeight: 1.45, marginTop: 4,
               borderTop: "1px dashed var(--rv-borda-suave)", paddingTop: 4 },
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
  linhaSaldo: { display: "flex", flexDirection: "column", gap: 3, width: "100%", textAlign: "left",
                background: "none", border: "none", borderBottom: "1px solid var(--rv-borda-suave)",
                padding: "8px 0", margin: 0, cursor: "pointer", font: "inherit", color: "inherit" },
  linhaTopoSaldo: { display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" },
  linhaPctSaldo: { fontSize: 12.5, fontWeight: 700, fontVariantNumeric: "tabular-nums" },

  // ---- um card por competência ----
  gradeBorderos: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14 },
  cartaoCompetencia: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)", borderRadius: 16,
             padding: "16px 18px 14px", boxShadow: "var(--rv-sombra)", display: "flex",
             flexDirection: "column", gap: 10 },
  compCabecalho: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10,
                   flexWrap: "wrap" },
  compNumero: { fontSize: 19, fontWeight: 800, letterSpacing: "-0.01em",
                fontFamily: "'Sora', Inter, sans-serif" },
  compSelo: { marginLeft: 8, fontSize: 11, fontWeight: 700, color: "var(--rv-azul-texto)",
              background: "var(--rv-azul-fundo)", border: "1px solid var(--rv-azul-borda)",
              borderRadius: 999, padding: "2px 8px" },
  compEntrada: { fontSize: 12, color: "var(--rv-texto-suave)" },
  // "Entraram" e "Recuperado" são botões, mas não devem PARECER botões: o card
  // inteiro já é uma superfície: só o cursor e o título mudam.
  compLinhaBotao: { display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-start",
                    textAlign: "left", background: "none", border: "none", padding: 0,
                    margin: 0, cursor: "pointer", font: "inherit", color: "inherit", width: "100%" },
  compRotulo: { fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
                color: "var(--rv-texto-fraco)" },
  compTexto: { fontSize: 13.5, color: "var(--rv-texto)" },

  compValorGrande: { fontSize: 30, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.1,
                     fontFamily: "'Sora', Inter, sans-serif", whiteSpace: "nowrap" },
  compApoio: { fontSize: 12.5, color: "var(--rv-texto-suave)" },
  trilho: { position: "relative", height: 9, borderRadius: 999, background: "var(--rv-fundo-suave)",
            overflow: "hidden" },
  barra: { position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 999 },
  compPcts: { display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12.5 },
  compBase: { fontSize: 11.5, color: "var(--rv-texto-suave)" },
  compGrade: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10,
               paddingTop: 8, borderTop: "1px solid var(--rv-borda-suave)" },
  compItem: { display: "flex", flexDirection: "column", gap: 1, alignItems: "flex-start",
              textAlign: "left", background: "none", border: "none", padding: 0, margin: 0,
              cursor: "pointer", font: "inherit", color: "inherit" },
  compItemRotulo: { fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
                    color: "var(--rv-texto-fraco)" },
  compItemValor: { fontSize: 16.5, fontWeight: 800, fontVariantNumeric: "tabular-nums",
                   whiteSpace: "nowrap" },
  compItemApoio: { fontSize: 11.5, color: "var(--rv-texto-suave)", lineHeight: 1.45 },

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
  // Falta de rastreabilidade não é dado neutro: fica em âmbar para ser vista.
  tdSemOrigem: { padding: "7px 8px", borderBottom: "1px solid var(--rv-borda-suave)", verticalAlign: "top",
                 color: "var(--rv-ambar-texto)", whiteSpace: "nowrap", fontWeight: 600 },
};
