import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

// EFETIVIDADE 2026/2 POR MÊS DE VENCIMENTO — um cartão por mês.
//
// Nenhuma conta acontece aqui. Quem soma é `carteira_2026_2_por_vencimento()`,
// que por sua vez só agrega o classificador 2026/2 já existente. O front
// desenha o que recebe e não recompõe situação nenhuma.
//
// As seis linhas do cartão e por que Pendente fica à parte estão na própria
// migration da RPC; na tela isso aparece no rodapé, em português de gestão.

const moeda = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 });
const num = (v) => Number(v || 0).toLocaleString("pt-BR");
// "1 alunos · 1 títulos" é o tipo de detalhe que faz a diretoria desconfiar do
// resto dos números. Plural só quando é plural.
const plural = (n, um, muitos) => num(n) + " " + (Number(n) === 1 ? um : muitos);
const dataCurta = (v) =>
  v ? new Date(v.length === 10 ? v + "T12:00:00" : v).toLocaleDateString("pt-BR") : "—";

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho",
               "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
function mesPorExtenso(competencia) {
  if (!competencia) return "—";
  const d = new Date(competencia.slice(0, 10) + "T12:00:00");
  const nome = MESES[d.getMonth()];
  return nome.charAt(0).toUpperCase() + nome.slice(1) + " de " + d.getFullYear();
}

const AZUL = "var(--rv-azul)", VERDE = "var(--rv-verde-ok)", VERMELHO = "var(--rv-vermelho)",
      AMBAR = "var(--rv-ambar)", CINZA = "var(--rv-texto-suave)";

// A ordem é a da gestão: Entrou é a base do mês, as quatro situações vêm
// depois, e Pendente fecha, separado por uma linha, porque NÃO é uma quinta
// situação — é o que ainda não foi classificado.
const SITUACOES = [
  // "valor efetivamente recebido" saiu de proposito: parte do Pago de cada mes
  // vem de rateio do acordo, e o rodape diz quanto. Prometer atribuicao exata
  // onde ha rateio e o tipo de frase que derruba a confianca no painel inteiro.
  { k: "pago",      r: "Pago",      cor: VERDE,     ajuda: "recebido atribuído ao título" },
  { k: "negociado", r: "Negociado", cor: AZUL,      ajuda: "saldo ainda não pago de acordo ativo" },
  { k: "cancelado", r: "Cancelado", cor: CINZA,     ajuda: "cobrança do título cancelada" },
  { k: "em_aberto", r: "Em aberto", cor: VERMELHO,  ajuda: "saldo sem acordo ativo" },
];
const PENDENTE = { k: "pendente", r: "Pendente de classificação", cor: AMBAR,
                   ajuda: "em conferência e ajuste acadêmico, à parte de propósito" };

function vazio() { return { alunos: 0, titulos: 0, valor: 0 }; }

