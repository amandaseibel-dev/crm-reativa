import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

function formatarData(data) {
  if (!data) return "-";
  return new Date(data + "T00:00:00").toLocaleDateString("pt-BR");
}

function moeda(valor) {
  if (valor == null) return "-";
  return Number(valor).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatarDataSimples(data) {
  if (!data) return "-";
  try {
    const partes = String(data).slice(0, 10).split("-");
    if (partes.length === 3) {
      const [ano, mes, dia] = partes;
      return `${dia}/${mes}/${ano}`;
    }
    return new Date(data).toLocaleDateString("pt-BR");
  } catch {
    return "-";
  }
}

const STATUS_PARCELA_LABEL = {
  A_VENCER: "A vencer",
  VENCIDA: "Vencida",
  PAGO: "Paga",
};

export default function FinanceiroAluno({ aluno }) {
  const [titulos, setTitulos] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [acordos, setAcordos] = useState([]);
  const [parcelasPorAcordo, setParcelasPorAcordo] = useState({});

  useEffect(() => {
    if (!aluno?.cpf) {
      setTitulos([]);
      setCarregando(false);
      return;
    }

    async function carregar() {
      setCarregando(true);
      const { data } = await supabase
        .from("acordos_titulos")
        .select("documento, vencimento, valor_original, saldo_corrigido, situacao, tipo_boleto")
        .eq("cpf", aluno.cpf)
        .order("vencimento", { ascending: true });

      setTitulos(data || []);
      setCarregando(false);
    }

    carregar();
  }, [aluno?.cpf]);

  useEffect(() => {
    if (!aluno?.id) {
      setAcordos([]);
      setParcelasPorAcordo({});
      return;
    }

    async function carregarAcordos() {
      const { data: acordosData } = await supabase
        .from("acordos")
        .select("*")
        .eq("aluno_id", String(aluno.id))
        .order("criado_em", { ascending: false });

      setAcordos(acordosData || []);

      if (acordosData && acordosData.length > 0) {
        const ids = acordosData.map((a) => a.id);
        const { data: parcelasData } = await supabase
          .from("parcelas")
          .select("*")
          .in("acordo_id", ids)
          .order("numero", { ascending: true });

        const agrupado = {};
        (parcelasData || []).forEach((p) => {
          if (!agrupado[p.acordo_id]) agrupado[p.acordo_id] = [];
          agrupado[p.acordo_id].push(p);
        });
        setParcelasPorAcordo(agrupado);
      } else {
        setParcelasPorAcordo({});
      }
    }

    carregarAcordos();
  }, [aluno?.id]);

  if (carregando) return null;

  if (titulos.length === 0) {
    return (
      <>
        <div style={estilos.caixa}>
          <strong>💰 Financeiro</strong>
          <p style={{ fontSize: 12, opacity: 0.7, margin: "6px 0 0" }}>
            {aluno?.cpf
              ? `Nenhum título importado pelos borderôs para o CPF ${aluno.cpf}.`
              : "Este aluno não tem CPF cadastrado, então não dá pra casar com os borderôs."}
          </p>
        </div>
        <SecaoAcordos acordos={acordos} parcelasPorAcordo={parcelasPorAcordo} />
      </>
    );
  }

  const emAberto = titulos.filter((t) => t.situacao !== "PAGO");
  const totalEmAberto = emAberto.reduce((soma, t) => soma + Number(t.saldo_corrigido || 0), 0);

  return (
    <>
    <div style={estilos.caixa}>
      <div style={estilos.cabecalho}>
        <strong>💰 Financeiro</strong>
        {emAberto.length > 0 && (
          <span style={estilos.totalAberto}>{moeda(totalEmAberto)} em aberto</span>
        )}
      </div>

      <div style={{ marginTop: 10 }}>
        {titulos.map((titulo) => (
          <div key={titulo.documento} style={estilos.linha}>
            <div>
              <div style={{ fontSize: 13 }}>
                Título {titulo.documento}
                {titulo.tipo_boleto ? ` · ${titulo.tipo_boleto}` : ""}
              </div>
              <div style={estilos.subLinha}>Vencimento: {formatarData(titulo.vencimento)}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>
                {moeda(titulo.saldo_corrigido ?? titulo.valor_original)}
              </div>
              <span
                style={
                  titulo.situacao === "PAGO" ? estilos.tagVerde : estilos.tagAmarela
                }
              >
                {titulo.situacao === "PAGO" ? "Pago" : "Em aberto"}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
    <SecaoAcordos acordos={acordos} parcelasPorAcordo={parcelasPorAcordo} />
    </>
  );
}

function SecaoAcordos({ acordos, parcelasPorAcordo }) {
  if (!acordos || acordos.length === 0) return null;

  return (
    <div style={estilos.caixa}>
      <strong>📄 Acordos e parcelas</strong>

      <div style={{ marginTop: 10 }}>
        {acordos.map((acordo) => {
          const parcelas = parcelasPorAcordo[acordo.id] || [];

          return (
            <div key={acordo.id} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>
                {acordo.forma_pagamento === "PARCELADO"
                  ? `Parcelado em ${acordo.qtd_parcelas}x`
                  : "À vista"}{" "}
                — {moeda(acordo.valor_total)}
              </div>

              {acordo.valor_entrada ? (
                <div style={estilos.subLinha}>
                  Entrada: {moeda(acordo.valor_entrada)}
                  {acordo.entrada_paga ? " (paga)" : " (pendente)"}
                </div>
              ) : null}

              {parcelas.map((p) => (
                <div key={p.id} style={estilos.linha}>
                  <div>
                    <div style={{ fontSize: 13 }}>Parcela {p.numero}</div>
                    <div style={estilos.subLinha}>
                      Vencimento: {formatarDataSimples(p.vencimento)}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{moeda(p.valor)}</div>
                    <span style={p.status === "PAGO" ? estilos.tagVerde : estilos.tagAmarela}>
                      {STATUS_PARCELA_LABEL[p.status] || p.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const estilos = {
  caixa: {
    padding: "12px 16px",
    marginTop: 14,
    marginBottom: 14,
    borderRadius: 10,
    background: "rgba(56,189,248,0.06)",
    border: "1px solid rgba(56,189,248,0.25)",
  },
  cabecalho: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  totalAberto: {
    fontSize: 13,
    color: "#fcd34d",
    fontWeight: 700,
  },
  linha: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 0",
    borderTop: "1px solid rgba(148,163,184,0.12)",
  },
  subLinha: {
    fontSize: 11,
    opacity: 0.7,
    marginTop: 2,
  },
  tagVerde: {
    background: "rgba(34,197,94,0.16)",
    color: "#86efac",
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 999,
  },
  tagAmarela: {
    background: "rgba(251,191,36,0.16)",
    color: "#fcd34d",
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 999,
  },
};
