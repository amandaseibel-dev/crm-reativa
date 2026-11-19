import { useEffect, useState } from "react";
import { supabase } from "../../services/supabase";

// Indicadores de carteira do semestre. ÚNICO contrato: a RPC
// `efetividade_caixa_resumo_semestre` (PR #966). Este componente só lê e exibe.
// Nenhuma regra financeira, percentual ou soma é calculada aqui.
//
// Negociado NÃO é recebido. Caixa confirmado é o pagamento provado e baixado.
// Pendente de classificação fica separado e visível. Dado indisponível aparece
// como "—", nunca como R$ 0,00.

const BRL = (v) => (v == null ? "—" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
const NUM = (v) => (v == null ? "—" : Number(v).toLocaleString("pt-BR"));
const PCT = (v) => (v == null ? "—" : String(v).replace(".", ",") + "%");

export default function IndicadoresCarteiraSemestre({ fonte }) {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let ativo = true;
    setCarregando(true);
    setErro("");
    setDados(null);
    supabase.rpc("efetividade_caixa_resumo_semestre", { p_semestre: fonte.semestre })
      .then(({ data, error }) => {
        if (!ativo) return;
        if (error) setErro("indisponível");
        else setDados(data || null);
      })
      .catch(() => { if (ativo) setErro("indisponível"); })
      .finally(() => { if (ativo) setCarregando(false); });
    return () => { ativo = false; };
  }, [fonte.semestre]);

  if (carregando) return <Bloco><p style={textoSuave}>Carregando indicadores de carteira…</p></Bloco>;
  if (erro) {
    return <Bloco><p style={textoSuave}>
      Indicadores de carteira indisponíveis para o seu acesso ou no momento.
    </p></Bloco>;
  }
  if (!dados) return <Bloco><p style={textoSuave}>Sem dados de carteira para este semestre.</p></Bloco>;

  const s2 = dados.saldo_2026_2 || null;
  const cards = [
    { rotulo: "Carteira original", valor: BRL(dados.carteira_original),
      apoio: NUM(dados.titulos_carteira) + " títulos" },
    { rotulo: "Saldo em aberto", valor: BRL(dados.saldo_em_aberto),
      apoio: s2?.saldo_em_conferencia != null
        ? "inclui " + BRL(s2.saldo_em_conferencia) + " em conferência" : "fonte: " + (dados.carteira_fonte || "—") },
    { rotulo: dados.negociado_definicao || "Negociado", valor: BRL(dados.negociado),
      apoio: "ainda não é recebimento · não comparável entre semestres" },
    { rotulo: "Caixa confirmado", valor: BRL(dados.caixa_confirmado),
      apoio: NUM(dados.pagamentos_confirmados) + " pagamentos provados e baixados" },
    { rotulo: "% recuperado por caixa", valor: PCT(dados.percentual_recuperado_caixa),
      apoio: "caixa identificado ÷ carteira original" },
    { rotulo: "Pendente de classificação", valor: BRL(dados.pendente_classificacao),
      apoio: NUM(dados.pagamentos_pendentes) + " pagamentos, fora do caixa" },
  ];
  return (
    <Bloco>
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 10px" }}>Indicadores de carteira — {fonte.semestre}</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
        {cards.map((c) => (
          <div key={c.rotulo} style={{ border: "1px solid var(--rv-borda)", borderRadius: 10, padding: "12px 14px" }}>
            <div style={{ fontSize: 12, color: "var(--rv-texto-suave)" }}>{c.rotulo}</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{c.valor}</div>
            <div style={{ fontSize: 12, color: "var(--rv-texto-suave)" }}>{c.apoio}</div>
          </div>
        ))}
      </div>
      <p style={{ ...textoSuave, fontSize: 12, marginTop: 8, marginBottom: 0 }}>
        Percentual é recuperação por caixa confirmado identificado, não recuperação total. Os valores não se somam entre si.
        Base da carteira original: {dados.base_carteira || "—"}.
        Data de referência: {dados.data_referencia || "—"}.
      </p>
      {dados.fotografia_atualizacao_pendente ? (
        <p style={{ fontSize: 12, marginTop: 6, marginBottom: 0, color: "var(--rv-ambar-texto)" }}>
          A fotografia de carteira deste semestre tem atualização pendente: carteira, saldo e negociado podem estar
          defasados. Gerada em {dados.fotografia_gerada_em || "—"}. O caixa confirmado é lido na hora.
        </p>
      ) : null}
    </Bloco>
  );
}

function Bloco({ children }) {
  return <section style={{ marginTop: 18 }}>{children}</section>;
}

const textoSuave = { color: "var(--rv-texto-suave)", margin: 0 };
