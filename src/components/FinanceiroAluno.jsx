import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { podeGerirFinanceiro, nomeOperadorPorEmail } from "../utils/operadores";

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

function somarMeses(dataISO, meses) {
  const [ano, mes, dia] = String(dataISO).split("-").map(Number);
  const totalMeses = mes - 1 + meses;
  const anoFinal = ano + Math.floor(totalMeses / 12);
  const mesFinal = (totalMeses % 12) + 1;
  const ultimoDiaMes = new Date(anoFinal, mesFinal, 0).getDate();
  const diaFinal = Math.min(dia, ultimoDiaMes);
  return `${anoFinal}-${String(mesFinal).padStart(2, "0")}-${String(diaFinal).padStart(2, "0")}`;
}

function paraNumero(v) {
  let t = String(v || "").replace("R$", "").replace(/\s/g, "").trim();
  const temVirgula = t.includes(",");
  const temPonto = t.includes(".");
  if (temVirgula && temPonto) t = t.replace(/\./g, "").replace(",", ".");
  else if (temVirgula) t = t.replace(",", ".");
  return Number(t) || 0;
}

const STATUS_PARCELA_LABEL = {
  A_VENCER: "A vencer",
  VENCIDA: "Vencida",
  PAGO: "Paga",
};

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

function valorTitulo(t) {
  return Number(t.valor_em_aberto ?? t.saldo_corrigido ?? t.valor_original ?? 0);
}

function novoAcordoInicial() {
  return {
    valorTotal: "",
    qtdParcelas: "1",
    temEntrada: false,
    entradaRs: "",
    entradaPct: "",
    entradaPaga: true,
    honorarios: "",
    primeiroVenc: somarMeses(hojeISO(), 1),
    titulosSel: [],
    parcelas: [],
  };
}

// Cadastro manual de mensalidade -- pra corrigir caso que ficou de fora
// de algum bordero (não é o fluxo normal, que é a importação em lote).
function mensalidadeManualInicial() {
  return {
    documento: "",
    vencimento: hojeISO(),
    valor: "",
    tipoBoleto: "",
    competencia: "",
    motivo: "",
  };
}

