// Fila de pagamentos sem vinculo -- a fila de excecao do dinheiro.
//
// POR QUE EXISTE. O extrato de pagamentos nao traz CPF, e ate 28/08/2026 a
// importacao tambem descartava a matricula (coluna B vem como
// "2026002333 - Nome"). Resultado: pagamento entrava sem nenhum vinculo com a
// base.
//
// MUDANCA DE 14/09/2026. A fila deixou de ser "pagamento sem aluno" e passou a
// ser "pagamento que nao baixou". O eixo antigo era `aluno_id IS NULL`, e ele
// escondia o caso mais caro: pagamento com aluno JA identificado (por boleto
// exato ou por numero Ulbra unico) cuja parcela nao baixou. Medido no arquivo
// de 14/09: 11 linhas / R$ 4.655,12 entravam sem registro nenhum do motivo.
// Agora entra na fila tudo que `pagamentos.status_conciliacao` diz que nao
// terminou em BAIXADO, com ou sem aluno.
//
// MUDANCA DE 12/09/2026. O nome deixou de vincular. A regra agora e, em ordem:
// CPF -> boleto exato -> prefixo UNICO -> numero_ulbra UNICO -> SEM VINCULO.
// O que nao tem identificador financeiro cai aqui e exige decisao humana.
// Medido: em lotes reais, 30 a 40% das linhas caem nesta fila. Por isso a fila
// entrou no menu -- antes a rota existia e ninguem a alcancava.
//
// Cada linha mostra DOIS motivos, que respondem perguntas diferentes:
//   motivo FINANCEIRO  -> por que nenhum identificador resolveu (vem de
//                         fila_pagamento_sem_vinculo.motivo)
//   motivo por NOME    -> NOME_REPETIDO / SEM_CADASTRO, so para a pessoa saber
//                         se existe homonimo antes de decidir
//
// Os candidatos por nome sao SUGESTAO. Nenhum deles vincula sozinho, nem aqui
// nem no banco: quem grava e pagamento_vincular_aluno, que exige gestao,
// registra origem_vinculo = 'GESTAO_MANUAL' e fecha a linha da fila com quem
// decidiu e quando.
//
// MUDANCA DE 16/09/2026. A acao da linha corresponde ao ponto exato em que o
// pagamento travou (`pagamentos_trava`). Em AGUARDANDO_ACORDO com aluno provado
// por matricula + nome, a trava e o acordo, nao o aluno: a linha diz "Aluno
// identificado · acordo nao encontrado" e oferece "Registrar acordo a vista" --
// nunca "Vincular aluno".
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { S } from "../ui/estilosFila";
import CadastroNovoAluno from "../components/CadastroNovoAluno";
import {
  STATUS_CONCILIACAO,
  acaoDaLinha,
  ACOES_DA_FILA,
  contarPorStatus,
  AVISO_PROJECAO,
  podeEncerrarPendencia,
  CONCLUSOES_FEITO,
  MOTIVOS_REJEICAO,
  FEITO_AVISO,
  REJEITAR_AVISO,
  finalizacaoInvalida,
} from "../utils/conciliacaoPagamento";
import RegistrarAcordoAvista from "../components/RegistrarAcordoAvista";
import Aluno from "./Aluno";
import DadosAcademicos from "../components/DadosAcademicos";

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function dataCurta(d) {
  if (!d) return "-";
  const [a, m, dia] = String(d).slice(0, 10).split("-");
  return `${dia}/${m}/${a}`;
}
function mesAtual() {
  const h = new Date();
  return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, "0")}`;
}

export default function PagamentosSemAluno() {
  const [mes, setMes] = useState(mesAtual());
  // Pendencia NAO se esconde atras do mes corrente. Os pagamentos em aberto
  // hoje sao todos de 2026-07: com o filtro no mes corrente a tela abria
  // dizendo "tudo baixado" com 6 pendencias na base -- pior que uma fila
  // cheia, porque parece resolvido. O checkbox continua ali para restringir a
  // um mes quando alguem quiser; o padrao e ver tudo que esta em aberto.
  const [todosOsMeses, setTodosOsMeses] = useState(true);
  const [linhas, setLinhas] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  const [filtro, setFiltro] = useState("TODOS");
  const [abertoId, setAbertoId] = useState(null);
  const [fichaId, setFichaId] = useState(null);
  const [nomeCopiado, setNomeCopiado] = useState("");
  const [travas, setTravas] = useState(null);
  const [registrando, setRegistrando] = useState(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro("");
    const { data, error } = await supabase.rpc("pagamentos_sem_aluno", {
      p_mes: mes,
      p_todos_os_meses: todosOsMeses,
    });
    if (error) {
      // `permission denied for function` e a ACL do Postgres respondendo: a
      // requisicao chegou sem JWT valido e o PostgREST usou a chave anonima.
      // Nao e erro de permissao da pessoa -- e sessao vencida. Jogar o texto
      // cru do banco na tela nao diz isso a ninguem.
      if (/permission denied for function/i.test(error.message))
        setErro("Sua sessão expirou. Recarregue a página e entre novamente.");
      // O portao interno da RPC, quando quem chama nao e da gestao financeira.
      else if (/gest[aã]o financeira/i.test(error.message))
        setErro("Esta fila é da gestão financeira.");
      else setErro(error.message);
    }
    setLinhas(data || []);
    setCarregando(false);

    // Em que ponto cada "aguardando acordo" travou. Sem esta resposta a linha
    // fica sem acao -- acao generica e o que a regra da tela proibe.
    const ids = (data || [])
      .filter((l) => l.status_conciliacao === "AGUARDANDO_ACORDO")
      .map((l) => l.pagamento_id);
    if (ids.length === 0) { setTravas({}); return; }
    setTravas(null);
    const { data: t, error: erroTrava } = await supabase.rpc("pagamentos_trava", { p_pagamento_ids: ids });
    const mapa = {};
    if (!erroTrava) for (const x of t || []) if (x && x.pagamento_id) mapa[x.pagamento_id] = x;
    setTravas(mapa);
  }, [mes, todosOsMeses]);

  useEffect(() => { carregar(); }, [carregar]);

  // O filtro passou a ser pelo ESTADO da conciliacao. O motivo por nome
  // (NOME_REPETIDO / SEM_CADASTRO) continua aparecendo na linha, mas nao serve
  // mais de filtro: ele so existe para as linhas sem aluno, e a fila agora tem
  // linhas com aluno.
  const visiveis = useMemo(
    () =>
      filtro === "TODOS"
        ? linhas
        : linhas.filter((l) => (l.status_conciliacao || "SEM_ESTADO") === filtro),
    [linhas, filtro],
  );
  const porStatus = useMemo(() => contarPorStatus(linhas), [linhas]);
  const total = useMemo(
    () => visiveis.reduce((s, l) => s + Number(l.valor_pago || 0), 0),
    [visiveis],
  );

  function copiarNome(nome) {
    navigator.clipboard.writeText(nome || "").then(() => {
      setNomeCopiado(nome);
      setTimeout(() => setNomeCopiado(""), 1500);
    });
  }

  return (
    <div style={S.wrap}>
      <div style={S.topo}>
        <div>
          <h1 style={S.titulo}>Pagamentos a conciliar</h1>
          <p style={S.sub}>
            Pagamento que entrou e <b>não baixou parcela</b> — falta o acordo, falta amarrar
            o boleto, a parcela já estava paga, ou há divergência. Também entra aqui o que
            nenhum identificador financeiro resolveu. <b>Nome não vincula</b>: aparece só
            como sugestão, e a decisão é sua. {AVISO_PROJECAO}
          </p>
        </div>
        <button type="button" onClick={carregar} style={S.btnGhost} disabled={carregando}>
          {carregando ? "Carregando…" : "Atualizar"}
        </button>
      </div>

      <div style={S.barra}>
        <input
          type="month"
          value={mes}
          onChange={(e) => setMes(e.target.value)}
          style={{ ...S.select, opacity: todosOsMeses ? 0.5 : 1 }}
          disabled={todosOsMeses}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "var(--rv-texto)" }}>
          <input
            type="checkbox"
            checked={todosOsMeses}
            onChange={(e) => setTodosOsMeses(e.target.checked)}
          />
          Toda a pendência, qualquer mês
        </label>
        <select value={filtro} onChange={(e) => setFiltro(e.target.value)} style={S.select}>
          <option value="TODOS">Todos ({linhas.length})</option>
          {Object.entries(STATUS_CONCILIACAO)
            .filter(([chave]) => chave !== "BAIXADO")
            .map(([chave, def]) => (
              <option key={chave} value={chave}>
                {def.rotulo} ({porStatus[chave] || 0})
              </option>
            ))}
          <option value="SEM_ESTADO">Anterior à regra ({porStatus.SEM_ESTADO || 0})</option>
        </select>
        <div style={S.contadores}>
          <span style={S.contadorAlunos}>{visiveis.length} pagamentos</span>
          <span style={S.contadorValor}>{moeda(total)}</span>
        </div>
      </div>

      {erro ? <div style={S.erroBox}>{erro}</div> : null}

      {!carregando && visiveis.length === 0 ? (
        <p style={S.muted}>
          Nenhum pagamento pendente de conciliação neste mês. Tudo baixado.
        </p>
      ) : null}

      <div style={S.cards}>
        {visiveis.map((l) => (
          <Linha
            key={l.pagamento_id}
            item={l}
            acao={acaoDaLinha(l, travas)}
            onRegistrar={() => setRegistrando(l)}
            aberto={abertoId === l.pagamento_id}
            onAbrir={() => setAbertoId(abertoId === l.pagamento_id ? null : l.pagamento_id)}
            onVinculado={carregar}
            onVerFicha={setFichaId}
            onCopiar={copiarNome}
            nomeCopiado={nomeCopiado}
          />
        ))}
      </div>

      {registrando ? (
        <RegistrarAcordoAvista
          item={registrando}
          onFechar={() => setRegistrando(null)}
          onRegistrado={carregar}
        />
      ) : null}

      {fichaId && (
        <div style={S.modalOverlay} onClick={() => setFichaId(null)}>
          <div style={S.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={S.modalTopo}>
              <span style={S.modalTitulo}>Ficha do aluno</span>
              <button
                type="button"
                style={{ ...S.modalFechar, marginLeft: "auto" }}
                onClick={() => setFichaId(null)}
              >
                Fechar ✕
              </button>
            </div>
            <div style={{ padding: "0 16px" }}>
              <DadosAcademicos aluno={{ id: fichaId }} />
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

function Linha({ item, acao, onRegistrar, aberto, onAbrir, onVinculado, onVerFicha, onCopiar, nomeCopiado }) {
  const [termo, setTermo] = useState("");
  const [resultados, setResultados] = useState(null);
  const [buscando, setBuscando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState("");
  // null | "FEITO" | "REJEITAR"
  const [finalizando, setFinalizando] = useState(null);
  const [escolha, setEscolha] = useState("");
  const [observacao, setObservacao] = useState("");

  const repetido = item.motivo === "NOME_REPETIDO";
  const podeVincular = acao.acao === "VINCULAR_ALUNO";
  // sugestoes vem da fila (jsonb). Nunca sao aplicadas: so oferecidas.
  const sugestoes = Array.isArray(item.sugestoes) ? item.sugestoes.filter((x) => x && x.aluno_id) : [];

  async function buscar() {
    const t = termo.trim();
    if (t.length < 3) { setMsg("Digite ao menos 3 letras ou o CPF."); return; }
    setBuscando(true); setMsg("");
    const { data, error } = await supabase.rpc("buscar_aluno", { p_termo: t });
    if (error) setMsg("Erro na busca: " + error.message);
    setResultados(data || []);
    setBuscando(false);
  }

  async function vincular(alunoId, nomeAluno) {
    if (!window.confirm(
      `Vincular o pagamento de ${moeda(item.valor_pago)} (${dataCurta(item.data_pagamento)}) ao aluno ${nomeAluno}?`
    )) return;
    setSalvando(true); setMsg("");
    const { data, error } = await supabase.rpc("pagamento_vincular_aluno", {
      p_pagamento_id: item.pagamento_id,
      p_aluno_id: alunoId,
      p_observacao:
        `Fila de pagamentos sem vínculo. Boleto ${item.numero_parcela_completo || "(sem)"}. ` +
        `Motivo: ${item.motivo_financeiro || item.motivo}.`,
    });
    setSalvando(false);
    if (error) { setMsg("Erro: " + error.message); return; }
    if (!data?.ok) { setMsg("Não foi possível: " + (data?.motivo || "desconhecido")); return; }
    onVinculado();
  }

  // FEITO e REJEITAR sao decisoes de revisao, nao correcao financeira: o banco
  // so grava a decisao da fila e a auditoria com o estado anterior. Rejeitar,
  // em particular, NAO apaga nada e NAO desfaz o pagamento.
  async function finalizar() {
    const impede = finalizacaoInvalida({ acao: finalizando, escolha, observacao });
    if (impede) { setMsg(impede); return; }

    const aviso = finalizando === "REJEITAR" ? REJEITAR_AVISO : FEITO_AVISO;
    const verbo = finalizando === "REJEITAR" ? "Rejeitar" : "Concluir";
    if (!window.confirm(
      `${verbo} a pendência do pagamento de ${moeda(item.valor_pago)} (${dataCurta(item.data_pagamento)})? ${aviso}`
    )) return;

    setSalvando(true); setMsg("");
    const obs = observacao.trim() === "" ? null : observacao.trim();
    const { data, error } = finalizando === "REJEITAR"
      ? await supabase.rpc("conciliacao_rejeitar", {
          p_pagamento_id: item.pagamento_id, p_motivo: escolha, p_observacao: obs,
        })
      : await supabase.rpc("conciliacao_feito", {
          p_pagamento_id: item.pagamento_id, p_conclusao: escolha, p_observacao: obs,
        });
    setSalvando(false);
    if (error) { setMsg("Erro: " + error.message); return; }
    if (!data?.ok) { setMsg("Não foi possível: " + (data?.motivo || "desconhecido")); return; }
    setFinalizando(null); setEscolha(""); setObservacao("");
    onVinculado();
  }

  function abrirFinalizacao(acao) {
    setMsg("");
    setEscolha("");
    setFinalizando((v) => (v === acao ? null : acao));
  }

  return (
    <div style={S.card}>
      <div style={S.cardHead}>
        <div style={S.cardHeadInfo}>
          <span style={S.cardNome}>{item.aluno_nome || "(sem nome no arquivo)"}</span>
          {item.aluno_nome ? (
            <button
              type="button"
              onClick={() => onCopiar && onCopiar(item.aluno_nome)}
              style={btnCopiarNome}
              title="Copiar o nome como veio no arquivo"
            >
              {nomeCopiado === item.aluno_nome ? "✓ Copiado" : "📋 Copiar"}
            </button>
          ) : null}
          <span style={S.cardCpf}>
            {dataCurta(item.data_pagamento)} · boleto {item.numero_parcela_completo || "(sem)"}
            {item.titulo_numero ? ` · título ${item.titulo_numero}` : ""}
            {item.matricula ? ` · matrícula ${item.matricula}` : ""}
            {item.arquivo_nome ? ` · ${item.arquivo_nome}` : ""}
          </span>
        </div>
        <div style={S.cardHeadDir}>
          <span style={seloEstado} title={acao.explica}>{acao.rotulo}</span>
          {podeVincular ? (
            <span style={repetido ? selo.repetido : selo.semCadastro}>
              {repetido ? `${item.candidatos} alunos com esse nome` : "sem cadastro na base"}
            </span>
          ) : null}
          <span style={S.contadorValor}>{moeda(item.valor_pago)}</span>
          <span style={S.cardCpf}>{item.operador_nome || "(sem operador)"}</span>
          {acao.acao === "REGISTRAR_ACORDO_AVISTA" ? (
            <button type="button" onClick={onRegistrar} style={S.btnGhost}>
              {ACOES_DA_FILA.REGISTRAR_ACORDO_AVISTA}
            </button>
          ) : podeVincular ? (
            <button type="button" onClick={onAbrir} style={S.btnGhost}>
              {aberto ? "Fechar" : ACOES_DA_FILA.VINCULAR_ALUNO}
            </button>
          ) : acao.carregando ? null : (
            // Sem acao manual para este ponto. A pendencia e de amarracao, de
            // estrutura do acordo, de rodada ou de revisao -- nenhuma delas se
            // resolve trocando o aluno, e oferecer "Vincular" aqui so daria a
            // chance de sobrescrever um vinculo correto. Enquanto o diagnostico
            // carrega, nada aqui: "sem acao manual" ainda nao e verdade.
            <span style={S.cardCpf} title={acao.explica}>
              {item.tem_aluno ? "aluno já identificado" : "sem ação manual"}
            </span>
          )}
          {podeEncerrarPendencia(item) ? (
            <>
              <button
                type="button"
                onClick={() => abrirFinalizacao("FEITO")}
                style={btnEncerrar}
                title={FEITO_AVISO}
              >
                {finalizando === "FEITO" ? "Fechar" : ACOES_DA_FILA.FEITO}
              </button>
              <button
                type="button"
                onClick={() => abrirFinalizacao("REJEITAR")}
                style={btnEncerrar}
                title={REJEITAR_AVISO}
              >
                {finalizando === "REJEITAR" ? "Fechar" : ACOES_DA_FILA.REJEITAR}
              </button>
            </>
          ) : null}
        </div>
      </div>

      {finalizando ? (
        <div style={encerrarCaixa}>
          <div style={{ fontWeight: 700, color: "var(--rv-tinta)", fontSize: 13 }}>
            {finalizando === "REJEITAR" ? ACOES_DA_FILA.REJEITAR : ACOES_DA_FILA.FEITO}
          </div>
          <p style={{ ...S.muted, margin: "6px 0 10px" }}>
            {finalizando === "REJEITAR" ? REJEITAR_AVISO : FEITO_AVISO}
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select
              value={escolha}
              onChange={(e) => setEscolha(e.target.value)}
              style={S.input}
              aria-label={finalizando === "REJEITAR" ? "Motivo da rejeição" : "Conclusão"}
            >
              <option value="">
                {finalizando === "REJEITAR" ? "Motivo da rejeição…" : "Conclusão…"}
              </option>
              {(finalizando === "REJEITAR" ? MOTIVOS_REJEICAO : CONCLUSOES_FEITO).map((o) => (
                <option key={o.valor} value={o.valor}>{o.rotulo}</option>
              ))}
            </select>
            <input
              value={observacao}
              onChange={(e) => setObservacao(e.target.value)}
              placeholder={
                finalizacaoInvalida({ acao: finalizando, escolha, observacao: "" })
                  && escolha ? "Observação (obrigatória)" : "Observação (opcional)"
              }
              style={S.input}
            />
            <button
              type="button"
              onClick={finalizar}
              disabled={salvando || !!finalizacaoInvalida({ acao: finalizando, escolha, observacao })}
              style={S.btnGhost}
            >
              {salvando ? "…" : finalizando === "REJEITAR" ? "Confirmar rejeição" : "Confirmar conclusão"}
            </button>
          </div>
        </div>
      ) : null}

      <div style={motivoBox}>
        <span style={motivoRotulo}>por que caiu aqui</span>
        {acao.trava ? (
          // O motor so sabe que o boleto nao achou parcela; a trava diz o que
          // falta de fato. O texto do motor fica como registro, em segundo plano.
          <span style={motivoTexto}>
            {acao.explica}
            <span style={{ display: "block", color: "var(--rv-texto-suave)", fontSize: 11.5 }}>
              motor: {item.motivo_financeiro || "—"}
            </span>
          </span>
        ) : (
          <span style={motivoTexto}>{item.motivo_financeiro || "—"}</span>
        )}
      </div>

      {aberto && podeVincular ? (
        <div style={{ padding: "14px 16px" }}>
          {sugestoes.length > 0 ? (
            <div style={sugestaoCaixa}>
              <div style={sugestaoTopo}>
                {sugestoes.length === 1 ? "1 sugestão por nome" : `${sugestoes.length} sugestões por nome`}
                <span style={sugestaoAviso}>
                  nome não é prova — confira a ficha antes de vincular
                </span>
              </div>
              {sugestoes.map((sg) => (
                <div key={sg.aluno_id} style={resultadoLinha}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: "var(--rv-tinta)", fontSize: 13.5 }}>{sg.nome}</div>
                    <div style={S.cardCpf}>
                      CPF {sg.cpf_mascarado || "-"}
                      {sg.matricula ? ` · matrícula ${sg.matricula}` : ""}
                      {sg.tem_acordo_ativo ? " · tem acordo ATIVO" : " · sem acordo ativo"}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => onVerFicha && onVerFicha(sg.aluno_id)}
                      style={{ ...S.btnGhost, background: "var(--rv-roxo-fundo)", color: "var(--rv-roxo-texto)" }}
                      title="Conferir a ficha antes de vincular, sem sair da fila"
                    >
                      Ver ficha
                    </button>
                    <button
                      type="button"
                      onClick={() => vincular(sg.aluno_id, sg.nome)}
                      disabled={salvando}
                      style={S.btnGhost}
                    >
                      {salvando ? "…" : "Vincular"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              value={termo}
              onChange={(e) => setTermo(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") buscar(); }}
              placeholder="Buscar aluno por nome ou CPF"
              style={S.input}
            />
            <button type="button" onClick={buscar} style={S.btnGhost} disabled={buscando}>
              {buscando ? "Buscando…" : "Buscar"}
            </button>
            {item.motivo === "SEM_CADASTRO" ? (
              <CadastroNovoAluno
                onSucesso={(novo) => { if (novo?.id) vincular(novo.id, novo.nome || "novo cadastro"); }}
              />
            ) : null}
          </div>

          {msg ? <p style={{ ...S.muted, marginTop: 10 }}>{msg}</p> : null}

          {resultados ? (
            resultados.length === 0 ? (
              <p style={{ ...S.muted, marginTop: 10 }}>
                Nenhum aluno encontrado com esse termo.
              </p>
            ) : (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                {resultados.slice(0, 12).map((a) => (
                  <div key={a.id} style={resultadoLinha}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, color: "var(--rv-tinta)", fontSize: 13.5 }}>{a.nome}</div>
                      <div style={S.cardCpf}>
                        CPF {a.cpf || "-"}
                        {a.responsavel_atual_nome ? ` · ${a.responsavel_atual_nome}` : " · sem responsável"}
                        {a.status_atual ? ` · ${a.status_atual}` : ""}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => onVerFicha && onVerFicha(a.id)}
                        style={{ ...S.btnGhost, background: "var(--rv-roxo-fundo)", color: "var(--rv-roxo-texto)" }}
                        title="Conferir a ficha antes de vincular, sem sair da fila"
                      >
                        Ver ficha
                      </button>
                      <button
                        type="button"
                        onClick={() => vincular(a.id, a.nome)}
                        disabled={salvando}
                        style={S.btnGhost}
                      >
                        {salvando ? "…" : "Vincular"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const btnEncerrar = {
  border: "1px solid var(--rv-borda)",
  background: "transparent",
  color: "var(--rv-texto-suave)",
  borderRadius: 8,
  padding: "6px 10px",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
};
const encerrarCaixa = {
  padding: "12px 16px",
  borderTop: "1px solid var(--rv-borda)",
  background: "var(--rv-fundo-suave)",
};
const motivoBox = {
  display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap",
  padding: "8px 16px", borderTop: "1px solid var(--rv-borda)", background: "var(--rv-fundo-cartao)",
};
const motivoRotulo = {
  fontSize: 10.5, fontWeight: 800, letterSpacing: ".06em", textTransform: "uppercase",
  color: "var(--rv-texto-suave)", whiteSpace: "nowrap",
};
const motivoTexto = { fontSize: 12.5, color: "var(--rv-texto)", minWidth: 0 };
const sugestaoCaixa = {
  border: "1px solid var(--rv-ambar-borda)", background: "var(--rv-ambar-fundo)",
  borderRadius: 10, padding: "10px 12px", marginBottom: 12,
  display: "flex", flexDirection: "column", gap: 8,
};
const sugestaoTopo = {
  display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap",
  fontSize: 12.5, fontWeight: 800, color: "var(--rv-ambar-texto)",
};
const sugestaoAviso = { fontWeight: 600, fontSize: 11.5, color: "var(--rv-ambar-texto)", opacity: 0.85 };
const btnCopiarNome = { background: "var(--rv-superficie)", color: "var(--rv-texto)", border: "1px solid var(--rv-borda-forte)", borderRadius: 8, padding: "3px 10px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" };
const selo = {
  repetido: { fontSize: 12, fontWeight: 800, color: "var(--rv-ambar-texto)", background: "var(--rv-ambar-fundo)", border: "1px solid var(--rv-ambar-borda)", borderRadius: 999, padding: "4px 12px" },
  semCadastro: { fontSize: 12, fontWeight: 800, color: "var(--rv-vermelho-texto)", background: "var(--rv-vermelho-fundo)", border: "1px solid var(--rv-vermelho-borda)", borderRadius: 999, padding: "4px 12px" },
};
// Selo do estado da conciliacao. Cor por papel (nunca hex inline): roxo e o
// neutro informativo da casa, e o estado nao e alerta -- alerta e o selo de
// nome, que so aparece quando falta aluno.
const seloEstado = {
  fontSize: 12, fontWeight: 800, color: "var(--rv-roxo-texto)",
  background: "var(--rv-roxo-fundo)", border: "1px solid var(--rv-borda-forte)",
  borderRadius: 999, padding: "4px 12px", whiteSpace: "nowrap",
};
const resultadoLinha = {
  display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
  border: "1px solid var(--rv-borda)", borderRadius: 10, padding: "10px 12px", background: "var(--rv-fundo-cartao)",
};
