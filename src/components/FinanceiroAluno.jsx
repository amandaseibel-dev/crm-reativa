import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { podeGerirFinanceiro } from "../utils/operadores";

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

function hojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
  const [usuario, setUsuario] = useState(null);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUsuario(data?.user || null));
  }, []);

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
  }, [aluno?.id, recarga]);

  const podeBaixar = podeGerirFinanceiro(usuario?.email || "");

  async function checarQuitacao(acordoId) {
    const agora = new Date().toISOString();
    const { data: ps } = await supabase.from("parcelas").select("status").eq("acordo_id", acordoId);
    if (ps && ps.length > 0 && ps.every((p) => p.status === "PAGO")) {
      await supabase.from("acordos").update({ status: "QUITADO", saldo: 0, atualizado_em: agora }).eq("id", acordoId);
      const { data: vinculos } = await supabase
        .from("acordo_titulo_vinculo")
        .select("titulo_id")
        .eq("acordo_id", acordoId)
        .eq("ativo", true);
      const ids = (vinculos || []).map((v) => v.titulo_id);
      if (ids.length > 0) {
        await supabase.from("acordos_titulos").update({ status: "quitada", atualizado_em: agora }).in("id", ids);
      }
      if (aluno?.id) {
        await supabase
          .from("carteira_operador")
          .update({ status: "quitado_saiu", saiu_em: agora })
          .eq("aluno_id", String(aluno.id))
          .eq("status", "ativo");
      }
    }
  }

  async function baixarParcela(acordo, parcela, dados) {
    const agora = new Date().toISOString();
    const email = usuario?.email || "";
    const responsavelOperador = acordo.operador_responsavel_email || acordo.criado_por_email || null;

    const { error: erroParcela } = await supabase
      .from("parcelas")
      .update({ status: "PAGO", pago_em: agora, confirmado_por_email: email, atualizado_em: agora })
      .eq("id", parcela.id);

    if (erroParcela) {
      alert("Erro ao dar baixa na parcela: " + erroParcela.message);
      return;
    }

    const { error: erroBaixa } = await supabase.from("baixas_pagamento").insert({
      aluno_id: String(aluno.id),
      aluno_nome: aluno.nome || null,
      aluno_cpf: aluno.cpf || null,
      parcela_id: parcela.id,
      acordo_id: acordo.id,
      valor_pago: dados.valor,
      honorarios_recebidos: dados.honorarios,
      data_pagamento: dados.data,
      status_baixa: "REALIZADA",
      responsavel_baixa_email: responsavelOperador,
      baixado_por_email: email,
      recebido_em: agora,
      atualizado_em: agora,
      baixado_em: agora,
    });

    if (erroBaixa) {
      console.error("Erro ao registrar baixa:", erroBaixa);
      alert("Parcela baixada, mas houve erro ao registrar a baixa: " + erroBaixa.message);
    }

    await checarQuitacao(acordo.id);
    setRecarga((r) => r + 1);
    alert("Baixa registrada.");
  }

  async function quitarCartao(acordo, parcelasAbertas, dados) {
    if (!dados.comprovante || !dados.comprovante.trim()) {
      alert("No cartão o comprovante é obrigatório.");
      return;
    }
    const agora = new Date().toISOString();
    const email = usuario?.email || "";
    const responsavelOperador = acordo.operador_responsavel_email || acordo.criado_por_email || null;

    const { error: erroParcelas } = await supabase
      .from("parcelas")
      .update({ status: "PAGO", pago_em: agora, confirmado_por_email: email, atualizado_em: agora })
      .eq("acordo_id", acordo.id)
      .neq("status", "PAGO");

    if (erroParcelas) {
      alert("Erro ao quitar as parcelas: " + erroParcelas.message);
      return;
    }

    const linhas = parcelasAbertas.map((p) => ({
      aluno_id: String(aluno.id),
      aluno_nome: aluno.nome || null,
      aluno_cpf: aluno.cpf || null,
      parcela_id: p.id,
      acordo_id: acordo.id,
      valor_pago: Number(p.valor || 0),
      honorarios_recebidos: p.honorarios != null ? Number(p.honorarios) : null,
      data_pagamento: dados.data,
      comprovante_url: dados.comprovante,
      status_baixa: "REALIZADA",
      responsavel_baixa_email: responsavelOperador,
      baixado_por_email: email,
      recebido_em: agora,
      atualizado_em: agora,
      baixado_em: agora,
    }));

    if (linhas.length > 0) {
      const { error: erroBaixa } = await supabase.from("baixas_pagamento").insert(linhas);
      if (erroBaixa) {
        console.error("Erro ao registrar baixas do cartão:", erroBaixa);
      }
    }

    await checarQuitacao(acordo.id);
    setRecarga((r) => r + 1);
    alert("Acordo quitado no cartão.");
  }

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
      <SecaoAcordos
        acordos={acordos}
        parcelasPorAcordo={parcelasPorAcordo}
        podeBaixar={podeBaixar}
        onBaixarParcela={baixarParcela}
        onQuitarCartao={quitarCartao}
      />
    </>
  );
}