export default function EfetividadePorVencimento() {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let ativo = true;
    (async () => {
      const { data, error } = await supabase.rpc("carteira_2026_2_por_vencimento");
      if (!ativo) return;
      if (error) setErro(error.message); else setDados(data || null);
      setCarregando(false);
    })();
    return () => { ativo = false; };
  }, []);

  if (carregando) return <p style={S.discreto}>Somando por mês de vencimento…</p>;
  if (erro) return <p style={S.erro}>Não foi possível carregar a visão por vencimento: {erro}</p>;

  const meses = dados?.meses || [];
  if (!meses.length) return <p style={S.discreto}>Sem títulos de 2026/2.</p>;

  const total = dados?.total?.situacoes || {};
  const conferencia = dados?.conferencia || {};
  const fichas = Number(dados?.total?.fichas || 0);
  const cpfs = Number(dados?.total?.cpfs || 0);
  const naoFecha = Number(conferencia.meses_que_nao_fecham || 0) > 0;

  return (
    <section>
      <div style={S.cabecalho}>
        <h2 style={S.h2}>Por mês de vencimento</h2>
        <span style={S.apoio}>
          {meses.length} {meses.length === 1 ? "mês" : "meses"} · vencimentos de{" "}
          {dataCurta(dados?.total?.vencimento_de)} a {dataCurta(dados?.total?.vencimento_ate)}
        </span>
      </div>

      {/* A invariante é medida a cada chamada. Enquanto fecha, a tela diz isso
          em uma linha; se um dia não fechar, o aviso sobe em vermelho e nenhum
          número é corrigido por conta própria. */}
      {naoFecha ? (
        <p style={S.erro}>
          ⚠️ {num(conferencia.meses_que_nao_fecham)}{" "}
          {Number(conferencia.meses_que_nao_fecham) === 1 ? "mês não fecha" : "meses não fecham"}: a soma das
          situações difere de Entrou em {moeda(conferencia.diferenca_total)}. Os números abaixo estão como vieram
          do classificador — nada foi ajustado para fechar.
        </p>
      ) : null}

      <div style={S.grade}>
        {meses.map((m) => (
          <Cartao key={m.competencia} mes={m} />
        ))}
      </div>

      <div style={{ ...S.cartao, marginTop: 16 }}>
        <div style={S.cartaoTopo}>
          <strong style={S.mesNome}>Todos os meses</strong>
          <span style={S.mesApoio}>2026/2 inteiro</span>
        </div>
        <Corpo s={total} composicao={dados?.pago_composicao} />
      </div>

      <p style={S.rodape}>
        <strong>O que é “atribuído diretamente” e o que é “por rateio”.</strong> Atribuído diretamente é baixa
        no próprio título, ou acordo que cobre um título só — nos dois casos o dinheiro é daquele título. Por
        rateio é acordo que cobre mais de um título: o valor é dividido entre eles pela proporção de parcelas
        pagas do acordo, que é o critério já existente no CRM. Como um acordo pode cobrir títulos de meses
        diferentes, essa parte do Pago pode ter vindo do mês vizinho. Os dois somam o Pago do mês.
      </p>
      {fichas && cpfs && fichas !== cpfs ? (
        <p style={S.rodape}>
          <strong>Duas unidades de contagem, as duas corretas.</strong> Os cartões contam{" "}
          <strong>fichas do CRM</strong> ({num(fichas)}), que é o registro que a operação trabalha. A linha
          “Carteira recebida”, acima, conta <strong>CPFs únicos</strong> ({num(cpfs)}). A diferença são CPFs
          com mais de uma ficha — não é divergência de cálculo, e nenhum cadastro foi alterado para os dois
          números coincidirem.
        </p>
      ) : null}
      <p style={S.rodape}>
        <strong>Um aluno pode aparecer em mais de uma situação</strong> — basta ter títulos em situações
        diferentes, no mesmo mês ou em meses diferentes. As contagens de alunos{" "}
        <strong>não devem ser somadas</strong>: nem entre situações, nem entre meses. Só títulos e valores somam.
      </p>
      <p style={S.rodape}>
        <strong>Saldo:</strong> {dados?.saldo_metodo}
      </p>
      <p style={S.rodape}>
        Situação do Prime coletada em {dataCurta(dados?.atualizado_em?.prime_coletado_em)} · último movimento em
        título em {dataCurta(dados?.atualizado_em?.titulo_mexido_em)}.
      </p>
    </section>
  );
}

function Cartao({ mes }) {
  const de = dataCurta(mes.vencimento_de), ate = dataCurta(mes.vencimento_ate);
  return (
    <div style={S.cartao}>
      <div style={S.cartaoTopo}>
        <strong style={S.mesNome}>{mesPorExtenso(mes.competencia)}</strong>
        <span style={S.mesApoio}>
          {de === ate ? "vence em " + de : "vence de " + de + " a " + ate}
          {Number(mes.datas_de_vencimento) > 1 ? " · " + num(mes.datas_de_vencimento) + " datas" : ""}
        </span>
      </div>
      <Corpo s={mes.situacoes || {}} composicao={mes.pago_composicao} />
      <Status lista={mes.status || []} />
    </div>
  );
}

// Entrou é a régua do cartão: é o 100% das barras e o denominador dos
// percentuais. Por isso ele vem inteiro em cima, e não como mais uma linha.
function Corpo({ s, composicao }) {
  const entrou = s.entrou || vazio();
  const base = Number(entrou.valor || 0);
  return (
    <>
      <div style={S.entrou}>
        <span style={S.entrouRotulo}>Entrou</span>
        <strong style={S.entrouValor}>{moeda(entrou.valor)}</strong>
        <span style={S.entrouApoio}>
          {plural(entrou.alunos, "aluno", "alunos")} · {plural(entrou.titulos, "título", "títulos")}
        </span>
      </div>
      <div>
        {SITUACOES.map((c) => (
          <Linha key={c.k} cfg={c} d={s[c.k] || vazio()} base={base}
                 composicao={c.k === "pago" ? composicao : null} />
        ))}
      </div>
      <div style={S.separador} />
      <Linha cfg={PENDENTE} d={s.pendente || vazio()} base={base} />
    </>
  );
}

