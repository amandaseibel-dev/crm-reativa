import { useEffect, useState } from "react";
import { supabase } from "../../services/supabase";

// Indicadores de carteira do semestre, lidos das MESMAS RPCs oficiais que a
// visão de Carteira usa. Nenhuma regra financeira é recalculada aqui: o
// componente só lê, soma o que já vem pronto e calcula o percentual declarado.
//
// Dois caminhos, conforme o semestre (ver configSemestres.js):
//  - "efetividade": 2026/1 consolidado. Saldo original recebido na carteira,
//    recuperado (pago), negociado e saldo em aberto (régua oficial da
//    composição). Percentual = recuperado ÷ saldo original recebido.
//  - "negociacoes": 2026/2 vigente. Só o que já foi negociado e quanto já foi
//    recebido. Percentual = recebido ÷ negociado. O universo de 2026/2 ainda
//    está em formação, então não há saldo original medido nesta visão.
//
// Negociado NÃO é recebido: são indicadores separados e nunca somados entre si.

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
    saldoOriginal: Number(s.entrou?.valor || 0),
    alunos: s.entrou?.alunos,
    titulos: s.entrou?.titulos,
    recuperado: Number(s.pago?.valor || 0),
    negociado: Number(s.negociado?.valor || 0),
    emAberto: oficial ? Number(oficial.valor || 0) : null,
    alunosEmAberto: oficial?.alunos,
    titulosEmAberto: oficial?.titulos,
  };
}

async function lerNegociacoes() {
  const { data, error } = await supabase.rpc("carteira_2026_2_negociacoes");
  if (error) throw error;
  const t = data?.total;
  if (!t) return null;
  return {
    tipo: "negociacoes",
    negociado: Number(t.negociado || 0),
    recebido: Number(t.recebido || 0),
    saldo: Number(t.saldo || 0),
    cpfs: t.cpfs,
    acordos: t.acordos,
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

  if (dados.tipo === "efetividade") {
    const cards = [
      { rotulo: "Saldo original recebido na carteira", valor: BRL(dados.saldoOriginal),
        apoio: NUM(dados.alunos) + " alunos · " + NUM(dados.titulos) + " títulos" },
      { rotulo: "Valor recuperado (pago)", valor: BRL(dados.recuperado),
        apoio: PCT(dados.recuperado, dados.saldoOriginal) + " do saldo original" },
      { rotulo: "Valor negociado", valor: BRL(dados.negociado),
        apoio: "ainda não é recebimento" },
      { rotulo: "Saldo em aberto", valor: dados.emAberto == null ? "—" : BRL(dados.emAberto),
        apoio: dados.emAberto == null ? "sem fotografia oficial" : NUM(dados.alunosEmAberto) + " alunos · " + NUM(dados.titulosEmAberto) + " títulos" },
      { rotulo: "Percentual de recuperação", valor: PCT(dados.recuperado, dados.saldoOriginal),
        apoio: "recuperado ÷ saldo original recebido" },
    ];
    return <Grade titulo="Indicadores de carteira" cards={cards} nota="Recuperado, negociado e saldo em aberto são indicadores separados: não se somam entre si." />;
  }

  const cards = [
    { rotulo: "Valor negociado", valor: BRL(dados.negociado),
      apoio: NUM(dados.cpfs) + " alunos · " + NUM(dados.acordos) + " acordos" },
    { rotulo: "Valor recebido", valor: BRL(dados.recebido),
      apoio: "de acordos já pagos em parte" },
    { rotulo: "Saldo negociado a receber", valor: BRL(dados.saldo),
      apoio: "ainda a receber" },
    { rotulo: "Percentual de recuperação", valor: PCT(dados.recebido, dados.negociado),
      apoio: "recebido ÷ negociado" },
  ];
  return <Grade titulo="Indicadores de carteira (negociações do semestre vigente)" cards={cards}
    nota="2026/2 está em andamento: o saldo original da carteira ainda não é medido nesta visão. O percentual é sobre o negociado, não sobre a carteira inteira." />;
}

function Grade({ titulo, cards, nota }) {
  return (
    <Bloco>
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 10px" }}>{titulo}</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
        {cards.map((c) => (
          <div key={c.rotulo} style={{ border: "1px solid var(--rv-borda)", borderRadius: 10, padding: "12px 14px" }}>
            <div style={{ fontSize: 12, color: "var(--rv-texto-suave)" }}>{c.rotulo}</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{c.valor}</div>
            <div style={{ fontSize: 12, color: "var(--rv-texto-suave)" }}>{c.apoio}</div>
          </div>
        ))}
      </div>
      <p style={{ ...textoSuave, fontSize: 12, marginTop: 8, marginBottom: 0 }}>{nota}</p>
    </Bloco>
  );
}

function Bloco({ children }) {
  return <section style={{ marginTop: 18 }}>{children}</section>;
}

const textoSuave = { color: "var(--rv-texto-suave)", margin: 0 };