function SecaoAcordos({ acordos, parcelasPorAcordo, podeBaixar, onBaixarParcela, onQuitarCartao }) {
  const [formParcela, setFormParcela] = useState(null); // id da parcela com form aberto
  const [formCartao, setFormCartao] = useState(null); // id do acordo com form de cartao aberto
  const [campos, setCampos] = useState({});

  if (!acordos || acordos.length === 0) return null;

  function abrirParcela(p) {
    setFormCartao(null);
    setFormParcela(p.id);
    setCampos({ data: hojeISO(), valor: String(p.valor ?? ""), honorarios: p.honorarios != null ? String(p.honorarios) : "0" });
  }

  function abrirCartao(acordoId) {
    setFormParcela(null);
    setFormCartao(acordoId);
    setCampos({ data: hojeISO(), comprovante: "" });
  }

  return (
    <div style={estilos.caixa}>
      <strong>📄 Acordos e parcelas</strong>

      <div style={{ marginTop: 10 }}>
        {acordos.map((acordo) => {
          const parcelas = parcelasPorAcordo[acordo.id] || [];
          const parcelasAbertas = parcelas.filter((p) => p.status !== "PAGO");
          const totalAcordoAberto = parcelasAbertas.reduce((soma, p) => soma + Number(p.valor || 0), 0);
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
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>
                    {acordo.forma_pagamento === "A_VISTA"
                      ? "À vista"
                      : `Parcelado em ${acordo.qtd_parcelas}x`}{" "}
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

              {podeBaixar && parcelasAbertas.length > 0 && (
                <div style={{ margin: "8px 0" }}>
                  <button style={estilos.botaoCartao} onClick={() => abrirCartao(acordo.id)}>
                    Quitar tudo no cartão
                  </button>
                </div>
              )}

              {podeBaixar && formCartao === acordo.id && (
                <div style={estilos.formBaixa}>
                  <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>
                    Cartão: um comprovante quita todas as {parcelasAbertas.length} parcelas em aberto.
                  </div>
                  <div style={estilos.formLinha}>
                    <label style={estilos.formLabel}>
                      Data
                      <input
                        type="date"
                        style={estilos.formInput}
                        value={campos.data || ""}
                        onChange={(e) => setCampos({ ...campos, data: e.target.value })}
                      />
                    </label>
                    <label style={estilos.formLabel}>
                      Comprovante (link/nº)
                      <input
                        type="text"
                        style={estilos.formInput}
                        placeholder="obrigatório no cartão"
                        value={campos.comprovante || ""}
                        onChange={(e) => setCampos({ ...campos, comprovante: e.target.value })}
                      />
                    </label>
                  </div>
                  <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                    <button
                      style={estilos.botaoConfirmar}
                      onClick={() => {
                        onQuitarCartao(acordo, parcelasAbertas, campos);
                        setFormCartao(null);
                      }}
                    >
                      Confirmar quitação
                    </button>
                    <button style={estilos.botaoCancelar} onClick={() => setFormCartao(null)}>
                      Cancelar
                    </button>
                  </div>
                </div>
              )}

              {parcelas.map((p) => {
                const pago = p.status === "PAGO";
                const vencida = !pago && diasAtraso(p.vencimento) > 0;
                const corP = pago ? CORES_STATUS.quitado : vencida ? CORES_STATUS.atraso : CORES_STATUS.em_aberto;
                return (
                  <div key={p.id}>
                    <div style={estilos.linha}>
                      <div>
                        <div style={{ fontSize: 13 }}>Parcela {p.numero}</div>
                        <div style={estilos.subLinha}>
                          Vencimento: {formatarDataSimples(p.vencimento)}
                          {vencida ? <span style={estilos.marcaVencida}>• vencida</span> : null}
                        </div>
                      </div>
                      <div style={{ textAlign: "right", display: "flex", alignItems: "center", gap: 10 }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 700 }}>{moeda(p.valor)}</div>
                          <span style={{ ...estilos.tagBase, background: corP.bg, color: corP.texto }}>
                            {pago ? "Paga" : STATUS_PARCELA_LABEL[p.status] || "A vencer"}
                          </span>
                        </div>
                        {podeBaixar && !pago && (
                          <button style={estilos.botaoPequeno} onClick={() => abrirParcela(p)}>
                            Baixar
                          </button>
                        )}
                      </div>
                    </div>

                    {podeBaixar && formParcela === p.id && (
                      <div style={estilos.formBaixa}>
                        <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>
                          Boleto: informe o pagamento desta parcela (sem comprovante obrigatório).
                        </div>
                        <div style={estilos.formLinha}>
                          <label style={estilos.formLabel}>
                            Data
                            <input
                              type="date"
                              style={estilos.formInput}
                              value={campos.data || ""}
                              onChange={(e) => setCampos({ ...campos, data: e.target.value })}
                            />
                          </label>
                          <label style={estilos.formLabel}>
                            Valor pago
                            <input
                              type="number"
                              step="0.01"
                              style={estilos.formInput}
                              value={campos.valor || ""}
                              onChange={(e) => setCampos({ ...campos, valor: e.target.value })}
                            />
                          </label>
                          <label style={estilos.formLabel}>
                            Honorários recebidos
                            <input
                              type="number"
                              step="0.01"
                              style={estilos.formInput}
                              value={campos.honorarios || ""}
                              onChange={(e) => setCampos({ ...campos, honorarios: e.target.value })}
                            />
                          </label>
                        </div>
                        <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                          <button
                            style={estilos.botaoConfirmar}
                            onClick={() => {
                              onBaixarParcela(acordo, p, {
                                data: campos.data,
                                valor: Number(campos.valor) || 0,
                                honorarios: Number(campos.honorarios) || 0,
                              });
                              setFormParcela(null);
                            }}
                          >
                            Confirmar baixa
                          </button>
                          <button style={estilos.botaoCancelar} onClick={() => setFormParcela(null)}>
                            Cancelar
                          </button>
                        </div>
                      </div>
                    )}
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
  botaoPequeno: {
    background: "#0ea5e9",
    color: "#fff",
    border: "none",
    padding: "6px 12px",
    borderRadius: 8,
    cursor: "pointer",
    fontWeight: 700,
    fontSize: 12,
  },
  botaoCartao: {
    background: "#7c3aed",
    color: "#fff",
    border: "none",
    padding: "6px 12px",
    borderRadius: 8,
    cursor: "pointer",
    fontWeight: 700,
    fontSize: 12,
  },
  botaoConfirmar: {
    background: "#198754",
    color: "#fff",
    border: "none",
    padding: "8px 14px",
    borderRadius: 8,
    cursor: "pointer",
    fontWeight: 700,
    fontSize: 13,
  },
  botaoCancelar: {
    background: "rgba(148,163,184,0.25)",
    color: "#e2e8f0",
    border: "none",
    padding: "8px 14px",
    borderRadius: 8,
    cursor: "pointer",
    fontWeight: 700,
    fontSize: 13,
  },
  formBaixa: {
    background: "rgba(15,23,42,0.35)",
    border: "1px solid rgba(148,163,184,0.25)",
    borderRadius: 8,
    padding: 10,
    margin: "6px 0 10px",
  },
  formLinha: {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
  },
  formLabel: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    fontSize: 11,
    opacity: 0.85,
    flex: 1,
    minWidth: 120,
  },
  formInput: {
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid rgba(148,163,184,0.4)",
    background: "rgba(15,23,42,0.6)",
    color: "#e2e8f0",
    fontSize: 12,
  },
};