function Linha({ cfg, d, base, composicao }) {
  const valor = Number(d.valor || 0);
  const share = base > 0 ? (valor / base) * 100 : 0;
  return (
    <div style={S.linha}>
      <div style={S.linhaTopo}>
        <span style={S.linhaRotulo}>
          <span style={{ ...S.ponto, background: cfg.cor }} aria-hidden="true" />{cfg.r}
        </span>
        <strong style={S.linhaValor}>{moeda(valor)}</strong>
        <span style={{ ...S.linhaPct, color: cfg.cor }}>
          {share.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%
        </span>
      </div>
      <span style={S.linhaApoio}>
        {plural(d.alunos, "aluno", "alunos")} · {plural(d.titulos, "título", "títulos")} · {cfg.ajuda}
      </span>
      {/* Um total principal de Pago; a composição fica DENTRO da linha, nunca
          como uma segunda métrica ao lado. Rateado não é pagamento
          identificado naquele título, e a tela diz isso com todas as letras. */}
      {composicao ? (
        <span style={S.composicao}>
          <span>Atribuído diretamente: <strong>{moeda(composicao.atribuido)}</strong></span>
          <span>Por rateio: <strong>{moeda(composicao.rateado)}</strong></span>
        </span>
      ) : null}
      <div style={S.trilho}>
        <div style={{ ...S.barra, width: Math.min(share, 100) + "%",
                      minWidth: valor > 0 ? 4 : 0, background: cfg.cor }} />
      </div>
    </div>
  );
}

// Abaixo dos números: quantos ALUNOS estão em cada status do título — o rótulo
// que o classificador já dá a cada título (`sub_faixa`), não uma etiqueta nova.
function Status({ lista }) {
  if (!lista.length) return null;
  return (
    <div style={S.statusBloco}>
      <span style={S.statusTitulo}>Alunos por status</span>
      <ul style={S.statusLista}>
        {lista.map((s) => (
          <li key={s.status} style={S.statusItem}>
            <span style={S.statusNome}>{s.status}</span>
            <span style={S.statusQtd}>{num(s.alunos)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const S = {
  cabecalho: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12,
               flexWrap: "wrap", marginBottom: 12 },
  h2: { margin: 0, fontSize: 12.5, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
        color: "var(--rv-texto-fraco)" },
  apoio: { fontSize: 12, color: "var(--rv-texto-fraco)", fontVariantNumeric: "tabular-nums" },

  // auto-fit com mínimo de 320px: em telas largas os meses ficam lado a lado e
  // em 375px cada cartão ocupa a largura inteira, sem rolagem horizontal.
  grade: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 },

  cartao: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)", borderRadius: 16,
            padding: "16px 18px 18px", boxShadow: "var(--rv-sombra)", display: "flex", flexDirection: "column" },
  cartaoTopo: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10,
                flexWrap: "wrap", paddingBottom: 10, borderBottom: "1px solid var(--rv-borda-suave)" },
  mesNome: { fontSize: 16, fontWeight: 800, letterSpacing: "-0.01em",
             fontFamily: "'Sora', Inter, sans-serif" },
  mesApoio: { fontSize: 11.5, color: "var(--rv-texto-fraco)", fontVariantNumeric: "tabular-nums" },

  entrou: { display: "flex", flexDirection: "column", gap: 2, padding: "12px 0 10px" },
  entrouRotulo: { fontSize: 11.5, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
                  color: "var(--rv-texto-fraco)" },
  entrouValor: { fontSize: 24, fontWeight: 800, lineHeight: 1.1, letterSpacing: "-0.03em",
                 fontFamily: "'Sora', Inter, sans-serif", fontVariantNumeric: "tabular-nums" },
  entrouApoio: { fontSize: 12, color: "var(--rv-texto-suave)", fontVariantNumeric: "tabular-nums" },

  linha: { padding: "9px 0" },
  linhaTopo: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto", alignItems: "baseline",
               columnGap: 10 },
  linhaRotulo: { fontSize: 13.5, fontWeight: 600, minWidth: 0 },
  linhaValor: { fontSize: 13.5, fontWeight: 700, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
  linhaPct: { fontSize: 13, fontWeight: 700, minWidth: 52, textAlign: "right",
              fontVariantNumeric: "tabular-nums" },
  linhaApoio: { display: "block", fontSize: 11.5, color: "var(--rv-texto-fraco)", marginTop: 3,
                fontVariantNumeric: "tabular-nums" },
  ponto: { display: "inline-block", width: 9, height: 9, borderRadius: 3, marginRight: 8 },
  trilho: { background: "var(--rv-fundo-suave)", borderRadius: 999, height: 6, overflow: "hidden", marginTop: 7 },
  barra: { height: "100%", borderRadius: 999 },
  separador: { height: 1, background: "var(--rv-borda-suave)", margin: "4px 0" },

  statusBloco: { marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--rv-borda-suave)" },
  statusTitulo: { fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
                  color: "var(--rv-texto-fraco)" },
  statusLista: { listStyle: "none", margin: "8px 0 0", padding: 0, display: "flex",
                 flexDirection: "column", gap: 4 },
  statusItem: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10,
                fontSize: 12.5 },
  statusNome: { color: "var(--rv-texto-suave)", minWidth: 0 },
  statusQtd: { fontWeight: 700, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },

  composicao: { display: "flex", flexWrap: "wrap", columnGap: 14, rowGap: 2, marginTop: 4,
                fontSize: 11.5, color: "var(--rv-texto-suave)", fontVariantNumeric: "tabular-nums" },

  rodape: { fontSize: 12, color: "var(--rv-texto-fraco)", lineHeight: 1.6, margin: "12px 0 0" },
  discreto: { fontSize: 12.5, color: "var(--rv-texto-fraco)", lineHeight: 1.6 },
  erro: { color: "var(--rv-vermelho-texto)", fontSize: 13, margin: "10px 0" },
};
