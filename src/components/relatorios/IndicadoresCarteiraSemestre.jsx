import { useEffect, useState } from "react";
import { supabase } from "../../services/supabase";

// Indicadores de carteira do semestre, lidos das RPCs oficiais. Nenhuma regra
// financeira é recalculada aqui: o componente lê, soma o que já vem pronto e
// calcula o percentual com a MESMA regra nos dois semestres:
//
//   Recuperado em pagamentos ÷ Entrou na carteira
//
// Negociado NÃO é recebimento: é um indicador separado e nunca entra na conta.
//
// Fontes:
//  - 2026/1 (fotografia de efetividade): entrou = situacoes.entrou; recuperado =
//    situacoes.pago (pagamentos da carteira).
//  - 2026/2 (ao vivo): entrou = carteira_2026_2_contexto.carteira_valor
//    (valor original da carteira do semestre); recuperado = recebido dos acordos
//    de 2026/2 (carteira_2026_2_negociacoes). Ver a ressalva na tela: é só a
//    parcela recebida por acordo, não todo pagamento da carteira.

const BRL = (v) => (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const NUM = (v) => (Number(v) || 0).toLocaleString("pt-BR");
const PCT = (parte, todo) => (Number(todo) ? ((Number(parte) || 0) / Number(todo) * 100).toFixed(1).replace(".", ",") + "%" : "—");

async function lerEfetividade(ano, semestre) {
  const [seis, comp] = await Promise.all([
    supabase.rpc("carteira_efetividade_ler", { p_bloco: "seis_linhas", p_ano: ano, p_semestre: semestre }),
    supabase.rpc("carteira_efetividade_ler", { p_bloco: "composicao_academica", p_ano: ano, p_semestre: semestre }),
  ]);
  if (seis.error) throw seis.error;
  if (comp.error) throw comp.error;
  const s = seis.data?.situacoes;
  if (!s) return null;
  const oficial = comp.data && !comp.data.sem_snapshot && comp.data.total ? comp.data.total : null;
  return {
    tipo: "efetividade",
    entrou: Number(s.entrou?.valor || 0),
    alunosEntrou: s.entrou?.alunos,
    titulosEntrou: s.entrou?.titulos,
    recuperado: Number(s.pago?.valor || 0),
    negociado: Number(s.negociado?.valor || 0),
    emAberto: oficial ? Number(oficial.valor || 0) : null,
    alunosEmAberto: oficial?.alunos,
    titulosEmAberto: oficial?.titulos,
    fotografia: seis.data?.snapshot?.gerado_em || null,
  };
}

async function lerNegociacoes() {
  const [neg, ctx] = await Promise.all([
    supabase.rpc("carteira_2026_2_negociacoes"),
    supabase.rpc("carteira_2026_2_contexto"),
  ]);
  if (neg.error) throw neg.error;
  if (ctx.error) throw ctx.error;
  const t = neg.data?.total;
  if (!t) return null;
  return {
    tipo: "negociacoes",
    entrou: Number(ctx.data?.carteira_valor || 0),
    titulosEntrou: ctx.data?.carteira_titulos,
    alunosEntrou: ctx.data?.carteira_cpfs,
    recuperado: Number(t.recebido || 0),
    negociado: Number(t.negociado || 0),
    saldoNegociado: Number(t.saldo || 0),
    acordos: t.acordos,
    fotografia: ctx.data?.atualizado_em || null,
  };
}

export default function IndicadoresCarteiraSemestre({ fonte }) {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let ativo = true;
    setCarregando(true);
    setErro("");
    setDados(null);
    const busca = fonte.tipo === "efetividade"
      ? lerEfetividade(fonte.ano, fonte.semestre)
      : lerNegociacoes();
    busca
      .then((d) => { if (ativo) setDados(d); })
      .catch((e) => { if (ativo) setErro(e?.message || "Falha ao consultar os indicadores de carteira."); })
      .finally(() => { if (ativo) setCarregando(false); });
    return () => { ativo = false; };
  }, [fonte.tipo, fonte.ano, fonte.semestre]);

  if (carregando) return <Bloco><p style={textoSuave}>Carregando indicadores de carteira…</p></Bloco>;
  if (erro) return <Bloco><p style={{ color: "var(--rv-vermelho-texto)", margin: 0 }}>{erro}</p></Bloco>;
  if (!dados) return <Bloco><p style={textoSuave}>Sem fotografia de carteira para este semestre ainda.</p></Bloco>;

  const principais = [
    { rotulo: "Entrou na carteira", valor: BRL(dados.entrou),
      apoio: NUM(dados.alunosEntrou) + " alunos · " + NUM(dados.titulosEntrou) + " títulos" },
    { rotulo: "Recuperado em pagamentos", valor: BRL(dados.recuperado),
      apoio: PCT(dados.recuperado, dados.entrou) + " de entrou na carteira" },
  ];

  const secundarios = dados.tipo === "efetividade"
    ? [
        { rotulo: "Negociado", valor: BRL(dados.negociado), apoio: "ainda não é recebimento" },
        { rotulo: "Em aberto (oficial)", valor: dados.emAberto == null ? "—" : BRL(dados.emAberto),
          apoio: dados.emAberto == null ? "sem fotografia oficial" : NUM(dados.alunosEmAberto) + " alunos · " + NUM(dados.titulosEmAberto) + " títulos" },
      ]
    : [
        { rotulo: "Negociado", valor: BRL(dados.negociado), apoio: NUM(dados.acordos) + " acordos" },
        { rotulo: "Saldo negociado a receber", valor: BRL(dados.saldoNegociado), apoio: "ainda a receber" },
      ];

  const nota = dados.tipo === "efetividade"
    ? "Fotografia de efetividade (" + (dados.fotografia ? new Date(dados.fotografia).toLocaleString("pt-BR") : "sem data") + "). Entrou, recuperado, negociado e em aberto são indicadores separados: não se somam entre si."
    : "2026/2 ao vivo (" + (dados.fotografia ? new Date(dados.fotografia).toLocaleString("pt-BR") : "sem data") + "). Em 2026/2, o recuperado é só o recebido dos acordos do semestre; pagamentos de títulos fora de acordo ainda não entram nesta visão.";

  return (
    <Bloco>
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 10px" }}>Indicadores de carteira</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12 }}>
        {principais.map((c) => <Cartao key={c.rotulo} {...c} destaque />)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12, marginTop: 12 }}>
        {secundarios.map((c) => <Cartao key={c.rotulo} {...c} />)}
      </div>
      <p style={{ ...textoSuave, fontSize: 12, marginTop: 8, marginBottom: 0 }}>{nota}</p>
    </Bloco>
  );
}

function Cartao({ rotulo, valor, apoio, destaque }) {
  return (
    <div style={{ border: "1px solid var(--rv-borda)", borderRadius: 10, padding: "12px 14px", background: destaque ? "var(--rv-fundo-suave)" : "transparent" }}>
      <div style={{ fontSize: 12, color: "var(--rv-texto-suave)" }}>{rotulo}</div>
      <div style={{ fontSize: destaque ? 22 : 20, fontWeight: 700 }}>{valor}</div>
      <div style={{ fontSize: 12, color: "var(--rv-texto-suave)" }}>{apoio}</div>
    </div>
  );
}

function Bloco({ children }) {
  return <section style={{ marginTop: 18 }}>{children}</section>;
}

const textoSuave = { color: "var(--rv-texto-suave)", margin: 0 };
