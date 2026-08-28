import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando } from "../ui/estados";
import { S as A } from "../ui/estilosFila";
import Aluno from "./Aluno";
import DadosAcademicos from "../components/DadosAcademicos";

// Conferência Prime: títulos que o CRM ainda cobra e a Prime já registra como
// liquidados. Mesma anatomia das outras filas (card por aluno, ação no próprio
// card), porque é o mesmo tipo de trabalho: olhar um caso e decidir.
//
// A REGRA QUE MANDA AQUI: nada é automático. A Prime só expõe parcela
// LIQUIDADA -- ausência lá não quer dizer "em aberto", quer dizer "não sei". E
// quando o aluno negocia, a mensalidade é liquidada na Prime pela negociação;
// se o acordo cair depois, a Prime NÃO reverte. Por isso a lista exclui quem
// tem acordo cancelado, e a baixa é um clique de gente, um título por vez.
//
// Os dois grupos NÃO são a mesma conversa:
//   - SEM acordo ativo  -> a Prime diz que o aluno pagou e nós seguimos
//                          cobrando. A baixa provavelmente é devida.
//   - COM acordo ativo  -> o título foi liquidado PELA negociação e virou
//                          acordo. Se ele continua aberto aqui, a dívida está
//                          sendo contada duas vezes -- baixar não perdoa nada,
//                          para de cobrar em dobro.