export default function FinanceiroAluno({ aluno }) {
  const [titulos, setTitulos] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [acordos, setAcordos] = useState([]);
  const [parcelasPorAcordo, setParcelasPorAcordo] = useState({});
  const [usuario, setUsuario] = useState(null);
  const [recarga, setRecarga] = useState(0);
  const [titulosSelecionaveis, setTitulosSelecionaveis] = useState([]);
  const [novoAberto, setNovoAberto] = useState(true);
  const [novo, setNovo] = useState(novoAcordoInicial());

  const [formMensalidadeAberto, setFormMensalidadeAberto] = useState(false);
  const [novaMensalidade, setNovaMensalidade] = useState(mensalidadeManualInicial());
  const [salvandoMensalidade, setSalvandoMensalidade] = useState(false);
  const [erroMensalidade, setErroMensalidade] = useState("");

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
      setTitulosSelecionaveis([]);
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

      const { data: titulosData } = await supabase
        .from("acordos_titulos")
        .select("id, documento, vencimento, valor_original, saldo_corrigido, valor_em_aberto, status")
        .eq("aluno_id", String(aluno.id))
        .eq("status", "em_aberto")
        .order("vencimento", { ascending: true });
      setTitulosSelecionaveis(titulosData || []);
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

  // ---- Montar novo acordo (direto na ficha) ----
  function atualizarNovo(campo, valor) {
    setNovo((atual) => ({ ...atual, [campo]: valor }));
  }

  function atualizarEntradaRs(valor) {
    setNovo((atual) => {
      const total = paraNumero(atual.valorTotal);
      const rs = paraNumero(valor);
      const pct = total > 0 ? ((rs / total) * 100).toFixed(1) : "";
      return { ...atual, entradaRs: valor, entradaPct: pct };
    });
  }

  function atualizarEntradaPct(valor) {
    setNovo((atual) => {
      const total = paraNumero(atual.valorTotal);
      const pct = Number(String(valor).replace(",", ".")) || 0;
      const rs = total > 0 ? ((total * pct) / 100).toFixed(2) : "";
      return { ...atual, entradaPct: valor, entradaRs: rs };
    });
  }

  function alternarTitulo(id) {
    setNovo((atual) => {
      const jaTem = atual.titulosSel.includes(id);
      const titulosSel = jaTem ? atual.titulosSel.filter((x) => x !== id) : [...atual.titulosSel, id];
      return { ...atual, titulosSel };
    });
  }

  function usarSomaTitulos() {
    setNovo((atual) => {
      const soma = titulosSelecionaveis
        .filter((t) => atual.titulosSel.includes(t.id))
        .reduce((acc, t) => acc + valorTitulo(t), 0);
      return { ...atual, valorTotal: soma.toFixed(2) };
    });
  }

  function gerarParcelasNovo() {
    const total = paraNumero(novo.valorTotal);
    if (total <= 0) {
      alert("Informe o valor total do acordo.");
      return;
    }
    const qtd = Math.max(1, parseInt(novo.qtdParcelas) || 1);
    const entrada = novo.temEntrada ? Math.min(paraNumero(novo.entradaRs), total) : 0;
    const honTotal = paraNumero(novo.honorarios);
    const saldo = Math.max(0, total - entrada);
    const vParc = saldo / qtd;
    const honEnt = total > 0 ? honTotal * (entrada / total) : 0;
    const honSaldo = Math.max(0, honTotal - honEnt);
    const honCada = honSaldo / qtd;
    const base = novo.primeiroVenc || hojeISO();
    const parcelas = [];
    for (let i = 1; i <= qtd; i++) {
      parcelas.push({
        numero: i,
        vencimento: somarMeses(base, i - 1),
        valor: vParc.toFixed(2),
        honorarios: honCada.toFixed(2),
        status: "A_VENCER",
      });
    }
    setNovo((atual) => ({ ...atual, parcelas }));
  }

  function atualizarParcelaNovo(index, campo, valor) {
    setNovo((atual) => {
      const parcelas = atual.parcelas.map((p, i) => (i === index ? { ...p, [campo]: valor } : p));
      return { ...atual, parcelas };
    });
  }

  async function salvarNovoAcordo() {
    if (!novo.parcelas.length) {
      alert('Clique em "Gerar parcelas" antes de salvar.');
      return;
    }
    const total = paraNumero(novo.valorTotal);
    if (total <= 0) {
      alert("Informe o valor total do acordo.");
      return;
    }
    const email = usuario?.email || "";
    const agora = new Date().toISOString();
    const entrada = novo.temEntrada ? Math.min(paraNumero(novo.entradaRs), total) : 0;
    const pct = total > 0 && novo.temEntrada ? Number(((entrada / total) * 100).toFixed(2)) : null;
    const honTotal = paraNumero(novo.honorarios);
    const saldo = Math.max(0, total - entrada);

    const { data: acordo, error } = await supabase
      .from("acordos")
      .insert({
        aluno_id: String(aluno.id),
        cpf: aluno.cpf,
        tipo: "ACORDO",
        forma_pagamento: "PARCELADO",
        valor_total: total,
        qtd_parcelas: novo.parcelas.length,
        valor_entrada: novo.temEntrada ? entrada : null,
        entrada_percentual: pct,
        entrada_paga: novo.temEntrada ? Boolean(novo.entradaPaga) : false,
        data_entrada: novo.temEntrada && novo.entradaPaga ? hojeISO() : null,
        honorarios_valor: honTotal || null,
        saldo: saldo,
        status: "ATIVO",
        operador_responsavel_email: email,
        criado_por_nome: nomeOperadorPorEmail(email),
        criado_por_email: email,
        confirmado_por_email: email,
        confirmado_em: agora,
      })
      .select()
      .single();

    if (error) {
      alert("Erro ao criar acordo: " + error.message);
      return;
    }

    const parcelas = novo.parcelas.map((p) => ({
      acordo_id: acordo.id,
      numero: p.numero,
      valor: paraNumero(p.valor),
      honorarios: p.honorarios != null ? paraNumero(p.honorarios) : null,
      vencimento: p.vencimento,
      status: p.status,
    }));

    const { error: e2 } = await supabase.from("parcelas").insert(parcelas);
    if (e2) {
      alert("Acordo criado, mas houve erro ao gerar as parcelas: " + e2.message);
      return;
    }

    if (novo.titulosSel.length > 0) {
      const { error: e3 } = await supabase
        .from("acordo_titulo_vinculo")
        .insert(novo.titulosSel.map((id) => ({ acordo_id: acordo.id, titulo_id: id, ativo: true, vinculado_por: email })));
      if (e3) {
        console.error("Erro ao vincular titulos:", e3);
        alert("Acordo criado, mas houve erro ao vincular os títulos: " + e3.message);
      } else {
        await supabase.from("acordos_titulos").update({ status: "vinculada", atualizado_em: agora }).in("id", novo.titulosSel);
      }
    }

    setNovo(novoAcordoInicial());
    setNovoAberto(false);
    setRecarga((r) => r + 1);
    alert("Acordo criado com sucesso!");
  }

  async function salvarMensalidadeManual() {
    setErroMensalidade("");

    if (!aluno?.id) {
      setErroMensalidade("Este aluno não tem cadastro (id) — não dá pra vincular o título.");
      return;
    }

    const documento = novaMensalidade.documento.trim();
    if (!documento) {
      setErroMensalidade("Informe o número do documento/título (o mesmo do bordero).");
      return;
    }
    if (!novaMensalidade.vencimento) {
      setErroMensalidade("Informe o vencimento.");
      return;
    }
    const valor = paraNumero(novaMensalidade.valor);
    if (!valor) {
      setErroMensalidade("Informe um valor válido.");
      return;
    }

    setSalvandoMensalidade(true);

    const { data: criado, error } = await supabase
      .from("acordos_titulos")
      .insert({
        aluno_id: String(aluno.id),
        cpf: aluno.cpf || null,
        documento,
        vencimento: novaMensalidade.vencimento,
        valor_original: valor,
        saldo_corrigido: valor,
        situacao: "ABERTO",
        status: "em_aberto",
        tipo_boleto: novaMensalidade.tipoBoleto || null,
        competencia: novaMensalidade.competencia || null,
        motivo_ajuste: `Inclusão manual na ficha do aluno${
          usuario?.email ? " por " + usuario.email : ""
        }${novaMensalidade.motivo ? " — " + novaMensalidade.motivo : ""}`,
      })
      .select()
      .single();

    setSalvandoMensalidade(false);

    if (error) {
      // Código 23505 = violação de UNIQUE -- já existe um título com esse
      // número de documento (provavelmente já veio de algum bordero).
      if (error.code === "23505") {
        setErroMensalidade(
          `Já existe um título com o documento "${documento}" no sistema. Confira se não é esse mesmo que você está procurando.`
        );
      } else {
        setErroMensalidade("Erro ao salvar: " + error.message);
      }
      return;
    }

    setTitulos((anteriores) =>
      [...anteriores, criado].sort((a, b) =>
        String(a.vencimento || "").localeCompare(String(b.vencimento || ""))
      )
    );
    setNovaMensalidade(mensalidadeManualInicial());
    setFormMensalidadeAberto(false);
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

  const somaTitulosMarcados = titulosSelecionaveis
    .filter((t) => novo.titulosSel.includes(t.id))
    .reduce((acc, t) => acc + valorTitulo(t), 0);

  return (
    <>
      {temAlgumValor && (
        <div style={estilos.caixaResumo}>
          <strong>💰 Total em aberto do aluno</strong>
          <span style={estilos.totalGeral}>{moeda(totalGeralAberto)}</span>
        </div>
      )}

      {podeBaixar && aluno?.id && (
        <div style={estilos.caixa}>
          <div style={estilos.cabecalho}>
            <strong>➕ Montar novo acordo</strong>
            <button style={estilos.botaoPequeno} onClick={() => setNovoAberto((v) => !v)}>
              {novoAberto ? "Fechar" : "Abrir"}
            </button>
          </div>

          {novoAberto && (
            <div style={{ marginTop: 10 }}>
              <div style={estilos.blocoTitulos}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
                  Títulos em aberto — marque os que entram neste acordo
                </div>
                {titulosSelecionaveis.length === 0 ? (
                  <div style={{ fontSize: 12, opacity: 0.7 }}>
                    Nenhum título em aberto para este aluno. Você pode montar o acordo mesmo assim.
                  </div>
                ) : (
                  <>
                    {titulosSelecionaveis.map((t) => (
                      <label key={t.id} style={estilos.linhaTitulo}>
                        <input
                          type="checkbox"
                          checked={novo.titulosSel.includes(t.id)}
                          onChange={() => alternarTitulo(t.id)}
                        />
                        <span style={{ flex: 1 }}>
                          Título {t.documento || "-"} — venc. {formatarDataSimples(t.vencimento)}
                        </span>
                        <span style={{ fontWeight: 700 }}>{moeda(valorTitulo(t))}</span>
                      </label>
                    ))}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                      <span style={{ fontSize: 12 }}>Soma marcados: <strong>{moeda(somaTitulosMarcados)}</strong></span>
                      <button style={estilos.botaoPequeno} onClick={usarSomaTitulos}>
                        Usar soma como valor total
                      </button>
                    </div>
                  </>
                )}
              </div>

              <div style={estilos.gridCampos}>
                <label style={estilos.campo}>
                  Valor total (R$)
                  <input style={estilos.input} value={novo.valorTotal} placeholder="Ex: 1500,00"
                    onChange={(e) => atualizarNovo("valorTotal", e.target.value)} />
                </label>
                <label style={estilos.campo}>
                  Nº de parcelas
                  <input style={estilos.input} type="number" min="1" value={novo.qtdParcelas}
                    onChange={(e) => atualizarNovo("qtdParcelas", e.target.value)} />
                </label>
                <label style={estilos.campo}>
                  Honorários (R$)
                  <input style={estilos.input} value={novo.honorarios} placeholder="Ex: 300,00"
                    onChange={(e) => atualizarNovo("honorarios", e.target.value)} />
                </label>
                <label style={estilos.campo}>
                  1º vencimento
                  <input style={estilos.input} type="date" value={novo.primeiroVenc}
                    onChange={(e) => atualizarNovo("primeiroVenc", e.target.value)} />
                </label>
              </div>

              <label style={{ ...estilos.campo, flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 }}>
                <input type="checkbox" checked={novo.temEntrada}
                  onChange={(e) => atualizarNovo("temEntrada", e.target.checked)} />
                Tem entrada
              </label>

              {novo.temEntrada && (
                <div style={estilos.gridCampos}>
                  <label style={estilos.campo}>
                    Entrada (R$)
                    <input style={estilos.input} value={novo.entradaRs}
                      onChange={(e) => atualizarEntradaRs(e.target.value)} />
                  </label>
                  <label style={estilos.campo}>
                    Entrada (%)
                    <input style={estilos.input} value={novo.entradaPct}
                      onChange={(e) => atualizarEntradaPct(e.target.value)} />
                  </label>
                  <label style={{ ...estilos.campo, flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <input type="checkbox" checked={novo.entradaPaga}
                      onChange={(e) => atualizarNovo("entradaPaga", e.target.checked)} />
                    Entrada já paga
                  </label>
                </div>
              )}

              <button style={{ ...estilos.botaoPequeno, marginTop: 10 }} onClick={gerarParcelasNovo}>
                Gerar parcelas
              </button>

              {novo.parcelas.length > 0 && (
                <div style={{ marginTop: 10, border: "1px solid rgba(148,163,184,0.25)", borderRadius: 8, overflow: "hidden" }}>
                  <div style={estilos.parcHead}>
                    <span>Nº</span><span>Vencimento</span><span>Valor</span><span>Honor.</span>
                  </div>
                  {novo.parcelas.map((p, index) => (
                    <div key={index} style={estilos.parcRow}>
                      <span>{p.numero}</span>
                      <input style={estilos.inputTabela} type="date" value={p.vencimento}
                        onChange={(e) => atualizarParcelaNovo(index, "vencimento", e.target.value)} />
                      <input style={estilos.inputTabela} value={p.valor}
                        onChange={(e) => atualizarParcelaNovo(index, "valor", e.target.value)} />
                      <input style={estilos.inputTabela} value={p.honorarios}
                        onChange={(e) => atualizarParcelaNovo(index, "honorarios", e.target.value)} />
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button style={estilos.botaoConfirmar} onClick={salvarNovoAcordo}>
                  Salvar acordo
                </button>
                <button style={estilos.botaoCancelar} onClick={() => { setNovo(novoAcordoInicial()); setNovoAberto(false); }}>
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {titulos.length === 0 ? (
        <div style={estilos.caixa}>
          <div style={estilos.cabecalho}>
            <strong>💰 Financeiro</strong>
            <button
              style={estilos.botaoPequeno}
              onClick={() => setFormMensalidadeAberto((v) => !v)}
            >
              {formMensalidadeAberto ? "Cancelar" : "+ Adicionar mensalidade manual"}
            </button>
          </div>
          <p style={{ fontSize: 12, opacity: 0.7, margin: "6px 0 0" }}>
            {aluno?.cpf
              ? `Nenhum título importado pelos borderôs para o CPF ${aluno.cpf}.`
              : "Este aluno não tem CPF cadastrado, então não dá pra casar com os borderôs."}
          </p>
          {formMensalidadeAberto && <FormMensalidadeManual
            novaMensalidade={novaMensalidade}
            setNovaMensalidade={setNovaMensalidade}
            salvando={salvandoMensalidade}
            erro={erroMensalidade}
            onSalvar={salvarMensalidadeManual}
            onCancelar={() => { setFormMensalidadeAberto(false); setErroMensalidade(""); }}
          />}
        </div>
      ) : (
        <div style={estilos.caixa}>
          <div style={estilos.cabecalho}>
            <strong>💰 Financeiro (borderôs)</strong>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {emAberto.length > 0 && (
                <span style={estilos.totalAberto}>{moeda(totalTitulosAberto)} em aberto</span>
              )}
              <button
                style={estilos.botaoPequeno}
                onClick={() => setFormMensalidadeAberto((v) => !v)}
              >
                {formMensalidadeAberto ? "Cancelar" : "+ Mensalidade manual"}
              </button>
            </div>
          </div>

          {formMensalidadeAberto && <FormMensalidadeManual
            novaMensalidade={novaMensalidade}
            setNovaMensalidade={setNovaMensalidade}
            salvando={salvandoMensalidade}
            erro={erroMensalidade}
            onSalvar={salvarMensalidadeManual}
            onCancelar={() => { setFormMensalidadeAberto(false); setErroMensalidade(""); }}
          />}

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

function FormMensalidadeManual({ novaMensalidade, setNovaMensalidade, salvando, erro, onSalvar, onCancelar }) {
  function setCampo(campo, valor) {
    setNovaMensalidade((anterior) => ({ ...anterior, [campo]: valor }));
  }

  return (
    <div style={estilos.formBaixa}>
      <p style={{ fontSize: 12, opacity: 0.8, margin: "0 0 8px" }}>
        Uso pontual — pra corrigir um caso que ficou de fora de algum bordero. Use o mesmo
        número de documento/título que estaria na planilha, pra não duplicar depois se o
        bordero certo for reimportado.
      </p>
      <div style={estilos.formLinha}>
        <label style={estilos.formLabel}>
          Documento/título *
          <input
            style={estilos.formInput}
            value={novaMensalidade.documento}
            onChange={(e) => setCampo("documento", e.target.value)}
            placeholder="Ex: 4192123"
          />
        </label>
        <label style={estilos.formLabel}>
          Vencimento *
          <input
            type="date"
            style={estilos.formInput}
            value={novaMensalidade.vencimento}
            onChange={(e) => setCampo("vencimento", e.target.value)}
          />
        </label>
        <label style={estilos.formLabel}>
          Valor *
          <input
            style={estilos.formInput}
            value={novaMensalidade.valor}
            onChange={(e) => setCampo("valor", e.target.value)}
            placeholder="Ex: 850,00"
          />
        </label>
      </div>
      <div style={{ ...estilos.formLinha, marginTop: 8 }}>
        <label style={estilos.formLabel}>
          Curso/tipo de boleto
          <input
            style={estilos.formInput}
            value={novaMensalidade.tipoBoleto}
            onChange={(e) => setCampo("tipoBoleto", e.target.value)}
            placeholder="Opcional"
          />
        </label>
        <label style={estilos.formLabel}>
          Competência
          <input
            style={estilos.formInput}
            value={novaMensalidade.competencia}
            onChange={(e) => setCampo("competencia", e.target.value)}
            placeholder="Opcional, ex: 05/2026"
          />
        </label>
        <label style={{ ...estilos.formLabel, flex: 2 }}>
          Motivo (fica registrado no histórico)
          <input
            style={estilos.formInput}
            value={novaMensalidade.motivo}
            onChange={(e) => setCampo("motivo", e.target.value)}
            placeholder="Ex: não veio no bordero 624"
          />
        </label>
      </div>

      {erro && <p style={{ color: "#f0999a", fontSize: 12, marginTop: 8 }}>{erro}</p>}

      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button style={estilos.botaoConfirmar} onClick={onSalvar} disabled={salvando}>
          {salvando ? "Salvando..." : "Salvar mensalidade"}
        </button>
        <button style={estilos.botaoCancelar} onClick={onCancelar} disabled={salvando}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

function SecaoAcordos({ acordos, parcelasPorAcordo, podeBaixar, onBaixarParcela, onQuitarCartao }) {
  const [formParcela, setFormParcela] = useState(null);
  const [formCartao, setFormCartao] = useState(null);
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
              style={{ marginBottom: 14, borderLeft: `4px solid ${cor.barra}`, paddingLeft: 10, borderRadius: 4 }}
            >
              <div style={estilos.cabecalho}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>
                    {acordo.forma_pagamento === "A_VISTA" ? "À vista" : `Parcelado em ${acordo.qtd_parcelas}x`}{" "}
                    — {moeda(acordo.valor_total)}
                  </div>
                  <span style={{ ...estilos.tagBase, background: cor.bg, color: cor.texto }}>{cor.label}</span>
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
                      <input type="date" style={estilos.formInput} value={campos.data || ""}
                        onChange={(e) => setCampos({ ...campos, data: e.target.value })} />
                    </label>
                    <label style={estilos.formLabel}>
                      Comprovante (link/nº)
                      <input type="text" style={estilos.formInput} placeholder="obrigatório no cartão" value={campos.comprovante || ""}
                        onChange={(e) => setCampos({ ...campos, comprovante: e.target.value })} />
                    </label>
                  </div>
                  <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                    <button style={estilos.botaoConfirmar} onClick={() => { onQuitarCartao(acordo, parcelasAbertas, campos); setFormCartao(null); }}>
                      Confirmar quitação
                    </button>
                    <button style={estilos.botaoCancelar} onClick={() => setFormCartao(null)}>Cancelar</button>
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
                          <button style={estilos.botaoPequeno} onClick={() => abrirParcela(p)}>Baixar</button>
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
                            <input type="date" style={estilos.formInput} value={campos.data || ""}
                              onChange={(e) => setCampos({ ...campos, data: e.target.value })} />
                          </label>
                          <label style={estilos.formLabel}>
                            Valor pago
                            <input type="number" step="0.01" style={estilos.formInput} value={campos.valor || ""}
                              onChange={(e) => setCampos({ ...campos, valor: e.target.value })} />
                          </label>
                          <label style={estilos.formLabel}>
                            Honorários recebidos
                            <input type="number" step="0.01" style={estilos.formInput} value={campos.honorarios || ""}
                              onChange={(e) => setCampos({ ...campos, honorarios: e.target.value })} />
                          </label>
                        </div>
                        <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                          <button style={estilos.botaoConfirmar}
                            onClick={() => {
                              onBaixarParcela(acordo, p, { data: campos.data, valor: Number(campos.valor) || 0, honorarios: Number(campos.honorarios) || 0 });
                              setFormParcela(null);
                            }}>
                            Confirmar baixa
                          </button>
                          <button style={estilos.botaoCancelar} onClick={() => setFormParcela(null)}>Cancelar</button>
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
  caixa: { padding: "12px 16px", marginTop: 14, marginBottom: 14, borderRadius: 10, background: "rgba(56,189,248,0.06)", border: "1px solid rgba(56,189,248,0.25)" },
  cabecalho: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  totalAberto: { fontSize: 13, color: "#fcd34d", fontWeight: 700 },
  caixaResumo: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", marginTop: 14, marginBottom: 4, borderRadius: 10, background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.3)" },
  totalGeral: { fontSize: 16, fontWeight: 800, color: "#4ade80" },
  linha: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderTop: "1px solid rgba(148,163,184,0.12)" },
  subLinha: { fontSize: 11, opacity: 0.7, marginTop: 2 },
  marcaVencida: { color: "#f0999a", fontWeight: 700, marginLeft: 6 },
  tagBase: { fontSize: 11, padding: "2px 8px", borderRadius: 999, fontWeight: 700 },
  botaoPequeno: { background: "#0ea5e9", color: "#fff", border: "none", padding: "6px 12px", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 12 },
  botaoCartao: { background: "#7c3aed", color: "#fff", border: "none", padding: "6px 12px", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 12 },
  botaoConfirmar: { background: "#198754", color: "#fff", border: "none", padding: "8px 14px", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 13 },
  botaoCancelar: { background: "rgba(148,163,184,0.25)", color: "#e2e8f0", border: "none", padding: "8px 14px", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 13 },
  formBaixa: { background: "rgba(15,23,42,0.35)", border: "1px solid rgba(148,163,184,0.25)", borderRadius: 8, padding: 10, margin: "6px 0 10px" },
  formLinha: { display: "flex", gap: 10, flexWrap: "wrap" },
  formLabel: { display: "flex", flexDirection: "column", gap: 4, fontSize: 11, opacity: 0.85, flex: 1, minWidth: 120 },
  formInput: { padding: "6px 8px", borderRadius: 6, border: "1px solid rgba(148,163,184,0.4)", background: "rgba(15,23,42,0.6)", color: "#e2e8f0", fontSize: 12 },
  blocoTitulos: { background: "rgba(24,95,165,0.12)", border: "1px solid rgba(24,95,165,0.3)", borderRadius: 8, padding: 10, marginBottom: 10 },
  linhaTitulo: { display: "flex", alignItems: "center", gap: 10, padding: "5px 0", borderTop: "1px solid rgba(148,163,184,0.15)", fontSize: 13 },
  gridCampos: { display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 },
  campo: { display: "flex", flexDirection: "column", gap: 4, fontSize: 11, opacity: 0.9, flex: 1, minWidth: 130 },
  input: { padding: "8px 10px", borderRadius: 6, border: "1px solid rgba(148,163,184,0.4)", background: "rgba(15,23,42,0.6)", color: "#e2e8f0", fontSize: 13 },
  parcHead: { display: "grid", gridTemplateColumns: "40px 1fr 1fr 1fr", gap: 8, background: "rgba(148,163,184,0.12)", padding: "6px 10px", fontSize: 11, fontWeight: 700, opacity: 0.8 },
  parcRow: { display: "grid", gridTemplateColumns: "40px 1fr 1fr 1fr", gap: 8, padding: "6px 10px", alignItems: "center", borderTop: "1px solid rgba(148,163,184,0.15)", fontSize: 13 },
  inputTabela: { padding: "6px", borderRadius: 6, border: "1px solid rgba(148,163,184,0.4)", background: "rgba(15,23,42,0.6)", color: "#e2e8f0", fontSize: 12 },
};
