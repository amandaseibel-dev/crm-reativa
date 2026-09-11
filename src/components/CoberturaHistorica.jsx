import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

// COBERTURA HISTÓRICA — 2024/1, 2024/2, 2025/1, 2025/2.
//
// Esta visão NÃO tem percentual de efetividade, e é de propósito: nenhuma fonte
// do CRM tem registro anterior a 01/07/2026. O que existe dessas safras é o
// SALDO RESIDUAL que ainda estava aberto quando a operação começou — não a
// carteira original do semestre. Calcular efetividade sobre isso mediria o
// tempo que a carteira está conosco, não a cobrança.
//
// Mostra só o que é comprovável e diz o que falta.

const moeda = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 });
const num = (v) => Number(v || 0).toLocaleString("pt-BR");
const data = (v) => (v ? new Date(v + "T12:00:00").toLocaleDateString("pt-BR") : "—");

export default function CoberturaHistorica({ safra }) {
  const [safras, setSafras] = useState(null);
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let ativo = true;
    (async () => {
      const { data: r, error } = await supabase.rpc("carteira_cobertura_historica");
      if (!ativo) return;
      if (error) setErro(error.message);
      else setSafras(r?.safras || []);
      setCarregando(false);
    })();
    return () => { ativo = false; };
  }, []);

  if (carregando) return <p style={S.discreto}>Carregando…</p>;
  if (erro) return <p style={{ ...S.discreto, color: "#b4232a" }}>{erro}</p>;

  const d = (safras || []).find((x) => x.safra === safra);
  if (!d) return <p style={S.discreto}>Sem dados para {safra}.</p>;

  return (
    <div>
      <div style={{ marginTop: 4 }}>
        <h2 style={{ fontSize: 20, margin: 0 }}>Cobertura histórica · {safra}</h2>
        <p style={{ margin: "4px 0 0", color: "var(--rv-texto-suave)", fontSize: 13 }}>
          Saldo residual recebido em cobrança e conversões comprovadas desde julho de 2026
        </p>
      </div>

      <div style={{ ...S.aviso, marginTop: 14 }}>
        O CRM possui histórico estruturado a partir de <strong>julho de 2026</strong>. Para 2024 e 2025, esta visão
        representa o <strong>saldo residual recebido em cobrança</strong> e as conversões comprovadas desde então.
        <strong> Não representa a efetividade total original desses semestres.</strong>
      </div>

      {/* CARTEIRA RESIDUAL */}
      <section style={{ ...S.cartao, marginTop: 18 }}>
        <span style={S.rotulo}>Carteira residual recebida em cobrança</span>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}>
          <strong style={{ fontSize: 30, letterSpacing: "-0.5px" }}>{moeda(d.valor_original)}</strong>
          <span style={{ color: "var(--rv-texto-suave)", fontSize: 13 }}>
            {num(d.titulos)} títulos · {num(d.cpfs)} CPFs · entrada de {data(d.entrada_de)} a {data(d.entrada_ate)}
          </span>
        </div>
      </section>

      {/* TRÊS BLOCOS */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 14, marginTop: 14 }}>
        <div style={{ ...S.cartao, borderLeft: "4px solid #2563eb" }}>
          <span style={S.rotulo}>Negociado comprovado</span>
          <strong style={{ fontSize: 24 }}>{moeda(d.negociado)}</strong>
          <span style={S.sub}>desde julho de 2026</span>
        </div>
        <div style={{ ...S.cartao, borderLeft: "4px solid #1f7a3d" }}>
          <span style={S.rotulo}>Recebido comprovado</span>
          <strong style={{ fontSize: 24 }}>{moeda(d.recebido)}</strong>
          <span style={S.sub}>desde julho de 2026</span>
        </div>
        <div style={{ ...S.cartao, borderLeft: "4px solid #b4232a" }}>
          <span style={S.rotulo}>Ainda aberto no Prime</span>
          <strong style={{ fontSize: 24 }}>{moeda(d.abertos_valor)}</strong>
          <span style={S.sub}>{num(d.abertos_titulos)} títulos confirmados abertos</span>
        </div>
      </div>

      {Number(d.sem_linha_prime) > 0 ? (
        <p style={{ ...S.discreto, marginTop: 12 }}>
          {num(d.sem_linha_prime)} título(s) desta safra não têm linha correspondente no Prime — a situação atual deles
          não pôde ser confirmada.
        </p>
      ) : null}
    </div>
  );
}

const S = {
  cartao: {
    background: "var(--rv-fundo-cartao)",
    border: "1px solid var(--rv-borda-suave)",
    borderRadius: 12,
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 4,
    color: "var(--rv-tinta)",
  },
  aviso: {
    background: "var(--rv-fundo-suave)",
    border: "1px solid var(--rv-borda-suave)",
    borderRadius: 10,
    padding: "12px 14px",
    color: "var(--rv-texto-suave)",
    fontSize: 12.5,
    lineHeight: 1.55,
  },
  rotulo: {
    fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em",
    color: "var(--rv-texto-fraco)", fontWeight: 700,
  },
  sub: { fontSize: 12, color: "var(--rv-texto-suave)" },
  discreto: { fontSize: 12.5, color: "var(--rv-texto-fraco)" },
};