function moeda(v) {
  return (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function dia(v) {
  if (!v) return "-";
  try {
    // Data pura (YYYY-MM-DD) não pode passar por fuso: viraria o dia anterior.
    const [a, m, d] = String(v).slice(0, 10).split("-");
    return `${d}/${m}/${a}`;
  } catch {
    return "-";
  }
}

function formatCpf(v) {
  const d = String(v || "").replace(/\D/g, "");
  if (d.length !== 11) return v || "-";
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

export default function ConferenciaPrime() {
  // Cruzamento com o relatorio do Santander: liquidado no Prime sem dinheiro
  // entrar e negociacao, nao pagamento. Amanda: "tem casos la que nem estao
  // pagos, nao tem vinculo com os relatorios do santander".
  const [dinheiro, setDinheiro] = useState("TODOS");
  const [cobertura, setCobertura] = useState("TODOS");
  // Simulacao nao cumprida: liquidou no Prime, nao entrou dinheiro e nao
  // existe acordo no CRM. A divida e real -- e o oposto de quem tem acordo
  // ativo, onde o titulo esta sendo cobrado em dobro.
  const [acordoSit, setAcordoSit] = useState("TODOS");
  const [nomeCopiado, setNomeCopiado] = useState("");
  const [itens, setItens] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [semPermissao, setSemPermissao] = useState(false);
  const [grupo, setGrupo] = useState("SEM_ACORDO");
  const [busca, setBusca] = useState("");
  const [ordem, setOrdem] = useState("VALOR_DESC");
  // O sinal e calculado por ALUNO, entao este filtro entra depois do agrupamento.
  const [sinal, setSinal] = useState("TODOS");
  const [processando, setProcessando] = useState({});
  // Ficha do aluno. A tela nasceu sem isso e ficou impossivel conferir o caso
  // antes de baixar -- que e exatamente o que se pede a quem usa esta lista.
  const [fichaId, setFichaId] = useState(null);

  useEffect(() => {
    carregar();
  }, []);

  async function carregar() {
    setCarregando(true);
    setErro("");
    try {
      const { data, error } = await supabase.rpc("prime_conferencia_fila");
      if (error) throw error;
      const linhas = data || [];
      setItens(linhas);
      // A RPC devolve vazio para quem não tem permissão (o gate está dentro
      // dela). Sem isso, a tela diria "nada a conferir" para quem só não pode ver.
      setSemPermissao(linhas.length === 0);
    } catch (e) {
      setErro(e?.message || String(e));
      setItens([]);
    } finally {
      setCarregando(false);
    }
  }

  // Baixa TODOS os titulos de um aluno. A decisao e por aluno -- quem liquidou
  // nove boletos no mesmo dia e um caso so, nao nove. Cada titulo continua
  // sendo uma chamada individual a RPC, que revalida a prova e trava a linha:
  // o que agrupa e a decisao, nao a permissao.
  async function baixarCard(g) {
    const ok = window.confirm(
      `Dar baixa em ${g.titulos.length} titulo(s) de ${g.nome}?\n\n` +
        `Total: ${moeda(g.total)}\n` +
        `A Prime registra liquidacao ${g.padrao === "DINHEIRO" ? "em datas distintas" : "toda no mesmo dia"}` +
        (g.ultimaLiquidacao ? `, ate ${dia(g.ultimaLiquidacao)}` : "") + ".\n\n" +
        (g.padrao === "NEGOCIACAO"
          ? "CUIDADO: este aluno tem assinatura de NEGOCIACAO (tudo no mesmo dia, incluindo mensalidade que venceria depois) e nao tem acordo no CRM. Baixar apaga divida sem deixar nada para cobrar.\n\n"
          : g.temAcordoAtivo
            ? "Este aluno tem acordo ATIVO: os titulos foram liquidados pela negociacao e estao sendo cobrados em dobro. Baixar corrige a duplicidade.\n\n"
            : "") +
        "Os titulos ficam como pagos e saem da divida em aberto."
    );
    if (!ok) return;

    const chave = `card:${g.chave}`;
    if (processando[chave]) return;
    setProcessando((p) => ({ ...p, [chave]: true }));

    let baixados = 0;
    const falhas = [];
    try {
      for (const t of g.titulos) {
        const { error } = await supabase.rpc("prime_conferencia_confirmar", {
          p_titulo_id: t.titulo_id,
          p_observacao: null,
        });
        if (error) falhas.push(`${t.documento}: ${error.message}`);
        else baixados += 1;
      }
    } finally {
      setProcessando((p) => {
        const n = { ...p };
        delete n[chave];
        return n;
      });
    }

    const idsBaixados = new Set(g.titulos.map((t) => t.titulo_id));
    if (falhas.length === 0) {
      setItens((prev) => prev.filter((x) => !idsBaixados.has(x.titulo_id)));
    } else {
      // Recarrega: parte foi e parte nao, e a tela nao pode adivinhar quais.
      alert(`${baixados} baixado(s). Falharam:\n${falhas.join("\n")}`);
      carregar();
    }
  }

  async function baixar(item) {
    const ok = window.confirm(
      `Dar baixa neste título?\n\n` +
        `Aluno: ${item.aluno_nome}\n` +
        `Boleto: ${item.documento}\n` +
        `Vencimento: ${dia(item.vencimento)}\n` +
        `Valor que o CRM cobra: ${moeda(item.valor_em_aberto)}\n` +
        `A Prime registra liquidado em: ${dia(item.liquidado_em)}\n\n` +
        (item.tem_acordo_ativo
          ? "ATENÇÃO: este aluno tem acordo ATIVO. Provavelmente o título foi liquidado pela negociação — baixar aqui evita cobrar a mesma dívida duas vezes.\n\n"
          : "") +
        (item.padraoAluno === "NEGOCIACAO"
          ? "CUIDADO: os títulos deste aluno foram todos liquidados no MESMO dia, incluindo mensalidade que venceria depois. Isso é assinatura de NEGOCIAÇÃO, não de pagamento — e não há acordo ativo no CRM. Se o acordo não foi importado, baixar apaga a dívida sem deixar nada para cobrar.\n\n"
          : "") +
        "O título fica como pago e sai da dívida em aberto."
    );
    if (!ok) return;
    if (processando[item.titulo_id]) return;

    setProcessando((p) => ({ ...p, [item.titulo_id]: true }));
    try {
      const { data, error } = await supabase.rpc("prime_conferencia_confirmar", {
        p_titulo_id: item.titulo_id,
        p_observacao: null,
      });
      if (error) throw error;

      // Tira da tela sem recarregar tudo: a lista é longa e a pessoa está no meio dela.
      setItens((prev) => prev.filter((x) => x.titulo_id !== item.titulo_id));
      if (data?.ja_processado) {
        alert("Este título já tinha sido baixado. Nada foi alterado.");
      }
    } catch (e) {
      alert("Não foi possível baixar: " + (e?.message || String(e)));
    } finally {
      setProcessando((p) => {
        const n = { ...p };
        delete n[item.titulo_id];
        return n;
      });
    }
  }

  const filtrados = useMemo(() => {
    const porDinheiro = (t) => dinheiro === "TODOS" || t.dinheiro === dinheiro;
    // A cobertura compara a SOMA dos titulos liquidados no dia com tudo que o
    // aluno pagou na janela. Valor titulo a titulo nao serve: de 1.595 titulos
    // com pagamento, so 1 batia exato -- o aluno paga em lote, com juros.
    const porAcordo = (t) => acordoSit === "TODOS" || t.acordo_situacao === acordoSit;
    const porCobertura = (t) => {
      if (cobertura === "TODOS") return true;
      const c = Number(t.lote_cobertura);
      if (!Number.isFinite(c)) return false;
      if (cobertura === "COBRE") return c >= 98;
      if (cobertura === "PARCIAL") return c >= 50 && c < 98;
      return c < 50;
    };
    let lista = itens.filter((i) => {
      if (!porDinheiro(i)) return false;
      if (!porCobertura(i)) return false;
      if (!porAcordo(i)) return false;
      if (grupo === "TODOS") return true;
      if (grupo === "COM_ACORDO") return i.tem_acordo_ativo;
      return !i.tem_acordo_ativo;
    });

    if (busca.trim()) {
      const t = busca.trim().toLowerCase();
      const digitos = t.replace(/\D/g, "");
      lista = lista.filter((i) => {
        const nomeOk = String(i.aluno_nome || "").toLowerCase().includes(t);
        const cpfOk = digitos && String(i.cpf || "").replace(/\D/g, "").includes(digitos);
        const docOk = digitos && String(i.documento || "").includes(digitos);
        return nomeOk || cpfOk || docOk;
      });
    }
    return lista;
  }, [itens, grupo, busca, dinheiro, cobertura, acordoSit]);

  // 1 card por aluno, como nas outras filas.
  const grupos = useMemo(() => {
    const mapa = new Map();
    for (const i of filtrados) {
      const chave = i.aluno_id || `SEM-${i.titulo_id}`;
      if (!mapa.has(chave)) {
        mapa.set(chave, {
          chave,
          alunoId: i.aluno_id,
          nome: i.aluno_nome,
          cpf: i.cpf,
          responsavel: i.operador_responsavel,
          temAcordoAtivo: i.tem_acordo_ativo,
          titulos: [],
        });
      }
      mapa.get(chave).titulos.push(i);
    }
    const arr = Array.from(mapa.values());
    for (const g of arr) {
      g.total = g.titulos.reduce((s, t) => s + (Number(t.valor_em_aberto) || 0), 0);
      g.ultimaLiquidacao = g.titulos.reduce(
        (max, t) => (t.liquidado_em && (!max || t.liquidado_em > max) ? t.liquidado_em : max),
        null
      );
      // COMO SE RECONHECE UMA NEGOCIACAO DISFARCADA DE PAGAMENTO:
      // ninguem paga adiantado quatro mensalidades que ainda nem venceram. Se
      // TODOS os titulos foram liquidados no MESMO dia e pelo menos um deles
      // venceria DEPOIS dessa data, o que aconteceu foi negociacao -- as
      // mensalidades futuras foram liquidadas de uma vez para virar acordo.
      // Quando esse aluno nao tem acordo ativo aqui, o acordo provavelmente
      // nao foi importado: baixar apagaria a divida dele do CRM sem que o
      // acordo exista para cobrar.
      const datas = new Set(g.titulos.map((t) => t.liquidado_em).filter(Boolean));
      const quitouFuturo = g.titulos.some(
        (t) => t.liquidado_em && t.vencimento && t.vencimento > t.liquidado_em
      );
      g.padrao =
        datas.size === 1 && quitouFuturo
          ? "NEGOCIACAO"
          : datas.size === 1 && g.titulos.length > 1
            ? "BLOCO"
            : "DINHEIRO";
    }
    const visiveis = sinal === "TODOS" ? arr : arr.filter((g) => g.padrao === sinal);
    const porNome = (a, b) => String(a.nome || "").localeCompare(String(b.nome || ""), "pt-BR");
    visiveis.sort((a, b) => {
      if (ordem === "VALOR_ASC") return a.total - b.total || porNome(a, b);
      if (ordem === "LIQUIDACAO_DESC") {
        return String(b.ultimaLiquidacao || "").localeCompare(String(a.ultimaLiquidacao || "")) || porNome(a, b);
      }
      return b.total - a.total || porNome(a, b);
    });
    return visiveis;
  }, [filtrados, ordem, sinal]);

  const contagens = useMemo(
    () => ({
      semAcordo: itens.filter((i) => !i.tem_acordo_ativo).length,
      comAcordo: itens.filter((i) => i.tem_acordo_ativo).length,
    }),
    [itens]
  );

  const totalFiltrado = filtrados.reduce((s, i) => s + (Number(i.valor_em_aberto) || 0), 0);

  if (carregando) {
    // REJEITAR: a Prime diz liquidado, mas a gestao conferiu e a divida e real
  // (o caso mais comum: portador 195, que significa "ainda em cobranca"). Nao
  // baixa nada -- so tira da fila com o motivo registrado.
  async function rejeitar(t) {
    const motivo = window.prompt(
      `Não baixar o boleto ${t.documento} de ${t.aluno_nome}?\n\n` +
      `Por quê? (ex.: Prime ainda cobra, cliente não pagou, liquidação por negociação)`,
      t.dinheiro === "NAO_ENTROU" && t.acordo_situacao === "SEM_ACORDO"
        ? "Simulação de acordo não cumprida: liquidou no Prime, não entrou dinheiro e não há acordo no CRM"
        : t.dinheiro === "NAO_ENTROU"
        ? "Liquidado no Prime sem pagamento no Santander — é negociação, não pagamento"
        : t.portador === 195
          ? "Prime ainda cobra este título (portador 195)"
          : "",
    );
    if (motivo === null) return;
    setProcessando((a) => ({ ...a, [t.titulo_id]: true }));
    const { error } = await supabase.rpc("prime_conferencia_rejeitar", {
      p_titulo_id: t.titulo_id,
      p_motivo: motivo,
    });
    setProcessando((a) => ({ ...a, [t.titulo_id]: false }));
    if (error) { alert("Erro ao rejeitar: " + error.message); return; }
    carregar();
  }

  // Rejeitar em lote. Rejeitar NAO mexe em dinheiro -- nao baixa titulo, nao
  // altera saldo, nao tira ninguem da carteira. So registra "conferi e a
  // divida e real" e tira da fila. Por isso o lote e seguro aqui, enquanto
  // BAIXAR continua um titulo por vez, de proposito.
  async function rejeitarLote(lista, descricao) {
    if (!lista.length) return;
    const total = lista.reduce((t, x) => t + Number(x.valor_em_aberto || 0), 0);
    const motivo = window.prompt(
      `Rejeitar ${lista.length} título(s) — ${descricao}\n` +
      `Somam ${moeda(total)}.\n\n` +
      `Rejeitar NÃO baixa nada: só marca que você conferiu e a dívida é real, ` +
      `e tira da fila.\n\nPor quê?`,
      "Liquidado no Prime sem pagamento no Santander — é negociação, não pagamento",
    );
    if (motivo === null) return;
    setProcessando((a) => ({ ...a, lote: true }));
    const { data, error } = await supabase.rpc("prime_conferencia_rejeitar_lote", {
      p_titulo_ids: lista.map((x) => x.titulo_id),
      p_motivo: motivo,
    });
    setProcessando((a) => ({ ...a, lote: false }));
    if (error) { alert("Erro ao rejeitar em lote: " + error.message); return; }
    alert(`${data?.rejeitados ?? lista.length} título(s) rejeitado(s).`);
    carregar();
  }

  function copiarNome(nome) {
    navigator.clipboard.writeText(nome || "").then(() => {
      setNomeCopiado(nome);
      setTimeout(() => setNomeCopiado(""), 1500);
    });
  }

  return (
      <div style={A.wrap}>
        <Carregando texto="Conferindo com a Prime…" />
      </div>
    );
  }

  return (
    <div style={A.wrap}>
      <div style={A.topo}>
        <div>
          <h1 style={A.titulo}>Conferência Prime</h1>
          <p style={A.sub}>Títulos que ainda cobramos e a Prime registra como liquidados.</p>
        </div>
        <button type="button" style={A.btnGhost} onClick={carregar}>Atualizar</button>
      </div>

      {erro && <div style={A.erroBox}>⚠️ {erro}</div>}

      {semPermissao && !erro ? (
        <p style={A.muted}>
          Nada a conferir — ou seu usuário não tem permissão para dar baixa em título.
        </p>
      ) : (
        <>
          <div style={A.barra}>
            <select style={A.select} value={grupo} onChange={(e) => setGrupo(e.target.value)}>
              <option value="SEM_ACORDO">Sem acordo ativo ({contagens.semAcordo})</option>
              <option value="COM_ACORDO">Com acordo ativo ({contagens.comAcordo})</option>
              <option value="TODOS">Todos ({itens.length})</option>
            </select>
            <select style={A.select} value={sinal} onChange={(e) => setSinal(e.target.value)}>
              <option value="TODOS">Todos os sinais</option>
              <option value="DINHEIRO">Só os sem selo (parece dinheiro)</option>
              <option value="BLOCO">Só quitação em bloco</option>
              <option value="NEGOCIACAO">Só provável negociação</option>
            </select>
            <select style={A.select} value={dinheiro} onChange={(e) => setDinheiro(e.target.value)}>
              <option value="TODOS">Entrou dinheiro? (todos)</option>
              <option value="ENTROU">Só com pagamento no Santander</option>
              <option value="NAO_ENTROU">Só sem pagamento nenhum</option>
              <option value="OUTRA_DATA">Pagou em outra data</option>
              <option value="FORA_DA_JANELA">Antes de a base ter pagamentos</option>
            </select>
            <select style={A.select} value={cobertura} onChange={(e) => setCobertura(e.target.value)}>
              <option value="TODOS">Cobertura do pagamento (todas)</option>
              <option value="COBRE">Pagamento cobre o dia inteiro</option>
              <option value="PARCIAL">Cobre só parte</option>
              <option value="ABAIXO">Muito abaixo — provável negociação</option>
            </select>
            <select style={A.select} value={acordoSit} onChange={(e) => setAcordoSit(e.target.value)}>
              <option value="TODOS">Acordo no CRM (todos)</option>
              <option value="SEM_ACORDO">Sem acordo — simulação não cumprida</option>
              <option value="ACORDO_ATIVO">Com acordo ativo — cobrança em dobro</option>
              <option value="ACORDO_ENCERRADO">Acordo já encerrado</option>
            </select>
            <select style={A.select} value={ordem} onChange={(e) => setOrdem(e.target.value)}>
              <option value="VALOR_DESC">Maior valor primeiro</option>
              <option value="VALOR_ASC">Menor valor primeiro</option>
              <option value="LIQUIDACAO_DESC">Liquidação mais recente</option>
            </select>
            <input
              style={A.input}
              placeholder="Buscar por nome, CPF ou boleto..."
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
            {dinheiro !== "TODOS" || cobertura !== "TODOS" || grupo !== "TODOS" ? (
              <button
                type="button"
                style={{ ...estilos.btnRejeitar, ...(processando.lote ? A.btnBusy : {}) }}
                disabled={!!processando.lote || filtrados.length === 0}
                onClick={() => rejeitarLote(filtrados, "resultado do filtro atual")}
                title="Marca todos os títulos filtrados como conferidos e não baixados"
              >
                {processando.lote ? "Rejeitando..." : `Rejeitar os ${filtrados.length} filtrados`}
              </button>
            ) : null}
            <div style={A.contadores}>
              <span style={A.contadorAlunos}>{grupos.length} alunos</span>
              <span style={A.contadorAcordos}>{filtrados.length} títulos</span>
              <span style={A.contadorValor}>{moeda(totalFiltrado)}</span>
            </div>
          </div>

          <div style={estilos.aviso}>
            {grupo === "COM_ACORDO" ? (
              <>
                Estes títulos foram liquidados na Prime <b>pela negociação</b> — a dívida virou
                acordo. Se o título segue aberto aqui, ela está sendo contada duas vezes: baixar
                não perdoa nada, para de cobrar em dobro. Confira o acordo do aluno antes.
              </>
            ) : (
              <>
                A Prime registra pagamento e nós continuamos cobrando. Confira o caso antes de
                baixar: a Prime mostra apenas o que foi liquidado, e <b>não distingue</b> dinheiro
                recebido de liquidação por negociação. Alunos com acordo cancelado já ficam fora
                desta lista.
              </>
            )}
          </div>

          {grupos.length === 0 ? (
            <p style={A.muted}>Nenhum título neste filtro.</p>
          ) : (
            <div style={A.cards}>
              {grupos.map((g) => (
                <div key={g.chave} style={A.card}>
                  <div style={A.cardHead}>
                    <div style={A.cardHeadInfo}>
                      <span style={A.cardNome}>{g.nome || "-"}</span>
                      <button
                        type="button"
                        onClick={() => copiarNome(g.nome)}
                        style={estilos.btnCopiar}
                        title="Copiar o nome do aluno"
                      >
                        {nomeCopiado === g.nome ? "✓ Copiado" : "📋 Copiar"}
                      </button>
                      <span style={A.cardCpf}>CPF {formatCpf(g.cpf)}</span>
                      {g.temAcordoAtivo && <span style={estilos.selo}>acordo ativo</span>}
                      {(() => {
                        const c = Number(g.titulos?.[0]?.lote_cobertura);
                        if (!Number.isFinite(c)) return null;
                        const est = c >= 98 ? estilos.seloComDinheiro
                          : c >= 50 ? estilos.seloPortadorAlerta : estilos.seloSemDinheiro;
                        return (
                          <span style={est} title={g.titulos[0].lote_diz || ""}>
                            pagamento cobre {c}% do dia
                          </span>
                        );
                      })()}
                      {g.padrao === "NEGOCIACAO" && (
                        <span
                          style={estilos.seloAlerta}
                          title="Tudo liquidado no mesmo dia, incluindo mensalidade que venceria depois. Isso é negociação, não pagamento — e o acordo não está no CRM."
                        >
                          provável negociação — não baixar
                        </span>
                      )}
                      {g.padrao === "BLOCO" && (
                        <span
                          style={estilos.seloAtencao}
                          title="Tudo liquidado no mesmo dia, mas só de parcelas já vencidas. Pode ser acordo à vista ou pagamento de atrasados juntos."
                        >
                          quitação em bloco — conferir
                        </span>
                      )}
                    </div>
                    <div style={A.cardHeadDir}>
                      <span style={A.cardResumo}>
                        {g.titulos.length} título{g.titulos.length > 1 ? "s" : ""} · {moeda(g.total)}
                        {g.ultimaLiquidacao ? ` · liquidado até ${dia(g.ultimaLiquidacao)}` : ""}
                      </span>
                      <span style={A.cardUnidade}>{g.responsavel}</span>
                      {g.titulos.length > 1 && (
                        <button
                          type="button"
                          style={{
                            ...A.btnConf,
                            ...(processando[`card:${g.chave}`] ? A.btnBusy : {}),
                            ...(g.padrao === "NEGOCIACAO" ? estilos.btnPerigo : {}),
                          }}
                          disabled={!!processando[`card:${g.chave}`]}
                          onClick={() => baixarCard(g)}
                          title={
                            g.padrao === "NEGOCIACAO"
                              ? "Este aluno tem assinatura de negociação — confira antes"
                              : "Baixa todos os títulos deste aluno de uma vez"
                          }
                        >
                          {processando[`card:${g.chave}`]
                            ? "Baixando..."
                            : `Baixar os ${g.titulos.length} títulos`}
                        </button>
                      )}
                      {g.titulos.length > 1 && (
                        <button
                          type="button"
                          style={{ ...estilos.btnRejeitar, ...(processando.lote ? A.btnBusy : {}) }}
                          disabled={!!processando.lote}
                          onClick={() => rejeitarLote(g.titulos, `todos do aluno ${g.nome}`)}
                          title="Confere e tira da fila sem baixar nada"
                        >
                          Rejeitar os {g.titulos.length}
                        </button>
                      )}
                      {g.alunoId && (
                        <button
                          type="button"
                          style={A.btnFicha}
                          onClick={() => setFichaId(g.alunoId)}
                          title="Abrir a ficha para conferir o caso antes de baixar"
                        >
                          Abrir ficha
                        </button>
                      )}
                    </div>
                  </div>

                  <table style={A.tabela}>
                    <thead>
                      <tr>
                        <th style={A.th}>Boleto</th>
                        <th style={A.th}>Vencimento</th>
                        <th style={A.th}>Liquidado na Prime</th>
                        <th style={A.thNum}>O CRM cobra</th>
                        <th style={A.th}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.titulos.map((t) => {
                        const busy = !!processando[t.titulo_id];
                        return (
                          <tr key={t.titulo_id}>
                            <td style={A.td}>{t.documento || "-"}</td>
                            <td style={A.td}>{dia(t.vencimento)}</td>
                            <td style={A.td}>
                              {dia(t.liquidado_em)}
                              {t.portador ? (
                                <span
                                  style={t.portador === 166 ? estilos.seloPortadorOk : estilos.seloPortadorAlerta}
                                  title={t.portador_diz || ""}
                                >
                                  {t.portador === 166 ? "saiu da cobrança" : `portador ${t.portador}`}
                                </span>
                              ) : null}
                              {t.dinheiro === "NAO_ENTROU" && t.acordo_situacao === "SEM_ACORDO" ? (
                                <span style={estilos.seloSimulacao} title={t.acordo_diz || ""}>
                                  simulação não cumprida
                                </span>
                              ) : null}
                              {t.dinheiro === "NAO_ENTROU" ? (
                                <span style={estilos.seloSemDinheiro} title={t.dinheiro_diz || ""}>
                                  sem pagamento no Santander
                                </span>
                              ) : t.dinheiro === "ENTROU" ? (
                                <span style={estilos.seloComDinheiro} title={t.dinheiro_diz || ""}>
                                  pagamento confere
                                </span>
                              ) : t.dinheiro === "OUTRA_DATA" ? (
                                <span style={estilos.seloPortadorAlerta} title={t.dinheiro_diz || ""}>
                                  pagou em outra data
                                </span>
                              ) : null}
                            </td>
                            <td style={A.tdNum}>{moeda(t.valor_em_aberto)}</td>
                            <td style={A.td}>
                              <div style={A.acoes}>
                                <button
                                  type="button"
                                  style={{ ...A.btnConf, ...(busy ? A.btnBusy : {}) }}
                                  disabled={busy}
                                  onClick={() => baixar({ ...t, padraoAluno: g.padrao })}
                                  title="Marca o título como pago e tira da dívida em aberto"
                                >
                                  {busy ? "Baixando..." : "Confirmado"}
                                </button>
                                <button
                                  type="button"
                                  style={{ ...estilos.btnRejeitar, ...(busy ? A.btnBusy : {}) }}
                                  disabled={busy}
                                  onClick={() => rejeitar(t)}
                                  title="A dívida é real: não baixar e tirar da fila"
                                >
                                  Rejeitar
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {fichaId && (
        <div style={A.modalOverlay} onClick={() => setFichaId(null)}>
          <div style={A.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={A.modalTopo}>
              <span style={A.modalTitulo}>Ficha do aluno</span>
              <button
                type="button"
                style={{ ...A.modalFechar, marginLeft: "auto" }}
                onClick={() => setFichaId(null)}
              >
                Fechar ✕
              </button>
            </div>
            <div style={{ padding: "0 16px" }}>
              <DadosAcademicos aluno={{ id: fichaId }} />
            </div>
            <div style={A.modalConteudo}>
              <Aluno fichaEmbedId={fichaId} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const estilos = {
  seloSimulacao: { marginLeft: 6, fontSize: 11, fontWeight: 800, color: "#7c2d12", background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 999, padding: "2px 8px" },
  seloSemDinheiro: { marginLeft: 6, fontSize: 11, fontWeight: 800, color: "#991b1b", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 999, padding: "2px 8px" },
  seloComDinheiro: { marginLeft: 6, fontSize: 11, fontWeight: 800, color: "#166534", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 999, padding: "2px 8px" },
  btnCopiar: { background: "#fff", color: "#475569", border: "1px solid #cbd5e1", borderRadius: 8, padding: "3px 10px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" },
  btnRejeitar: { background: "#fff", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 8, padding: "6px 14px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
  seloPortadorAlerta: { marginLeft: 8, fontSize: 11, fontWeight: 800, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 999, padding: "2px 8px" },
  seloPortadorOk: { marginLeft: 8, fontSize: 11, fontWeight: 800, color: "#166534", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 999, padding: "2px 8px" },
  aviso: {
    background: "#fffbeb",
    border: "1px solid #fde68a",
    color: "#92400e",
    borderRadius: 10,
    padding: "12px 14px",
    fontSize: 13,
    lineHeight: 1.5,
    marginBottom: 14,
  },
  btnPerigo: { background: "#b91c1c" },
  seloAlerta: {
    fontSize: 11,
    fontWeight: 700,
    borderRadius: 999,
    padding: "2px 10px",
    background: "#fef2f2",
    color: "#991b1b",
    border: "1px solid #fecaca",
    whiteSpace: "nowrap",
  },
  seloAtencao: {
    fontSize: 11,
    fontWeight: 700,
    borderRadius: 999,
    padding: "2px 10px",
    background: "#fffbeb",
    color: "#92400e",
    border: "1px solid #fde68a",
    whiteSpace: "nowrap",
  },
  selo: {
    fontSize: 11,
    fontWeight: 700,
    borderRadius: 999,
    padding: "2px 10px",
    background: "#eef2ff",
    color: "#3730a3",
    border: "1px solid #c7d2fe",
    whiteSpace: "nowrap",
  },
};
