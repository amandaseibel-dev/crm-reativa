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

// Cores por status (alinhado com a Visao Financeira: azul=em aberto, verde=em dia,
// ambar=atraso, vermelho=quebrado, teal=quitado)
const CORES_STATUS = {
  em_aberto: { barra: "#185FA5", bg: "rgba(24,95,165,0.16)", texto: "#7cb5f0", label: "Em aberto" },
  em_dia: { barra: "#639922", bg: "rgba(99,153,34,0.18)", texto: "#a3d15f", label: "Em dia" },
  atraso: { barra: "#EF9F27", bg: "rgba(239,159,39,0.18)", texto: "#f2c67a", label: "Em atraso" },
  quebrado: { barra: "#E24B4A", bg: "rgba(226,75,74,0.18)", texto: "#f0999a", label: "Quebrado" },
  quitado: { barra: "#1D9E75", bg: "rgba(29,158,117,0.18)", texto: "#6fd7b6", label: "Quitado" },
};

function diasAtraso(venc) {
  if (!venc) return -9999;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  return Math.floor((hoje - new Date(String(venc).slice(0, 10) + "T00:00:00")) / 86400000);
}

// Deriva o status do acordo a partir das parcelas (nao muda nada no banco)
function statusAcordo(acordo, parcelas) {
  if (acordo?.status === "QUITADO" || (parcelas.length > 0 && parcelas.every((p) => p.status === "PAGO"))) {
    return "quitado";
  }
  let maiorAtraso = -9999;
  let algumaPaga = false;
  let algumaVencida = false;
  parcelas.forEach((p) => {
    if (p.status === "PAGO") {
      algumaPaga = true;
      return;
    }
    const dl = diasAtraso(p.vencimento);
    if (dl > 0) {
      algumaVencida = true;
      if (dl > maiorAtraso) maiorAtraso = dl;
    }
  });
  if (maiorAtraso > 30) return "quebrado";
  if (algumaVencida) return "atraso";
  if (algumaPaga) return "em_dia";
  return "em_aberto";
}

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

  const emAberto = titulos.filter((t) => t.situacao !== "PAGO");
  const totalTitulosAberto = emAberto.reduce(
    (soma, t) => soma + Number(t.saldo_corrigido ?? t.valor_original ?? 0),
    0
  );

  const todasParcelas = Object.values(parcelasPorAcordo).flat();
  const parcelasEmAberto = todasParcelas.filter((p) => p.status !== "PAGO");
  const totalParcelasAberto = parcelasEmAberto.reduce((soma, p) => soma + Number(p.valor || 0), 0);

  const totalGeralAberto = totalTitulosAberto + totalParcelasAberto;
  const temAlgumValor = titulos.length > 0 || acordos.length > 0;

  return (
    <>
      {temAlgumValor && (
        <div style={estilos.caixaResumo}>
          <strong>💰 Total em aberto do aluno</strong>
          <span style={estilos.totalGeral}>{moeda(totalGeralAberto)}</span>
        </div>
      )}

      {titulos.length === 0 ? (
        <div style={estilos.caixa}>
          <strong>💰 Financeiro</strong>
          <p style={{ fontSize: 12, opacity: 0.7, margin: "6px 0 0" }}>
            {aluno?.cpf
              ? `Nenhum título importado pelos borderôs para o CPF ${aluno.cpf}.`
              : "Este aluno não tem CPF cadastrado, então não dá pra casar com os borderôs."}
          </p>
        </div>
      ) : (
        <div style={estilos.caixa}>
          <div style={estilos.cabecalho}>
            <strong>💰 Financeiro (borderôs)</strong>
            {emAberto.length > 0 && (
              <span style={estilos.totalAberto}>{moeda(totalTitulosAberto)} em aberto</span>
            )}
          </div>

          <div style={{ marginTop: 10 }}>
            {titulos.map((titulo) => {
              const pago = titulo.situacao === "PAGO";
              const vencida = !pago && diasAtraso(titulo.vencimento) > 0;
              const cor = pago ? CORES_STATUS.quitado : CORES_STATUS.em_aberto;
              return (
                <div
                  key={titulo.documento}
                  style={{ ...estilos.linha, borderLeft: `3px solid ${cor.barra}`, paddingLeft: 8 }}
                >
                  <div>
                    <div style={{ fontSize: 13 }}>
                      Título {titulo.documento}
                      {titulo.tipo_boleto ? ` · ${titulo.tipo_boleto}` : ""}
                    </div>
                    <div style={estilos.subLinha}>
                      Vencimento: {formatarData(titulo.vencimento)}
                      {vencida ? <span style={estilos.marcaVencida}>• vencida</span> : null}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>
                      {moeda(titulo.saldo_corrigido ?? titulo.valor_original)}
                    </div>
                    <span style={{ ...estilos.tagBase, background: cor.bg, color: cor.texto }}>
                      {pago ? "Quitada" : "Em aberto"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
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
          const totalAcordoAberto = parcelas
            .filter((p) => p.status !== "PAGO")
            .reduce((soma, p) => soma + Number(p.valor || 0), 0);
          const chave = statusAcordo(acordo, parcelas);
          const cor = CORES_STATUS[chave];

          return (
            <div
              key={acordo.id}
              style={{
                marginBottom: 14,
                borderLeft: `4px solid ${cor.barra}`,
                paddingLeft: 10,
                borderRadius: 4,
              }}
            >
              <div style={estilos.cabecalho}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>
                    {acordo.forma_pagamento === "PARCELADO"
                      ? `Parcelado em ${acordo.qtd_parcelas}x`
                      : acordo.forma_pagamento === "cartao"
                      ? `Cartão em ${acordo.qtd_parcelas}x`
                      : acordo.forma_pagamento === "boleto"
                      ? `Boleto em ${acordo.qtd_parcelas}x`
                      : "À vista"}{" "}
                    — {moeda(acordo.valor_total)}
                  </div>
                  <span style={{ ...estilos.tagBase, background: cor.bg, color: cor.texto }}>
                    {cor.label}
                  </span>
                </div>
                {totalAcordoAberto > 0 && (
                  <span style={estilos.totalAberto}>{moeda(totalAcordoAberto)} em aberto</span>
                )}
              </div>

              {acordo.valor_entrada ? (
                <div style={estilos.subLinha}>
                  Entrada: {moeda(acordo.valor_entrada)}
                  {acordo.entrada_paga ? " (paga)" : " (pendente)"}
                </div>
              ) : null}

              {parcelas.map((p) => {
                const pago = p.status === "PAGO";
                const vencida = !pago && diasAtraso(p.vencimento) > 0;
                const corP = pago ? CORES_STATUS.quitado : vencida ? CORES_STATUS.atraso : CORES_STATUS.em_aberto;
                return (
                  <div key={p.id} style={estilos.linha}>
                    <div>
                      <div style={{ fontSize: 13 }}>Parcela {p.numero}</div>
                      <div style={estilos.subLinha}>
                        Vencimento: {formatarDataSimples(p.vencimento)}
                        {vencida ? <span style={estilos.marcaVencida}>• vencida</span> : null}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{moeda(p.valor)}</div>
                      <span style={{ ...estilos.tagBase, background: corP.bg, color: corP.texto }}>
                        {pago ? "Paga" : STATUS_PARCELA_LABEL[p.status] || "A vencer"}
                      </span>
                    </div>
                  </div>
                );
              })}
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
  caixaResumo: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 16px",
    marginTop: 14,
    marginBottom: 4,
    borderRadius: 10,
    background: "rgba(34,197,94,0.08)",
    border: "1px solid rgba(34,197,94,0.3)",
  },
  totalGeral: {
    fontSize: 16,
    fontWeight: 800,
    color: "#4ade80",
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
  marcaVencida: {
    color: "#f0999a",
    fontWeight: 700,
    marginLeft: 6,
  },
  tagBase: {
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 999,
    fontWeight: 700,
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
