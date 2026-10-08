import { useCallback, useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import {
  EFEITO_VINCULA, CLASSES_HUMANAS, CLASSES_ADMINISTRATIVAS, motivoSugerido, pedirMotivo,
} from "../utils/emConfirmacao";

// RESOLVER O TITULO QUE ESTA "EM CONFIRMACAO", ONDE ELE APARECE.
//
// Amanda, 23/09/2026: "isso nao pode acontecer, nao conseguir movimentar os
// titulos do aluno preso em algo que nao sei onde corrigir e preciso andar em
// circulos".
//
// O titulo que a Conferencia Prime tira da cobranca some das duas pontas: zera
// o saldo (e a fila do extrato exclui saldo zerado) e nao entra na lista de
// vincular da ficha (que filtrava `status = 'em_aberto'`). Ficava visivel so
// como um rotulo cinza que dizia que OUTRA tela ia decidir -- sem dizer qual,
// sem link e sem botao. Este componente e a saida, e ele vive nos dois lugares
// onde o titulo aparece: a fila do extrato e a ficha do aluno.
//
// NENHUMA REGRA NOVA MORA AQUI. Quem decide o que o clique faz e o banco:
// `conferencia_em_confirmacao_do_aluno` calcula o efeito lendo as mesmas
// funcoes que vao executar, e a acao e sempre uma RPC da Conferencia Prime --
// com as mesmas travas e o mesmo motivo obrigatorio na auditoria. Por isso o
// vinculo daqui NAO chama `vincular_titulos_acordo` direto: so
// `prime_conferencia_vincular` fecha a decisao pendente junto, senao o caso
// sairia do titulo e continuaria na fila da Conferencia Prime para sempre.

const moeda = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dia = (v) => {
  if (!v) return "—";
  const p = String(v).slice(0, 10).split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : String(v);
};

export default function ResolverEmConfirmacao({
  alunoId,
  tituloId = null,      // na ficha, limita ao titulo daquela linha
  podeDecidir = true,
  onResolvido,
  compacto = false,
}) {
  const [itens, setItens] = useState(null);
  const [erro, setErro] = useState("");
  const [decidindo, setDecidindo] = useState(null);
  // QUEM ESCOLHE O ACORDO E A GESTAO, NAO A SUGESTAO.
  //
  // Amanda, 24/09/2026: "eu quero decidir onde vincular, como era antes". Ate
  // aqui este bloco mandava sempre `item.acordo_id` -- o acordo que a deteccao
  // sugeriu -- e nao havia por onde trocar. Quando a sugestao erra, sobrava
  // rejeitar o titulo e vincular pela ficha: duas etapas para uma decisao so.
  // E a sugestao erra: no boleto 4445066 (R$ 3.987,54) ela aponta o acordo
  // 4691, de R$ 981,08.
  //
  // `acordos` vem de `conferencia_acordos_do_aluno`, que calcula o efeito de
  // cada acordo lendo as MESMAS funcoes que vao executar -- a lista nunca
  // oferece o que a trava recusa. `escolha` guarda, por titulo, o acordo que a
  // pessoa marcou; sem marcacao, vale a sugestao.
  const [acordos, setAcordos] = useState([]);
  const [escolha, setEscolha] = useState({});
  // A CLASSE HUMANA — "o que apareceu no Prime".
  //
  // Amanda, 08/10/2026: "esta aparecendo apenas Rejeitar". Estava certo para
  // 84% da fila: medido em producao, 541 dos 641 titulos nao tem NENHUM acordo
  // que a trava aceite, entao Vincular nao podia aparecer. O que faltava nao
  // era um botao escondido — eram as DUAS decisoes da Conferencia Prime que
  // esta tela nunca ofereceu: registrar a classe e encerrar administrativamente.
  //
  // `classe_humana` nao vem de `conferencia_em_confirmacao_do_aluno`. Vem de
  // `prime_conferencia_ficha`, que ja existe e e por titulo. Ela tem portao
  // proprio (`usuario_e_gestao`), mais estreito que o `podeDecidir` da tela:
  // se o portao recusar, as duas decisoes simplesmente nao aparecem — quem
  // decide quem pode e o servidor, nao uma lista de e-mails aqui.
  const [classes, setClasses] = useState({});

  // `buscar` nao mexe em estado: quem guarda e o efeito (com a trava `vivo`,
  // porque na ficha este bloco monta e desmonta a cada troca de aba) e o
  // `decidir`, que precisa da lista nova para avisar quem chamou.
  const buscar = useCallback(async () => {
    const { data, error } = await supabase.rpc("conferencia_em_confirmacao_do_aluno", { p_aluno_id: alunoId });
    return { itens: data || [], erro: error?.message || "" };
  }, [alunoId]);

  useEffect(() => {
    if (!alunoId) return undefined;
    let vivo = true;
    (async () => {
      const r = await buscar();
      if (!vivo) return;
      setErro(r.erro);
      setItens(r.itens);
      // A lista de acordos nao bloqueia o bloco: se ela falhar, continua
      // valendo a sugestao, como antes. O que se perde e a escolha, nao a
      // saida do titulo.
      const { data } = await supabase.rpc("conferencia_acordos_do_aluno", { p_aluno_id: alunoId });
      if (vivo) setAcordos(data || []);
      // Uma ficha por titulo em confirmacao. O erro 42501 (portao da gestao) e
      // esperado e silencioso: sem ficha, sem botao de gestao.
      const alvo = tituloId
        ? (r.itens || []).filter((x) => String(x.titulo_id) === String(tituloId))
        : (r.itens || []);
      const mapa = {};
      for (const it of alvo) {
        const f = await supabase.rpc("prime_conferencia_ficha", { p_titulo_id: it.titulo_id });
        if (!f.error && f.data) mapa[it.titulo_id] = f.data.classe_humana || "";
      }
      if (vivo) setClasses(mapa);
    })();
    return () => { vivo = false; };
  }, [alunoId, buscar, tituloId]);

  // O acordo que vale para este titulo: o marcado pela pessoa ou, na ausencia,
  // o sugerido pela deteccao.
  function acordoDe(item) {
    const id = escolha[item.titulo_id] || item.acordo_id;
    return acordos.find((a) => String(a.acordo_id) === String(id)) || null;
  }

  async function decidir(item, acao) {
    if (decidindo) return;
    let motivo = null;
    if (acao === "VINCULAR") {
      const alvo = acordoDe(item);
      const numero = alvo?.numero || item.acordo_numero;
      const efeito = alvo?.efeito_texto || item.efeito_texto;
      const pergunta =
        `${efeito}\n\nVincular o boleto ${item.documento} (${moeda(item.valor)}) ao acordo ${numero}` +
        `${alvo?.valor_total != null ? ` (${moeda(alvo.valor_total)})` : ""}?\n\n` +
        "Por que este acordo cobre esta mensalidade?";
      // O motivo vem pronto, com os dois valores: so confirmar. O banco recusa
      // abaixo de 10 caracteres, mas digitar nao e o que a auditoria precisa.
      if (item.exige_motivo) {
        motivo = pedirMotivo(pergunta, undefined, motivoSugerido(item, alvo));
        if (!motivo) return;
      } else if (!window.confirm(pergunta)) return;
    } else if (acao === "CLASSIFICAR") {
      // A classe vem de um prompt com a lista, porque o banco recusa qualquer
      // valor fora das sete (CLASSE_INVALIDA) e a observacao e obrigatoria.
      const menu = CLASSES_HUMANAS.map((c, i) => `${i + 1}. ${c.rotulo}`).join("\n");
      const escolhido = window.prompt(
        `O que apareceu no Prime para o boleto ${item.documento} (${moeda(item.valor)})?\n\n${menu}\n\nDigite o número:`,
        "");
      if (escolhido === null) return;
      const idx = Number(String(escolhido).trim()) - 1;
      const classe = CLASSES_HUMANAS[idx];
      if (!classe) { alert("Escolha um número de 1 a " + CLASSES_HUMANAS.length + "."); return; }
      motivo = pedirMotivo(
        `Registrar "${classe.rotulo}" para o boleto ${item.documento}.\n\nIsto não decide o título: só grava o que a gestão viu no Prime, com seu nome e a data.\n\nO que apareceu lá?`,
        undefined, `${classe.rotulo.toLowerCase()} conferido no Prime para o boleto ${item.documento}`);
      if (!motivo) return;
      setDecidindo(item.titulo_id);
      try {
        const r = await supabase.rpc("prime_conferencia_classificar_humano",
          { p_titulo_id: item.titulo_id, p_classe: classe.valor, p_obs: motivo });
        if (r.error) throw r.error;
        setClasses((c) => ({ ...c, [item.titulo_id]: classe.valor }));
      } catch (e) {
        alert("Não foi possível registrar: " + (e?.message || String(e)));
      } finally {
        setDecidindo(null);
      }
      return;
    } else if (acao === "ENCERRAR") {
      motivo = pedirMotivo(
        `ENCERRAR ADMINISTRATIVAMENTE o boleto ${item.documento} (${moeda(item.valor)}).\n\n` +
        "O título passa a CANCELADA e sai da cobrança. Não vira pago e não cria acordo, parcela nem pagamento — o banco recusa a operação se qualquer um desses nascer.\n\n" +
        "Por que este título não deve mais ser cobrado?");
      if (!motivo) return;
    } else if (acao === "SEGUIR") {
      motivo = pedirMotivo(
        `O boleto ${item.documento} volta ao fluxo oficial de pagamento e sai desta fila; o motor conclui. Nada é marcado pago aqui.\n\nPor que este pagamento é deste título?`);
      if (!motivo) return;
    } else {
      motivo = pedirMotivo(
        `Rejeitar: o boleto ${item.documento} (${moeda(item.valor)}) volta a ser cobrado, em aberto. A mesma evidência não o traz de volta.\n\nPor que a liquidação não vale?`);
      if (!motivo) return;
    }
    setDecidindo(item.titulo_id);
    try {
      let r;
      if (acao === "VINCULAR") {
        r = await supabase.rpc("prime_conferencia_vincular",
          { p_titulo_id: item.titulo_id,
            p_acordo_id: acordoDe(item)?.acordo_id || item.acordo_id,
            p_observacao: motivo });
      } else if (acao === "ENCERRAR") {
        r = await supabase.rpc("prime_conferencia_encerrar_administrativo",
          { p_titulo_id: item.titulo_id, p_observacao: motivo });
      } else if (acao === "SEGUIR") {
        r = await supabase.rpc("prime_conferencia_seguir_pagamento",
          { p_titulo_id: item.titulo_id, p_pagamento_id: item.pagamento_id, p_motivo: motivo });
      } else {
        r = await supabase.rpc("prime_conferencia_rejeitar",
          { p_titulo_id: item.titulo_id, p_motivo: motivo });
      }
      if (r.error) throw r.error;
      const r2 = await buscar();
      setErro(r2.erro);
      setItens(r2.itens);
      if (onResolvido) onResolvido(r2.itens);
    } catch (e) {
      alert("Não foi possível concluir: " + (e?.message || String(e)));
    } finally {
      setDecidindo(null);
    }
  }

  if (!alunoId) return null;
  if (itens === null) return <div style={estilos.aviso}>Carregando o que está em confirmação…</div>;
  if (erro) return <div style={{ ...estilos.aviso, color: "var(--rv-vermelho-texto)" }}>{erro}</div>;

  const lista = tituloId ? itens.filter((x) => String(x.titulo_id) === String(tituloId)) : itens;
  if (!lista.length) return compacto ? null : <div style={estilos.aviso}>Nada em confirmação.</div>;

  return (
    <div>
      {lista.map((item) => {
        const ocupado = decidindo === item.titulo_id;
        // `undefined` = ficha ainda nao respondeu ou o portao da gestao recusou.
        // String vazia = respondeu e o titulo ainda nao tem classe.
        const classeCarregada = Object.prototype.hasOwnProperty.call(classes, item.titulo_id);
        const classeAtual = classes[item.titulo_id] || "";
        // O acordo que vale agora e o efeito DELE -- nao o da sugestao.
        const alvo = acordoDe(item);
        const efeitoAtual = alvo?.efeito || item.efeito;
        const efeitoTextoAtual = alvo?.efeito_texto || item.efeito_texto;
        const numeroAtual = alvo?.numero || item.acordo_numero;
        return (
          <div key={item.titulo_id} style={compacto ? estilos.itemCompacto : estilos.item}>
            <div style={{ minWidth: 240, flex: 1 }}>
              {!compacto && (
                <div style={estilos.cabecalhoItem}>
                  Boleto {item.documento} · venc. {dia(item.vencimento)} · {moeda(item.valor)}
                </div>
              )}
              {/* O que o clique VAI fazer, dito pelo banco: quem decide e
                  vincular_titulos_acordo mais a trava do acordo quitado sem
                  dinheiro real, nao um texto escrito aqui. */}
              <div style={estilos.explica}>{efeitoTextoAtual}</div>
              {/* A ESCOLHA DO ACORDO. Cada opcao traz o VALOR ao lado do
                  numero: e a conferencia que nenhuma rota de vinculo fazia --
                  a sugestao deste boleto pode ser um acordo de um quarto do
                  valor da mensalidade. O que a trava recusa aparece desabilitado
                  com o motivo, em vez de falhar depois do clique. */}
              {podeDecidir && acordos.length > 0 && (
                <label style={estilos.escolhaLinha}>
                  <span style={estilos.escolhaRotulo}>Vincular ao acordo:</span>
                  <select
                    style={estilos.escolhaSelect}
                    value={escolha[item.titulo_id] || item.acordo_id || ""}
                    disabled={!!decidindo}
                    onChange={(e) =>
                      setEscolha((a) => ({ ...a, [item.titulo_id]: e.target.value }))
                    }
                  >
                    {!item.acordo_id && <option value="">— escolha o acordo —</option>}
                    {acordos.map((a) => (
                      <option key={a.acordo_id} value={a.acordo_id} disabled={!a.aceita_vinculo}>
                        {`nº ${a.numero} · ${moeda(a.valor_total)} · ${a.qtd_parcelas}x · ${a.status}`}
                        {a.aceita_vinculo ? "" : ` — ${a.efeito_texto}`}
                        {String(a.acordo_id) === String(item.acordo_id) ? " (sugerido)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div style={estilos.detalhe}>
                {item.dias_pendente} dia{item.dias_pendente === 1 ? "" : "s"} parado
                {item.pagamento_data
                  ? ` · pagamento ${dia(item.pagamento_data)} de ${moeda(item.pagamento_valor)}${item.pagamento_status ? ` (${String(item.pagamento_status).toLowerCase()})` : ""}`
                  : ""}
              </div>
              {!podeDecidir && (
                <div style={estilos.detalhe}>
                  A decisão é da gestão financeira — Financeiro → Conferência Prime.
                </div>
              )}
            </div>
            {podeDecidir && (
              <div style={estilos.acoes}>
                {EFEITO_VINCULA.has(efeitoAtual) ? (
                  <button type="button" style={ocupado ? estilos.btnOcupado : estilos.btnResolver}
                    disabled={!!decidindo} onClick={() => decidir(item, "VINCULAR")}
                    title={efeitoTextoAtual}>
                    {ocupado ? "Processando…"
                      : `${efeitoAtual === "VIRA_PAGO" ? "Vincular e quitar" : "Vincular"} acordo ${numeroAtual}`}
                  </button>
                ) : null}
                {item.pode_seguir_pagamento ? (
                  <button type="button" style={estilos.btnNeutro} disabled={!!decidindo}
                    onClick={() => decidir(item, "SEGUIR")}
                    title="O título volta ao fluxo oficial de pagamento e o motor conclui. Nada é marcado pago aqui.">
                    Seguir pagamento
                  </button>
                ) : null}
                {/* REGISTRAR A CLASSE. Só aparece quando `prime_conferencia_ficha`
                    respondeu — ou seja, quando o portão da gestão deixou. Não
                    decide o título: grava o que a gestão viu no Prime, e é
                    pré-requisito do encerramento administrativo. */}
                {classeCarregada ? (
                  <button type="button" style={estilos.btnNeutro} disabled={!!decidindo}
                    onClick={() => decidir(item, "CLASSIFICAR")}
                    title="Grava o que apareceu no Prime, com seu nome e a data. Não muda o título.">
                    {classeAtual
                      ? `Classe: ${rotuloClasse(classeAtual)} — trocar`
                      : "Registrar o que apareceu no Prime"}
                  </button>
                ) : null}
                {/* ENCERRAR ADMINISTRATIVAMENTE. `prime_conferencia_encerrar_administrativo`
                    recusa sem classe (SEM_CLASSE_HUMANA) e recusa classe que
                    não seja cancelamento/estorno ou isenção/FIES/bolsa
                    (CLASSE_NAO_ADMINISTRATIVA). A mesma condição aqui. */}
                {CLASSES_ADMINISTRATIVAS.has(classeAtual) ? (
                  <button type="button" style={estilos.btnEncerrar} disabled={!!decidindo}
                    onClick={() => decidir(item, "ENCERRAR")}
                    title="O título passa a CANCELADA e sai da cobrança. Não vira pago.">
                    Encerrar administrativamente
                  </button>
                ) : null}
                <button type="button" style={estilos.btnNeutro} disabled={!!decidindo}
                  onClick={() => decidir(item, "REJEITAR")}
                  title="A liquidação não vale: o título volta a ser cobrado, em aberto.">
                  Rejeitar
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function rotuloClasse(valor) {
  return CLASSES_HUMANAS.find((c) => c.valor === valor)?.rotulo || valor;
}

const estilos = {
  btnEncerrar: {
    background: "var(--rv-superficie)", color: "var(--rv-ambar-texto)",
    border: "1px solid var(--rv-ambar-borda)", borderRadius: 8,
    padding: "5px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer",
  },
  aviso: { fontSize: 11.5, color: "var(--rv-texto-suave)" },
  item: {
    display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap",
    padding: "7px 0", borderTop: "1px solid var(--rv-borda-forte)",
  },
  itemCompacto: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 4 },
  cabecalhoItem: { fontSize: 12.5, fontWeight: 800, color: "var(--rv-texto-forte)" },
  explica: { fontSize: 11.5, color: "var(--rv-texto-suave)", marginTop: 2 },
  detalhe: { fontSize: 11, color: "var(--rv-texto-fraco)", marginTop: 2 },
  acoes: { display: "flex", gap: 6, flexWrap: "wrap" },
  escolhaLinha: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 4 },
  escolhaRotulo: { fontSize: 11, color: "var(--rv-texto-fraco)", fontWeight: 700 },
  escolhaSelect: {
    background: "var(--rv-superficie)", color: "var(--rv-texto)",
    border: "1px solid var(--rv-borda-forte)", borderRadius: 8,
    padding: "3px 7px", fontSize: 11.5, fontWeight: 600, maxWidth: 420,
  },
  btnResolver: {
    background: "#0f766e", color: "#fff", border: "none", borderRadius: 8,
    padding: "5px 13px", fontSize: 12, fontWeight: 800, cursor: "pointer",
  },
  btnOcupado: {
    background: "var(--rv-borda)", color: "var(--rv-texto)", border: "none", borderRadius: 8,
    padding: "5px 13px", fontSize: 12, fontWeight: 800, cursor: "wait",
  },
  btnNeutro: {
    background: "var(--rv-superficie)", color: "var(--rv-texto)",
    border: "1px solid var(--rv-borda-forte)", borderRadius: 8,
    padding: "5px 11px", fontSize: 12, fontWeight: 700, cursor: "pointer",
  },
};
