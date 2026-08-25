import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando } from "../ui/estados";
import { podeVincularAcordoFila } from "../utils/operadores";
import Aluno from "./Aluno";
import { S } from "../ui/estilosFila";

// Fila de acordos importados para a operacao confirmar/acompanhar.
// A tela agrupa por CPF: 1 card por aluno, com uma tabela de todos os acordos dele.
// As acoes continuam individualizadas por ID do acordo.

const PAGE_SIZE = 1000;

function moeda(n) { return (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }

// CPF somente numeros, completado para 11 digitos (mantem os 11 finais se vier maior).
function normCpf(v) {
  const d = String(v || "").replace(/\D/g, "");
  if (!d) return "";
  return d.length >= 11 ? d.slice(-11) : d.padStart(11, "0");
}

// Data em que o acordo ENTROU na fila (criado_em = importacao). Em prod sao
// ~10 datas distintas de remessa, entao "mais antigos primeiro" separa de fato
// o que esta encalhado desde julho do que chegou ontem.
function ts(v) {
  const t = v ? new Date(v).getTime() : 0;
  return Number.isNaN(t) ? 0 : t;
}

function formatData(v) {
  if (!v) return "-";
  try {
    return new Date(v).toLocaleDateString("pt-BR");
  } catch {
    return "-";
  }
}

function formatCpf(v) {
  const d = normCpf(v);
  if (d.length !== 11) return v || "-";
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

const STATUS_META = {
  A_CONFIRMAR: { rotulo: "A confirmar", estilo: "chipPend" },
  CONFIRMADO: { rotulo: "Confirmado", estilo: "chipOk" },
  REJEITADO: { rotulo: "Rejeitado", estilo: "chipRej" },
  // Aluno nao deve mais nada: nao ha o que confirmar com ele. Sai da fila de
  // trabalho, mas nada e apagado -- fica achavel aqui e da pra reabrir.
  ENCERRADO_SEM_SALDO: { rotulo: "Encerrado sem saldo", estilo: "chipZero" },
};

// Exibição do responsável ESPECÍFICO do acordo, a partir do estado devolvido
// pela RPC public.fila_acordos_responsavel (vínculo por acordo_id explícito).
// Distingue os três casos exigidos, sem inferir por nome/CPF/valor/parcelas:
//   - NAO_VINCULADO   -> "Acordo não vinculado"
//   - SEM_RESPONSAVEL -> "Sem responsável" (acordo vinculado, mas sem operador)
//   - OK              -> nome (prioridade) ou e-mail (fallback)
function exibirResponsavel(resp) {
  const vinculo = resp?.vinculo || "NAO_VINCULADO";
  if (vinculo === "NAO_VINCULADO") return { texto: "Acordo não vinculado", tom: "naoVinc" };
  if (vinculo === "SEM_RESPONSAVEL") return { texto: "Sem responsável", tom: "semResp" };
  const nome = String(resp?.operador_responsavel_nome || "").trim();
  if (nome) return { texto: nome, tom: "ok" };
  const email = String(resp?.operador_responsavel_email || "").trim();
  if (email) return { texto: email, tom: "ok" };
  // OK sem nome/email não deveria ocorrer (a RPC classificaria como SEM_RESPONSAVEL).
  return { texto: "Sem responsável", tom: "semResp" };
}

export default function FilaAcordosConfirmar() {
  const [itens, setItens] = useState([]);
  const [responsaveis, setResponsaveis] = useState({}); // fila_id -> { vinculo, acordo_id, nome, email }
  const [podeVincular, setPodeVincular] = useState(false);
  const [vinculando, setVinculando] = useState(null); // item da fila em vínculo (modal) ou null
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [filtro, setFiltro] = useState("A_CONFIRMAR");
  const [ordem, setOrdem] = useState("VALOR_DESC");
  const [busca, setBusca] = useState("");
  const [email, setEmail] = useState("");
  const [fichaId, setFichaId] = useState(null);
  const [processando, setProcessando] = useState({}); // id do acordo -> true enquanto salva

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getUser();
      const mail = data?.user?.email || "";
      setEmail(mail);
      setPodeVincular(podeVincularAcordoFila(mail));
      await carregar();
      // Caso zerado nao tem o que confirmar: o aluno ja nao deve nada. A rotina
      // tira esses da fila (status ENCERRADO_SEM_SALDO, nada e apagado) sempre
      // que a gestao abre a tela, pra fila nao voltar a acumular conforme os
      // alunos vao pagando. Operador nao tem permissao e o erro e ignorado --
      // a fila carrega normal de qualquer jeito.
      const { data: limpeza, error: erroLimpeza } = await supabase.rpc(
        "fila_acordos_sair_sem_saldo",
        { p_dry_run: false, p_limite: 500 }
      );
      if (!erroLimpeza && Number(limpeza?.encerrados) > 0) carregar();
    })();
  }, []);

  // Busca TODOS os registros paginando por range ate acabar (evita o teto de 1000).
  async function carregar() {
    setCarregando(true);
    setErro("");
    let from = 0;
    const todos = [];
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { data, error } = await supabase
          .from("fila_acordos_confirmar")
          .select("*")
          .order("valor_total", { ascending: false })
          // Desempate estavel: sem uma chave unica na ordenacao, linhas com o
          // mesmo valor_total podem trocar de pagina entre um range e outro e
          // sumir (ou vir duas vezes) da fila. A ordem final da tela e feita
          // no client; aqui a ordem so precisa ser DETERMINISTICA.
          .order("id", { ascending: true })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        const lote = data || [];
        todos.push(...lote);
        if (lote.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }
      setItens(todos);
      // Resolve o responsavel ESPECIFICO de cada acordo (somente leitura).
      // A RPC devolve nome/email apenas quando ha vinculo unico e seguro com
      // public.acordos; caso contrario os campos vem nulos -> "Sem responsavel".
      // Falha aqui nao quebra a fila: apenas nao exibe responsavel.
      try {
        const { data: resp, error: respErr } = await supabase.rpc("fila_acordos_responsavel");
        if (respErr) throw respErr;
        const mapa = {};
        for (const r of resp || []) {
          mapa[r.fila_id] = {
            vinculo: r.vinculo,
            acordo_id: r.acordo_id,
            operador_responsavel_nome: r.operador_responsavel_nome,
            operador_responsavel_email: r.operador_responsavel_email,
          };
        }
        setResponsaveis(mapa);
      } catch {
        setResponsaveis({});
      }
    } catch (e) {
      setErro(e?.message || String(e));
      setItens([]);
    } finally {
      setCarregando(false);
    }
  }

  // Troca o status de UM acordo, identificado SEMPRE pelo id unico (PK) da fila.
  // Nunca por aluno_id/CPF/matricula/card agrupado/indice: acao afeta 1 registro.
  // Estado de processamento e atualizacao sao individuais por id; try/catch/finally
  // garantem que a tela seja sempre liberada, mesmo se a requisicao falhar.
  async function mudarStatus(item, novoStatus) {
    if (!item?.id) return;
    if (processando[item.id]) return; // impede requisicao duplicada enquanto processa
    setProcessando((p) => ({ ...p, [item.id]: true }));
    setErro("");

    const patch = { status_confirmacao: novoStatus };
    if (novoStatus === "CONFIRMADO") {
      patch.operador_email = email;
      patch.confirmado_em = new Date().toISOString();
    } else if (novoStatus === "REJEITADO") {
      patch.operador_email = email;
      patch.confirmado_em = null;
    } else {
      // A_CONFIRMAR (reabrir)
      patch.confirmado_em = null;
    }

    try {
      const { error } = await supabase
        .from("fila_acordos_confirmar")
        .update(patch)
        .eq("id", item.id); // <- exatamente 1 registro, pelo id unico

      if (error) throw error;

      // Atualizacao otimista: mexe SOMENTE no acordo processado.
      // Outros acordos do mesmo aluno permanecem inalterados e visiveis.
      setItens((prev) => prev.map((x) => (x.id === item.id ? { ...x, ...patch } : x)));
    } catch (e) {
      // Mostra o erro real do Supabase.
      setErro(`Erro ao atualizar o acordo ${item.id}: ${e?.message || String(e)}`);
    } finally {
      // Libera SEMPRE o botao clicado, mesmo em caso de falha (evita travar a tela).
      setProcessando((p) => {
        const n = { ...p };
        delete n[item.id];
        return n;
      });
    }
  }

  const rejeitar = (item) => mudarStatus(item, "REJEITADO");
  const reabrir = (item) => mudarStatus(item, "A_CONFIRMAR");

  // Confirma DE UMA VEZ todos os acordos "A confirmar" de um aluno (card).
  // Evita o vai-e-volta de confirmar 1 e o aluno reaparecer pela pendencia do
  // outro. Update em lote pelos ids da fila (nunca por CPF/aluno); mexe SOMENTE
  // nos ids pendentes daquele card. Estado de processamento por grupo (chave).
  async function confirmarTodos(grupo) {
    const pendentes = grupo.acordos.filter((a) => (a.status_confirmacao || "A_CONFIRMAR") === "A_CONFIRMAR");
    if (pendentes.length === 0) return;
    const chaveBusy = `grp:${grupo.chave}`;
    if (processando[chaveBusy]) return;
    setProcessando((p) => ({ ...p, [chaveBusy]: true }));
    setErro("");

    const ids = pendentes.map((a) => a.id);
    const patch = { status_confirmacao: "CONFIRMADO", operador_email: email, confirmado_em: new Date().toISOString() };

    try {
      const { error } = await supabase
        .from("fila_acordos_confirmar")
        .update(patch)
        .in("id", ids); // <- somente os ids pendentes deste card

      if (error) throw error;

      setItens((prev) => prev.map((x) => (ids.includes(x.id) ? { ...x, ...patch } : x)));
    } catch (e) {
      setErro(`Erro ao confirmar todos do aluno ${grupo.nome || formatCpf(grupo.cpf)}: ${e?.message || String(e)}`);
    } finally {
      setProcessando((p) => {
        const n = { ...p };
        delete n[chaveBusy];
        return n;
      });
    }
  }

  // Filtro por status (client-side) + busca por nome/CPF.
  const filtrados = itens.filter((i) => {
    const st = i.status_confirmacao || "A_CONFIRMAR";
    if (filtro !== "TODOS" && st !== filtro) return false;
    if (!busca.trim()) return true;
    const t = busca.trim().toLowerCase();
    const cpfBusca = t.replace(/\D/g, "");
    const nomeOk = String(i.nome || "").toLowerCase().includes(t);
    const cpfOk = cpfBusca && normCpf(i.cpf).includes(cpfBusca);
    return nomeOk || cpfOk;
  });

  // Agrupa por CPF -> 1 card por aluno.
  const grupos = (() => {
    const map = new Map();
    for (const i of filtrados) {
      const cpf = normCpf(i.cpf);
      const chave = cpf || `SEMCPF-${i.id}`;
      if (!map.has(chave)) {
        map.set(chave, { chave, cpf, nome: i.nome, unidade: i.unidade, alunoId: i.aluno_id, acordos: [] });
      }
      map.get(chave).acordos.push(i);
    }
    const arr = Array.from(map.values());
    arr.forEach((g) => {
      g.total = g.acordos.reduce((s, a) => s + (Number(a.valor_total) || 0), 0);
      // O card representa o aluno: a data dele e a do acordo mais ANTIGO da fila
      // (o que esta esperando ha mais tempo), nao a do ultimo que chegou.
      g.entrouEm = g.acordos.reduce((min, a) => {
        const t = ts(a.criado_em);
        return t && (!min || t < min) ? t : min;
      }, 0);
    });
    const porNome = (a, b) => String(a.nome || "").localeCompare(String(b.nome || ""), "pt-BR");
    arr.sort((a, b) => {
      if (ordem === "VALOR_ASC") {
        const v = a.total - b.total;
        return v !== 0 ? v : porNome(a, b);
      }
      if (ordem === "DATA_ASC") {
        const d = a.entrouEm - b.entrouEm;
        return d !== 0 ? d : b.total - a.total;
      }
      if (ordem === "DATA_DESC") {
        const d = b.entrouEm - a.entrouEm;
        return d !== 0 ? d : b.total - a.total;
      }
      const v = b.total - a.total;   // VALOR_DESC (padrao de sempre)
      return v !== 0 ? v : porNome(a, b);
    });
    return arr;
  })();

  const totalAlunos = grupos.length;
  const totalAcordos = filtrados.length;
  const totalValor = filtrados.reduce((s, i) => s + (Number(i.valor_total) || 0), 0);

  return (
    <div style={S.wrap}>
      <div style={S.topo}>
        <div>
          <h1 style={S.titulo}>Fila de confirmação de acordos</h1>
          <p style={S.sub}>Acordos importados para a operação confirmar com o aluno e acompanhar.</p>
        </div>
        <button type="button" style={S.btnGhost} onClick={carregar}>Atualizar</button>
      </div>

      <div style={S.barra}>
        <select style={S.select} value={filtro} onChange={(e) => setFiltro(e.target.value)}>
          <option value="A_CONFIRMAR">A confirmar</option>
          <option value="CONFIRMADO">Confirmados</option>
          <option value="REJEITADO">Rejeitados</option>
          <option value="ENCERRADO_SEM_SALDO">Encerrados sem saldo</option>
          <option value="TODOS">Todos</option>
        </select>
        <select style={S.select} value={ordem} onChange={(e) => setOrdem(e.target.value)}>
          <option value="VALOR_DESC">Maior valor primeiro</option>
          <option value="VALOR_ASC">Menor valor primeiro</option>
          <option value="DATA_ASC">Mais antigos primeiro</option>
          <option value="DATA_DESC">Mais recentes primeiro</option>
        </select>
        <input style={S.input} placeholder="Buscar por nome ou CPF..." value={busca} onChange={(e) => setBusca(e.target.value)} />
        <div style={S.contadores}>
          <span style={S.contadorAlunos}>{totalAlunos} alunos</span>
          <span style={S.contadorAcordos}>{totalAcordos} acordos</span>
          <span style={S.contadorValor}>{moeda(totalValor)}</span>
        </div>
      </div>

      {erro && <div style={S.erroBox}>⚠️ {erro}</div>}

      {carregando ? (
        <Carregando texto="Carregando…" />
      ) : grupos.length === 0 ? (
        <p style={S.muted}>Nenhum acordo nesta fila.</p>
      ) : (
        <div style={S.cards}>
          {grupos.map((g) => (
            <div key={g.chave} style={S.card}>
              <div style={S.cardHead}>
                <div style={S.cardHeadInfo}>
                  <span style={S.cardNome}>{g.nome || "-"}</span>
                  <span style={S.cardCpf}>CPF {formatCpf(g.cpf)}</span>
                  {g.unidade && <span style={S.cardUnidade}>{g.unidade}</span>}
                </div>
                <div style={S.cardHeadDir}>
                  <span style={S.cardResumo}>
                    {g.acordos.length} acordo{g.acordos.length > 1 ? "s" : ""} · {moeda(g.total)}
                    {g.entrouEm ? ` · na fila desde ${formatData(g.entrouEm)}` : ""}
                  </span>
                  {(() => {
                    const pendentes = g.acordos.filter((a) => (a.status_confirmacao || "A_CONFIRMAR") === "A_CONFIRMAR");
                    const busyGrp = !!processando[`grp:${g.chave}`];
                    if (pendentes.length === 0) return null;
                    return (
                      <button
                        type="button"
                        style={{ ...S.btnConf, ...(busyGrp ? S.btnBusy : {}) }}
                        disabled={busyGrp}
                        onClick={() => confirmarTodos(g)}
                        title={
                          pendentes.length > 1
                            ? "Confirma de uma vez todos os acordos pendentes deste aluno"
                            : "Confirma o acordo pendente deste aluno"
                        }
                      >
                        {busyGrp
                          ? "Confirmando..."
                          : pendentes.length > 1
                            ? `Confirmar os ${pendentes.length} acordos`
                            : "Confirmar"}
                      </button>
                    );
                  })()}
                  <button type="button" style={S.btnFicha} onClick={() => setFichaId(g.alunoId)}>Abrir ficha</button>
                </div>
              </div>

              <table style={S.tabela}>
                <thead>
                  <tr>
                    <th style={S.thNum}>Parcelas</th>
                    <th style={S.thNum}>Valor</th>
                    {podeVincular && <th style={S.th}>Responsável pelo acordo</th>}
                    <th style={S.th}>Status</th>
                    <th style={S.th}></th>
                  </tr>
                </thead>
                <tbody>
                  {g.acordos.map((a) => {
                    const st = a.status_confirmacao || "A_CONFIRMAR";
                    const meta = STATUS_META[st] || STATUS_META.A_CONFIRMAR;
                    const busy = !!processando[a.id];
                    const resp = responsaveis[a.id];
                    const view = exibirResponsavel(resp);
                    const estiloResp = view.tom === "ok" ? S.resp : view.tom === "semResp" ? S.respVazio : S.respNaoVinc;
                    return (
                      <tr key={a.id}>
                        <td style={S.tdNum}>{a.qtd_parcelas}</td>
                        <td style={S.tdNum}>{moeda(a.valor_total)}</td>
                        {podeVincular && (
                          <td style={S.td}>
                            <div style={S.respCell}>
                              <span style={estiloResp}>{view.texto}</span>
                              <button
                                type="button"
                                style={S.btnVinc}
                                onClick={() => setVinculando(a)}
                                title="Vincular ou trocar o acordo desta linha"
                              >
                                {resp?.acordo_id ? "Trocar" : "Vincular"}
                              </button>
                            </div>
                          </td>
                        )}
                        <td style={S.td}>
                          <span style={{ ...S.chip, ...S[meta.estilo] }}>{meta.rotulo}</span>
                        </td>
                        <td style={S.td}>
                          <div style={S.acoes}>
                            {/* Confirmar mora SO no cabecalho do card (um botao por
                                aluno). Antes, card de 1 acordo -- a maioria --
                                mostrava dois botoes verdes fazendo a mesma coisa:
                                "Confirmar todos (1)" e "Confirmar". Rejeitar
                                continua por linha: rejeitar e sempre sobre UM
                                acordo especifico, nunca sobre o aluno inteiro. */}
                            {st === "A_CONFIRMAR" && (
                              <button type="button" style={{ ...S.btnRej, ...(busy ? S.btnBusy : {}) }} disabled={busy} onClick={() => rejeitar(a)}>
                                {busy ? "..." : "Rejeitar"}
                              </button>
                            )}
                            {(st === "REJEITADO" || st === "ENCERRADO_SEM_SALDO") && (
                              <button type="button" style={{ ...S.btnMini, ...(busy ? S.btnBusy : {}) }} disabled={busy} onClick={() => reabrir(a)}>
                                {busy ? "..." : "reabrir"}
                              </button>
                            )}
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

      {vinculando && podeVincular && (
        <ModalVincularAcordo
          item={vinculando}
          onClose={() => setVinculando(null)}
          onVinculado={(estado) => {
            // Atualiza SOMENTE a linha vinculada, sem recarregar a tela.
            setResponsaveis((prev) => ({
              ...prev,
              [estado.fila_id]: {
                vinculo:
                  String(estado.operador_responsavel_nome || "").trim() ||
                  String(estado.operador_responsavel_email || "").trim()
                    ? "OK"
                    : "SEM_RESPONSAVEL",
                acordo_id: estado.acordo_id,
                operador_responsavel_nome: estado.operador_responsavel_nome,
                operador_responsavel_email: estado.operador_responsavel_email,
              },
            }));
            setVinculando(null);
          }}
        />
      )}

      {fichaId && (
        <div style={S.modalOverlay} onClick={() => setFichaId(null)}>
          <div style={S.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={S.modalTopo}>
              <span style={S.modalTitulo}>Ficha do aluno</span>
              <button type="button" style={S.modalFechar} onClick={() => setFichaId(null)}>Fechar ✕</button>
            </div>
            <div style={S.modalConteudo}>
              <Aluno fichaEmbedId={fichaId} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Modal de vínculo/troca de acordo. Busca o acordo por identificador SEGURO
// (número do acordo, único) via RPC; exige motivo; uma confirmação e uma
// execução; trava contra duplo clique; libera o botão em sucesso OU erro.
// A autorização definitiva é do banco (RPC SECURITY DEFINER + allowlist).
function ModalVincularAcordo({ item, onClose, onVinculado }) {
  const [numero, setNumero] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [achado, setAchado] = useState(null); // acordo encontrado
  const [motivo, setMotivo] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState("");

  async function buscar() {
    setErro("");
    setAchado(null);
    const n = String(numero).replace(/\D/g, "");
    if (!n) { setErro("Informe o número do acordo."); return; }
    setBuscando(true);
    try {
      const { data, error } = await supabase.rpc("fila_buscar_acordo", { p_numero: Number(n) });
      if (error) throw error;
      if (!data || data.length === 0) { setErro("Nenhum acordo encontrado para esse número."); return; }
      setAchado(data[0]);
    } catch (e) {
      setErro(e?.message || String(e));
    } finally {
      setBuscando(false);
    }
  }

  async function salvar() {
    if (salvando) return; // trava contra duplo clique
    if (!achado?.acordo_id) { setErro("Busque e selecione um acordo válido."); return; }
    if (!motivo.trim()) { setErro("O motivo é obrigatório."); return; }
    setSalvando(true);
    setErro("");
    try {
      const { data, error } = await supabase.rpc("fila_vincular_acordo", {
        p_fila_id: item.id,
        p_acordo_id: achado.acordo_id,
        p_motivo: motivo.trim(),
      });
      if (error) throw error;
      onVinculado(data); // atualiza a tela sem recarregar
    } catch (e) {
      setErro(e?.message || String(e));
    } finally {
      setSalvando(false); // libera o botão em sucesso OU erro
    }
  }

  return (
    <div style={S.modalOverlay} onClick={onClose}>
      <div style={S.vincBox} onClick={(e) => e.stopPropagation()}>
        <div style={S.modalTopo}>
          <span style={S.modalTitulo}>Vincular acordo</span>
          <button type="button" style={S.modalFechar} onClick={onClose}>Fechar ✕</button>
        </div>
        <div style={S.vincCorpo}>
          <p style={S.vincSub}>
            Fila: <b>{item.nome || "-"}</b> · {item.qtd_parcelas} parcelas · {moeda(item.valor_total)}
          </p>

          <label style={S.vincLabel}>Número do acordo (identificador seguro)</label>
          <div style={S.vincLinha}>
            <input
              style={S.input}
              placeholder="Ex.: 12345"
              value={numero}
              onChange={(e) => setNumero(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") buscar(); }}
            />
            <button type="button" style={S.btnGhost} disabled={buscando} onClick={buscar}>
              {buscando ? "Buscando..." : "Buscar"}
            </button>
          </div>

          {achado && (
            <div style={S.vincAchado}>
              <div><b>Acordo #{achado.numero_acordo}</b></div>
              <div style={S.muted}>{achado.qtd_parcelas} parcelas · {moeda(achado.valor_total)}</div>
              <div style={S.muted}>
                Responsável do acordo:{" "}
                {String(achado.operador_responsavel_nome || "").trim() ||
                  String(achado.operador_responsavel_email || "").trim() ||
                  "Sem responsável"}
              </div>
            </div>
          )}

          <label style={S.vincLabel}>Motivo (obrigatório)</label>
          <textarea
            style={S.vincTextarea}
            rows={3}
            placeholder="Descreva o motivo do vínculo/troca..."
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
          />

          {erro && <div style={S.erroBox}>⚠️ {erro}</div>}

          <div style={S.vincAcoes}>
            <button type="button" style={S.btnGhostClaro} onClick={onClose}>Cancelar</button>
            <button
              type="button"
              style={{ ...S.btnConf, ...((salvando || !achado || !motivo.trim()) ? S.btnBusy : {}) }}
              disabled={salvando || !achado || !motivo.trim()}
              onClick={salvar}
            >
              {salvando ? "Salvando..." : "Confirmar vínculo"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
